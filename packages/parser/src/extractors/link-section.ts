// Which part of the page an anchor sits in (#2307).
//
// `position` (./links.ts) is a descriptive label that falls back to class/id substrings; `isChrome`
// (./chrome.ts) is a landmark-only yes/no. This is the label a FINDING quotes ("broken link in the
// footer"): landmark tags and ARIA roles, plus one markup-only rule for comment threads, because a
// link there is worth far less than one in the article body and is where spam lands.
//
// Strict on purpose: a wrong section names the wrong part of the page in a fix, a missed one only
// leaves the link as "unknown". Class/id substrings drive only the comments rule, and only on
// names that mean a comment thread (never a bare `comment` that could be a comment *form* label).
//
// The walk is memoised per element: a footer with 300 links reads the footer's attributes once.

import type { Element } from "linkedom";

import type { LinkSection } from "./types";

/** Sections that name sitewide furniture; once an ancestor is one, nothing inside can override it. */
const CHROME: ReadonlySet<LinkSection> = new Set(["header", "footer", "navigation", "sidebar"]);

const ROLE_SECTION: Record<string, LinkSection> = {
  banner: "header",
  contentinfo: "footer",
  navigation: "navigation",
  complementary: "sidebar",
  main: "content",
};

// A comment THREAD container: WordPress (`comments`, `comment-list`, `commentlist`, `comments-area`),
// Disqus, Discourse-style threads, Facebook/Commento embeds. `respond`/`comment-form` is the reply
// box (no links worth reporting), so it does not count.
const COMMENTS_PATTERN =
  /(?:^|[\s_-])(?:comments|comment-?list|comment-?thread|comment-?section|comments-?area|disqus_thread|fb-comments|commento)(?:$|[\s_-])/;

function ownSection(element: Element): LinkSection | null {
  const tag = element.tagName?.toLowerCase();
  if (tag === "nav") return "navigation";
  if (tag === "aside") return "sidebar";
  if (tag === "header") return "header";
  if (tag === "footer") return "footer";
  if (tag === "main" || tag === "article") return "content";
  const role = element.getAttribute?.("role")?.toLowerCase();
  if (role && ROLE_SECTION[role]) return ROLE_SECTION[role]!;
  const id = element.getAttribute?.("id");
  const cls = element.getAttribute?.("class");
  if (id || cls) {
    if (id && COMMENTS_PATTERN.test(id.toLowerCase())) return "comments";
    if (cls && COMMENTS_PATTERN.test(cls.toLowerCase())) return "comments";
  }
  return null;
}

/** Make a section resolver for one document; call it for every anchor of that document. */
export function makeSectionResolver(): (element: Element) => LinkSection {
  const memo = new WeakMap<Element, LinkSection>();
  const resolve = (element: Element): LinkSection => {
    const cached = memo.get(element);
    if (cached) return cached;
    const parent = element.parentElement;
    const inherited: LinkSection = parent ? resolve(parent) : "unknown";
    let section = inherited;
    if (!CHROME.has(inherited)) {
      const own = ownSection(element);
      if (own) {
        // A <header>/<footer> inside <main>/<article> or a comment is that block's own heading,
        // not the site's banner or contentinfo (HTML spec: they only scope to sectioning content).
        const scoped = (own === "header" || own === "footer") && inherited !== "unknown";
        if (!scoped) section = own;
      }
    }
    memo.set(element, section);
    return section;
  };
  return resolve;
}

/** One-off convenience; use {@link makeSectionResolver} when resolving many anchors of a page. */
export function linkSectionOf(element: Element): LinkSection {
  return makeSectionResolver()(element);
}
