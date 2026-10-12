// reliability/broken-resources - scripts, stylesheets and fonts that fail to load (#703)
//
// Reads the asset data the crawl already fetched for the performance rules. No
// render and no new requests: a deploy that deletes a hashed bundle shows up here
// even when the HTML that references it is a 200.

import type {
  CheckItem,
  CheckResult,
  ResourceSizeData,
  ScriptContentData,
} from "@squirrelscan/core-contracts";
import { isRateLimitStatus } from "@squirrelscan/utils/rate-limit";

import type { Rule, RuleContext, RuleResult, SiteData } from "../types";

type Kind = "script" | "stylesheet" | "font";

/** One resource URL, merged across the pages that reference it. */
interface Asset {
  url: string;
  kind: Kind;
  firstParty: boolean;
  status: number | null;
  error: string | null;
  sourcePages: Set<string>;
}

/**
 * How one resource reads:
 * - `fail`: a first-party script or stylesheet answered 4xx/5xx (error).
 * - `warn`: a third-party script or stylesheet, or any font, answered 4xx/5xx, or
 *   the request failed at the network level (DNS, TLS, timeout). Warning only,
 *   because a network failure is often transient and a third party is not the
 *   site's own code.
 * - `unverified`: throttled (429/430) or 503. The origin is asking us to come
 *   back, so the status says nothing about the file.
 * - `unchecked`: the fetch was skipped (budget, tarpit) or never ran.
 * - `ok`: answered below 400.
 */
type Verdict = "fail" | "warn" | "unverified" | "unchecked" | "ok";

function siteHost(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * First-party means the site's own host or a subdomain of it: the same test the
 * asset collector applies when deciding which scripts and stylesheets to fetch.
 */
function isFirstParty(url: string, host: string | null): boolean {
  if (!host) return false;
  let urlHost: string;
  try {
    urlHost = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return urlHost === host || urlHost.endsWith(`.${host}`);
}

function verdictOf(asset: Asset): Verdict {
  if (asset.status === null) {
    // No status and no error: the fetch never ran. `skipped` is the budget or
    // tarpit path, which the asset phase records explicitly.
    if (asset.error === null || asset.error === "skipped") return "unchecked";
    // A status-less error is a network failure (DNS, TLS, timeout, reset).
    return "warn";
  }
  if (isRateLimitStatus(asset.status) || asset.status === 503) return "unverified";
  if (asset.status < 400) return "ok";
  // 4xx/5xx. Only first-party scripts and stylesheets are errors; fonts and
  // third-party files are warnings.
  const firstPartyCode = asset.firstParty && asset.kind !== "font";
  return firstPartyCode ? "fail" : "warn";
}

function toItem(asset: Asset): CheckItem {
  const detail =
    asset.status !== null ? `HTTP ${asset.status}` : `error: ${asset.error ?? "unknown"}`;
  return {
    id: asset.url,
    label: `${asset.url} (${detail})`,
    sourcePages: [...asset.sourcePages],
    meta: { kind: asset.kind, status: asset.status, error: asset.error },
  };
}

function collect(site: SiteData, host: string | null): { assets: Asset[]; unmeasured: Kind[] } {
  const byKey = new Map<string, Asset>();
  const add = (entries: Array<ScriptContentData | ResourceSizeData>, kind: Kind): void => {
    for (const entry of entries) {
      const key = `${kind}\n${entry.url}`;
      const existing = byKey.get(key);
      if (existing) {
        for (const page of entry.sourcePages) existing.sourcePages.add(page);
        continue;
      }
      byKey.set(key, {
        url: entry.url,
        kind,
        firstParty: isFirstParty(entry.url, host),
        status: entry.status,
        error: entry.error,
        sourcePages: new Set(entry.sourcePages),
      });
    }
  };

  // A kind whose list is absent was never measured (hand-built context, older
  // caller). That is "not checked", never "none referenced".
  const unmeasured: Kind[] = [];
  if (site.scripts === undefined) unmeasured.push("script");
  else add(site.scripts, "script");

  if (site.resourceSizes?.css === undefined) unmeasured.push("stylesheet");
  else add(site.resourceSizes.css, "stylesheet");

  if (site.resourceSizes?.fonts === undefined) unmeasured.push("font");
  else add(site.resourceSizes.fonts, "font");

  return { assets: [...byKey.values()], unmeasured };
}

const KIND_LABEL: Record<Kind, string> = {
  script: "script",
  stylesheet: "stylesheet",
  font: "font",
};

export const brokenResourcesRule: Rule = {
  meta: {
    id: "reliability/broken-resources",
    name: "Broken Scripts, Stylesheets and Fonts",
    description:
      "Checks that the scripts, stylesheets and fonts pages reference load, and reports 4xx/5xx or failed requests",
    solution:
      "A page whose script or stylesheet returns 404 or 500 still answers 200 with its title and meta, but renders unstyled or its interactive parts never run. The usual cause is a deploy: cached HTML still points at hashed bundles the new release deleted. Redeploy the missing file, or update the reference so pages point at the bundle that exists. Keep old hashed assets for as long as cached HTML may reference them. Third-party failures are reported as warnings: check the provider's status, or remove the reference if the service is gone.",
    category: "reliability",
    scope: "site",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const site = ctx.site;

    if (!site) {
      checks.push({
        name: "broken-resources",
        status: "skipped",
        message: "Site data not available",
      });
      return { checks };
    }

    const host = siteHost(site.baseUrl);
    const { assets, unmeasured } = collect(site, host);

    const failed: Asset[] = [];
    const warned: Asset[] = [];
    const unverified: Asset[] = [];
    let unchecked = 0;
    let ok = 0;
    for (const asset of assets) {
      switch (verdictOf(asset)) {
        case "fail":
          failed.push(asset);
          break;
        case "warn":
          warned.push(asset);
          break;
        case "unverified":
          unverified.push(asset);
          break;
        case "unchecked":
          unchecked++;
          break;
        case "ok":
          ok++;
          break;
      }
    }

    // Partial when any fetch was skipped or a whole kind was never measured. The
    // asset fetch is capped, so this result must say so instead of reading as a
    // full pass.
    const notChecked = unchecked + unmeasured.length;

    if (failed.length > 0) {
      checks.push({
        name: "broken-resources",
        status: "fail",
        message: `${failed.length} first-party script or stylesheet(s) answer with an error status`,
        items: failed.map(toItem),
        details: { count: failed.length },
      });
    }

    if (warned.length > 0) {
      checks.push({
        name: "unreachable-resources",
        status: "warn",
        message: `${warned.length} script, stylesheet or font(s) fail to load: third-party or font, or a network error`,
        items: warned.map(toItem),
        details: { count: warned.length },
      });
    }

    if (unverified.length > 0) {
      checks.push({
        name: "unverified-resources",
        status: "info",
        message: `${unverified.length} resource(s) were rate-limited or returned 503, so their status is unverified and not reported as broken`,
        items: unverified.map(toItem),
        details: { count: unverified.length },
      });
    }

    if (notChecked > 0) {
      const parts: string[] = [];
      if (unchecked > 0) {
        parts.push(
          `${unchecked} referenced resource(s) were not fetched (asset fetch capped or cut short)`,
        );
      }
      if (unmeasured.length > 0) {
        const kinds = unmeasured.map((k) => `${KIND_LABEL[k]}s`).join(", ");
        parts.push(`${kinds} were not measured this audit`);
      }
      checks.push({
        name: "unchecked-resources",
        status: "info",
        message: `Partial check: ${parts.join("; ")}`,
        details: { unchecked, unmeasuredKinds: unmeasured },
      });
    }

    if (failed.length === 0 && warned.length === 0) {
      if (ok > 0) {
        checks.push({
          name: "broken-resources",
          status: "pass",
          message:
            notChecked > 0
              ? `No broken resources among the ${ok} checked`
              : `All ${ok} checked script, stylesheet and font resource(s) load`,
          value: ok,
        });
      } else if (assets.length === 0 && notChecked === 0) {
        checks.push({
          name: "broken-resources",
          status: "pass",
          message: "No same-site scripts, stylesheets or fonts to check",
          value: 0,
        });
      }
    }

    return { checks };
  },
};
