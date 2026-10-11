// a11y/aria-hidden-focus: controls hidden by CSS are not focusable, pub#664.
//
// squirrel 0.0.108 reported `1 focusable element(s) inside aria-hidden` for a
// button inside an aria-hidden container hidden by `display:none` or
// `visibility:hidden` from a document `<style>` rule. Neither can be reached
// with Tab (W3C ACT 6cfa84, Passed Example 2). The rule now asks the shared
// static visibility check (src/shared/static-hidden.ts), which reads inline
// styles and the page's own `<style>` blocks; where that CSS cannot be settled
// statically the element is reported as an unconfirmed warning, not a failure.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { ariaHiddenFocusRule } from "../src/a11y/aria-hidden-focus";
import type { ParsedPage, RuleContext } from "../src/types";

function run(html: string): CheckResult[] {
  const url = "https://example.com/";
  const ctx: RuleContext = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  };
  return ariaHiddenFocusRule.run(ctx).checks as CheckResult[];
}

function check(checks: CheckResult[], name: string): CheckResult | undefined {
  return checks.find((c) => c.name === name);
}

/** The issue's page shell, byte for byte. */
function fixture(variant: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Hidden focus fixture</title></head><body><h1>Fixture</h1>${variant}</body></html>`;
}

/** The repro's six variants (pub#664). */
const VARIANTS = {
  bad: '<div aria-hidden="true"><button>Close</button></div>',
  "display-none":
    '<style>.modal{display:none}</style><div class="modal" aria-hidden="true"><button>Close</button></div>',
  hidden: '<div hidden aria-hidden="true"><button>Close</button></div>',
  "visibility-hidden":
    '<style>.modal{visibility:hidden}</style><div class="modal" aria-hidden="true"><button>Close</button></div>',
  inert: '<div inert aria-hidden="true"><button>Close</button></div>',
  disabled: '<div aria-hidden="true"><button disabled>Close</button></div>',
};

function statuses(html: string): Record<string, string> {
  return Object.fromEntries(run(html).map((c) => [c.name, c.status]));
}

describe("a11y/aria-hidden-focus: the six repro fixtures (pub#664)", () => {
  test("bad: a visible button inside aria-hidden still fails", () => {
    const checks = run(fixture(VARIANTS.bad));
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      name: "aria-hidden-focus",
      status: "fail",
      message: "1 focusable element(s) inside aria-hidden",
      items: [{ id: "button" }],
    });
  });

  for (const name of [
    "display-none",
    "hidden",
    "visibility-hidden",
    "inert",
    "disabled",
  ] as const) {
    test(`${name}: passes`, () => {
      expect(statuses(fixture(VARIANTS[name]))).toEqual({ "aria-hidden-focus": "pass" });
    });
  }
});

describe("a11y/aria-hidden-focus: static CSS", () => {
  test("inline display:none or visibility:hidden on the container passes", () => {
    for (const style of ["display:none", "visibility: hidden", "DISPLAY: NONE !important"]) {
      expect(
        statuses(fixture(`<div style="${style}" aria-hidden="true"><a href="/x">x</a></div>`)),
      ).toEqual({ "aria-hidden-focus": "pass" });
    }
  });

  test("a stylesheet rule hiding an ancestor of the container passes", () => {
    expect(
      statuses(
        fixture(
          `<style>#overlay{display:none}</style><div id="overlay"><div aria-hidden="true"><button>b</button></div></div>`,
        ),
      ),
    ).toEqual({ "aria-hidden-focus": "pass" });
  });

  test("a child that sets visibility:visible inside a visibility:hidden container is still focusable", () => {
    const checks = run(
      fixture(
        `<style>.modal{visibility:hidden}</style><div class="modal" aria-hidden="true"><a href="/x" id="back" style="visibility:visible">x</a></div>`,
      ),
    );
    expect(check(checks, "aria-hidden-focus")?.status).toBe("fail");
    expect(check(checks, "aria-hidden-focus")?.items).toEqual([{ id: "a#back" }]);
  });

  test("a later, more specific rule that shows the container again keeps the failure", () => {
    // Bootstrap's open modal: `.modal` hides it, `.modal.show` shows it.
    const checks = run(
      fixture(
        `<style>.modal{display:none}.modal.show{display:block}</style><div class="modal show" aria-hidden="true"><button id="ok">OK</button></div>`,
      ),
    );
    expect(check(checks, "aria-hidden-focus")?.status).toBe("fail");
    // ...and the closed modal (no `.show`) passes.
    expect(
      statuses(
        fixture(
          `<style>.modal{display:none}.modal.show{display:block}</style><div class="modal" aria-hidden="true"><button>OK</button></div>`,
        ),
      ),
    ).toEqual({ "aria-hidden-focus": "pass" });
  });

  test("off-screen but focusable content is still reported", () => {
    for (const style of [
      "position:absolute;left:-9999px",
      "opacity:0",
      "width:0;height:0;overflow:hidden",
      "clip:rect(0 0 0 0);position:absolute",
    ]) {
      const checks = run(
        fixture(`<div aria-hidden="true" style="${style}"><a href="/x" id="off">x</a></div>`),
      );
      expect(check(checks, "aria-hidden-focus")?.status).toBe("fail");
    }
    // The same through a stylesheet class.
    const checks = run(
      fixture(
        `<style>.offscreen{position:absolute;left:-10000px}</style><div class="offscreen" aria-hidden="true"><a href="/x">x</a></div>`,
      ),
    );
    expect(check(checks, "aria-hidden-focus")?.status).toBe("fail");
  });

  test("a rule in a print stylesheet does not hide anything on screen", () => {
    const checks = run(
      fixture(
        `<style>@media print{.modal{display:none}}</style><div class="modal" aria-hidden="true"><button>b</button></div>`,
      ),
    );
    expect(check(checks, "aria-hidden-focus")?.status).toBe("fail");
  });

  test("a region under the hidden attribute is skipped as before, whatever CSS may do to it", () => {
    // The rule only ever moves a finding to pass or to unconfirmed: the plain
    // `hidden` skip it always had is not handed to the CSS check.
    for (const variant of [
      `<div hidden style="display:block" aria-hidden="true"><button>b</button></div>`,
      `<style>.menu:hover div{display:block}</style><div class="menu"><div hidden aria-hidden="true"><button>b</button></div></div>`,
      `<style>@media (min-width:600px){[hidden]{display:block}}</style><div hidden aria-hidden="true"><button>b</button></div>`,
      `${"<style>.q{color:red}</style>".repeat(1_001)}<div hidden aria-hidden="true"><button>b</button></div>`,
    ]) {
      expect(statuses(fixture(variant))).toEqual({ "aria-hidden-focus": "pass" });
    }
  });

  test("a CSS-hidden honeypot is neither an error nor a honeypot warning", () => {
    expect(
      statuses(
        fixture(
          `<style>.hp{display:none}</style><form><div class="hp" aria-hidden="true"><input id="contact-hp" name="contact-hp"></div></form>`,
        ),
      ),
    ).toEqual({ "aria-hidden-focus": "pass" });
  });
});

describe("a11y/aria-hidden-focus: CSS a static read cannot settle", () => {
  test("a rule the page's CSS may apply makes the finding an unconfirmed warning, not a failure", () => {
    const cases: Array<[string, string]> = [
      // Hidden, but a :hover rule shows it again.
      [
        `<style>.menu{display:none}.nav:hover .menu{display:block}</style><nav class="nav"><div class="menu" aria-hidden="true"><a href="/x">x</a></div></nav>`,
        "interactive",
      ],
      // Hidden on wide screens only.
      [
        `<style>.drawer{display:none}@media (max-width: 600px){.drawer{display:block}}</style><div class="drawer" aria-hidden="true"><a href="/x">x</a></div>`,
        "conditional",
      ],
      // A selector the check does not evaluate.
      [
        `<style>.panel:has(> .closed){display:none}</style><div class="panel" aria-hidden="true"><a href="/x">x</a></div>`,
        "selector",
      ],
      // A custom property.
      [
        `<style>.sheet{display:var(--sheet-display)}</style><div class="sheet" aria-hidden="true"><a href="/x">x</a></div>`,
        "value",
      ],
    ];
    for (const [variant, reason] of cases) {
      const checks = run(fixture(variant));
      expect(check(checks, "aria-hidden-focus")).toBeUndefined();
      const warn = check(checks, "aria-hidden-focus-unconfirmed");
      expect(warn?.status).toBe("warn");
      expect(warn?.message).toBe(
        "1 focusable element(s) inside aria-hidden may be hidden by the page's CSS (unconfirmed)",
      );
      expect(warn?.items?.[0]?.id).toBe("a");
      expect(warn?.items?.[0]?.label).toContain(
        { interactive: ":hover", conditional: "@media", selector: "selector", value: "variable" }[
          reason
        ] as string,
      );
    }
  });

  test("a media query that hides a shown control does not unconfirm it: it is shown elsewhere", () => {
    const checks = run(
      fixture(
        `<style>@media (max-width: 600px){.promo{display:none}}</style><div class="promo" aria-hidden="true"><a href="/x">x</a></div>`,
      ),
    );
    expect(check(checks, "aria-hidden-focus")?.status).toBe("fail");
    expect(check(checks, "aria-hidden-focus-unconfirmed")).toBeUndefined();
  });

  test("confirmed and unconfirmed findings are reported side by side", () => {
    const checks = run(
      fixture(
        `<style>.menu{display:none}.nav:hover .menu{display:block}</style><div aria-hidden="true"><a href="/a" id="seen">a</a></div><nav class="nav"><div class="menu" aria-hidden="true"><a href="/b" id="maybe">b</a></div></nav>`,
      ),
    );
    expect(check(checks, "aria-hidden-focus")?.items).toEqual([{ id: "a#seen" }]);
    expect(check(checks, "aria-hidden-focus-unconfirmed")?.items?.map((i) => i.id)).toEqual([
      "a#maybe",
    ]);
  });
});
