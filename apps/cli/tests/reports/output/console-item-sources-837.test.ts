// pub#837: the console lists each page that carries a broken link once, with how many links it
// has to the target and where they sit, and the summary keeps the links and the pages apart.

import { describe, expect, spyOn, test } from "bun:test";

import type { AuditReport } from "@/types";

import { generateConsoleReport } from "@/reports/output/console";

import { createMinimalReport } from "../fixtures";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const SITE = "https://example.com";

function capture(report: AuditReport): string {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  try {
    generateConsoleReport(report);
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n").replace(ANSI, "");
}

function brokenLinks(
  sources: { page: string; links: number; sections?: Record<string, number> }[]
): AuditReport {
  const report = createMinimalReport();
  report.ruleResults = {
    "links/broken-links": {
      meta: {
        id: "links/broken-links",
        name: "Broken Links",
        description: "Detects links returning 404 or 5xx errors",
        category: "links",
        scope: "site",
        severity: "error",
        weight: 7,
      },
      checks: [
        {
          name: "broken-links",
          status: "fail",
          message: "1 broken internal link(s) (4xx/5xx)",
          items: [
            {
              id: `${SITE}/gone`,
              label: `${SITE}/gone (404)`,
              sourcePages: sources.map((s) => s.page),
              sources,
            },
          ],
        },
      ],
    },
  };
  return report;
}

describe("console broken link sources (pub#837)", () => {
  test("each page once, with its link count and the sections it links from", () => {
    const out = capture(
      brokenLinks([
        { page: `${SITE}/a`, links: 2, sections: { content: 1, footer: 1 } },
        { page: `${SITE}/b`, links: 1, sections: { footer: 1 } },
        { page: `${SITE}/c`, links: 1 },
      ])
    );
    expect(out).toContain(
      "broken-links: 1 broken internal link(s) (4xx/5xx), found on 3 pages"
    );
    expect(out).toContain(
      "from /a (2 links, in the page content and the footer)"
    );
    expect(out).toContain("from /b (in the footer)");
    expect(out.split("from /a").length - 1).toBe(1);
    expect(out).toMatch(/from \/c\s/);
  });

  test("a long list says how many pages it leaves out", () => {
    const out = capture(
      brokenLinks(
        Array.from({ length: 5 }, (_, k) => ({
          page: `${SITE}/p${k}`,
          links: 1,
        }))
      )
    );
    expect(out).toContain("from /p2");
    expect(out).not.toContain("from /p3");
    expect(out).toContain("... +2 more pages");
  });
});
