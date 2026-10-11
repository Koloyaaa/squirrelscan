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

/** One `property: value` pair from a declaration block. */
export interface CssDeclaration {
  /** Lower-cased property name. */
  prop: string;
  /** Lower-cased value with any `!important` removed. */
  value: string;
  important: boolean;
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
  options: { stripComments?: boolean } = {},
): CssDeclaration[] {
  const decls: CssDeclaration[] = [];
  let i = 0;
  let chunkStart = 0;
  let depth = 0;

  const flush = (end: number): void => {
    let chunk = css.slice(chunkStart, end);
    // Off by default: content/hidden-text has always read the raw chunk.
    if (options.stripComments && chunk.includes("/*")) {
      chunk = chunk.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, "");
    }
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
    const prop = chunk.slice(0, colon).trim().toLowerCase();
    if (!prop) return;
    const raw = chunk.slice(colon + 1);
    const value = raw
      .replace(/!\s*important/gi, "")
      .trim()
      .toLowerCase();
    if (!value) return;
    decls.push({ prop, value, important: /!\s*important/i.test(raw) });
  };

  while (i < css.length) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      i = skipString(css, i);
      continue;
    }
    if (ch === "/" && css[i + 1] === "*") {
      i = skipComment(css, i);
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
   * may not apply — `@media print { .no-print { display:none } }` hides
   * nothing on screen — so content/hidden-text never applies it, and marks the
   * selectors it names untrustworthy instead.
   */
  conditional: boolean;
  /** Preludes of the enclosing at-rules (`@media (max-width: 600px)`), outermost first. */
  atRules: string[];
}

/**
 * A single linear pass over a stylesheet. Deliberately hand-written: the regex
 * form (`/([^{}]+)\{([^{}]*)\}/g` over comment-stripped text) backtracks
 * quadratically, and a page carrying 200KB of brace-less or unterminated-comment
 * CSS took 26 seconds to index — a crawler-wide stall on attacker-supplied
 * input. This scanner is O(n) and allocates only the rules it yields.
 */
export function parseRules(css: string, maxRules: number): RawRule[] {
  const rules: RawRule[] = [];
  let i = 0;
  let preludeStart = 0;
  const atRules: string[] = [];

  while (i < css.length && rules.length < maxRules) {
    const ch = css[i];

    if (ch === "/" && css[i + 1] === "*") {
      i = skipComment(css, i);
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipString(css, i);
      continue;
    }
    // A statement at-rule (`@import url(…);`) or a stray semicolon: whatever
    // came before it was not a selector.
    if (ch === ";") {
      i++;
      preludeStart = i;
      continue;
    }
    if (ch === "}") {
      atRules.pop();
      i++;
      preludeStart = i;
      continue;
    }
    if (ch !== "{") {
      i++;
      continue;
    }

    const prelude = css.slice(preludeStart, i).trim();
    // `@media`, `@supports`, `@layer`, `@keyframes`: descend, marking everything
    // inside as conditional rather than skipping past it.
    if (prelude.startsWith("@")) {
      atRules.push(prelude);
      i++;
      preludeStart = i;
      continue;
    }

    // A style rule. Consume its whole block, including any nested braces, so a
    // malformed sheet cannot desynchronise the scan.
    const bodyStart = i + 1;
    let depth = 1;
    let j = bodyStart;
    while (j < css.length && depth > 0) {
      const c = css[j];
      if (c === "/" && css[j + 1] === "*") {
        j = skipComment(css, j);
        continue;
      }
      if (c === '"' || c === "'") {
        j = skipString(css, j);
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      j++;
    }
    rules.push({
      selector: prelude,
      body: css.slice(bodyStart, depth === 0 ? j - 1 : css.length),
      conditional: atRules.length > 0,
      atRules: [...atRules],
    });
    i = j;
    preludeStart = i;
  }

  return rules;
}
