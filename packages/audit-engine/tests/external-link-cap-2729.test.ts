// repo#2729: an audit requests at most `max_links` distinct external links. The
// choice must be deterministic, take the links on the most pages first, and
// put any the caller names (an open finding's links) ahead of the rest.

import { describe, expect, test } from "bun:test";

import { externalLinkCheckCap } from "@squirrelscan/core-contracts/limits";

import { selectExternalLinksToCheck, type ExternalLinkOccurrences } from "../src/adapter";

function occurrences(spec: Record<string, string[]>): ExternalLinkOccurrences {
  const map: ExternalLinkOccurrences = new Map();
  for (const [href, pages] of Object.entries(spec)) {
    map.set(
      href,
      pages.map((pageUrl) => ({ pageUrl, text: "", position: "body", isNofollow: false })) as never,
    );
  }
  return map;
}

const SITE = occurrences({
  "https://b.example/": ["/a", "/b"],
  "https://a.example/": ["/a", "/b"],
  "https://footer.example/": ["/a", "/b", "/c"],
  "https://once.example/": ["/c"],
  // The same page twice counts once.
  "https://twice.example/": ["/a", "/a"],
});

describe("selectExternalLinksToCheck", () => {
  test("everything when there is no limit or it fits", () => {
    expect(selectExternalLinksToCheck(SITE, undefined)).toHaveLength(5);
    expect(selectExternalLinksToCheck(SITE, 5)).toHaveLength(5);
  });

  test("most pages first, ties by URL", () => {
    expect(selectExternalLinksToCheck(SITE, 3)).toEqual([
      "https://footer.example/",
      "https://a.example/",
      "https://b.example/",
    ]);
  });

  test("links the caller names go first, and an unknown one is ignored", () => {
    expect(
      selectExternalLinksToCheck(SITE, 2, ["https://once.example/", "https://gone.example/"]),
    ).toEqual(["https://once.example/", "https://footer.example/"]);
  });
});

describe("externalLinkCheckCap", () => {
  test("the page budget, never below 200", () => {
    expect(externalLinkCheckCap(10)).toBe(200);
    expect(externalLinkCheckCap(500)).toBe(500);
    expect(externalLinkCheckCap(Number.NaN)).toBe(200);
  });
});
