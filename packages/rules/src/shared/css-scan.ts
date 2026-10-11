// Linear-time scanning of CSS text: the declaration and rule scanners behind
// content/hidden-text and the static visibility checks in ./static-hidden.
// Hand-written rather than regex-based, because a backtracking regex over
// attacker-supplied stylesheet text stalls the crawl (see parseRules).

/**
 * Index just past a quoted string that starts at `start`. Used by every scanner
 * below so that punctuation inside a quoted value or a `data:` URL cannot be
 * mistaken for structure.
 */
export function skipString(css: string, start: number): number {
  const quote = css[start];
  let i = start + 1;
  while (i < css.length) {
    if (css[i] === "\\") {
      i += 2;
      continue;
    }
    if (css[i] === quote) return i + 1;
    i++;
  }
  return css.length;
}

/** Index just past a CSS comment starting at `start`, or end of input. */
function skipComment(css: string, start: number): number {
  const end = css.indexOf("*/", start + 2);
  return end === -1 ? css.length : end + 2;
}

/** A character that continues a CSS name: `myurl(` is not `url(`. */
function isNameChar(ch: string | undefined): boolean {
  return ch !== undefined && (/[-_a-zA-Z0-9\\]/.test(ch) || ch.charCodeAt(0) >= 0x80);
}

/**
 * Index just past an unquoted `url(…)` starting at `start`, or -1 when none
 * starts there. A browser reads it as one token up to `)`, so the `{`, `}` and
 * `;` inside (`url(}.b{x)`) are never structure. `url("…")` is an ordinary
 * function holding a string, and returns -1.
 */
function skipUnquotedUrl(css: string, start: number): number {
  if (css[start + 3] !== "(" || css.slice(start, start + 3).toLowerCase() !== "url") return -1;
  if (isNameChar(css[start - 1])) return -1;
  let i = start + 4;
  while (i < css.length && /[\t\n\f\r ]/.test(css[i])) i++;
  if (css[i] === '"' || css[i] === "'") return -1;
  while (i < css.length) {
    if (css[i] === "\\") {
      i += 2;
      continue;
    }
    if (css[i] === ")") return i + 1;
    i++;
  }
  return css.length;
}

/**
 * Tracks the `(`, `[` and `{` blocks a browser opens inside a stretch of CSS.
 * Only the closer a block expects ends it; any other closer is plain text, so
 * `(}` keeps the `}` inside the parentheses. Returns the index to continue at,
 * after the character (or unquoted `url(…)` token) at `i`.
 */
function stepBlocks(css: string, i: number, closers: string[]): number {
  const ch = css[i];
  if (ch === "u" || ch === "U") {
    const end = skipUnquotedUrl(css, i);
    if (end !== -1) return end;
  }
  if (ch === "(") closers.push(")");
  else if (ch === "[") closers.push("]");
  else if (ch === "{") closers.push("}");
  else if (ch === closers[closers.length - 1]) closers.pop();
  return i + 1;
}

/**
 * `text` with every comment replaced by `replacement`, in one linear pass with
 * no regex; an unterminated comment runs to the end of the text.
 */
export function replaceComments(text: string, replacement: string): string {
  let at = text.indexOf("/*");
  if (at === -1) return text;
  let out = "";
  let from = 0;
  while (at !== -1) {
    out += text.slice(from, at) + replacement;
    const close = text.indexOf("*/", at + 2);
    if (close === -1) return out;
    from = close + 2;
    at = text.indexOf("/*", from);
  }
  return out + text.slice(from);
}

/** One `property: value` pair from a declaration block. */
export interface CssDeclaration {
  /** Lower-cased property name. */
  prop: string;
  /** Lower-cased value with any `!important` removed. */
  value: string;
  important: boolean;
  /**
   * The property and value as written (comments replaced when asked), for a
   * reader that must match a browser exactly: `trim()` and `toLowerCase()`
   * above are Unicode-aware, CSS whitespace and keywords are ASCII only.
   */
  rawProp: string;
  rawValue: string;
}

/**
 * Scans a declaration block (`color:red;display:none`) into its declarations,
 * in source order. Splits on the structural `;` and `:` only:
 * `background:url("data:…;base64,…")` carries both inside a quoted string and a
 * `url()`, and naive splitting there manufactures declarations that were never
 * written.
 */
export function scanDeclarations(
  css: string,
  options: { strict?: boolean } = {},
): CssDeclaration[] {
  const decls: CssDeclaration[] = [];
  let i = 0;
  let chunkStart = 0;
  let depth = 0;
  const closers: string[] = [];

  const flush = (end: number): void => {
    let chunk = css.slice(chunkStart, end);
    // Off by default: content/hidden-text has always read the raw chunk. A
    // comment separates tokens, so it becomes a space: `n/**/one` is not `none`.
    if (options.strict) chunk = replaceComments(chunk, " ");
    let colon = -1;
    let d = 0;
    for (let k = 0; k < chunk.length; k++) {
      const c = chunk[k];
      if (c === "(") d++;
      else if (c === ")") d--;
      else if (c === ":" && d === 0) {
        colon = k;
        break;
      }
    }
    if (colon === -1) return;
    const rawProp = chunk.slice(0, colon);
    const prop = rawProp.trim().toLowerCase();
    if (!prop) return;
    const raw = chunk.slice(colon + 1);
    const value = raw
      .replace(/!\s*important/gi, "")
      .trim()
      .toLowerCase();
    if (!value) return;
    decls.push({ prop, value, important: /!\s*important/i.test(raw), rawProp, rawValue: raw });
  };

  while (i < css.length) {
    const ch = css[i];
    // With strict, an escaped character (`\;`, `\)`) is part of a token, never
    // structure, as in a browser.
    if (ch === "\\" && options.strict) {
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipString(css, i);
      continue;
    }
    if (ch === "/" && css[i + 1] === "*") {
      i = skipComment(css, i);
      continue;
    }
    if (options.strict) {
      // A `;` ends a declaration only outside every block and url() token.
      if (ch === ";" && closers.length === 0) {
        flush(i);
        chunkStart = i + 1;
        i++;
      } else {
        i = stepBlocks(css, i, closers);
      }
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === ";" && depth === 0) {
      flush(i);
      chunkStart = i + 1;
    }
    i++;
  }
  flush(css.length);
  return decls;
}

/** A declaration block as a property map, the last declaration of a property winning. */
export function parseDeclarations(css: string): Map<string, string> {
  const decls = new Map<string, string>();
  for (const { prop, value } of scanDeclarations(css)) decls.set(prop, value);
  return decls;
}

/** One style rule lifted out of a sheet, with the at-rules that enclose it. */
export interface RawRule {
  selector: string;
  body: string;
  /**
   * The rule sits inside `@media`/`@supports`/`@layer`/`@keyframes`. Such a rule
   * may not apply (`@media print { .no-print { display:none } }` hides nothing
   * on screen), so content/hidden-text never applies it, and marks the
   * selectors it names untrustworthy instead.
   */
  conditional: boolean;
  /**
   * Preludes of the enclosing at-rules (`@media (max-width: 600px)`), outermost
   * first, at most MAX_RECORDED_AT_RULES of them. Rules sharing one nesting
   * state share the array.
   */
  atRules: readonly string[];
  /** How many at-rules enclose the rule; more than `atRules` holds when nesting runs deeper. */
  atDepth: number;
}

/** Enclosing at-rules recorded per rule; deeper nesting is only counted. */
export const MAX_RECORDED_AT_RULES = 8;

/**
 * A single linear pass over a stylesheet. Deliberately hand-written: the regex
 * form (`/([^{}]+)\{([^{}]*)\}/g` over comment-stripped text) backtracks
 * quadratically, and a page carrying 200KB of brace-less or unterminated-comment
 * CSS took 26 seconds to index — a crawler-wide stall on attacker-supplied
 * input. This scanner is O(n) and allocates only the rules it yields.
 */
export function parseRules(
  css: string,
  maxRules: number,
  options: { strictPreludes?: boolean } = {},
): RawRule[] {
  const rules: RawRule[] = [];
  let i = 0;
  let preludeStart = 0;
  // Blocks open in the current prelude. With strictPreludes, a `{`, `}` or `;`
  // inside one (`@supports (not (display:flex;gap:1em))`, `.x(}`) or inside an
  // unquoted url() is not structure, as in a browser.
  const closers: string[] = [];
  // Whether the current prelude opens with `@`, read at its first character
  // that is not whitespace or a comment, so no prelude is ever re-scanned.
  let preludeKind: "" | "at" | "other" = "";
  const atRules: string[] = [];
  // Copied once per nesting state, not once per rule: a deep stack of at-rules
  // around thousands of rules would otherwise copy the stack for each.
  let snapshot: readonly string[] | null = null;

  while (i < css.length && rules.length < maxRules) {
    const ch = css[i];

    if (ch === "/" && css[i + 1] === "*") {
      i = skipComment(css, i);
      continue;
    }
    if (preludeKind === "" && !/[\t\n\f\r ]/.test(ch)) preludeKind = ch === "@" ? "at" : "other";
    // With strictPreludes, an escaped character (`.a\}b`, `content:\}`) is part
    // of a token, never structure.
    if (ch === "\\" && options.strictPreludes) {
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipString(css, i);
      continue;
    }
    if (
      options.strictPreludes &&
      (closers.length > 0 || ch === "(" || ch === "[" || ch === "u" || ch === "U")
    ) {
      i = stepBlocks(css, i, closers);
      continue;
    }
    // A statement at-rule (`@import url(…);`) or a stray semicolon: whatever
    // came before it was not a selector. With strictPreludes, a `;` that ends
    // no at-rule stays in the next rule's prelude, as in a browser, where it
    // makes the selector invalid and drops the rule (`; .b { … }`).
    if (ch === ";") {
      i++;
      if (!options.strictPreludes || preludeKind === "at") {
        preludeStart = i;
        preludeKind = "";
      }
      continue;
    }
    if (ch === "}") {
      i++;
      if (atRules.length > 0) {
        atRules.pop();
        snapshot = null;
      } else if (options.strictPreludes) {
        // A stray `}` outside any block likewise stays in the next prelude.
        continue;
      }
      preludeStart = i;
      preludeKind = "";
      continue;
    }
    if (ch !== "{") {
      i++;
      continue;
    }
    preludeKind = "";

    const prelude = css.slice(preludeStart, i).trim();
    // Off by default: content/hidden-text has always read the raw prelude. A
    // comment before an at-rule (`/*!sc*/@media …`) otherwise hides the `@`.
    // Only the at-rule test reads past comments; a selector keeps them.
    const atPrelude = options.strictPreludes ? replaceComments(prelude, " ").trim() : prelude;
    // `@media`, `@supports`, `@layer`, `@keyframes`: descend, marking everything
    // inside as conditional rather than skipping past it.
    if (atPrelude.startsWith("@")) {
      atRules.push(atPrelude);
      snapshot = null;
      i++;
      preludeStart = i;
      continue;
    }

    // A style rule. Consume its whole block, including any nested braces, so a
    // malformed sheet cannot desynchronise the scan.
    const bodyStart = i + 1;
    let depth = 1;
    let j = bodyStart;
    // With strictPreludes the body ends at the `}` that matches, read through
    // blocks and url() tokens the way a browser reads them.
    const bodyClosers = ["}"];
    while (j < css.length && depth > 0) {
      const c = css[j];
      if (c === "\\" && options.strictPreludes) {
        j += 2;
        continue;
      }
      if (c === "/" && css[j + 1] === "*") {
        j = skipComment(css, j);
        continue;
      }
      if (c === '"' || c === "'") {
        j = skipString(css, j);
        continue;
      }
      if (options.strictPreludes) {
        j = stepBlocks(css, j, bodyClosers);
        depth = bodyClosers.length;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      j++;
    }
    snapshot ??= atRules.slice(0, MAX_RECORDED_AT_RULES);
    rules.push({
      selector: prelude,
      body: css.slice(bodyStart, depth === 0 ? j - 1 : css.length),
      conditional: atRules.length > 0,
      atRules: snapshot,
      atDepth: atRules.length,
    });
    i = j;
    preludeStart = i;
  }

  return rules;
}
