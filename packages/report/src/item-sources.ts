// The pages an item was found on, one row each (pub#837): the page, and what its links there add
// ("2 links, in the footer"). Every format renders these rows, so a broken link reads the same in
// each, and a cut list says how many pages it leaves out instead of pointing at a list elsewhere.

import { itemSourceDetail, type CheckItem } from "@squirrelscan/core-contracts";

export interface ItemSourceRow {
  page: string;
  /** "2 links, in the footer"; "" when the page has nothing to add. */
  detail: string;
}

export interface ItemSourceList {
  /** Each page of `sourcePages` once, in its order. */
  rows: ItemSourceRow[];
  /** Pages the item was found on that the report does not list (`pageCount` past the rows). */
  unlisted: number;
}

/** The item's source pages as rows, each page once, with the detail its `sources` entry gives. */
export function itemSourceList(item: CheckItem): ItemSourceList {
  const detail = new Map<string, string>();
  for (const source of item.sources ?? []) detail.set(source.page, itemSourceDetail(source));
  const rows = [...new Set(item.sourcePages ?? [])].map((page) => ({
    page,
    detail: detail.get(page) ?? "",
  }));
  const total = item.pageCount;
  const unlisted =
    typeof total === "number" && Number.isFinite(total) && total > rows.length
      ? Math.floor(total) - rows.length
      : 0;
  return { rows, unlisted };
}

/** "/about (2 links, in the footer)", or the page alone when it has nothing to add. */
export function sourceRowText(page: string, detail: string): string {
  return detail ? `${page} (${detail})` : page;
}

/** "+1 more page" / "+4 more pages". */
export function moreSourcePages(n: number): string {
  return `+${n} more ${n === 1 ? "page" : "pages"}`;
}

/** True when the check's items are links that say how they sit on each page. */
export function hasItemSources(check: { items?: CheckItem[] }): boolean {
  return check.items?.some((item) => (item.sources?.length ?? 0) > 0) ?? false;
}

/**
 * What follows a check's message: ", found on 3 pages" when its items are links found on pages,
 * so the summary keeps the links and the pages apart; " (3 pages)" for other checks on more than
 * one page; "" otherwise.
 */
export function affectedPagesSuffix(check: { items?: CheckItem[] }, count: number): string {
  if (hasItemSources(check) && count > 0) return `, found on ${count} ${count === 1 ? "page" : "pages"}`;
  return count > 1 ? ` (${count} pages)` : "";
}
