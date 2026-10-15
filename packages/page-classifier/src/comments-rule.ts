// A deterministic comment-section detector.
//
// On linking pages the section head misses almost every comment thread. Two
// reasons: per-comment nodes are cut by the 400-candidate cap on big threads,
// and the comment-list node it does rank first rarely clears the strict 0.96
// threshold. Comment threads are almost always CMS-built and say so in their
// markup, so this rule reads that markup instead.
//
// An element is a comment section when its id or one of its class tokens:
//   1. holds a comment word: `comment` or `comments`, alone or fused with
//      list/box/area/wrap/block/section/thread/form (`commentlist`, `comments-area`,
//      `li-comment-12`, `ast-comment-list`, `wp-block-post-comments`), or is
//      WordPress's reply-form id `respond` or Disqus's `disqus_thread`; and
//   2. holds no stop word (`comments-link`, `comment-count`, `recent-comments`,
//      `has-comments`, `post-meta-comments`: links TO comments, widgets, flags).
// A match that contains the page's <h1> is a page wrapper, not a thread, and is
// refused. A thread inside a reviews container (WooCommerce stores product
// reviews as comments) is `reviews`. Policy: `comments` is the discussion
// thread under the content, or its reply form.
//
// `classifyDocument` (predict.ts) runs this on every page and it wins over the
// section head; `elementPlacer` (placement.ts) applies it per element. Each
// makes its own `commentRule()` pass, so an edit to the page between calls is
// always seen.

type El = Element & { parentElement: El | null };

export type CommentSection = "comments" | "reviews";

export interface CommentMatch {
  label: CommentSection;
  /** The nearest matching ancestor-or-self. */
  container: Element;
  /** Steps from the start element up to `container` (0 = itself). */
  hops: number;
  /** The id or class token that matched, lowercased, digits folded to N. */
  token: string;
}

const COMMENT_WORD = /^comments?(?:list|box|area|wrap|block|section|thread|form)?$/;
const WHOLE_IDS = new Set(["respond", "disqus_thread"]);
const STOP = new Set([
  "count",
  "counts",
  "counter",
  "link",
  "links",
  "number",
  "num",
  "icon",
  "icons",
  "btn",
  "button",
  "toggle",
  "bubble",
  "total",
  "meta",
  "recent",
  "latest",
  "popular",
  "top",
  "widget",
  "no",
  "has",
  "open",
  "closed",
  "disabled",
  "off",
  "rss",
  "feed",
]);
const REVIEW_WORD = /^(?:product)?reviews?$/;

function words(token: string): string[] {
  return token.split(/[-_]+/).filter(Boolean);
}

/** Does one id or class token name a comment section? Exported for tests. */
export function isCommentToken(token: string, kind: "id" | "class"): boolean {
  const t = token.toLowerCase();
  if (kind === "id" && WHOLE_IDS.has(t)) return true;
  const ws = words(t);
  return ws.some((w) => COMMENT_WORD.test(w)) && !ws.some((w) => STOP.has(w));
}

function isReviewToken(token: string): boolean {
  const ws = words(token.toLowerCase());
  return ws.some((w) => REVIEW_WORD.test(w)) && !ws.some((w) => STOP.has(w));
}

// Every token isCommentToken accepts holds "comment", bar the WHOLE_IDS, so an
// id or class list without it is skipped before it is split.
const MAY_HOLD = /comment/i;

/** The first comment-section token among an id and a class list (id first),
 *  or undefined. */
function commentToken(id: string | null, cls: string | null): [string, "id" | "class"] | undefined {
  const idMay = id !== null && (MAY_HOLD.test(id) || WHOLE_IDS.has(id.trim().toLowerCase()));
  if (!idMay && (cls === null || !MAY_HOLD.test(cls))) return undefined;
  return tokensFrom(id, cls).find(([token, kind]) => isCommentToken(token, kind));
}

function tokensFrom(id: string | null, cls: string | null): Array<[string, "id" | "class"]> {
  const out: Array<[string, "id" | "class"]> = [];
  if (id) out.push([id.trim(), "id"]);
  if (cls) for (const c of cls.split(/\s+/)) if (c) out.push([c, "class"]);
  return out;
}

const tokensOf = (el: El) => tokensFrom(el.getAttribute("id"), el.getAttribute("class"));

const fold = (token: string) => token.toLowerCase().replace(/\d+/g, "N").slice(0, 60);

/** The id and class values and subtree sizes of `elements`, by position, as
 *  the featurizer's walk recorded them (FeaturizeOptions.attributesOut). */
export interface ElementAttributes {
  idAttr: ArrayLike<string | null>;
  classAttr: ArrayLike<string | null>;
  subtreeSize: ArrayLike<number>;
}

export interface CommentRule {
  /** The comment section `start` sits in (itself or an ancestor), or null. */
  sectionOf(start: Element): CommentMatch | null;
  /**
   * The outermost comment sections among `elements`, which must be in
   * document order (the featurizer's walk, or a querySelectorAll result):
   * each one's position in `elements` and its match. A nested match inside
   * one is the same thread. With `attributes`, the scan reads no attribute
   * itself and jumps past each section it accepts: a big thread holds tens of
   * thousands of comment-classed elements, and checking each cost ~200 ms on
   * the worst probe pages.
   */
  outermost(
    elements: ArrayLike<unknown>,
    attributes?: ElementAttributes,
  ): Array<{ index: number; match: CommentMatch }>;
}

/**
 * One pass of the rule over a page that does not change meanwhile. The h1 and
 * reviews lookups are memoized per element for the life of the pass, so make
 * one per classification or per placer, never one kept across edits to the
 * page.
 */
export function commentRule(): CommentRule {
  return makeRule(true);
}

function makeRule(indexH1s: boolean): CommentRule {
  // One h1 lookup per container, however many links share it. A pass asks
  // whether one of the page's few <h1>s sits under `el` (a walk up from each),
  // not querySelector over the subtree: nested replies made that a scan of
  // most of a big thread per candidate node (~80 ms on the worst probe page).
  // The h1s are gathered per root, so a detached subtree finds its own. A
  // one-off lookup skips the page-wide gather and queries the subtree.
  const holdsH1 = new Map<object, boolean>();
  const h1sOfRoot = new Map<object, Element[]>();
  const containsH1 = (el: El): boolean => {
    let known = holdsH1.get(el);
    if (known === undefined && !indexH1s) {
      known = el.querySelector("h1") !== null;
      holdsH1.set(el, known);
    }
    if (known === undefined) {
      let root: El = el;
      while (root.parentElement) root = root.parentElement;
      let h1s = h1sOfRoot.get(root);
      if (!h1s) {
        h1s = Array.from(root.querySelectorAll("h1"));
        h1sOfRoot.set(root, h1s);
      }
      // Descendants only, as querySelector: an <h1 class="comments-title"> is
      // the thread's own heading, not a page title it wraps.
      known = h1s.some((h1) => h1 !== el && el.contains(h1));
      holdsH1.set(el, known);
    }
    return known;
  };

  // Whether an element, or an ancestor below <body>, carries a reviews token.
  // Once per element: every node of a big thread shares the walk up.
  const underReviews = new Map<object, boolean>();
  const inReviews = (start: El): boolean => {
    const path: El[] = [];
    let answer = false;
    for (let el: El | null = start; el && el.localName !== "body"; el = el.parentElement) {
      const known = underReviews.get(el);
      if (known !== undefined) {
        answer = known;
        break;
      }
      path.push(el);
      if (tokensOf(el).some(([token]) => isReviewToken(token))) {
        answer = true;
        break;
      }
    }
    for (const el of path) underReviews.set(el, answer);
    return answer;
  };

  const sectionOf = (start: Element): CommentMatch | null => {
    let hops = 0;
    for (let el: El | null = start as El; el; el = el.parentElement, hops++) {
      const tag = el.localName;
      if (tag === "body" || tag === "html") return null;
      const hit = commentToken(el.getAttribute("id"), el.getAttribute("class"));
      if (!hit) continue;
      // A wrapper that holds the page title holds the article too: no ancestor
      // above it can be a thread either.
      if (containsH1(el)) return null;
      const label: CommentSection = inReviews(el) ? "reviews" : "comments";
      return { label, container: el, hops, token: fold(hit[0]) };
    }
    return null;
  };

  const outermost = (
    elements: ArrayLike<unknown>,
    attributes?: ElementAttributes,
  ): Array<{ index: number; match: CommentMatch }> => {
    const out: Array<{ index: number; match: CommentMatch }> = [];
    let latest: El | null = null;
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i] as El;
      const hit = attributes
        ? commentToken(attributes.idAttr[i] ?? null, attributes.classAttr[i] ?? null)
        : commentToken(el.getAttribute("id"), el.getAttribute("class"));
      if (!hit) continue;
      // In document order a section's descendants come straight after it, so
      // only the latest section found can hold this element.
      if (latest?.contains(el)) continue;
      const match = sectionOf(el);
      if (match && match.container === el) {
        out.push({ index: i, match });
        latest = el;
        if (attributes) i += Math.max(0, (attributes.subtreeSize[i] ?? 1) - 1);
      }
    }
    return out;
  };

  return { sectionOf, outermost };
}

/** The comment section `start` sits in (itself or an ancestor), or null. A
 *  one-off lookup: for many elements of one page, share a `commentRule()`. */
export function commentSectionOf(start: Element): CommentMatch | null {
  return makeRule(false).sectionOf(start);
}

/** `CommentRule.outermost` as one pass. */
export function outermostCommentSections(
  elements: ArrayLike<unknown>,
  attributes?: ElementAttributes,
): Array<{ index: number; match: CommentMatch }> {
  return commentRule().outermost(elements, attributes);
}

/** Does the anchor carry rel="ugc" (Google's user-generated-content marker,
 *  which WordPress puts on comment author links)? */
export function hasUgcRel(anchor: Element): boolean {
  return (anchor.getAttribute("rel") ?? "").toLowerCase().split(/\s+/).includes("ugc");
}

/** Outermost comment-section containers in a parsed document, for tagging a
 *  whole page (a nested match inside one is the same thread). */
export function findCommentSections(document: unknown): Element[] {
  const doc = document as { body?: El | null };
  const body = doc.body;
  if (!body) return [];
  const all = body.querySelectorAll("[id], [class]") as ArrayLike<El>;
  return outermostCommentSections(all).map(({ match }) => match.container);
}
