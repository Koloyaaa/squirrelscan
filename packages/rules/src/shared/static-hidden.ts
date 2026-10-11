// Whether an element is removed from the accessibility tree, as far as a static
// read of the page can tell (pub#664, pub#665). Shared by a11y/aria-hidden-focus
// and a11y/button-name, so both rules agree on which controls are hidden.
//
// What counts: the `hidden` attribute (not `hidden="until-found"`), a closed
// `<dialog>` and an unopened `popover` (the user-agent stylesheet hides all
// three), a `<template>` ancestor, `aria-hidden="true"` when the caller asks for
// it, and `display` / `visibility` set by inline `style` attributes or by the
// page's own `<style>` blocks.
//
// There is no layout engine and no CSSOM. External stylesheets are not fetched,
// so a control hidden only by one reads as shown. Within the page's own CSS, a
// rule this module cannot settle does not decide the answer either way: a rule
// under `@supports` or `@layer`, an interaction state such as `:hover`, a
// selector it does not evaluate, a CSS variable. The element comes back
// `unknown` with the reason, and the rules report it as an unconfirmed candidate
// rather than as a failure or a pass. A `@media` rule that HIDES a shown control
// is the one exception: the control is shown wherever the query does not match,
// so it stays in the accessibility tree there.

import type { Document } from "linkedom";

import { getAttrCI, hasAttrCI } from "@squirrelscan/utils";

import { parseRules, replaceComments, scanDeclarations, skipString } from "./css-scan";

/** Why a static read cannot settle whether an element is hidden. */
export type UnknownReason = "conditional" | "interactive" | "selector" | "value" | "truncated";

export type StaticVisibility =
  | { state: "shown" }
  | { state: "hidden" }
  | { state: "unknown"; reason: UnknownReason };

/** One line per reason, for the item labels of an unconfirmed finding. */
export const UNKNOWN_REASON_LABELS: Record<UnknownReason, string> = {
  conditional:
    "a rule in the page's CSS under @media, @supports, @layer or <noscript> may change whether it is hidden",
  interactive:
    "a rule in the page's CSS for :hover, :focus or another interaction state may change whether it is hidden",
  selector:
    "a rule in the page's CSS with a selector squirrel does not evaluate may change whether it is hidden",
  value: "its display or visibility is set through a CSS variable",
  truncated: "the page's inline CSS is too large or too complex for squirrel to resolve",
};

export interface StaticVisibilityOptions {
  /** Count `aria-hidden="true"` on the element or an ancestor as hidden. */
  ariaHidden: boolean;
}

export interface StaticVisibilityResolver {
  visibility(el: Element): StaticVisibility;
}

// Generous next to content/hidden-text's budgets: only rules that set `display`
// or `visibility` are kept, so the scan is linear and the index stays small.
const MAX_STYLE_CHARS = 1_000_000;
const MAX_STYLE_RULES = 20_000;
/** Compounds in one complex selector; real selectors stay far below this. */
const MAX_COMPOUNDS = 16;
/** Nesting of `:not()` / `:is()` arguments; deeper ones are not parsed. */
const MAX_SELECTOR_NESTING = 4;
/** Arguments of one `:not()` / `:is()`; a longer list is not evaluated. */
const MAX_PSEUDO_ARGS = 32;
/** Longer selectors are read loosely instead of parsed. */
const MAX_SELECTOR_CHARS = 4_096;
/** Selectors kept in the index for one page; past this the index counts as cut short. */
const MAX_INDEXED_SELECTORS = 50_000;
/** `<style>` elements read per page; past this the index counts as cut short. */
const MAX_STYLE_ELEMENTS = 1_000;
/** Compound tests for one selector against one element, bounding descendant backtracking. */
const MATCH_STEP_BUDGET = 2_000;
/**
 * Compound tests for one page. A real page spends a few thousand; a sheet of
 * universal-subject selectors over a deep tree can spend millions, so past this
 * the remaining elements come back `unknown` rather than stalling the audit.
 */
const PAGE_STEP_BUDGET = 300_000;

const SHOWN: StaticVisibility = { state: "shown" };
const HIDDEN: StaticVisibility = { state: "hidden" };

// ── Selectors ───────────────────────────────────────────────────────────────

/**
 * A tri-state match: true, false, or the reason it cannot be told statically.
 * Parts this module does not evaluate (`:hover`, `:has()`) match as "maybe",
 * so a "maybe" selector matches a superset of what a browser would.
 */
type Match = boolean | UnknownReason;

type Specificity = [number, number, number];

interface AttrTest {
  name: string;
  op: "" | "=" | "~=" | "|=" | "^=" | "$=" | "*=";
  value: string;
  caseInsensitive: boolean;
}

type PseudoTest =
  | { kind: "not" | "is"; args: Compound[] }
  | { kind: "root" | "first-child" | "last-child" | "only-child" | "defined" }
  | {
      kind: "unknown";
      reason: UnknownReason;
      /** A functional pseudo-class (`:has(#a)`) whose arguments set a specificity not read here. */
      opaqueSpecificity: boolean;
    };

interface Compound {
  /** Lower-cased type selector, or null for `*` or none. */
  tag: string | null;
  ids: string[];
  classes: string[];
  attrs: AttrTest[];
  pseudos: PseudoTest[];
  /** Null when a functional pseudo-class leaves it unknown. */
  specificity: Specificity | null;
}

type Combinator = " " | ">" | "+" | "~";

interface ComplexSelector {
  compounds: Compound[];
  /** combinators[i] joins compounds[i] and compounds[i + 1]. */
  combinators: Combinator[];
  /** Null when a functional pseudo-class leaves it unknown. */
  specificity: Specificity | null;
}

/** Pseudo-classes for states the page enters through interaction. */
const INTERACTION_PSEUDOS = new Set([
  "hover",
  "focus",
  "focus-within",
  "focus-visible",
  "active",
  "target",
  "target-within",
  "checked",
  "open",
  "popover-open",
  "modal",
  "fullscreen",
]);

/** Pseudo-elements CSS2 allowed with a single colon. */
const LEGACY_PSEUDO_ELEMENTS = new Set(["before", "after", "first-line", "first-letter"]);

/**
 * Pseudo-elements a browser accepts. Any other one, vendor-prefixed or made up,
 * makes a browser drop the whole rule, so it cannot be skipped as harmless.
 */
const KNOWN_PSEUDO_ELEMENTS = new Set([
  ...LEGACY_PSEUDO_ELEMENTS,
  "marker",
  "placeholder",
  "selection",
  "backdrop",
  "file-selector-button",
  "cue",
  "cue-region",
  "part",
  "slotted",
  "highlight",
  "spelling-error",
  "grammar-error",
  "target-text",
  "details-content",
  "view-transition",
  "view-transition-group",
  "view-transition-image-pair",
  "view-transition-old",
  "view-transition-new",
]);

const CSS_WHITESPACE = /[\t\n\f\r ]/;
const IDENT_CHAR = /[-_a-zA-Z0-9]/;

class SelectorSyntaxError extends Error {}

/** Returned for a selector whose subject is a pseudo-element: it styles a generated box, not the element. */
const PSEUDO_ELEMENT = Symbol("pseudo-element");

/**
 * Returned for a pseudo-element a browser does not accept (`::-moz-placeholder`
 * in Chrome, a made-up name). It styles no element either, but a browser drops
 * the whole rule over it, so it voids the other selectors in its list.
 */
const UNKNOWN_PSEUDO_ELEMENT = Symbol("unknown-pseudo-element");

type ParsedSelector = ComplexSelector | typeof PSEUDO_ELEMENT | typeof UNKNOWN_PSEUDO_ELEMENT;

/** Reads a CSS identifier at `i`, decoding escapes (`.md\:hidden`, `.\31 0`). */
function readIdent(s: string, start: number): { ident: string; end: number } | null {
  let i = start;
  let out = "";
  // An identifier may not start with a digit, or with a hyphen and a digit.
  if (/[0-9]/.test(s[i] ?? "") || (s[i] === "-" && /[0-9]/.test(s[i + 1] ?? ""))) return null;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      const hex = /^[0-9a-fA-F]{1,6}/.exec(s.slice(i + 1, i + 7));
      if (hex) {
        const cp = Number.parseInt(hex[0], 16);
        const valid = cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff);
        out += String.fromCodePoint(valid ? cp : 0xfffd);
        i += 1 + hex[0].length;
        if (CSS_WHITESPACE.test(s[i] ?? "")) i++;
        continue;
      }
      if (i + 1 >= s.length || s[i + 1] === "\n") break;
      out += s[i + 1];
      i += 2;
      continue;
    }
    if (IDENT_CHAR.test(c) || c.charCodeAt(0) >= 0x80) {
      out += c;
      i++;
      continue;
    }
    break;
  }
  return out ? { ident: out, end: i } : null;
}

/** Index of the `close` that balances the opener at `start`, skipping strings and escapes. */
function findClose(s: string, start: number, open: string, close: string): number {
  let depth = 0;
  let i = start;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(s, i);
      continue;
    }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
    i++;
  }
  return -1;
}

/** Splits on top-level commas: `:is(.a, .b), .c` is two selectors, `.a,` is `.a` and an empty one. */
export function splitSelectorList(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(text, i);
      continue;
    }
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(text.slice(start));
  // Empty entries are kept: `button, {}` is an invalid list, not `button`.
  return parts.map((p) => p.trim());
}

/** Decodes CSS escapes in a string or identifier: `\61` and `\61 ` are `a`, `\:` is `:`. */
function decodeEscapes(raw: string): string {
  if (!raw.includes("\\")) return raw;
  return raw.replace(
    /\\(?:([0-9a-fA-F]{1,6})[\t\n\f\r ]?|([\s\S]))/g,
    (_, hex: string | undefined, ch: string) => {
      if (hex === undefined) return ch === "\n" ? "" : ch;
      const cp = Number.parseInt(hex, 16);
      const valid = cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff);
      return String.fromCodePoint(valid ? cp : 0xfffd);
    },
  );
}

function parseAttr(body: string): AttrTest {
  const m =
    /^\s*([-_a-zA-Z0-9]+)\s*(?:([~|^$*]?=)\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s"']+))\s*([iIsS])?\s*)?$/.exec(
      body,
    );
  if (!m) throw new SelectorSyntaxError();
  const value = decodeEscapes(m[3] ?? m[4] ?? m[5] ?? "");
  return {
    name: m[1].toLowerCase(),
    op: (m[2] ?? "") as AttrTest["op"],
    value,
    caseInsensitive: m[6]?.toLowerCase() === "i",
  };
}

function emptyCompound(): Compound {
  return { tag: null, ids: [], classes: [], attrs: [], pseudos: [], specificity: [0, 0, 0] };
}

function addSpecificity(a: Specificity | null, b: Specificity | null): Specificity | null {
  if (a === null || b === null) return null;
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function maxSpecificity(list: Compound[]): Specificity | null {
  let best: Specificity = [0, 0, 0];
  for (const c of list) {
    if (c.specificity === null) return null;
    if (compareSpecificity(c.specificity, best) > 0) best = c.specificity;
  }
  return best;
}

function compareSpecificity(a: Specificity, b: Specificity): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Parses `:not(.a, [b])`-style arguments: a list of compounds, no combinators. */
function parseCompoundList(text: string, depth: number): Compound[] | null {
  const out: Compound[] = [];
  const parts = splitSelectorList(text);
  if (parts.length > MAX_PSEUDO_ARGS) return null;
  for (const part of parts) {
    if (part === "") return null;
    let parsed: ParsedSelector;
    try {
      parsed = parseComplex(part, depth);
    } catch (err) {
      if (err instanceof SelectorSyntaxError) return null;
      throw err;
    }
    if (typeof parsed === "symbol" || parsed.compounds.length !== 1) return null;
    out.push(parsed.compounds[0]);
  }
  return out.length > 0 ? out : null;
}

function parsePseudo(name: string, args: string | null, depth: number): PseudoTest {
  const lower = name.toLowerCase();
  if (args !== null) {
    const listPseudo =
      lower === "not" || lower === "is" || lower === "where" || lower === "matches";
    const list =
      listPseudo && depth < MAX_SELECTOR_NESTING ? parseCompoundList(args, depth + 1) : null;
    // :where() contributes no specificity; parsePseudo's caller handles that.
    if (list) return { kind: lower === "not" ? "not" : "is", args: list };
    return { kind: "unknown", reason: "selector", opaqueSpecificity: lower !== "where" };
  }
  if (lower === "root" || lower === "first-child" || lower === "last-child") return { kind: lower };
  if (lower === "only-child" || lower === "defined") return { kind: lower };
  return {
    kind: "unknown",
    reason: INTERACTION_PSEUDOS.has(lower) ? "interactive" : "selector",
    opaqueSpecificity: false,
  };
}

/**
 * Parses one complex selector (`.nav > li:hover .sub`). Returns PSEUDO_ELEMENT (or UNKNOWN_PSEUDO_ELEMENT)
 * for a selector whose subject is a pseudo-element, and throws on syntax this
 * module does not read (namespaces, nesting).
 */
function parseComplex(text: string, depth = 0): ParsedSelector {
  const s = text.trim();
  if (s.length > MAX_SELECTOR_CHARS) throw new SelectorSyntaxError();
  const compounds: Compound[] = [];
  const combinators: Combinator[] = [];
  let current = emptyCompound();
  let empty = true;
  let i = 0;

  const finishCompound = (): void => {
    if (empty) throw new SelectorSyntaxError();
    compounds.push(current);
    current = emptyCompound();
    empty = true;
  };

  while (i < s.length) {
    const c = s[i];
    if (CSS_WHITESPACE.test(c) || c === ">" || c === "+" || c === "~") {
      let j = i;
      while (j < s.length && CSS_WHITESPACE.test(s[j])) j++;
      let combinator: Combinator = " ";
      if (s[j] === ">" || s[j] === "+" || s[j] === "~") {
        combinator = s[j] as Combinator;
        j++;
        while (j < s.length && CSS_WHITESPACE.test(s[j])) j++;
        // `button >` is invalid, and a browser drops the whole rule.
        if (j >= s.length) throw new SelectorSyntaxError();
      }
      if (j >= s.length) break;
      finishCompound();
      combinators.push(combinator);
      i = j;
      continue;
    }
    if (c === "*") {
      if (!empty || s[i + 1] === "|") throw new SelectorSyntaxError();
      empty = false;
      i++;
      continue;
    }
    if (c === "." || c === "#") {
      const id = readIdent(s, i + 1);
      if (!id) throw new SelectorSyntaxError();
      if (c === ".") {
        current.classes.push(id.ident);
        current.specificity = addSpecificity(current.specificity, [0, 1, 0]);
      } else {
        current.ids.push(id.ident);
        current.specificity = addSpecificity(current.specificity, [1, 0, 0]);
      }
      empty = false;
      i = id.end;
      continue;
    }
    if (c === "[") {
      const end = findClose(s, i, "[", "]");
      if (end === -1) throw new SelectorSyntaxError();
      current.attrs.push(parseAttr(s.slice(i + 1, end)));
      current.specificity = addSpecificity(current.specificity, [0, 1, 0]);
      empty = false;
      i = end + 1;
      continue;
    }
    if (c === ":") {
      if (s[i + 1] === ":") {
        const pseudoElement = readIdent(s, i + 2);
        if (!pseudoElement) throw new SelectorSyntaxError();
        return KNOWN_PSEUDO_ELEMENTS.has(pseudoElement.ident.toLowerCase())
          ? PSEUDO_ELEMENT
          : UNKNOWN_PSEUDO_ELEMENT;
      }
      const id = readIdent(s, i + 1);
      if (!id) throw new SelectorSyntaxError();
      const name = id.ident.toLowerCase();
      if (LEGACY_PSEUDO_ELEMENTS.has(name)) return PSEUDO_ELEMENT;
      let args: string | null = null;
      i = id.end;
      if (s[i] === "(") {
        const end = findClose(s, i, "(", ")");
        if (end === -1) throw new SelectorSyntaxError();
        args = s.slice(i + 1, end);
        i = end + 1;
      }
      const pseudo = parsePseudo(name, args, depth);
      current.pseudos.push(pseudo);
      let spec: Specificity | null = [0, 1, 0];
      if (name === "where") spec = [0, 0, 0];
      else if (pseudo.kind === "not" || pseudo.kind === "is") spec = maxSpecificity(pseudo.args);
      else if (pseudo.kind === "unknown" && pseudo.opaqueSpecificity) spec = null;
      current.specificity = addSpecificity(current.specificity, spec);
      empty = false;
      continue;
    }
    // A type selector opens a compound; anything else here (`&`, `|`, `%`) is
    // syntax this module does not read.
    if (!empty) throw new SelectorSyntaxError();
    const id = readIdent(s, i);
    if (!id || s[id.end] === "|") throw new SelectorSyntaxError();
    current.tag = id.ident.toLowerCase();
    current.specificity = addSpecificity(current.specificity, [0, 0, 1]);
    empty = false;
    i = id.end;
  }

  finishCompound();
  if (compounds.length > MAX_COMPOUNDS) throw new SelectorSyntaxError();
  let specificity: Specificity | null = [0, 0, 0];
  for (const compound of compounds) specificity = addSpecificity(specificity, compound.specificity);
  return { compounds, combinators, specificity };
}

/**
 * The element-level requirements of a selector this module could not parse,
 * read loosely from its last compound: a superset match, used only to decide
 * whether the rule MAY apply.
 */
function looseSubject(text: string): Compound {
  // The text after the last top-level, unescaped combinator, with bracketed
  // and parenthesised parts dropped.
  let last = "";
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      // A whole escape, a hex one's terminating space included, is one
      // character of a name: `.\\66 oo` is `.foo`, not `.f` then `oo`.
      const hex = /^[0-9a-fA-F]{1,6}/.exec(text.slice(i + 1, i + 7));
      let end = i + 2;
      let ch = text[i + 1] ?? "";
      if (hex) {
        end = i + 1 + hex[0].length;
        ch = decodeEscapes(text.slice(i, end));
        if (CSS_WHITESPACE.test(text[end] ?? "")) end++;
      }
      if (depth === 0) last += IDENT_CHAR.test(ch) || ch.charCodeAt(0) >= 0x80 ? ch : `\\${ch}`;
      i = end;
      continue;
    }
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      last = CSS_WHITESPACE.test(c) || c === ">" || c === "+" || c === "~" ? "" : last + c;
    }
    i++;
  }
  // A namespace prefix (`svg|a`, `*|a`) says nothing about the element's name.
  const bar = last.lastIndexOf("|");
  if (bar !== -1 && last[bar - 1] !== "\\") last = last.slice(bar + 1);
  const compound = emptyCompound();
  for (const m of last.matchAll(/([.#])((?:\\.|[-_a-zA-Z0-9\u0080-\uffff])+)/g)) {
    const name = decodeEscapes(m[2]);
    if (m[1] === ".") compound.classes.push(name);
    else compound.ids.push(name);
  }
  const tag = /^[a-zA-Z][-_a-zA-Z0-9]*/.exec(last);
  if (tag) compound.tag = tag[0].toLowerCase();
  return compound;
}

// ── Matching ────────────────────────────────────────────────────────────────

function and(a: Match, b: Match): Match {
  if (a === false || b === false) return false;
  if (a === true) return b;
  return a;
}

/** What selectors read most, read once per element. */
interface ElementFacts {
  tag: string;
  id: string | null;
  classes: Set<string>;
}

const factsCache = new WeakMap<Element, ElementFacts>();

function factsOf(el: Element): ElementFacts {
  let facts = factsCache.get(el);
  if (!facts) {
    const classes = (getAttrCI(el, "class") ?? "").split(/[\t\n\f\r ]+/).filter(Boolean);
    facts = { tag: tagOf(el), id: getAttrCI(el, "id"), classes: new Set(classes) };
    factsCache.set(el, facts);
  }
  return facts;
}

function tagOf(el: Element): string {
  return (el.localName || el.tagName || "").toLowerCase();
}

function matchAttr(el: Element, test: AttrTest): boolean {
  const raw = getAttrCI(el, test.name);
  if (raw === null) return false;
  if (test.op === "") return true;
  const value = test.caseInsensitive ? raw.toLowerCase() : raw;
  const want = test.caseInsensitive ? test.value.toLowerCase() : test.value;
  switch (test.op) {
    case "=":
      return value === want;
    case "~=":
      return want !== "" && !/\s/.test(want) && value.split(/[\t\n\f\r ]+/).includes(want);
    case "|=":
      return value === want || value.startsWith(`${want}-`);
    case "^=":
      return want !== "" && value.startsWith(want);
    case "$=":
      return want !== "" && value.endsWith(want);
    case "*=":
      return want !== "" && value.includes(want);
  }
}

class MatchBudgetError extends Error {}

/** Thrown when the page's whole step budget is spent. */
class PageBudgetError extends Error {}

/**
 * Compound tests left: for this one match, and for the page. Every compound
 * test spends one, `:not()` / `:is()` arguments included.
 */
interface StepBudget {
  match: number;
  page: { steps: number };
}

function matchPseudo(el: Element, pseudo: PseudoTest, budget: StepBudget): Match {
  switch (pseudo.kind) {
    case "not": {
      let result: Match = true;
      for (const arg of pseudo.args) {
        const m = matchCompound(el, arg, budget);
        if (m === true) return false;
        if (m !== false) result = m;
      }
      return result;
    }
    case "is": {
      let result: Match = false;
      for (const arg of pseudo.args) {
        const m = matchCompound(el, arg, budget);
        if (m === true) return true;
        if (m !== false) result = m;
      }
      return result;
    }
    case "root":
      return el.parentElement === null && tagOf(el) === "html";
    case "first-child":
      return el.previousElementSibling === null;
    case "last-child":
      return el.nextElementSibling === null;
    case "only-child":
      return el.previousElementSibling === null && el.nextElementSibling === null;
    case "defined":
      // Built-in elements are always defined; a custom element only once its
      // script has run.
      return tagOf(el).includes("-") ? "selector" : true;
    case "unknown":
      return pseudo.reason;
  }
}

function matchCompound(el: Element, compound: Compound, budget: StepBudget): Match {
  if (--budget.page.steps < 0) throw new PageBudgetError();
  if (--budget.match < 0) throw new MatchBudgetError();
  const facts = factsOf(el);
  if (compound.tag !== null && facts.tag !== compound.tag) return false;
  for (const id of compound.ids) if (facts.id !== id) return false;
  for (const cls of compound.classes) if (!facts.classes.has(cls)) return false;
  for (const attr of compound.attrs) if (!matchAttr(el, attr)) return false;
  let result: Match = true;
  for (const pseudo of compound.pseudos) {
    result = and(result, matchPseudo(el, pseudo, budget));
    if (result === false) return false;
  }
  return result;
}

/** Right-to-left match of compounds[0..index] ending at `el`. */
function matchFrom(sel: ComplexSelector, index: number, el: Element, budget: StepBudget): Match {
  const own = matchCompound(el, sel.compounds[index], budget);
  if (own === false || index === 0) return own;

  const combinator = sel.combinators[index - 1];
  let rest: Match = false;
  if (combinator === ">" || combinator === "+") {
    const next = combinator === ">" ? el.parentElement : el.previousElementSibling;
    rest = next ? matchFrom(sel, index - 1, next, budget) : false;
  } else {
    const step = (node: Element): Element | null =>
      combinator === " " ? node.parentElement : node.previousElementSibling;
    for (let node = step(el); node; node = step(node)) {
      const m = matchFrom(sel, index - 1, node, budget);
      if (m === true) {
        rest = true;
        break;
      }
      if (m !== false) rest = m;
    }
  }
  return and(own, rest);
}

/** Matches a parsed selector, or an unparsed rule's loose subject (`sel` null: "may apply" at best). */
function matchRule(rule: IndexedRule, el: Element, page: { steps: number }): Match {
  const budget: StepBudget = { match: MATCH_STEP_BUDGET, page };
  try {
    if (rule.selector)
      return matchFrom(rule.selector, rule.selector.compounds.length - 1, el, budget);
    return matchCompound(el, rule.subject, budget) === false ? false : "selector";
  } catch (err) {
    if (err instanceof MatchBudgetError) return "selector";
    throw err;
  }
}

// ── Conditions ──────────────────────────────────────────────────────────────

/**
 * When a rule applies: always; never on screen (`@media print`, `@keyframes`);
 * in some environments but not all (`@media (max-width: 600px)`, `<noscript>`);
 * or under a condition this module does not evaluate (`@supports`, `@layer`).
 */
type Condition = "always" | "never" | "variant" | "conditional";

const CONDITION_RANK: Record<Condition, number> = {
  never: 0,
  conditional: 1,
  variant: 2,
  always: 3,
};

/** At-rules whose blocks hold no rules that style elements. */
const NON_STYLE_AT_RULES = new Set([
  "keyframes",
  "font-face",
  "page",
  "property",
  "counter-style",
  "font-feature-values",
  "font-palette-values",
  "starting-style",
  "view-transition",
  "position-try",
]);

const KNOWN_MEDIA_TYPES = new Set([
  "all",
  "screen",
  "print",
  "speech",
  "aural",
  "braille",
  "embossed",
  "handheld",
  "projection",
  "tty",
  "tv",
]);

function mediaQueryCondition(query: string): Condition {
  const m = /^(?:(not|only)\s+)?([a-z-]+)(\s+and\s+[\s\S]+)?$/.exec(query);
  if (!m) return query.startsWith("(") ? "variant" : "conditional";
  const [, modifier, type, features] = m;
  if (!KNOWN_MEDIA_TYPES.has(type)) return "never";
  const onScreen = type === "all" || type === "screen";
  if (modifier === "not") {
    if (features) return "conditional";
    return onScreen ? "never" : "always";
  }
  if (!onScreen) return "never";
  return features ? "variant" : "always";
}

/** A media query list applies if any of its queries does. */
export function mediaCondition(list: string): Condition {
  let best: Condition = "never";
  const queries = splitSelectorList(list.toLowerCase()).filter(Boolean);
  if (queries.length === 0) return "always";
  for (const query of queries) {
    const c = mediaQueryCondition(query.replace(/\s+/g, " "));
    if (CONDITION_RANK[c] > CONDITION_RANK[best]) best = c;
  }
  return best;
}

function atRuleCondition(prelude: string): Condition {
  const m = /^@(?:-[a-z]+-)?([a-z-]+)\s*([\s\S]*)$/i.exec(prelude);
  if (!m) return "conditional";
  const name = m[1].toLowerCase();
  if (name === "media") return mediaCondition(m[2]);
  if (NON_STYLE_AT_RULES.has(name)) return "never";
  return "conditional";
}

/** Nested conditions: the most restrictive wins. */
function combineConditions(conditions: Condition[]): Condition {
  let worst: Condition = "always";
  for (const c of conditions) if (CONDITION_RANK[c] < CONDITION_RANK[worst]) worst = c;
  return worst;
}

// ── Cascade ─────────────────────────────────────────────────────────────────

/** Where a declaration comes from: user agent, page stylesheet, or `style` attribute. */
type Origin = "ua" | "sheet" | "inline";

const NORMAL_RANK: Record<Origin, number> = { ua: 0, sheet: 1, inline: 2 };
const IMPORTANT_RANK: Record<Origin, number> = { sheet: 0, inline: 1, ua: 2 };

interface Decl {
  prop: "display" | "visibility";
  value: string;
  important: boolean;
  origin: Origin;
  /** Null when the selector could not be parsed. */
  specificity: Specificity | null;
  order: number;
}

/** A declaration that applies to the element, or may (`may` says why it is not certain). */
interface AppliedDecl {
  decl: Decl;
  may: UnknownReason | null;
  /** Applies only under a media query or `<noscript>`: shown elsewhere. */
  variant: boolean;
}

/** Whether `a` beats `b` in the cascade; null when that cannot be told. */
function outranks(a: Decl, b: Decl): boolean | null {
  if (a.important !== b.important) return a.important;
  const ranks = a.important ? IMPORTANT_RANK : NORMAL_RANK;
  if (ranks[a.origin] !== ranks[b.origin]) return ranks[a.origin] > ranks[b.origin];
  if (a.specificity === null || b.specificity === null) return null;
  const bySpecificity = compareSpecificity(a.specificity, b.specificity);
  if (bySpecificity !== 0) return bySpecificity > 0;
  return a.order > b.order;
}

function cascadeWinner(decls: Decl[]): Decl | null {
  let best: Decl | null = null;
  for (const d of decls) if (!best || outranks(d, best) === true) best = d;
  return best;
}

const UNREADABLE_VALUE = /\b(?:var|env|attr)\(/;
/** Single-keyword `display` values, prefixed legacy ones included. */
const DISPLAY_KEYWORDS = new Set([
  "none",
  "contents",
  "block",
  "inline",
  "inline-block",
  "flex",
  "inline-flex",
  "grid",
  "inline-grid",
  "flow",
  "flow-root",
  "table",
  "inline-table",
  "table-row-group",
  "table-header-group",
  "table-footer-group",
  "table-row",
  "table-cell",
  "table-column-group",
  "table-column",
  "table-caption",
  "list-item",
  "run-in",
  "ruby",
  "ruby-base",
  "ruby-text",
  "ruby-base-container",
  "ruby-text-container",
  "math",
  "-webkit-box",
  "-webkit-inline-box",
  "-webkit-flex",
  "-webkit-inline-flex",
  "-ms-flexbox",
  "-ms-inline-flexbox",
  "-ms-grid",
  "-ms-inline-grid",
  "-moz-box",
  "-moz-inline-box",
  "initial",
  "inherit",
  "unset",
  "revert",
  "revert-layer",
]);

/** Keywords of the multi-keyword `display` syntax (`inline flex`, `block flow list-item`). */
const DISPLAY_PARTS = new Set([
  "block",
  "inline",
  "run-in",
  "flow",
  "flow-root",
  "table",
  "flex",
  "grid",
  "ruby",
  "list-item",
  "math",
]);

function isDisplayValue(v: string): boolean {
  if (DISPLAY_KEYWORDS.has(v)) return true;
  const parts = v.split(" ");
  return parts.length <= 3 && parts.every((p) => DISPLAY_PARTS.has(p));
}

/** `display` as hidden or not; null for a value a browser would drop. */
function displayKind(value: string, uaHidden: boolean): "none" | "shown" | "unknown" | null {
  if (UNREADABLE_VALUE.test(value)) return "unknown";
  const v = value.replace(/\s+/g, " ");
  if (!isDisplayValue(v)) return null;
  if (v === "none") return "none";
  // revert rolls back to the user-agent stylesheet, which hides `[hidden]`.
  if (v === "revert" || v === "revert-layer") return uaHidden ? "none" : "shown";
  return "shown";
}

function visibilityKind(value: string): "hidden" | "visible" | "inherit" | "unknown" | null {
  if (UNREADABLE_VALUE.test(value)) return "unknown";
  switch (value) {
    case "hidden":
    case "collapse":
      return "hidden";
    case "visible":
    case "initial":
      return "visible";
    case "inherit":
    case "unset":
    case "revert":
    case "revert-layer":
      return "inherit";
    default:
      return null;
  }
}

const UA_DISPLAY_NONE: Decl = {
  prop: "display",
  value: "none",
  important: false,
  origin: "ua",
  specificity: [0, 1, 0],
  order: -1,
};

// ── Style index ─────────────────────────────────────────────────────────────

interface IndexedRule {
  /** Null when the selector could not be parsed: `subject` alone decides whether it may apply. */
  selector: ComplexSelector | null;
  subject: Compound;
  decls: Decl[];
  condition: Exclude<Condition, "never">;
  /**
   * Set when another selector in the same list could not be parsed. A browser
   * drops the whole rule over one invalid selector, so even a match here only
   * MAY apply.
   */
  approx: UnknownReason | null;
}

interface StyleIndex {
  byId: Map<string, IndexedRule[]>;
  byClass: Map<string, IndexedRule[]>;
  byTag: Map<string, IndexedRule[]>;
  /** Keyed by lower-cased attribute name, for subjects such as `[hidden]`. */
  byAttr: Map<string, IndexedRule[]>;
  universal: IndexedRule[];
  /**
   * Set when the index cannot settle any CSS verdict on the page: a budget
   * ran out, so rules past it were never read ("truncated"), or the page uses
   * CSS nesting to set display or visibility ("selector").
   */
  unsettled: UnknownReason | null;
}

function addToIndex(index: StyleIndex, rule: IndexedRule): void {
  const { subject } = rule;
  const push = (map: Map<string, IndexedRule[]>, key: string): void => {
    const list = map.get(key);
    if (list) list.push(rule);
    else map.set(key, [rule]);
  };
  if (subject.ids.length > 0) push(index.byId, subject.ids[0]);
  else if (subject.classes.length > 0) push(index.byClass, subject.classes[0]);
  else if (subject.tag !== null) push(index.byTag, subject.tag);
  else if (subject.attrs.length > 0) push(index.byAttr, subject.attrs[0].name);
  else index.universal.push(rule);
}

function styleElementCondition(style: Element): Condition {
  const type = getAttrCI(style, "type");
  if (type !== null && type.trim() !== "" && type.trim().toLowerCase() !== "text/css")
    return "never";
  const conditions: Condition[] = [];
  const media = getAttrCI(style, "media");
  if (media !== null) conditions.push(mediaCondition(media));
  // Styles inside <noscript> apply only with scripting off.
  for (let node = style.parentElement; node; node = node.parentElement) {
    const tag = tagOf(node);
    if (tag === "template") return "never";
    if (tag === "noscript") conditions.push("variant");
  }
  return combineConditions(conditions);
}

/**
 * The rule scanner keeps comments that sit before or inside a selector, such as
 * the marker styled-components writes before every rule. A comment is not
 * whitespace in a selector: `.a`, a comment, then `.b` is the compound `.a.b`.
 * Between two identifier characters it splits one token into two, which no
 * selector parses, so it is replaced by a character the parser rejects. Quoted
 * strings are copied as they are: a comment inside one is text.
 */
function stripSelectorComments(text: string): string {
  if (!text.includes("/*")) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      out += text.slice(i, i + 2);
      i += 2;
    } else if (c === '"' || c === "'") {
      const end = skipString(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? text.length : close + 2;
      const splitsToken = /[-\w]/.test(out[out.length - 1] ?? "") && /[-\w]/.test(text[end] ?? "");
      if (splitsToken) out += "/";
      i = end;
    } else {
      out += c;
      i++;
    }
  }
  return out.trim();
}

/** In an at-rule prelude a comment separates tokens like whitespace. */
function stripPreludeComments(text: string): string {
  return replaceComments(text, " ").trim();
}

interface HidingDeclaration {
  prop: "display" | "visibility";
  value: string;
  important: boolean;
}

/** `display` and `visibility` declarations, with the `all` shorthand counted as both. */
function hidingDeclarations(css: string): HidingDeclaration[] {
  const out: HidingDeclaration[] = [];
  for (const d of scanDeclarations(css, { stripComments: true })) {
    if (d.prop === "display" || d.prop === "visibility") {
      out.push({ prop: d.prop, value: d.value, important: d.important });
    } else if (d.prop === "all" && CSS_WIDE_KEYWORDS.has(d.value)) {
      // `all: initial` resets both, which shows an element `display:none` hid.
      out.push({ prop: "display", value: d.value, important: d.important });
      out.push({ prop: "visibility", value: d.value, important: d.important });
    }
  }
  return out;
}

const CSS_WIDE_KEYWORDS = new Set(["initial", "inherit", "unset", "revert", "revert-layer"]);

/** Cheap test for a block worth scanning. */
const HIDING_PROPERTY = /display|visibility|\ball\s*:/i;

/**
 * The `display` and `visibility` a declaration block settles on: per property,
 * the last valid declaration, an `!important` one beating any normal one. A
 * value a browser would drop does not count, so `display:none;display:nope`
 * stays `none`.
 */
function blockWinners(body: string, order: number): Decl[] {
  const winners = new Map<"display" | "visibility", { value: string; important: boolean }>();
  for (const d of hidingDeclarations(body)) {
    const valid = d.prop === "display" ? displayKind(d.value, false) : visibilityKind(d.value);
    if (valid === null) continue;
    const best = winners.get(d.prop);
    if (!best || d.important || !best.important) winners.set(d.prop, d);
  }
  return [...winners].map(([prop, d]) => ({
    prop,
    value: d.value,
    important: d.important,
    origin: "sheet",
    specificity: null,
    order,
  }));
}

/** A selector list, parsed. */
interface SelectorScope {
  entries: Array<{ selector: ComplexSelector | null; subject: Compound }>;
  /** One selector in the list is invalid, so a browser may drop all of them. */
  listInvalid: boolean;
  /** The list held more selectors than the index had room for. */
  cut: boolean;
}

/** Parses at most `limit` selectors of a list; `cut` says when there were more. */
function parseSelectorScope(list: string, limit: number): SelectorScope {
  const entries: SelectorScope["entries"] = [];
  let listInvalid = false;
  const texts = splitSelectorList(stripSelectorComments(list));
  const cut = texts.length > limit;
  for (const selectorText of cut ? texts.slice(0, Math.max(limit, 0)) : texts) {
    if (selectorText === "") {
      listInvalid = true;
      continue;
    }
    try {
      const parsed = parseComplex(selectorText);
      if (parsed === PSEUDO_ELEMENT) continue;
      if (parsed === UNKNOWN_PSEUDO_ELEMENT) {
        listInvalid = true;
        continue;
      }
      entries.push({ selector: parsed, subject: parsed.compounds[parsed.compounds.length - 1] });
    } catch (err) {
      if (!(err instanceof SelectorSyntaxError)) throw err;
      listInvalid = true;
      entries.push({ selector: null, subject: looseSubject(selectorText) });
    }
  }
  return { entries, listInvalid, cut };
}

function buildStyleIndex(doc: Document): StyleIndex {
  const index: StyleIndex = {
    byId: new Map(),
    byClass: new Map(),
    byTag: new Map(),
    byAttr: new Map(),
    universal: [],
    unsettled: null,
  };
  let budget = MAX_STYLE_CHARS;
  let ruleBudget = MAX_STYLE_RULES;
  let selectorBudget = MAX_INDEXED_SELECTORS;
  let styleElements = 0;
  let order = 0;

  try {
    for (const style of doc.querySelectorAll("style") as Iterable<Element>) {
      if (budget <= 0 || ruleBudget <= 0 || ++styleElements > MAX_STYLE_ELEMENTS) {
        index.unsettled = "truncated";
        break;
      }
      const elementCondition = styleElementCondition(style);
      if (elementCondition === "never") continue;
      const text = (style.textContent || "").slice(0, budget);
      budget -= text.length;

      for (const rule of parseRules(text, ruleBudget, { strictPreludes: true })) {
        ruleBudget--;
        order++;
        if (!HIDING_PROPERTY.test(rule.body)) continue;
        // CSS nesting (`.panel { &.open { display:block } }`) is not read. A
        // nested rule that sets display or visibility may reveal or hide any
        // control, so every CSS verdict on the page is left unsettled.
        if (rule.body.includes("{")) {
          index.unsettled = "selector";
          return index;
        }
        const preludes = rule.atRules.map(stripPreludeComments);
        const condition = combineConditions([
          elementCondition,
          ...preludes.map(atRuleCondition),
          // Nesting deeper than the scanner records is not evaluated.
          rule.atDepth > rule.atRules.length ? "conditional" : "always",
        ]);
        if (condition === "never") continue;
        const decls = blockWinners(rule.body, order);
        if (decls.length === 0) continue;
        // Inside @layer or @scope the cascade is not modelled: a matching rule
        // there may beat any other, whatever its specificity.
        const cascadeKnown =
          rule.atDepth === rule.atRules.length &&
          preludes.every((p) => /^@(?:-[a-z]+-)?(?:media|supports|container)\b/i.test(p));

        const scope = parseSelectorScope(rule.selector, selectorBudget);
        for (const { selector, subject } of scope.entries) {
          const specificity = cascadeKnown ? (selector?.specificity ?? null) : null;
          addToIndex(index, {
            selector,
            subject,
            decls: decls.map((d) => ({ ...d, specificity })),
            condition,
            approx: scope.listInvalid ? "selector" : null,
          });
        }
        selectorBudget -= scope.entries.length;
        if (scope.cut || selectorBudget <= 0) {
          index.unsettled = "truncated";
          return index;
        }
      }
    }
  } catch (err) {
    // Hostile CSS that still trips an engine limit (call stack, string or
    // array length) leaves every CSS verdict unsettled, never a thrown rule.
    if (!(err instanceof RangeError)) throw err;
    index.unsettled = "truncated";
  }

  // Conservative at the boundary: a budget spent exactly to zero reads as cut.
  if (budget <= 0 || ruleBudget <= 0) index.unsettled ??= "truncated";
  return index;
}

/** The candidate rule lists for `el`: those keyed by its id, a class, its tag, an attribute, or none. */
function candidateLists(index: StyleIndex, el: Element): IndexedRule[][] {
  const lists: IndexedRule[][] = [];
  const add = (list: IndexedRule[] | undefined): void => {
    if (list) lists.push(list);
  };
  const facts = factsOf(el);
  if (facts.id) add(index.byId.get(facts.id));
  for (const cls of facts.classes) add(index.byClass.get(cls));
  add(index.byTag.get(facts.tag));
  if (index.byAttr.size > 0) {
    const names = new Set<string>();
    for (const attr of el.attributes) names.add(attr.name.toLowerCase());
    for (const name of names) add(index.byAttr.get(name));
  }
  add(index.universal);
  return lists;
}

/** Throws PageBudgetError once the page's matching budget is spent. */
function appliedDecls(index: StyleIndex, el: Element, page: { steps: number }): AppliedDecl[] {
  const applied: AppliedDecl[] = [];
  for (const list of candidateLists(index, el)) {
    for (const rule of list) {
      const match = matchRule(rule, el, page);
      if (match === false) continue;
      let may: UnknownReason | null;
      if (match !== true) may = match;
      else if (rule.approx) may = rule.approx;
      else if (rule.condition !== "always") may = "conditional";
      // Certain to match, but where it ranks in the cascade is not known, so it
      // may or may not win.
      else if (rule.decls[0]?.specificity === null) may = "selector";
      else may = null;
      const variant = match === true && rule.condition === "variant";
      for (const decl of rule.decls) applied.push({ decl, may, variant });
    }
  }

  const inline = getAttrCI(el, "style");
  if (inline) {
    let order = 0;
    for (const d of hidingDeclarations(inline)) {
      applied.push({
        decl: { ...d, origin: "inline", specificity: [0, 0, 0], order: order++ },
        may: null,
        variant: false,
      });
    }
  }
  return applied;
}

// ── Resolution ──────────────────────────────────────────────────────────────

interface VisibilityState {
  hidden: boolean;
  unknown: UnknownReason | null;
}

interface ChainState {
  /** An ancestor-or-self is removed from rendering: nothing below can come back. */
  removed: boolean;
  /** `removed` rests on markup alone (aria-hidden, template), not on CSS. */
  removedByMarkup: boolean;
  /** An ancestor-or-self may or may not be `display: none`. */
  displayUnknown: UnknownReason | null;
  visibility: VisibilityState;
}

const ROOT_STATE: ChainState = {
  removed: false,
  removedByMarkup: false,
  displayUnknown: null,
  visibility: { hidden: false, unknown: null },
};

/** The user-agent stylesheet hides these: `[hidden]`, `dialog:not([open])`, `[popover]`. */
function uaHidden(el: Element): boolean {
  const hidden = getAttrCI(el, "hidden");
  // Keyword match without trimming: " until-found " is not the keyword.
  if (hidden !== null && hidden.toLowerCase() !== "until-found") return true;
  if (tagOf(el) === "dialog" && !hasAttrCI(el, "open")) return true;
  return hasAttrCI(el, "popover");
}

/** Whether a declaration that may apply could beat the certain winner. */
function mayBeat(decl: Decl, winner: Decl | null): boolean {
  return winner === null || outranks(decl, winner) !== false;
}

function resolveDisplay(
  applied: AppliedDecl[],
  ua: boolean,
): { none: boolean; unknown: UnknownReason | null } {
  const certain: Decl[] = ua ? [UA_DISPLAY_NONE] : [];
  for (const a of applied) {
    if (a.decl.prop === "display" && a.may === null && displayKind(a.decl.value, ua) !== null) {
      certain.push(a.decl);
    }
  }
  const winner = cascadeWinner(certain);
  const kind = winner ? displayKind(winner.value, ua) : "shown";
  const none = kind === "none";
  let unknown: UnknownReason | null = kind === "unknown" ? "value" : null;

  for (const a of applied) {
    if (a.decl.prop !== "display" || a.may === null || !mayBeat(a.decl, winner)) continue;
    const mayKind = displayKind(a.decl.value, ua);
    if (mayKind === null) continue;
    if (mayKind === "unknown") {
      unknown ??= a.may;
      continue;
    }
    const mayNone = mayKind === "none";
    if (mayNone === none) continue;
    // Hidden only under a media query: shown wherever the query does not match.
    if (mayNone && a.variant) continue;
    unknown ??= a.may;
  }
  return { none, unknown };
}

function resolveVisibility(applied: AppliedDecl[], parent: VisibilityState): VisibilityState {
  const certain: Decl[] = [];
  for (const a of applied) {
    if (a.decl.prop === "visibility" && a.may === null && visibilityKind(a.decl.value) !== null) {
      certain.push(a.decl);
    }
  }
  const winner = cascadeWinner(certain);
  const kind = winner ? visibilityKind(winner.value) : "inherit";
  let state: VisibilityState;
  if (kind === "inherit") state = { ...parent };
  else if (kind === "unknown") state = { hidden: false, unknown: "value" };
  else state = { hidden: kind === "hidden", unknown: null };

  for (const a of applied) {
    if (a.decl.prop !== "visibility" || a.may === null || !mayBeat(a.decl, winner)) continue;
    const mayKind = visibilityKind(a.decl.value);
    if (mayKind === null) continue;
    if (mayKind === "unknown") {
      state.unknown ??= a.may;
      continue;
    }
    // Inheriting from a parent that is itself unsettled leaves this unsettled too.
    if (mayKind === "inherit" && parent.unknown !== null) {
      state.unknown ??= parent.unknown;
      continue;
    }
    const mayHidden = mayKind === "inherit" ? parent.hidden : mayKind === "hidden";
    if (mayHidden === state.hidden) continue;
    if (mayHidden && a.variant) continue;
    state.unknown ??= a.may;
  }
  return state;
}

/**
 * A per-page resolver. The style index is built on the first call, so a page
 * whose rules never ask pays nothing, and results are memoised per element, so
 * the ancestors that controls share are resolved once.
 */
export function createStaticVisibility(
  doc: Document,
  options: StaticVisibilityOptions,
): StaticVisibilityResolver {
  let index: StyleIndex | null = null;
  const states = new Map<Element, ChainState>();
  const page = { steps: PAGE_STEP_BUDGET };

  const ownState = (el: Element, parent: ChainState): ChainState => {
    if (parent.removed) return parent;
    const markupHidden =
      tagOf(el) === "template" ||
      (options.ariaHidden && getAttrCI(el, "aria-hidden")?.toLowerCase() === "true");
    if (markupHidden) return { ...parent, removed: true, removedByMarkup: true };

    index ??= buildStyleIndex(doc);
    let applied: AppliedDecl[];
    try {
      if (page.steps <= 0) throw new PageBudgetError();
      applied = appliedDecls(index, el, page);
    } catch (err) {
      if (!(err instanceof PageBudgetError)) throw err;
      // This element's own rules were never read: neither its display nor its
      // visibility is settled.
      return {
        ...parent,
        displayUnknown: parent.displayUnknown ?? "truncated",
        visibility: { ...parent.visibility, unknown: parent.visibility.unknown ?? "truncated" },
      };
    }
    const display = resolveDisplay(applied, uaHidden(el));
    if (display.none && display.unknown === null) {
      return { ...parent, removed: true, removedByMarkup: false };
    }
    return {
      removed: false,
      removedByMarkup: false,
      displayUnknown: parent.displayUnknown ?? display.unknown,
      visibility: resolveVisibility(applied, parent.visibility),
    };
  };

  const stateOf = (el: Element): ChainState => {
    // Walk up to the nearest resolved ancestor, then resolve back down, so a
    // deep tree never recurses.
    const chain: Element[] = [];
    let node: Element | null = el;
    while (node && !states.has(node)) {
      chain.push(node);
      node = node.parentElement;
    }
    let state = node ? (states.get(node) as ChainState) : ROOT_STATE;
    for (let i = chain.length - 1; i >= 0; i--) {
      state = ownState(chain[i], state);
      states.set(chain[i], state);
    }
    return state;
  };

  return {
    visibility(el: Element): StaticVisibility {
      const state = stateOf(el);
      if (state.removedByMarkup) return HIDDEN;
      if (index?.unsettled) return { state: "unknown", reason: index.unsettled };
      if (state.removed) return HIDDEN;
      if (state.visibility.hidden && state.visibility.unknown === null) return HIDDEN;
      const reason = state.displayUnknown ?? state.visibility.unknown;
      return reason ? { state: "unknown", reason } : SHOWN;
    },
  };
}
