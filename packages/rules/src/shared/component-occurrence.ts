import {
  componentSiteOrigin,
  type ComponentOccurrence,
  type RootHint,
  type SubtreeCandidate,
} from "@squirrelscan/core-contracts";
import type { Element } from "linkedom";
import { createHash } from "node:crypto";

type RegionRole = ComponentOccurrence["region"]["role"];

/**
 * A deterministic, non-reversible display key; raw crawler text never leaves
 * the rule.
 *
 * SHA-256 truncated to its first 128 bits. An occurrence carries six of these
 * and a page of 1,000 defective links carries 1,000 occurrences, so the full
 * 64-hex digest was the single largest term in report size — halving it halves
 * the evidence payload with collision odds that stay negligible at corpus
 * scale. The prefix says what the value actually is rather than claiming a full
 * SHA-256: `s128` = SHA-256 truncated to 128 bits.
 */
export function componentHash(value: string): string {
  return `s128:${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function tag(element: Element): string {
  return element.tagName.toLowerCase();
}

/**
 * Class tokens that mark PER-PAGE interaction state rather than component
 * identity. The same nav on the same site carries `active`/`is-current` on a
 * different link on every page, so leaving them in would make each page its own
 * variant and grouping would never fire on a real site.
 */
const STATE_CLASS_TOKENS = new Set([
  "active",
  "current",
  "selected",
  "open",
  "opened",
  "expanded",
  "collapsed",
]);

/** True for `active`, `is-active`, `has-open`, `nav--current`, `menu_selected`… */
function isStateClass(token: string): boolean {
  const segments = token.toLowerCase().split(/[-_]+/).filter(Boolean);
  while (segments.length > 1 && (segments[0] === "is" || segments[0] === "has")) {
    segments.shift();
  }
  const last = segments[segments.length - 1];
  return last !== undefined && STATE_CLASS_TOKENS.has(last);
}

/**
 * Per-element memo for {@link stableAttributes}.
 *
 * It splits, filters and sorts a class list and reads six more attributes, and
 * a skeleton calls it once per node — so a block of 1,000 rows pays for the
 * same 3,000 nodes again on every element's ladder. Rules never mutate the DOM
 * they are handed, so the value cannot go stale, and the map is keyed on
 * elements from a per-run document that is released with the rule context.
 */
const stableAttributeCache = new WeakMap<Element, string>();

function stableAttributes(element: Element): string {
  const memoized = stableAttributeCache.get(element);
  if (memoized !== undefined) return memoized;
  const value = buildStableAttributes(element);
  stableAttributeCache.set(element, value);
  return value;
}

function buildStableAttributes(element: Element): string {
  const id = element.getAttribute("id");
  const role = element.getAttribute("role");
  const classes = (element.getAttribute("class") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !isStateClass(token))
    .sort()
    .map((value) => `.${value}`);
  // `aria-current`/`aria-expanded` are the ARIA spelling of the same per-page
  // state as the class tokens above, and are excluded for the same reason.
  const semantics = ["lang", "dir", "hidden", "aria-label", "aria-labelledby", "aria-hidden"]
    .map((name) => {
      const value = element.getAttribute(name);
      return value === null ? "" : `[${name}=${value}]`;
    })
    .filter(Boolean);
  // This string is only ever fed to componentHash; no raw crawled attribute
  // value is attached to report evidence.
  return [id ? `#${id}` : "", role ? `[role=${role}]` : "", ...classes, ...semantics]
    .filter(Boolean)
    .join("");
}

function isArticle(element: Element): boolean {
  return tag(element) === "article" || element.getAttribute("role") === "article";
}

function isMain(element: Element): boolean {
  return tag(element) === "main" || element.getAttribute("role") === "main";
}

function regionRole(element: Element): RegionRole | undefined {
  const name = tag(element);
  const role = element.getAttribute("role");
  if (name === "footer" || role === "contentinfo") return "footer";
  if (name === "header" || role === "banner") return "header";
  if (name === "nav" || role === "navigation") return "navigation";
  if (name === "main" || role === "main") return "main";
  return undefined;
}

/**
 * Article/main ancestry strictly BETWEEN `element` and `region`. `nestedIn`
 * below only looks ABOVE the region, so a `<footer><article><a>` reads as plain
 * site chrome and two unrelated articles' links merge into one repair target.
 */
function nestedBelowRegion(
  element: Element,
  region: Element,
): ComponentOccurrence["region"]["nestedIn"] | undefined {
  for (let current = element.parentElement; current && current !== region; current = current.parentElement) {
    if (isArticle(current)) return "article";
    if (isMain(current)) return "main";
  }
  return undefined;
}

function nestedIn(element: Element): ComponentOccurrence["region"]["nestedIn"] {
  for (let current = element.parentElement; current; current = current.parentElement) {
    if (isArticle(current)) return "article";
    if (isMain(current)) return "main";
  }
  return "none";
}

/**
 * Keep landmarks scoped to their enclosing chrome composition. A navigation
 * inside a header is not the same repair target as an otherwise identical
 * navigation inside a footer, and header siblings must not renumber footer
 * navigation slots on another layout.
 */
function semanticAncestorContext(element: Element): string {
  const roles: string[] = [];
  for (let current = element.parentElement; current; current = current.parentElement) {
    const role = regionRole(current);
    if (role) roles.push(role);
  }
  return roles.length > 0 ? roles.join(">") : "none";
}

/**
 * A structural digest of `element`'s whole subtree, hashed as it is walked.
 *
 * Replaces a 256-node skeleton STRING. The cap was there to bound the string,
 * but it also set `structure-truncated`, which made the region ungroupable —
 * and the regions it hit were the big shared ones. On one WordPress theme it
 * silenced 102 of 235 link-text occurrences, all of them the same mega menu:
 * the budget removed exactly the component the feature exists to find.
 *
 * Streaming removes the cap without ever materialising the string, so cost is
 * one O(nodes) pass. It is iterative because the walk is now unbounded and a
 * deep DOM would otherwise overflow the stack. The token sequence is identical
 * to the old skeleton's, so this is the same identity, just not truncated.
 */
function structuralDigest(element: Element): string {
  const hash = createHash("sha256");
  // A string entry is a literal token; an element entry is expanded in place.
  const stack: (Element | string)[] = [element];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (typeof current === "string") {
      hash.update(current);
      continue;
    }
    hash.update(`${tag(current)}${stableAttributes(current)}(`);
    const children = [...current.children] as Element[];
    // Pushed in reverse so the stack yields `child , child , child )`.
    stack.push(")");
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]!);
      if (index > 0) stack.push(",");
    }
  }
  return `s128:${hash.digest("hex").slice(0, 32)}`;
}

function elementPath(root: Element, element: Element, cache: ComponentOccurrenceCache): string {
  const parts: string[] = [];
  for (
    let current: Element | null = element;
    current && current !== root;
    current = current.parentElement
  ) {
    parts.push(`${tag(current)}:${cache.siblingTagIndex(current)}`);
  }
  parts.push(tag(root));
  return parts.reverse().join(">");
}

function documentRoot(element: Element): Element {
  let root = element;
  for (let current = element.parentElement; current; current = current.parentElement)
    root = current;
  return root;
}

type RegionEvidence = {
  skeleton: string;
  contentHash: string;
  slot: string;
};

/**
 * Rule-run-local DOM cache. Callers create one per run; it is never global, so
 * parsed documents are released with the rule context.
 */
export class ComponentOccurrenceCache {
  readonly regionEvidence = new WeakMap<Element, RegionEvidence>();
  readonly slots = new Map<string, WeakMap<Element, string>>();
  /** Per-parent tag positions keep repeated sibling locators linear in the DOM size. */
  readonly siblingTagPositions = new WeakMap<Element, WeakMap<Element, number>>();
  /** Direct-child tag sequence per element; rebuilt per faulty element made a
   * 5,000-link nav quadratic (each link re-walked all 5,000 siblings). */
  readonly childTagSequences = new WeakMap<Element, string>();
  /** Ancestor skeletons and text lengths for the subtree ladder. Every faulty
   * element in one block walks the SAME ancestors, so without this the ladder
   * would re-skeletonize each shared ancestor once per element. */
  readonly subtreeSignatures = new WeakMap<Element, string>();
  readonly textLengths = new WeakMap<Element, number>();
  /** Skeleton string -> digest; bounded by the page's distinct subtree shapes. */
  readonly signatureBySkeleton = new Map<string, string>();
  /** Hints are per ancestor and every element in a block walks the same ones. */
  readonly rootHints = new WeakMap<Element, RootHint | null>();

  rootHint(element: Element): RootHint | undefined {
    const cached = this.rootHints.get(element);
    if (cached !== undefined) return cached ?? undefined;
    const value = rootHint(element) ?? null;
    this.rootHints.set(element, value);
    return value ?? undefined;
  }
  subtreeSignatureBuilds = 0;

  /**
   * Structurally identical siblings produce the SAME skeleton string, so the
   * digest is memoised by that string as well as by element. A page of 1,000
   * identical rows hashes once instead of a thousand times, which is most of
   * the ladder's cost on a page that has a thousand defects in one block.
   */
  subtreeSignature(element: Element): string {
    const cached = this.subtreeSignatures.get(element);
    if (cached !== undefined) return cached;
    const skeleton = structuralDigest(element);
    let value = this.signatureBySkeleton.get(skeleton);
    if (value === undefined) {
      value = componentHash(skeleton);
      this.signatureBySkeleton.set(skeleton, value);
      this.subtreeSignatureBuilds++;
    }
    this.subtreeSignatures.set(element, value);
    return value;
  }

  textLength(element: Element): number {
    const cached = this.textLengths.get(element);
    if (cached !== undefined) return cached;
    const value = (element.textContent ?? "").replace(/\s+/g, " ").trim().length;
    this.textLengths.set(element, value);
    return value;
  }
  regionBuilds = 0;
  siblingTagIndexBuilds = 0;
  childTagSequenceBuilds = 0;

  childTagSequence(element: Element): string {
    const cached = this.childTagSequences.get(element);
    if (cached !== undefined) return cached;
    const value = [...(element.children as unknown as Iterable<Element>)].map(tag).join(",");
    this.childTagSequences.set(element, value);
    this.childTagSequenceBuilds++;
    return value;
  }

  siblingTagIndex(element: Element): number {
    const parent = element.parentElement;
    if (!parent) return 1;
    let positions = this.siblingTagPositions.get(parent);
    if (!positions) {
      positions = new WeakMap<Element, number>();
      const byTag = new Map<string, number>();
      for (const child of parent.children as unknown as Iterable<Element>) {
        const childTag = tag(child);
        const index = (byTag.get(childTag) ?? 0) + 1;
        byTag.set(childTag, index);
        positions.set(child, index);
      }
      this.siblingTagPositions.set(parent, positions);
      this.siblingTagIndexBuilds++;
    }
    return positions.get(element) ?? 1;
  }

  getRegionEvidence(
    region: Element,
    role: RegionRole,
    nesting: ComponentOccurrence["region"]["nestedIn"],
    ancestorContext: string,
  ): RegionEvidence {
    const cached = this.regionEvidence.get(region);
    if (cached) return cached;
    const root = documentRoot(region);
    const slotKey = `${role}|${nesting}|${ancestorContext}`;
    let slots = this.slots.get(slotKey);
    if (!slots) {
      slots = new WeakMap<Element, string>();
      // Article/main-local landmarks are not peers of site chrome. Their slot
      // must not shift a footer/navigation identity on another page layout.
      const peers = [...root.querySelectorAll("*")].filter(
        (element) =>
          regionRole(element as Element) === role &&
          nestedIn(element as Element) === nesting &&
          semanticAncestorContext(element as Element) === ancestorContext,
      ) as Element[];
      peers.forEach((peer, index) => slots!.set(peer, `${role}:${index + 1}`));
      this.slots.set(slotKey, slots);
    }
    const evidence = {
      skeleton: structuralDigest(region),
      contentHash: componentHash(region.textContent?.replace(/\s+/g, " ").trim() ?? ""),
      slot: slots.get(region) ?? `${role}:unknown`,
    };
    this.regionEvidence.set(region, evidence);
    this.regionBuilds++;
    return evidence;
  }
}

/**
 * Rungs nearest the faulty element, and rungs nearest the region root.
 *
 * A pure element-upward ladder made DEPTH decide which rungs exist: in one
 * theme's menu, six links sat one level deeper than two others, so the deeper
 * six ran out of budget before reaching the block and promoted at its child.
 * One menu became two components. Anchoring the top of the ladder at the region
 * root instead means any two elements under the same block always share that
 * block's rungs, whatever their depth.
 */
const SUBTREE_NEAR_LEVELS = 4;
const SUBTREE_ROOT_LEVELS = 4;
/** Safety bound on the upward walk itself; real DOMs are far shallower. */
const MAX_ANCESTOR_WALK = 64;

/**
 * Values that must never ride along in a hint. A heading or aria-label is page
 * text, so it is filtered the way any other emitted text is: addresses, phone
 * numbers, URLs and token-shaped strings are dropped rather than truncated.
 */
const SENSITIVE_HINT_TEXT =
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\bhttps?:\/\/\S+|\b\+?\d[\d(). -]{7,}\d\b|\b(?:bearer|token|key|secret)\b\s*[:=]?\s*\S{6,}/i;
const HINT_MAX = 60;

/** Bounded, single-line, and dropped entirely when it carries anything sensitive. */
function hintText(value: string | null | undefined): string | undefined {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (!text || SENSITIVE_HINT_TEXT.test(text)) return undefined;
  return text.length > HINT_MAX ? `${text.slice(0, HINT_MAX - 1)}\u2026` : text;
}

/**
 * An id a human would recognise, not `sp-ppork3` or `wp-block-3f8a91`.
 *
 * Every hyphen/underscore token must be all letters or all digits. A token that
 * MIXES them is a generated suffix: one real theme emitted `sp-ppork3`, which a
 * digit-count rule happily accepted and which says nothing to a reader.
 */
function stableId(value: string | null): string | undefined {
  const id = (value ?? "").trim();
  if (!id || id.length > 40) return undefined;
  const tokens = id.split(/[-_]+/).filter(Boolean);
  if (tokens.length === 0) return undefined;
  if (!tokens.every((token) => /^[A-Za-z]+$/.test(token) || /^\d+$/.test(token))) return undefined;
  if (!tokens.some((token) => /^[A-Za-z]{2,}$/.test(token))) return undefined;
  return hintText(id);
}

/**
 * Describe `element` for a person: its own labelling first, then the nearest
 * heading inside it, then the closest heading before it. The inside-first order
 * matters because a block's own heading names the block, while a preceding one
 * only names the section it sits in.
 */
function rootHint(element: Element): RootHint | undefined {
  const hint: RootHint = { tag: tag(element) };
  const id = stableId(element.getAttribute("id"));
  if (id) hint.id = id;
  const label = hintText(element.getAttribute("aria-label"));
  if (label) hint.ariaLabel = label;
  // Only headings INSIDE the root. A preceding heading names whatever section
  // the block happens to sit after, not the block: on one storefront the
  // fallback labelled a sticky product bar "Recent post". A wrong label is
  // worse than none, so there is no fallback.
  let heading: string | undefined;
  for (const node of Array.from(element.querySelectorAll("h1,h2,h3,h4,h5,h6")) as Element[]) {
    heading = hintText(node.textContent);
    if (heading) break;
  }
  if (heading) hint.heading = heading;
  return hint.id || hint.ariaLabel || hint.heading ? hint : undefined;
}

/**
 * The ladder's root when there is no landmark at all.
 *
 * A theme with no header/nav/main/footer gives every element `no-region`, which
 * is most of a WooCommerce page: one real site produced 323 occurrences on 40
 * pages, every one of them unjudgeable. `<body>` is the honest outer bound
 * there, and the text share is measured against it for the same reason.
 */
function ladderRoot(element: Element): Element {
  let last = element;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (tag(current) === "body") return current;
    last = current;
  }
  return last;
}

/**
 * Describe each ancestor between the faulty element and its region root.
 *
 * Rules run one page at a time, so this cannot decide whether a subtree is
 * shared. It records what each ancestor looks like; the report stage, which
 * sees every page, promotes the highest level that recurs. Level 0 (the element
 * itself) is deliberately absent: a candidate rooted at the faulty element can
 * never match a sibling defect in the same block.
 */
function subtreeCandidates(
  element: Element,
  region: Element,
  cache: ComponentOccurrenceCache,
): SubtreeCandidate[] {
  const regionText = cache.textLength(region);
  if (regionText === 0) return [];
  // One upward pass collects both the ancestors and the path segments. Calling
  // elementPath per level re-walks the chain each time, which is quadratic in
  // the ladder depth for every faulty element on the page.
  const ancestors: Element[] = [];
  const segments: string[] = [`${tag(element)}:${cache.siblingTagIndex(element)}`];
  for (
    let ancestor = element.parentElement;
    ancestor && ancestor !== region && ancestors.length < MAX_ANCESTOR_WALK;
    ancestor = ancestor.parentElement
  ) {
    ancestors.push(ancestor);
    segments.push(`${tag(ancestor)}:${cache.siblingTagIndex(ancestor)}`);
  }
  // Nearest the element, then nearest the region root. Deduped and ordered, so
  // two elements at different depths still share the outer rungs.
  const chosen = new Set<number>();
  for (let index = 0; index < Math.min(SUBTREE_NEAR_LEVELS, ancestors.length); index += 1)
    chosen.add(index);
  for (
    let index = Math.max(0, ancestors.length - SUBTREE_ROOT_LEVELS);
    index < ancestors.length;
    index += 1
  )
    chosen.add(index);
  const candidates: SubtreeCandidate[] = [];
  for (const index of [...chosen].sort((left, right) => left - right)) {
    const ancestor = ancestors[index]!;
    // The locator for this rung is the element's path through the ancestors
    // below it, rooted at that ancestor's tag.
    const path = [tag(ancestor), ...segments.slice(0, index + 1).reverse()].join(">");
    candidates.push({
      level: index + 1,
      skeletonSignature: cache.subtreeSignature(ancestor),
      locatorFromRoot: path,
      textShareOfRegion: Math.round((cache.textLength(ancestor) / regionText) * 100) / 100,
      ...(cache.rootHint(ancestor) ? { rootHint: cache.rootHint(ancestor) } : {}),
    });
  }
  return candidates;
}

function findRegion(element: Element): Element | undefined {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (regionRole(current)) return current;
  }
  return undefined;
}

export function componentOccurrence(
  input: {
    pageUrl: string;
    /** The fetched/final URL determines site identity; pageUrl preserves source membership. */
    observedUrl?: string;
    rendered: boolean;
    element: Element;
    kind: ComponentOccurrence["defect"]["kind"];
    values: Record<string, string | number>;
    sensitiveValues?: Record<string, string>;
  },
  cache = new ComponentOccurrenceCache(),
): ComponentOccurrence {
  const region = findRegion(input.element);
  const role = region ? regionRole(region)! : "unknown";
  const nesting = region ? nestedIn(region) : "unknown";
  const ancestorContext = region ? semanticAncestorContext(region) : "unknown";
  // An article header is content, not site chrome. Unknown DOM ancestry remains
  // deliberately page-scoped rather than becoming a speculative component.
  const regionEvidence = region
    ? cache.getRegionEvidence(region, role, nesting, ancestorContext)
    : undefined;
  const regionSkeleton = regionEvidence?.skeleton ?? tag(input.element);
  const elementSkeleton = structuralDigest(input.element);
  // Ordered most-specific first, so the recorded reason names the actual cause
  // rather than whichever test happened to run first.
  const contentNested =
    region !== undefined &&
    (nesting === "article" || nesting === "main" || nestedBelowRegion(input.element, region) !== undefined);
  const uncertainReason: ComponentOccurrence["uncertainReason"] = !region
    ? "no-region"
    : contentNested
      ? "content-nested"
      : role === "main"
        ? "region-main"
        : undefined;
  const groupable = uncertainReason === undefined;
  const regionStructure = regionSkeleton;
  const elementStructure = elementSkeleton;
  const contentHash = regionEvidence?.contentHash ?? componentHash("");
  const pageHash = componentHash(input.pageUrl);
  // Derived ONCE, here, and recorded on the occurrence below; every consumer
  // reads it back rather than deriving its own. See `componentSiteOrigin`.
  const origin = componentSiteOrigin(input.observedUrl ?? input.pageUrl);
  // Family must be stricter than "same tag": a footer with no id or class would
  // otherwise merge with every other site footer of the same nesting. The direct
  // child tag sequence is the cheapest shape that separates them and, unlike the
  // full skeleton, does not move when a nested element changes.
  const childTagSequence = cache.childTagSequence(region ?? input.element);
  const familyStructure = `${role}|${nesting}|${ancestorContext}|${tag(region ?? input.element)}${stableAttributes(region ?? input.element)}|(${childTagSequence})`;
  const familyKey = groupable ? componentHash(`${origin}|${familyStructure}`) : `page:${pageHash}`;
  // Variant is a STRUCTURAL identity. Region text is reported separately as
  // `contentHash`; folding it in here made any per-page string in a footer
  // (a date, a breadcrumb, a page number) split every page into its own variant.
  const variantStructure = `${familyStructure}|${regionStructure}`;
  const variantKey = groupable ? componentHash(variantStructure) : `page:${pageHash}`;
  const valueHashes = Object.fromEntries(
    Object.entries({ ...input.values, ...input.sensitiveValues }).map(([key, value]) => [
      key,
      componentHash(String(value)),
    ]),
  );

  // Two cases the rule genuinely cannot judge from one page: an element inside
  // `main`, and a page with no landmarks at all. Both get a ladder so the
  // report stage can decide. A landmark occurrence keeps exactly the evidence
  // it has today, and an article-nested one stays page-scoped.
  const candidates =
    uncertainReason === "region-main" && region
      ? subtreeCandidates(input.element, region, cache)
      : uncertainReason === "no-region"
        ? subtreeCandidates(input.element, ladderRoot(input.element), cache)
        : [];

  return {
    version: 1,
    pageUrl: input.pageUrl,
    siteOrigin: origin,
    provenance: { source: "page-dom", rendered: input.rendered },
    groupable,
    confidence: groupable ? "observed" : "uncertain",
    ...(uncertainReason ? { uncertainReason } : {}),
    region: { role, nestedIn: nesting, structuralSignature: componentHash(regionStructure) },
    family: { key: familyKey, structuralSignature: componentHash(familyStructure) },
    variant: { key: variantKey, structuralSignature: componentHash(variantStructure), contentHash },
    ...(candidates.length > 0 ? { subtreeCandidates: candidates } : {}),
    element: {
      // The region slot separates two otherwise-identical footer/navigation
      // instances on one page without making a page-layout path part of family.
      locator: region
        ? `${regionEvidence!.slot}>${elementPath(region, input.element, cache)}`
        : elementPath(documentRoot(input.element), input.element, cache),
      structuralSignature: componentHash(elementStructure),
    },
    defect: { kind: input.kind, values: input.values, valueHashes },
  };
}
