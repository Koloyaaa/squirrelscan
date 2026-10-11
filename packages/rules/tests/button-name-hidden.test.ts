// a11y/button-name: hidden buttons are out of the accessibility tree, pub#665.
//
// squirrel 0.0.108 reported `Buttons without accessible names` for empty
// buttons inside a CSS-hidden, `hidden` or `aria-hidden` ancestor. None of them
// is in the accessibility tree, so the rule does not apply to them (W3C ACT
// 97a4e1, Inapplicable Example 2). The rule now asks the shared static
// visibility check (src/shared/static-hidden.ts), the same one
// a11y/aria-hidden-focus uses (pub#664).

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { buttonNameRule } from "../src/a11y/button-name";
import type { ParsedPage, RuleContext } from "../src/types";

function run(html: string): CheckResult[] {
  const url = "https://example.com/";
  const ctx: RuleContext = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  };
  return buttonNameRule.run(ctx).checks as CheckResult[];
}

function check(checks: CheckResult[], name: string): CheckResult | undefined {
  return checks.find((c) => c.name === name);
}

/** The issue's page shell, byte for byte. */
function fixture(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Button name control</title></head><body><main>${body}</main></body></html>`;
}

/** The repro's six cases (pub#665). */
const CASES = {
  bad: "<button></button>",
  title: '<button title="Zoom in"></button>',
  named: '<button aria-label="Zoom in"></button>',
  css: "<style>.closed{display:none}</style><div class=\"closed\"><button></button></div>",
  hidden: "<div hidden><button></button></div>",
  aria: '<div aria-hidden="true"><button></button></div>',
};

function statuses(html: string): Record<string, string> {
  return Object.fromEntries(run(html).map((c) => [c.name, c.status]));
}

describe("a11y/button-name: the six repro fixtures (pub#665)", () => {
  test("bad: a visible unnamed button still fails", () => {
    const checks = run(fixture(CASES.bad));
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      name: "button-name",
      status: "fail",
      message: "Buttons without accessible names",
      items: [{ id: "button" }],
    });
  });

  for (const name of ["title", "named"] as const) {
    test(`${name}: a named button passes`, () => {
      const checks = run(fixture(CASES[name]));
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({
        name: "button-name",
        status: "pass",
        message: "All buttons have accessible names",
        details: { buttonsChecked: 1 },
      });
    });
  }

  for (const name of ["css", "hidden", "aria"] as const) {
    test(`${name}: an unnamed button in a hidden ancestor is not reported`, () => {
      const checks = run(fixture(CASES[name]));
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({
        name: "button-name",
        status: "pass",
        message: "All buttons in the accessibility tree have accessible names",
        details: { buttonsChecked: 1, hiddenWithoutName: 1 },
      });
    });
  }
});

describe("a11y/button-name: what counts as hidden", () => {
  test("an inline display:none or visibility:hidden ancestor, or on the button itself", () => {
    for (const body of [
      '<div style="display:none"><button></button></div>',
      '<div style="visibility:hidden"><button></button></div>',
      '<button style="display: none"></button>',
      '<input type="submit" value="" style="visibility:collapse">',
    ]) {
      expect(statuses(fixture(body))).toEqual({ "button-name": "pass" });
    }
  });

  test("an id rule, a compound rule and a descendant rule in a <style> block", () => {
    for (const body of [
      '<style>#zoom{display:none}</style><div id="zoom"><button></button></div>',
      '<style>.overlay.is-closed{visibility:hidden}</style><div class="overlay is-closed"><button></button></div>',
      '<style>.gallery .zoom-controls{display:none}</style><div class="gallery"><div class="zoom-controls"><button class="js-image-zoom-in"></button></div></div>',
      '<style>[data-state="closed"]{display:none}</style><div data-state="closed"><button></button></div>',
    ]) {
      expect(statuses(fixture(body))).toEqual({ "button-name": "pass" });
    }
  });

  test("a closed <dialog> and an unopened popover are hidden by the user-agent stylesheet", () => {
    expect(statuses(fixture("<dialog><button></button></dialog>"))).toEqual({
      "button-name": "pass",
    });
    expect(statuses(fixture("<div popover><button></button></div>"))).toEqual({
      "button-name": "pass",
    });
    expect(statuses(fixture("<dialog open><button></button></dialog>"))).toEqual({
      "button-name": "fail",
    });
  });

  test("a button inside <template> is not rendered", () => {
    expect(check(run(fixture("<template><button></button></template>")), "button-name")?.status).not.toBe("fail");
  });

  test("off-screen and merely disabled buttons are not treated as hidden", () => {
    for (const body of [
      '<button style="position:absolute;left:-9999px"></button>',
      '<style>.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style><button class="sr-only"></button>',
      '<button style="opacity:0"></button>',
      "<button disabled></button>",
      '<input type="button" disabled>',
    ]) {
      const checks = run(fixture(body));
      expect(check(checks, "button-name")?.status).toBe("fail");
    }
  });

  test("hidden=until-found does not hide, and aria-hidden=false does not either", () => {
    expect(statuses(fixture('<div hidden="until-found"><button></button></div>'))).toEqual({
      "button-name": "fail",
    });
    expect(statuses(fixture('<div aria-hidden="false"><button></button></div>'))).toEqual({
      "button-name": "fail",
    });
  });

  test("a hidden and a visible unnamed button: only the visible one fails", () => {
    const checks = run(
      fixture(
        '<style>.closed{display:none}</style><div class="closed"><button id="zoom-in"></button></div><button id="cart"></button>',
      ),
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ status: "fail", items: [{ id: "button#cart" }] });
  });
});

describe("a11y/button-name: CSS a static read cannot settle", () => {
  test("a closed overlay a :hover rule opens is an unconfirmed warning, not a failure", () => {
    const checks = run(
      fixture(
        '<style>.zoom-controls{display:none}.gallery:hover .zoom-controls{display:flex}</style><div class="gallery"><div class="zoom-controls"><button class="zoom-in"></button></div></div>',
      ),
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      name: "button-name-unconfirmed",
      status: "warn",
      message: "1 button(s) without accessible names may be hidden by the page's CSS (unconfirmed)",
    });
    expect(checks[0].items?.[0]?.id).toBe("button.zoom-in");
    expect(checks[0].items?.[0]?.label).toContain(":hover");
  });

  test("a rule under @supports is unconfirmed, a rule under @media print is ignored", () => {
    expect(
      statuses(
        fixture(
          "<style>@supports (display:grid){.closed{display:none}}</style><div class=\"closed\"><button></button></div>",
        ),
      ),
    ).toEqual({ "button-name-unconfirmed": "warn" });
    expect(
      statuses(
        fixture(
          "<style>@media print{button{display:none}}</style><button></button>",
        ),
      ),
    ).toEqual({ "button-name": "fail" });
  });

  test("a responsive hide leaves the button failing: it is shown at other widths", () => {
    expect(
      statuses(
        fixture(
          "<style>@media (min-width: 768px){.menu-toggle{display:none}}</style><button class=\"menu-toggle\"></button>",
        ),
      ),
    ).toEqual({ "button-name": "fail" });
  });

  test("an external stylesheet is not read: a button it might hide still fails", () => {
    // HTTP mode does not fetch stylesheets; the limitation is in the rule's
    // solution text and docs.
    expect(
      statuses(
        `<!doctype html><html lang="en"><head><link rel="stylesheet" href="/app.css"><title>t</title></head><body><div class="modal"><button></button></div></body></html>`,
      ),
    ).toEqual({ "button-name": "fail" });
  });
});
