// reliability/broken-forms - forms that silently lose submissions (#707)
//
// Two causes that look fine from the outside. A control with no `name` is shown,
// filled in and never sent, because the browser submits only named controls. A
// form whose `action` answers 404, points at a staging or localhost host, or is
// `mailto:` never reaches a handler, and the visitor is shown a success page anyway.
//
// Field checks read the DOM the crawl already parsed. Action checks reuse the
// crawl's status for a same-site URL. Anything else gets at most one probe per
// distinct action URL, through the shared probe budget: HEAD, then GET when HEAD is
// refused (405/501) or fails at the network level. The probe method type is
// `"HEAD" | "GET"`, so no POST can be sent and no submission can happen.

import type { CheckItem, CheckResult } from "@squirrelscan/core-contracts";
import { normalizeUrl } from "@squirrelscan/utils";
import { isRateLimitedResponse } from "@squirrelscan/utils/rate-limit";

import { classifyHost, siteOriginOf } from "../content/dev-leakage";
import type { ProbeBudget } from "../probe-budget";
import { fieldSelector, fieldSnippet, formSelector, inputType } from "../shared/form-fields";
import type { ExternalLinkCheckData, Rule, RuleContext, RuleResult, SiteData } from "../types";

/** Per-request cap, on top of the shared budget's deadline. */
const PROBE_TIMEOUT_MS = 10_000;

/** Control types that never carry a submitted name of their own. */
const UNNAMEABLE_TYPES = new Set(["submit", "button", "reset", "image"]);

/** Submit controls whose `formaction` overrides the owning form's action. */
const FORMACTION_SUBMITTERS =
  'button[formaction]:not([type="button" i]):not([type="reset" i]), input[type="submit" i][formaction], input[type="image" i][formaction]';

const REASON_PASSIVE = "passive probing sends no requests";
const REASON_BUDGET = "probe budget exhausted";
const REASON_EXTERNAL_OFF = "external link checking is off";

type Method = "HEAD" | "GET";

interface Sent {
  status: number | null;
  error: string | null;
  retryAfter: string | null;
  challenge: boolean;
}

/** How one action URL reads. */
type Reach =
  | { kind: "ok" }
  /** A first-party action that answers 404 or 410: submissions are lost. */
  | { kind: "dead"; status: number }
  /** 5xx, a network failure, or a third-party 404/410. */
  | { kind: "unreachable"; detail: string }
  /** Throttled, or a WAF challenge: the status says nothing about the handler. */
  | { kind: "unverified"; detail: string }
  /** Nothing was sent, or nothing is known. */
  | { kind: "unchecked"; reason: string };

/** Where a form action points, before any request. */
type Target =
  | { kind: "skip" }
  | { kind: "mailto"; href: string }
  | { kind: "non-production"; href: string; host: string; classification: string }
  | { kind: "reach"; href: string; firstParty: boolean };

interface ActionSource {
  page: string;
  form: string;
  raw: string;
  attribute: "action" | "formaction";
}

interface UnnamedField {
  page: string;
  form: string;
  hasAction: boolean;
  field: string;
  type: string;
  snippet: string;
}

/** One finding bucket: a list of items, each with the pages it was seen on. */
class Bucket {
  private readonly items = new Map<
    string,
    { label: string; pages: Set<string>; meta: Record<string, unknown> }
  >();

  add(key: string, label: string, page: string, meta: Record<string, unknown> = {}): void {
    const existing = this.items.get(key);
    if (existing) {
      existing.pages.add(page);
      return;
    }
    this.items.set(key, { label, pages: new Set([page]), meta });
  }

  get size(): number {
    return this.items.size;
  }

  toItems(): CheckItem[] {
    return [...this.items.entries()].map(([key, v]) => ({
      id: key,
      label: v.label,
      sourcePages: [...v.pages],
      meta: v.meta,
    }));
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The site's own host or a subdomain of it, as broken-resources reads first-party. */
function isFirstParty(host: string, siteHostName: string | null): boolean {
  if (!siteHostName) return false;
  return host === siteHostName || host.endsWith(`.${siteHostName}`);
}

/** A real action: non-empty, not a fragment, not `javascript:`. */
function hasRealAction(raw: string): boolean {
  const value = raw.trim();
  return value !== "" && !value.startsWith("#") && !/^javascript:/i.test(value);
}

/** A control the browser would submit if it had a name. */
function isNameable(el: Element): boolean {
  if (el.hasAttribute("disabled")) return false;
  if (el.closest("template")) return false;
  return !UNNAMEABLE_TYPES.has(inputType(el));
}

function reachOf(sent: Sent, firstParty: boolean): Reach {
  if (sent.status === null) {
    return { kind: "unreachable", detail: `error: ${sent.error ?? "unknown"}` };
  }
  if (sent.challenge || isRateLimitedResponse(sent.status, sent.retryAfter)) {
    return { kind: "unverified", detail: `HTTP ${sent.status}` };
  }
  if (sent.status === 404 || sent.status === 410) {
    return firstParty
      ? { kind: "dead", status: sent.status }
      : { kind: "unreachable", detail: `HTTP ${sent.status}` };
  }
  if (sent.status >= 500) return { kind: "unreachable", detail: `HTTP ${sent.status}` };
  // 401, 403, 405 and 501 mean the endpoint exists and refuses this probe. Not broken.
  return { kind: "ok" };
}

/** Classify one action from the target's classification, before any request. */
function targetOf(raw: string, pageUrl: string, siteHostName: string | null): Target {
  const value = raw.trim();
  if (/^mailto:/i.test(value)) return { kind: "mailto", href: value };

  let resolved: URL;
  try {
    resolved = new URL(value, pageUrl);
  } catch {
    return { kind: "skip" };
  }
  // tel:, sms:, data: and friends never reach a handler this rule can judge.
  if (resolved.protocol !== "https:" && resolved.protocol !== "http:") return { kind: "skip" };
  resolved.hash = "";

  const host = resolved.hostname.toLowerCase();
  const origin = siteOriginOf(pageUrl);
  const dev = origin ? classifyHost(host, origin) : null;
  // A dev host is reported without a request: probing localhost or a staging host
  // from the audit would be a request to the wrong place.
  if (dev) {
    return { kind: "non-production", href: resolved.href, host, classification: dev.kind };
  }
  // Plain http: is an insecure submission. security/form-https reports it; this
  // rule never sends it a request.
  if (resolved.protocol === "http:") return { kind: "skip" };
  return { kind: "reach", href: resolved.href, firstParty: isFirstParty(host, siteHostName) };
}

/** One request, HEAD or GET. Null when the shared budget does not allow it. */
async function send(budget: ProbeBudget, url: string, method: Method): Promise<Sent | null> {
  if (!budget.allows("quiet")) return null;
  const signal = AbortSignal.any([budget.signal(), AbortSignal.timeout(PROBE_TIMEOUT_MS)]);
  // Counted before the request leaves, so a request that fails still uses budget.
  budget.record();
  try {
    const res = await globalThis.fetch(url, {
      method,
      redirect: "manual",
      signal,
      headers: { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
    });
    await res.body?.cancel().catch(() => {});
    return {
      status: res.status,
      error: null,
      retryAfter: res.headers.get("retry-after"),
      challenge: res.headers.get("cf-mitigated") === "challenge",
    };
  } catch (err) {
    return {
      status: null,
      error: err instanceof Error ? err.name || err.message : String(err),
      retryAfter: null,
      challenge: false,
    };
  }
}

/** The reason a probe was refused: passive by level, otherwise the budget. */
function refusalReason(budget: ProbeBudget | undefined): string {
  return !budget || budget.level === "passive" ? REASON_PASSIVE : REASON_BUDGET;
}

/** HEAD first; GET only when HEAD is refused (405/501) or fails at the network level. */
async function probeReach(budget: ProbeBudget, url: string, firstParty: boolean): Promise<Reach> {
  const head = await send(budget, url, "HEAD");
  if (head === null) return { kind: "unchecked", reason: refusalReason(budget) };
  let sent = head;
  if (head.status === null || head.status === 405 || head.status === 501) {
    const get = await send(budget, url, "GET");
    if (get === null) return { kind: "unchecked", reason: refusalReason(budget) };
    sent = get;
  }
  return reachOf(sent, firstParty);
}

export const brokenFormsRule: Rule = {
  meta: {
    id: "reliability/broken-forms",
    name: "Forms That Lose Submissions",
    description:
      "Checks that form fields are submitted (they have a name) and that form actions answer, not 404, a staging host or mailto:",
    solution:
      "A field without a name is never submitted, so its value is lost even though the visitor sees it filled in. Give every input, select and textarea a name that the handler reads. A form action that answers 404 or 410 loses every submission: point it at the endpoint that exists, or remove the form. Staging, preview, development and localhost hosts shipped to production lose submissions for every visitor: replace them with the production URL. A mailto: action only opens the visitor's mail client, so most submissions are lost: use a handler that stores or sends them.",
    category: "reliability",
    scope: "site",
    severity: "error",
    weight: 6,
  },

  async run(ctx: RuleContext): Promise<RuleResult> {
    const checks: CheckResult[] = [];
    const site: SiteData | undefined = ctx.site;

    if (!site?.pages) {
      checks.push({
        name: "broken-forms",
        status: "skipped",
        message: "Site data not available for form checks",
      });
      return { checks };
    }

    const siteHostName = hostOf(site.baseUrl);
    const crawled = new Map<string, number>();
    for (const page of site.pages) crawled.set(normalizeUrl(page.url), page.statusCode);
    const external = new Map<string, ExternalLinkCheckData>();
    for (const link of site.externalLinks ?? []) external.set(normalizeUrl(link.href), link);

    // Pass 1: read every page's DOM for forms, unnamed controls and action sources.
    let formCount = 0;
    const unnamed: UnnamedField[] = [];
    const sources: ActionSource[] = [];
    for (const page of site.pages) {
      const doc = page.parsed?.document;
      if (!doc) continue;
      const pageUrl = page.finalUrl || page.url;
      const forms: Element[] = [...doc.querySelectorAll("form")];
      formCount += forms.length;

      // The first form with each id wins, as the browser associates `form=` with it.
      const byId = new Map<string, Element>();
      for (const form of forms) {
        const id = form.getAttribute("id");
        if (id && !byId.has(id)) byId.set(id, form);
      }
      // `form=` overrides ancestry, and a `form=` that names no form owns nothing.
      const ownerOf = (el: Element): Element | null => {
        const attr = el.getAttribute("form");
        if (attr !== null) return byId.get(attr) ?? null;
        return el.closest("form");
      };
      const selectorOf = (form: Element): string => formSelector(form, forms.indexOf(form));

      const realAction = new Map<Element, string>();
      for (const form of forms) {
        const raw = form.getAttribute("action");
        if (raw !== null && hasRealAction(raw)) realAction.set(form, raw.trim());
      }

      for (const el of doc.querySelectorAll("input, select, textarea")) {
        if (!isNameable(el)) continue;
        if ((el.getAttribute("name") ?? "") !== "") continue;
        const owner = ownerOf(el);
        if (!owner) continue;
        unnamed.push({
          page: pageUrl,
          form: selectorOf(owner),
          hasAction: realAction.has(owner),
          field: fieldSelector(el),
          type: inputType(el),
          snippet: fieldSnippet(el, 200),
        });
      }

      for (const [form, raw] of realAction) {
        sources.push({ page: pageUrl, form: selectorOf(form), raw, attribute: "action" });
      }
      for (const el of doc.querySelectorAll(FORMACTION_SUBMITTERS)) {
        const raw = el.getAttribute("formaction");
        if (raw === null || !hasRealAction(raw)) continue;
        const owner = ownerOf(el);
        if (!owner) continue;
        sources.push({
          page: pageUrl,
          form: selectorOf(owner),
          raw: raw.trim(),
          attribute: "formaction",
        });
      }
    }

    // Pass 2: where each distinct action goes. One verdict per resolved URL.
    const dead = new Bucket();
    const nonProduction = new Bucket();
    const mailto = new Bucket();
    const unreachable = new Bucket();
    const unverified = new Bucket();
    const unchecked = new Bucket();
    const uncheckedReasons = new Set<string>();
    const verdicts = new Map<string, Reach>();

    for (const source of sources) {
      const target = targetOf(source.raw, source.page, siteHostName);
      if (target.kind === "skip") continue;
      if (target.kind === "mailto") {
        mailto.add(`${source.form}\n${target.href}`, `${source.form} submits with ${target.href}: this opens the visitor's mail client and loses the submission otherwise`, source.page, { href: target.href });
        continue;
      }
      if (target.kind === "non-production") {
        nonProduction.add(
          `${source.form}\n${target.href}`,
          `${source.form} submits to ${target.href} (${target.classification} host)`,
          source.page,
          { href: target.href, host: target.host, classification: target.classification },
        );
        continue;
      }

      let reach = verdicts.get(target.href);
      if (!reach) {
        reach = await verdictFor(ctx, site, crawled, external, target.href, target.firstParty);
        verdicts.set(target.href, reach);
      }
      const key = `${source.form}\n${target.href}`;
      switch (reach.kind) {
        case "ok":
          break;
        case "dead":
          dead.add(key, `${source.form} submits to ${target.href} (HTTP ${reach.status}): submissions are lost`, source.page, { href: target.href, status: reach.status });
          break;
        case "unreachable":
          unreachable.add(key, `${source.form} submits to ${target.href} (${reach.detail})`, source.page, { href: target.href, detail: reach.detail });
          break;
        case "unverified":
          unverified.add(key, `${source.form} submits to ${target.href} (${reach.detail}): not verified, not reported as broken`, source.page, { href: target.href, detail: reach.detail });
          break;
        case "unchecked":
          uncheckedReasons.add(reach.reason);
          unchecked.add(key, `${source.form} submits to ${target.href}: not checked (${reach.reason})`, source.page, { href: target.href, reason: reach.reason });
          break;
      }
    }

    // Pass 3: unnamed controls, split by whether the form posts to a real action.
    const unnamedWarn = new Bucket();
    const unnamedInfo = new Bucket();
    for (const field of unnamed) {
      const key = `${field.form}\n${field.field}`;
      if (field.hasAction) {
        unnamedWarn.add(
          key,
          `${field.field} (${field.type}) in ${field.form} has no name, so the browser never submits it`,
          field.page,
          { form: field.form, field: field.field, type: field.type, snippet: field.snippet },
        );
      } else {
        unnamedInfo.add(
          key,
          `${field.field} (${field.type}) in ${field.form} has no name; the form has no action, so a script may read it`,
          field.page,
          { form: field.form, field: field.field, type: field.type, snippet: field.snippet },
        );
      }
    }

    if (dead.size > 0) {
      checks.push({
        name: "dead-form-action",
        status: "fail",
        message: `${dead.size} form action(s) answer 404 or 410: submissions are lost`,
        items: dead.toItems(),
        details: { count: dead.size },
      });
    }
    if (nonProduction.size > 0) {
      checks.push({
        name: "non-production-form-action",
        status: "warn",
        message: `${nonProduction.size} form action(s) point at a staging, preview, development or localhost host`,
        items: nonProduction.toItems(),
        details: { count: nonProduction.size },
      });
    }
    if (mailto.size > 0) {
      checks.push({
        name: "mailto-form-action",
        status: "warn",
        message: `${mailto.size} form action(s) use mailto:, which loses submissions unless the visitor's mail client sends them`,
        items: mailto.toItems(),
        details: { count: mailto.size },
      });
    }
    if (unreachable.size > 0) {
      checks.push({
        name: "unreachable-form-action",
        status: "warn",
        message: `${unreachable.size} form action(s) answer 5xx, fail at the network level, or are gone on a third-party host`,
        items: unreachable.toItems(),
        details: { count: unreachable.size },
      });
    }
    if (unnamedWarn.size > 0) {
      checks.push({
        name: "unnamed-form-fields",
        status: "warn",
        message: `${unnamedWarn.size} field(s) with no name in forms that post to an action: the browser does not submit them`,
        items: unnamedWarn.toItems(),
        details: { count: unnamedWarn.size },
      });
    }
    if (unnamedInfo.size > 0) {
      checks.push({
        name: "unnamed-form-fields-no-action",
        status: "info",
        message: `${unnamedInfo.size} field(s) with no name in forms without a real action: a script may read them, so they are not reported as broken`,
        items: unnamedInfo.toItems(),
        details: { count: unnamedInfo.size },
      });
    }
    if (unverified.size > 0) {
      checks.push({
        name: "unverified-form-actions",
        status: "info",
        message: `${unverified.size} form action(s) were throttled, challenged or returned 503 with Retry-After: unverified, not reported as broken`,
        items: unverified.toItems(),
        details: { count: unverified.size },
      });
    }
    if (unchecked.size > 0) {
      const reasons = [...uncheckedReasons].join("; ");
      checks.push({
        name: "unchecked-form-actions",
        status: "info",
        message: `${unchecked.size} form action(s) not checked: ${reasons}`,
        items: unchecked.toItems(),
        details: { count: unchecked.size, reasons: [...uncheckedReasons] },
      });
    }

    const hasProblem =
      dead.size + nonProduction.size + mailto.size + unreachable.size + unnamedWarn.size > 0;
    if (formCount === 0) {
      checks.push({ name: "broken-forms", status: "info", message: "No forms detected" });
    } else if (!hasProblem && unchecked.size === 0 && unverified.size === 0 && unnamedInfo.size === 0) {
      checks.push({
        name: "broken-forms",
        status: "pass",
        message: `All ${formCount} form(s) name their fields and their actions answer`,
        value: formCount,
      });
    }

    return { checks };
  },
};

/**
 * The verdict for one resolved action URL: the crawl's status for a same-site
 * URL, the external checker's row for a third-party URL, or one probe.
 */
async function verdictFor(
  ctx: RuleContext,
  site: SiteData,
  crawled: Map<string, number>,
  external: Map<string, ExternalLinkCheckData>,
  href: string,
  firstParty: boolean,
): Promise<Reach> {
  const normalized = normalizeUrl(href);

  if (firstParty) {
    const status = crawled.get(normalized);
    if (status !== undefined) {
      if (status === 0) return { kind: "unchecked", reason: "the crawl did not fetch it" };
      return reachOf({ status, error: null, retryAfter: null, challenge: false }, true);
    }
    if (!ctx.probe || ctx.probe.level === "passive") {
      return { kind: "unchecked", reason: refusalReason(ctx.probe) };
    }
    return probeReach(ctx.probe, href, true);
  }

  // Third-party: only when external link checking ran for this audit.
  if (site.externalLinks === undefined) return { kind: "unchecked", reason: REASON_EXTERNAL_OFF };
  const link = external.get(normalized);
  if (link) {
    if (link.rateLimited === true || link.wafBlocked === true) {
      return { kind: "unverified", detail: link.status !== null ? `HTTP ${link.status}` : "throttled" };
    }
    if (link.status === null && link.error === null) {
      return { kind: "unchecked", reason: "the external check did not run" };
    }
    return reachOf({ status: link.status, error: link.error, retryAfter: null, challenge: false }, false);
  }
  if (!ctx.probe || ctx.probe.level === "passive") {
    return { kind: "unchecked", reason: refusalReason(ctx.probe) };
  }
  return probeReach(ctx.probe, href, false);
}
