// #2307: a broken internal link says which part of its source pages it was linked from.

import { describe, expect, test } from "bun:test";

import { brokenLinksRule } from "../src/links/broken-links";
import type { RuleContext } from "../src/types";

const BASE = "https://example.com";

type L = { url: string; section?: string };

function ctx(pages: { url: string; status: number; links: L[] }[]): RuleContext {
  return {
    page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {},
    site: {
      baseUrl: BASE,
      robotsTxt: null,
      sitemaps: null,
      pages: pages.map((p) => ({
        url: p.url,
        statusCode: p.status,
        parsed: {
          links: p.links.map((l) => ({
            url: l.url,
            text: "",
            isInternal: true,
            section: l.section,
          })),
        },
      })),
    },
    options: {},
  } as unknown as RuleContext;
}

const gone = `${BASE}/gone`;

describe("links/broken-links: section", () => {
  test("label and meta say where the broken link sat", () => {
    const { checks } = brokenLinksRule.run(
      ctx([
        { url: `${BASE}/`, status: 200, links: [{ url: gone, section: "footer" }] },
        { url: `${BASE}/a`, status: 200, links: [{ url: gone, section: "footer" }] },
        { url: `${BASE}/b`, status: 200, links: [{ url: gone, section: "content" }] },
        { url: gone, status: 404, links: [] },
      ]),
    );
    const item = checks.find((c) => c.name === "broken-links")!.items![0]!;
    expect(item.label).toBe(`${gone} (404), linked in the footer and the page content`);
    expect(item.meta).toMatchObject({ statusCode: 404, sections: { footer: 2, content: 1 } });
  });

  test("an old crawl with no section keeps the plain label", () => {
    const { checks } = brokenLinksRule.run(
      ctx([
        { url: `${BASE}/`, status: 200, links: [{ url: gone }] },
        { url: gone, status: 404, links: [] },
      ]),
    );
    const item = checks.find((c) => c.name === "broken-links")!.items![0]!;
    expect(item.label).toBe(`${gone} (404)`);
    expect(item.meta).not.toHaveProperty("sections");
  });

  test("links of unknown placement add no phrase", () => {
    const { checks } = brokenLinksRule.run(
      ctx([
        { url: `${BASE}/`, status: 200, links: [{ url: gone, section: "unknown" }] },
        { url: gone, status: 404, links: [] },
      ]),
    );
    expect(checks.find((c) => c.name === "broken-links")!.items![0]!.label).toBe(`${gone} (404)`);
  });
});
