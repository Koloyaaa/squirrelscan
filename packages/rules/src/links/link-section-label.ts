// Where on its source pages a link sat, for finding labels (#2307).

import type { LinkSection, LinkSectionCounts } from "@squirrelscan/core-contracts";

/**
 * How an item reads: "in the footer", "in the page content", "in the pagination", ... The first
 * six come from page markup; the rest are section purposes the page classifier names where the
 * markup says nothing.
 */
const PHRASE: Record<Exclude<LinkSection, "unknown">, string> = {
  header: "the header",
  footer: "the footer",
  navigation: "the navigation",
  sidebar: "the sidebar",
  comments: "the comments",
  content: "the page content",
  pagination: "the pagination",
  breadcrumbs: "the breadcrumbs",
  related_content: "a related-content block",
  business_info: "the business details",
  social_share: "the social sharing links",
  account_login: "the account and login links",
  author_byline: "the author byline",
  newsletter_signup: "the newsletter signup",
};

export type SectionCounts = LinkSectionCounts;

/** Add one link's section to the counts; unknown and missing add nothing. */
export function countSection(counts: SectionCounts, section: LinkSection | undefined): void {
  if (!section || section === "unknown") return;
  counts[section] = (counts[section] ?? 0) + 1;
}

/** "the footer and the page content", most links first; "" when no section is known. */
function sectionList(counts: SectionCounts): string {
  const names = (Object.keys(counts) as (keyof SectionCounts)[])
    .sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0) || a.localeCompare(b))
    .map((section) => PHRASE[section]);
  if (names.length === 0) return "";
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

/** "in the footer" / "in the footer and the page content"; "" when no section is known. */
export function sectionPhrase(counts: SectionCounts): string {
  const list = sectionList(counts);
  return list ? `in ${list}` : "";
}

/** "the footer, the navigation and the breadcrumbs": up to three names, then "and N more". */
function nameList(names: string[]): string {
  if (names.length <= 1) return names.join("");
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

/**
 * Where the links to a page that only sitewide chrome points at sit (#2307), for
 * `links/no-contextual-inbound`. The decision that the page is chrome-only is the `isChrome`
 * flag (a `nav`, `header`, `footer` or `aside` ancestor); this says what the sections were.
 *
 * Every section but `content` is named. Links the section rules read as `content` are template
 * links: an anchor inside a post's own `<footer>` ("Back to the journal") is chrome by tag and
 * content by section. They are counted apart and never named as a place the page is linked
 * "only from".
 *
 * "linked only from the footer, the navigation and the breadcrumbs, and 22 template links inside
 * the page content". `complete` is true when every counted inbound link had a section; without it
 * the phrase drops "only". "" when there is nothing to say.
 */
export function chromeSectionPhrase(counts: SectionCounts, complete: boolean): string {
  const named = (Object.keys(counts) as (keyof SectionCounts)[])
    .filter((section) => section !== "content" && (counts[section] ?? 0) > 0)
    .sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0) || a.localeCompare(b));
  const content = counts.content ?? 0;
  const template =
    content > 0
      ? `${content} template ${content === 1 ? "link" : "links"} inside the page content`
      : "";
  const lead = complete ? "linked only" : "linked";
  if (named.length === 0) return template ? `${lead} by ${template}` : "";
  const places = nameList(named.map((section) => PHRASE[section]));
  return `${lead} from ${places}${template ? `, and ${template}` : ""}`;
}
