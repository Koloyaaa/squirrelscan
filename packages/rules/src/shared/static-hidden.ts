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

import { parseRules, scanDeclarations, skipString } from "./css-scan";

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
  | { kind: "unknown"; reason: UnknownReason };

interface Compound {
  /** Lower-cased type selector, or null for `*` or none. */
  tag: string | null;
  ids: string[];
  classes: string[];
  attrs: AttrTest[];
  pseudos: PseudoTest[];
  specificity: Specificity;
}

type Combinator = " " | ">" | "+" | "~";

interface ComplexSelector {
  compounds: Compound[];
  /** combinators[i] joins compounds[i] and compounds[i + 1]. */
  combinators: Combinator[];
  specificity: Specificity;
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

const CSS_WHITESPACE = /[\t\n\f\r ]/;
const IDENT_CHAR = /[-_a-zA-Z0-9]/;

class SelectorSyntaxError extends Error {}

/** Returned for a selector whose subject is a pseudo-element: it styles a generated box, not the element. */
const PSEUDO_ELEMENT = Symbol("pseudo-element");

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

/** Splits on top-level commas: `:is(.a, .b), .c` is two selectors. */
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
  return parts.map((p) => p.trim()).filter(Boolean);
}

function parseAttr(body: string): AttrTest {
  const m =
    /^\s*([-_a-zA-Z0-9]+)\s*(?:([~|^$*]?=)\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s"']+))\s*([iIsS])?\s*)?$/.exec(
      body,
    );
  if (!m) throw new SelectorSyntaxError();
  const value = (m[3] ?? m[4] ?? m[5] ?? "").replace(/\\(.)/g, "$1");
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

function addSpecificity(a: Specificity, b: Specificity): Specificity {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function maxSpecificity(list: Compound[]): Specificity {
  let best: Specificity = [0, 0, 0];
  for (const c of list) if (compareSpecificity(c.specificity, best) > 0) best = c.specificity;
  return best;
}

function compareSpecificity(a: Specificity, b: Specificity): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Parses `:not(.a, [b])`-style arguments: a list of compounds, no combinators. */
function parseCompoundList(text: string): Compound[] | null {
  const out: Compound[] = [];
  for (const part of splitSelectorList(text)) {
    const parsed = parseComplex(part);
    if (parsed === PSEUDO_ELEMENT || parsed.compounds.length !== 1) return null;
    out.push(parsed.compounds[0]);
  }
  return out.length > 0 ? out : null;
}

function parsePseudo(name: string, args: string | null): PseudoTest {
  const lower = name.toLowerCase();
  if (args !== null) {
    if (lower === "not" || lower === "is" || lower === "where" || lower === "matches") {
      const list = parseCompoundList(args);
      if (!list) return { kind: "unknown", reason: "selector" };
      // :where() contributes no specificity; parsePseudo's caller handles that.
      return { kind: lower === "not" ? "not" : "is", args: list };
    }
    return { kind: "unknown", reason: "selector" };
  }
  if (lower === "root" || lower === "first-child" || lower === "last-child") return { kind: lower };
  if (lower === "only-child" || lower === "defined") return { kind: lower };
  return { kind: "unknown", reason: INTERACTION_PSEUDOS.has(lower) ? "interactive" : "selector" };
}

/**
 * Parses one complex selector (`.nav > li:hover .sub`). Returns PSEUDO_ELEMENT
 * for a selector whose subject is a pseudo-element, and throws on syntax this
 * module does not read (namespaces, nesting).
 */
function parseComplex(text: string): ComplexSelector | typeof PSEUDO_ELEMENT {
  const s = text.trim();
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
      if (s[i + 1] === ":") return PSEUDO_ELEMENT;
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
      const pseudo = parsePseudo(name, args);
      current.pseudos.push(pseudo);
      const spec: Specificity =
        name === "where"
          ? [0, 0, 0]
          : pseudo.kind === "not" || pseudo.kind === "is"
            ? maxSpecificity(pseudo.args)
            : [0, 1, 0];
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
  let specificity: Specificity = [0, 0, 0];
  for (const compound of compounds) specificity = addSpecificity(specificity, compound.specificity);
  return { compounds, combinators, specificity };
}

/**
 * The element-level requirements of a selector this module could not parse,
 * read loosely from its last compound: a superset match, used only to decide
 * whether the rule MAY apply.
 */
function looseSubject(text: string): Compound {
  let flat = "";
  let depth = 0;
  for (const c of text) {
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0) flat += c;
  }
  const pieces = flat.split(/[\s>+~]+/).filter(Boolean);
  const last = pieces[pieces.length - 1] ?? "";
  const compound = emptyCompound();
  for (const m of last.matchAll(/([.#])((?:\\.|[-_a-zA-Z0-9\u0080-￿])+)/g)) {
    const name = m[2].replace(/\\(.)/g, "$1");
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

function matchPseudo(el: Element, pseudo: PseudoTest): Match {
  switch (pseudo.kind) {
    case "not": {
      let result: Match = true;
      for (const arg of pseudo.args) {
        const m = matchCompound(el, arg);
        if (m === true) return false;
        if (m !== false) result = m;
      }
      return result;
    }
    case "is": {
      let result: Match = false;
      for (const arg of pseudo.args) {
        const m = matchCompound(el, arg);
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

function matchCompound(el: Element, compound: Compound): Match {
  const facts = factsOf(el);
  if (compound.tag !== null && facts.tag !== compound.tag) return false;
  for (const id of compound.ids) if (facts.id !== id) return false;
  for (const cls of compound.classes) if (!facts.classes.has(cls)) return false;
  for (const attr of compound.attrs) if (!matchAttr(el, attr)) return false;
  let result: Match = true;
  for (const pseudo of compound.pseudos) {
    result = and(result, matchPseudo(el, pseudo));
    if (result === false) return false;
  }
  return result;
}

class MatchBudgetError extends Error {}

/** Thrown when the page's whole step budget is spent. */
class PageBudgetError extends Error {}

interface StepBudget {
  /** Steps left for this one match. */
  match: number;
  /** Steps left for the page, shared by every match. */
  page: { steps: number };
}

/** Right-to-left match of compounds[0..index] ending at `el`. */
function matchFrom(sel: ComplexSelector, index: number, el: Element, budget: StepBudget): Match {
  if (--budget.page.steps < 0) throw new PageBudgetError();
  if (--budget.match < 0) throw new MatchBudgetError();
  const own = matchCompound(el, sel.compounds[index]);
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

function matchSelector(sel: ComplexSelector, el: Element, page: { steps: number }): Match {
  try {
    return matchFrom(sel, sel.compounds.length - 1, el, { match: MATCH_STEP_BUDGET, page });
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
  const queries = splitSelectorList(list.toLowerCase());
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
const KEYWORD_VALUE = /^-?[a-z][a-z-]*(?: -?[a-z][a-z-]*){0,2}$/;

/** `display` as hidden or not; null for a value a browser would drop. */
function displayKind(value: string, uaHidden: boolean): "none" | "shown" | "unknown" | null {
  if (UNREADABLE_VALUE.test(value)) return "unknown";
  const v = value.replace(/\s+/g, " ");
  if (!KEYWORD_VALUE.test(v)) return null;
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
}

interface StyleIndex {
  byId: Map<string, IndexedRule[]>;
  byClass: Map<string, IndexedRule[]>;
  byTag: Map<string, IndexedRule[]>;
  /** Keyed by lower-cased attribute name, for subjects such as `[hidden]`. */
  byAttr: Map<string, IndexedRule[]>;
  universal: IndexedRule[];
  /** The text or rule budget ran out, so rules past it were never read. */
  truncated: boolean;
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
 */
function stripComments(text: string): string {
  return text.includes("/*") ? text.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, "").trim() : text;
}

function buildStyleIndex(doc: Document): StyleIndex {
  const index: StyleIndex = {
    byId: new Map(),
    byClass: new Map(),
    byTag: new Map(),
    byAttr: new Map(),
    universal: [],
    truncated: false,
  };
  let budget = MAX_STYLE_CHARS;
  let ruleBudget = MAX_STYLE_RULES;
  let order = 0;

  for (const style of doc.querySelectorAll("style") as Iterable<Element>) {
    if (budget <= 0 || ruleBudget <= 0) break;
    const elementCondition = styleElementCondition(style);
    if (elementCondition === "never") continue;
    const text = (style.textContent || "").slice(0, budget);
    budget -= text.length;

    for (const rule of parseRules(text, ruleBudget)) {
      ruleBudget--;
      order++;
      if (!/display|visibility/i.test(rule.body)) continue;
      const condition = combineConditions([
        elementCondition,
        ...rule.atRules.map((prelude) => atRuleCondition(stripComments(prelude))),
      ]);
      if (condition === "never") continue;

      const decls: Decl[] = [];
      for (const d of scanDeclarations(rule.body)) {
        if (d.prop !== "display" && d.prop !== "visibility") continue;
        decls.push({ ...d, prop: d.prop, origin: "sheet", specificity: null, order });
      }
      if (decls.length === 0) continue;

      for (const selectorText of splitSelectorList(stripComments(rule.selector))) {
        let selector: ComplexSelector | null = null;
        let subject: Compound;
        try {
          const parsed = parseComplex(selectorText);
          if (parsed === PSEUDO_ELEMENT) continue;
          selector = parsed;
          subject = parsed.compounds[parsed.compounds.length - 1];
        } catch (err) {
          if (!(err instanceof SelectorSyntaxError)) throw err;
          subject = looseSubject(selectorText);
        }
        const specificity = selector?.specificity ?? null;
        addToIndex(index, {
          selector,
          subject,
          decls: decls.map((d) => ({ ...d, specificity })),
          condition,
        });
      }
    }
  }

  // Conservative at the boundary: a budget spent exactly to zero reads as cut.
  index.truncated = budget <= 0 || ruleBudget <= 0;
  return index;
}

/** The candidate rules for `el`: those keyed by its id, a class, its tag, an attribute, or none. */
function candidateRules(index: StyleIndex, el: Element): IndexedRule[] {
  const out: IndexedRule[] = [];
  const facts = factsOf(el);
  if (facts.id) out.push(...(index.byId.get(facts.id) ?? []));
  for (const cls of facts.classes) out.push(...(index.byClass.get(cls) ?? []));
  out.push(...(index.byTag.get(facts.tag) ?? []));
  if (index.byAttr.size > 0) {
    const names = new Set<string>();
    for (const attr of el.attributes) names.add(attr.name.toLowerCase());
    for (const name of names) out.push(...(index.byAttr.get(name) ?? []));
  }
  out.push(...index.universal);
  return out;
}

/** Throws PageBudgetError once the page's matching budget is spent. */
function appliedDecls(index: StyleIndex, el: Element, page: { steps: number }): AppliedDecl[] {
  const applied: AppliedDecl[] = [];
  for (const rule of candidateRules(index, el)) {
    // Unparsed: whether its loosely-read subject fits decides "may apply".
    const match: Match = rule.selector
      ? matchSelector(rule.selector, el, page)
      : matchCompound(el, rule.subject) === false
        ? false
        : "selector";
    if (match === false) continue;
    let may: UnknownReason | null;
    if (match !== true) may = match;
    else may = rule.condition === "always" ? null : "conditional";
    const variant = match === true && rule.condition === "variant";
    for (const decl of rule.decls) applied.push({ decl, may, variant });
  }

  const inline = getAttrCI(el, "style");
  if (inline) {
    let order = 0;
    for (const d of scanDeclarations(inline)) {
      if (d.prop !== "display" && d.prop !== "visibility") continue;
      applied.push({
        decl: { ...d, prop: d.prop, origin: "inline", specificity: [0, 0, 0], order: order++ },
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
      if (index?.truncated) return { state: "unknown", reason: "truncated" };
      if (state.removed) return HIDDEN;
      if (state.visibility.hidden && state.visibility.unknown === null) return HIDDEN;
      const reason = state.displayUnknown ?? state.visibility.unknown;
      return reason ? { state: "unknown", reason } : SHOWN;
    },
  };
}
