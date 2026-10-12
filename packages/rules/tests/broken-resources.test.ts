// reliability/broken-resources - scripts, stylesheets and fonts that fail to load (#703).

import { describe, expect, test } from "bun:test";

import type {
  CheckResult,
  ResourceSizeData,
  ScriptContentData,
} from "@squirrelscan/core-contracts";

import { getCategoryGroup, getCategoryName, CATEGORY_CODES } from "../src/categories";
import { loadAllRules } from "../src/loader";
import { brokenResourcesRule } from "../src/reliability/broken-resources";
import type { ParsedPage, RuleContext, SiteData } from "../src/types";

const PAGE = "https://example.com/";

function script(overrides: Partial<ScriptContentData> = {}): ScriptContentData {
  return {
    url: "https://example.com/app.js",
    status: 200,
    error: null,
    contentType: "application/javascript",
    sizeBytes: 100,
    content: null,
    sourcePages: [PAGE],
    ...overrides,
  };
}

function sheet(overrides: Partial<ResourceSizeData> = {}): ResourceSizeData {
  return {
    url: "https://example.com/app.css",
    status: 200,
    error: null,
    contentType: "text/css",
    sizeBytes: 100,
    sourcePages: [PAGE],
    ...overrides,
  };
}

interface Measured {
  scripts?: ScriptContentData[];
  css?: ResourceSizeData[];
  fonts?: ResourceSizeData[];
  images?: ResourceSizeData[];
  baseUrl?: string;
}

function ctx(m: Measured): RuleContext {
  const site: SiteData = {
    baseUrl: m.baseUrl ?? "https://example.com",
    pages: [],
    robotsTxt: null,
    sitemaps: null,
    resourceSizes:
      m.css === undefined && m.fonts === undefined && m.images === undefined
        ? undefined
        : {
            css: m.css ?? [],
            images: m.images ?? [],
            ...(m.fonts !== undefined ? { fonts: m.fonts } : {}),
          },
    ...(m.scripts !== undefined ? { scripts: m.scripts } : {}),
  };
  return {
    page: { url: PAGE, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site,
    options: {},
  };
}

function run(m: Measured): CheckResult[] {
  return brokenResourcesRule.run(ctx(m)).checks as CheckResult[];
}

function named(checks: CheckResult[], name: string): CheckResult | undefined {
  return checks.find((c) => c.name === name);
}

describe("reliability category wiring", () => {
  test("is registered as a category in the Performance group", () => {
    expect(CATEGORY_CODES).toContain("reliability");
    expect(getCategoryName("reliability")).toBe("Reliability");
    expect(getCategoryGroup("reliability")).toBe("performance");
  });

  test("the rule is loaded by the rule loader", () => {
    expect(loadAllRules().has("reliability/broken-resources")).toBe(true);
  });
});

describe("reliability/broken-resources", () => {
  test("meta: reliability category, site scope, error severity", () => {
    expect(brokenResourcesRule.meta.id).toBe("reliability/broken-resources");
    expect(brokenResourcesRule.meta.category).toBe("reliability");
    expect(brokenResourcesRule.meta.scope).toBe("site");
    expect(brokenResourcesRule.meta.severity).toBe("error");
  });

  test("first-party script answering 404 is an error finding naming URL, status and page", () => {
    const checks = run({
      scripts: [
        script({
          url: "https://example.com/app.js",
          status: 404,
          error: "HTTP 404",
          sourcePages: ["https://example.com/", "https://example.com/about"],
        }),
      ],
      css: [],
      fonts: [],
    });
    const fail = named(checks, "broken-resources");
    expect(fail?.status).toBe("fail");
    expect(fail?.items).toHaveLength(1);
    const item = fail!.items![0]!;
    expect(item.id).toBe("https://example.com/app.js");
    expect(item.label).toContain("HTTP 404");
    expect(item.sourcePages).toEqual(["https://example.com/", "https://example.com/about"]);
  });

  test("first-party stylesheet answering 500 is an error finding", () => {
    const checks = run({
      scripts: [],
      css: [sheet({ url: "https://example.com/site.css", status: 500, error: "HTTP 500" })],
      fonts: [],
    });
    const fail = named(checks, "broken-resources");
    expect(fail?.status).toBe("fail");
    expect(fail?.items?.[0]?.id).toBe("https://example.com/site.css");
    expect(fail?.items?.[0]?.label).toContain("HTTP 500");
  });

  test("first-party subdomain counts as first-party", () => {
    const checks = run({
      scripts: [script({ url: "https://cdn.example.com/app.js", status: 404, error: "HTTP 404" })],
      css: [],
      fonts: [],
    });
    expect(named(checks, "broken-resources")?.status).toBe("fail");
  });

  test("third-party script answering 404 is a warning, not an error", () => {
    const checks = run({
      scripts: [script({ url: "https://tracker.other.net/t.js", status: 404, error: "HTTP 404" })],
      css: [],
      fonts: [],
    });
    expect(named(checks, "broken-resources")).toBeUndefined();
    const warn = named(checks, "unreachable-resources");
    expect(warn?.status).toBe("warn");
    expect(warn?.items?.[0]?.id).toBe("https://tracker.other.net/t.js");
  });

  test("font answering 404 is a warning, not an error", () => {
    const checks = run({
      scripts: [],
      css: [],
      fonts: [sheet({ url: "https://example.com/fonts/a.woff2", status: 404, error: "HTTP 404" })],
    });
    expect(named(checks, "broken-resources")).toBeUndefined();
    expect(named(checks, "unreachable-resources")?.status).toBe("warn");
  });

  test("network-level failures (DNS, TLS, timeout) are warnings", () => {
    const checks = run({
      scripts: [script({ url: "https://example.com/slow.js", status: null, error: "timeout" })],
      css: [],
      fonts: [],
    });
    expect(named(checks, "broken-resources")).toBeUndefined();
    const warn = named(checks, "unreachable-resources");
    expect(warn?.status).toBe("warn");
    expect(warn?.items?.[0]?.label).toContain("timeout");
  });

  test("429, 430 and 503 are unverified info, never broken", () => {
    const checks = run({
      scripts: [
        script({ url: "https://example.com/a.js", status: 429, error: "HTTP 429" }),
        script({ url: "https://example.com/b.js", status: 430, error: "HTTP 430" }),
        script({ url: "https://example.com/c.js", status: 503, error: "HTTP 503" }),
      ],
      css: [sheet({ url: "https://example.com/d.css", status: 503, error: "HTTP 503" })],
      fonts: [],
    });
    expect(named(checks, "broken-resources")).toBeUndefined();
    expect(named(checks, "unreachable-resources")).toBeUndefined();
    const unverified = named(checks, "unverified-resources");
    expect(unverified?.status).toBe("info");
    expect(unverified?.items).toHaveLength(4);
  });

  test("one URL referenced from five pages yields one finding listing all five pages", () => {
    const pages = [1, 2, 3, 4, 5].map((n) => `https://example.com/p${n}`);
    const checks = run({
      scripts: [
        script({
          url: "https://example.com/gone.js",
          status: 404,
          error: "HTTP 404",
          sourcePages: pages,
        }),
      ],
      css: [],
      fonts: [],
    });
    const fail = named(checks, "broken-resources");
    expect(fail?.items).toHaveLength(1);
    expect(fail?.items?.[0]?.sourcePages).toEqual(pages);
  });

  test("a fully healthy set passes", () => {
    const checks = run({
      scripts: [script()],
      css: [sheet()],
      fonts: [sheet({ url: "https://example.com/f.woff2" })],
    });
    expect(named(checks, "broken-resources")?.status).toBe("pass");
    expect(named(checks, "unchecked-resources")).toBeUndefined();
  });

  test("skipped fetches (asset budget) make the result partial, not a pass", () => {
    const checks = run({
      scripts: [
        script({ url: "https://example.com/ok.js" }),
        script({ url: "https://example.com/late.js", status: null, error: "skipped" }),
      ],
      css: [],
      fonts: [],
    });
    const partial = named(checks, "unchecked-resources");
    expect(partial?.status).toBe("info");
    expect(partial?.message).toContain("Partial check");
    expect(partial?.message).toContain("1 referenced resource(s) were not fetched");
    // The pass that remains must not claim every resource was checked.
    expect(named(checks, "broken-resources")?.message).toBe(
      "No broken resources among the 1 checked",
    );
  });

  test("a resource kind absent from the crawl is reported as not measured", () => {
    const checks = run({ scripts: [script()] });
    const partial = named(checks, "unchecked-resources");
    expect(partial?.status).toBe("info");
    expect(partial?.message).toContain("stylesheets, fonts were not measured");
  });

  test("broken images are left to images/broken-images", () => {
    const checks = run({
      scripts: [],
      css: [],
      fonts: [],
      images: [
        {
          url: "https://example.com/missing.png",
          status: 404,
          error: "HTTP 404",
          contentType: null,
          sizeBytes: null,
          sourcePages: [PAGE],
        },
      ],
    });
    expect(checks.some((c) => c.items?.some((i) => i.id.includes("missing.png")))).toBe(false);
  });

  test("site data missing is skipped", () => {
    const result = brokenResourcesRule.run({
      page: { url: PAGE, html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: {} as ParsedPage,
      options: {},
    } as unknown as RuleContext);
    expect(result.checks[0]?.status).toBe("skipped");
  });
});
