// Where on its source pages a link sat, for finding labels (#2307).

import type { LinkSection } from "@squirrelscan/core-contracts";

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

export type SectionCounts = Partial<Record<Exclude<LinkSection, "unknown">, number>>;

/** Add one link's section to the counts; unknown and missing add nothing. */
export function countSection(counts: SectionCounts, section: LinkSection | undefined): void {
  if (!section || section === "unknown") return;
  counts[section] = (counts[section] ?? 0) + 1;
}

/** "in the footer" / "in the footer and the page content"; "" when no section is known. */
export function sectionPhrase(counts: SectionCounts): string {
  const names = (Object.keys(counts) as (keyof SectionCounts)[])
    .sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0) || a.localeCompare(b))
    .map((section) => PHRASE[section]);
  if (names.length === 0) return "";
  if (names.length <= 2) return `in ${names.join(" and ")}`;
  return `in ${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}
