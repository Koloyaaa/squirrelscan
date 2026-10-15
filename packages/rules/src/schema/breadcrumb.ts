// schema/breadcrumb - BreadcrumbList schema validation

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { flattenJsonLdNodes } from "@squirrelscan/utils";

import { microdataAndRdfaTypes } from "./markup-types";

/**
 * Anchors the classifier must place in the breadcrumbs section before a missing
 * schema is a finding. One, not two: the current page is plain text in a trail, so
 * a short trail is a single link (`Docs / Security`). Measured on a small SaaS
 * site, every one of its 14 docs pages with a trail has exactly one such link, and
 * none has two.
 */
const MIN_TRAIL_LINKS = 1;

export const breadcrumbSchemaRule: Rule = {
  meta: {
    id: "schema/breadcrumb",
    name: "Breadcrumb Schema",
    description: "Checks for BreadcrumbList schema on non-homepage",
    solution:
      "BreadcrumbList schema shows navigation path in search results. Structure: BreadcrumbList with itemListElement array of ListItem. Each ListItem needs position (1, 2, 3...), name, and item (URL). The last item (current page) doesn't need a URL. Breadcrumbs help users understand site structure and improve click-through rates.",
    category: "schema",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const url = new URL(ctx.page.url);

    // Skip homepage
    if (url.pathname === "/" || url.pathname === "") {
      checks.push({
        name: "breadcrumb-schema",
        status: "info",
        message: "Homepage - breadcrumbs not typically needed",
      });
      return { checks };
    }

    const schemaScripts = doc.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    let breadcrumbSchema: Record<string, unknown> | null = null;

    for (const script of schemaScripts) {
      // Flattened per script, so a Yoast / Rank Math `@graph` wrapper is
      // descended into rather than read as one typeless node (#317). Per
      // SCRIPT and not over the joined `schema.raw`, because that join can
      // mis-split a pretty-printed block (#1099). Unparseable JSON yields an
      // empty list, which is what the old try/catch was for.
      const schemas = flattenJsonLdNodes(script.textContent || "");

      for (const schema of schemas) {
        const type = schema["@type"];
        if (
          type === "BreadcrumbList" ||
          (Array.isArray(type) && type.includes("BreadcrumbList"))
        ) {
          breadcrumbSchema = schema;
          break;
        }
      }
    }

    if (!breadcrumbSchema) {
      // The classifier's section head labels an anchor "breadcrumbs" only when it
      // sits in a trail (a high-precision class, and never a markup-rules answer),
      // so the page shows a trail that no structured data describes (#2307). With
      // the classifier off no link carries a section and this stays the info check.
      const trailLinks = (ctx.parsed.links ?? []).filter((link) => link.section === "breadcrumbs").length;
      // A trail marked up as microdata or RDFa (older themes) is described, just not
      // in JSON-LD, so it is not this finding.
      const hasMarkupTrail = microdataAndRdfaTypes(doc).some(
        (name) => name.toLowerCase() === "breadcrumblist"
      );
      if (trailLinks >= MIN_TRAIL_LINKS && !hasMarkupTrail) {
        checks.push({
          name: "breadcrumb-schema",
          status: "fail",
          message: "A breadcrumb trail on the page has no BreadcrumbList schema",
          value: "Add BreadcrumbList JSON-LD that mirrors the trail",
          details: { trailLinks },
        });
        return { checks };
      }
      checks.push({
        name: "breadcrumb-schema",
        status: "info",
        message: "No BreadcrumbList schema found",
        value: "Consider adding for non-homepage",
      });
      return { checks };
    }

    // Check itemListElement
    const items = breadcrumbSchema["itemListElement"];
    if (!items || !Array.isArray(items) || items.length === 0) {
      checks.push({
        name: "breadcrumb-items",
        status: "warn",
        message: "BreadcrumbList has no items",
      });
      return { checks };
    }

    // Validate items
    let hasValidItems = true;
    let lastPosition = 0;

    for (const item of items) {
      const position = item["position"];
      const name = item["name"];

      if (!position || !name) {
        hasValidItems = false;
      }

      if (typeof position === "number" && position !== lastPosition + 1) {
        checks.push({
          name: "breadcrumb-order",
          status: "warn",
          message: "Breadcrumb positions not sequential",
        });
      }
      lastPosition = position;
    }

    if (hasValidItems) {
      checks.push({
        name: "breadcrumb-valid",
        status: "pass",
        message: `BreadcrumbList has ${items.length} item(s)`,
      });
    } else {
      checks.push({
        name: "breadcrumb-items",
        status: "warn",
        message: "Some breadcrumb items missing position or name",
      });
    }

    return { checks };
  },
};
