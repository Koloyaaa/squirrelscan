// shared/static-hidden: whether a static read of the page proves an element is
// out of the accessibility tree (pub#664, pub#665). The rule tests cover the
// issues' fixtures; these pin the cascade and selector details under them.

import { describe, expect, test } from "bun:test";

import { parseHTML } from "@squirrelscan/parser/dom";

import { createStaticVisibility, mediaCondition } from "../src/shared/static-hidden";

/** The verdict for `#t` (state, plus the reason when unknown). */
function verdict(body: string, head = "", ariaHidden = true): string {
  const { document } = parseHTML(
    `<!doctype html><html><head>${head}</head><body>${body}</body></html>`,
  );
  const target = document.querySelector("#t");
  if (!target) throw new Error("fixture has no #t");
  const seen = createStaticVisibility(document, { ariaHidden }).visibility(
    target as unknown as Element,
  );
  return seen.state === "unknown" ? `unknown:${seen.reason}` : seen.state;
}

describe("static-hidden: markup", () => {
  test("hidden, aria-hidden (when asked), template, closed dialog, popover", () => {
    expect(verdict('<div hidden><b id="t"></b></div>')).toBe("hidden");
    expect(verdict('<div HIDDEN=""><b id="t"></b></div>')).toBe("hidden");
    expect(verdict('<div hidden="until-found"><b id="t"></b></div>')).toBe("shown");
    expect(verdict('<div hidden=" until-found "><b id="t"></b></div>')).toBe("hidden");
    expect(verdict('<div aria-hidden="true"><b id="t"></b></div>')).toBe("hidden");
    expect(verdict('<div aria-hidden="TRUE"><b id="t"></b></div>')).toBe("hidden");
    expect(verdict('<div aria-hidden="true"><b id="t"></b></div>', "", false)).toBe("shown");
    expect(verdict('<dialog><b id="t"></b></dialog>')).toBe("hidden");
    expect(verdict('<dialog open><b id="t"></b></dialog>')).toBe("shown");
    expect(verdict('<div popover="manual"><b id="t"></b></div>')).toBe("hidden");
  });

  test("a <template> subtree is never rendered", () => {
    // querySelectorAll does not walk into <template>, but its children are
    // reachable through the element, and a caller walking them gets "hidden".
    const { document } = parseHTML(
      "<!doctype html><html><body><template><b></b></template></body></html>",
    );
    const inner = document.querySelector("template")?.firstElementChild;
    expect(inner).toBeTruthy();
    const seen = createStaticVisibility(document, { ariaHidden: false }).visibility(
      inner as unknown as Element,
    );
    expect(seen.state).toBe("hidden");
  });

  test("an author display beats the user-agent [hidden] rule; revert restores it", () => {
    expect(verdict('<div hidden style="display:flex"><b id="t"></b></div>')).toBe("shown");
    expect(
      verdict('<div hidden class="x"><b id="t"></b></div>', "<style>.x{display:block}</style>"),
    ).toBe("shown");
    expect(verdict('<div hidden style="display:revert"><b id="t"></b></div>')).toBe("hidden");
    expect(verdict('<dialog style="display:block"><b id="t"></b></dialog>')).toBe("shown");
  });

  test("nothing hiding it: shown", () => {
    expect(verdict('<div><b id="t"></b></div>')).toBe("shown");
  });
});

describe("static-hidden: the cascade", () => {
  test("inline beats a sheet rule, !important in a sheet beats inline", () => {
    expect(
      verdict('<b id="t" class="x" style="display:inline"></b>', "<style>.x{display:none}</style>"),
    ).toBe("shown");
    expect(
      verdict(
        '<b id="t" class="x" style="display:inline"></b>',
        "<style>.x{display:none !important}</style>",
      ),
    ).toBe("hidden");
    expect(
      verdict(
        '<b id="t" class="x" style="display:inline !important"></b>',
        "<style>.x{display:none !important}</style>",
      ),
    ).toBe("shown");
  });

  test("specificity, then source order", () => {
    expect(
      verdict('<b id="t" class="x"></b>', "<style>#t{display:none}.x{display:block}</style>"),
    ).toBe("hidden");
    expect(
      verdict('<b id="t" class="x"></b>', "<style>.x{display:none}.x{display:block}</style>"),
    ).toBe("shown");
    expect(
      verdict(
        '<b id="t" class="x"></b>',
        "<style>.x{display:block}</style><style>b.x{display:none}</style>",
      ),
    ).toBe("hidden");
  });

  test("display:none on any ancestor cannot be undone below it", () => {
    expect(
      verdict(
        '<div class="a"><b id="t" style="display:block"></b></div>',
        "<style>.a{display:none}</style>",
      ),
    ).toBe("hidden");
  });

  test("visibility inherits, and a descendant can set it back", () => {
    expect(verdict('<div style="visibility:hidden"><p><b id="t"></b></p></div>')).toBe("hidden");
    expect(
      verdict('<div style="visibility:hidden"><b id="t" style="visibility:visible"></b></div>'),
    ).toBe("shown");
    expect(
      verdict('<div style="visibility:hidden"><b id="t" style="visibility:inherit"></b></div>'),
    ).toBe("hidden");
    expect(
      verdict('<div style="visibility:hidden"><b id="t" style="visibility:initial"></b></div>'),
    ).toBe("shown");
  });

  test("an invalid value is dropped, as a browser drops it", () => {
    expect(verdict('<b id="t" style="display:none\\9"></b>')).toBe("shown");
    expect(verdict('<b id="t" style="visibility:nope"></b>')).toBe("shown");
  });

  test("a CSS variable cannot be settled", () => {
    expect(verdict('<b id="t" style="display:var(--d)"></b>')).toBe("unknown:value");
  });
});

describe("static-hidden: selectors", () => {
  test("escaped class names (Tailwind) match", () => {
    expect(
      verdict('<b id="t" class="md:hidden"></b>', "<style>.md\\:hidden{display:none}</style>"),
    ).toBe("hidden");
    expect(
      verdict('<b id="t" class="w-1/2"></b>', "<style>.w-1\\/2{visibility:hidden}</style>"),
    ).toBe("hidden");
  });

  test("combinators: child, descendant, adjacent and general sibling", () => {
    const head = "<style>.a > .b{display:none}.c + .d{display:none}.e ~ .f{display:none}</style>";
    expect(verdict('<div class="a"><b id="t" class="b"></b></div>', head)).toBe("hidden");
    expect(verdict('<div class="a"><i><b id="t" class="b"></b></i></div>', head)).toBe("shown");
    expect(verdict('<i class="c"></i><b id="t" class="d"></b>', head)).toBe("hidden");
    expect(verdict('<i class="c"></i><s></s><b id="t" class="d"></b>', head)).toBe("shown");
    expect(verdict('<i class="e"></i><s></s><b id="t" class="f"></b>', head)).toBe("hidden");
  });

  test(":not(), :is() and :where() with simple arguments are evaluated", () => {
    const head = "<style>.modal:not(.show){display:none}</style>";
    expect(verdict('<div class="modal"><b id="t"></b></div>', head)).toBe("hidden");
    expect(verdict('<div class="modal show"><b id="t"></b></div>', head)).toBe("shown");
    expect(verdict('<b id="t" class="y"></b>', "<style>:is(.x, .y){display:none}</style>")).toBe(
      "hidden",
    );
    // :where() adds no specificity: a plain .z rule beats it even when it comes first.
    expect(
      verdict(
        '<b id="t" class="z"></b>',
        "<style>.z{display:none}:where(.z){display:block}</style>",
      ),
    ).toBe("hidden");
    expect(
      verdict(
        '<b id="t" class="z"></b>',
        "<style>:where(.z){display:none}b{display:block}</style>",
      ),
    ).toBe("shown");
  });

  test("comments before or inside a selector are dropped", () => {
    expect(verdict('<b id="t" class="x"></b>', "<style>/*!sc*/\n.x{display:none}</style>")).toBe(
      "hidden",
    );
    expect(
      verdict('<b id="t" hidden></b>', "<style>/* fix */ *[hidden]{display:none}</style>"),
    ).toBe("hidden");
    expect(verdict('<b id="t" class="a b"></b>', "<style>.a/**/.b{display:none}</style>")).toBe(
      "hidden",
    );
    expect(
      verdict(
        '<b id="t" class="x"></b>',
        "<style>@media /* wide */ print{.x{display:none}}</style>",
      ),
    ).toBe("shown");
  });

  test(":defined holds for built-in elements", () => {
    expect(verdict('<b id="t"></b>', "<style>:not(:defined){visibility:hidden}</style>")).toBe(
      "shown",
    );
  });

  test("a pseudo-element rule does not hide the element", () => {
    expect(
      verdict('<b id="t" class="x"></b>', "<style>.x::before,.x:after{display:none}</style>"),
    ).toBe("shown");
  });

  test("attribute selectors", () => {
    const head =
      '<style>[data-state="closed"]{display:none}[aria-expanded=false i] + .p{display:none}</style>';
    expect(verdict('<b id="t" data-state="closed"></b>', head)).toBe("hidden");
    expect(verdict('<b id="t" data-state="open"></b>', head)).toBe("shown");
    expect(verdict('<i aria-expanded="FALSE"></i><b id="t" class="p"></b>', head)).toBe("hidden");
  });

  test("an interaction state, or a selector not evaluated, may change the answer", () => {
    expect(
      verdict(
        '<li class="m"><ul class="sub"><b id="t"></b></ul></li>',
        "<style>.sub{display:none}.m:hover > .sub{display:block}</style>",
      ),
    ).toBe("unknown:interactive");
    expect(
      verdict('<div class="p"><b id="t"></b></div>', "<style>.p:has(b){display:none}</style>"),
    ).toBe("unknown:selector");
    // A rule that cannot beat the certain winner changes nothing.
    expect(
      verdict(
        '<div id="d" class="p"><b id="t"></b></div>',
        "<style>#d{display:none}.p:hover{display:block}</style>",
      ),
    ).toBe("hidden");
    // Unparseable syntax: read loosely, as a rule that may apply.
    expect(
      verdict('<div class="p"><b id="t"></b></div>', "<style>ns|div .p{display:none}</style>"),
    ).toBe("unknown:selector");
  });
});

describe("static-hidden: conditions", () => {
  test("media query lists", () => {
    expect(mediaCondition("")).toBe("always");
    expect(mediaCondition("screen")).toBe("always");
    expect(mediaCondition("all")).toBe("always");
    expect(mediaCondition("print")).toBe("never");
    expect(mediaCondition("only print")).toBe("never");
    expect(mediaCondition("not print")).toBe("always");
    expect(mediaCondition("print, screen")).toBe("always");
    expect(mediaCondition("screen and (max-width: 600px)")).toBe("variant");
    expect(mediaCondition("(prefers-reduced-motion: reduce)")).toBe("variant");
    expect(mediaCondition("not screen and (color)")).toBe("conditional");
  });

  test("a <style media> attribute and <noscript> styles", () => {
    expect(
      verdict('<b id="t" class="x"></b>', '<style media="print">.x{display:none}</style>'),
    ).toBe("shown");
    expect(
      verdict('<b id="t" class="x"></b>', '<style media="screen">.x{display:none}</style>'),
    ).toBe("hidden");
    expect(
      verdict('<b id="t" class="x"></b>', '<style type="text/x-template">.x{display:none}</style>'),
    ).toBe("shown");
  });

  test("@layer and @supports rules may apply; @keyframes and @font-face hold no element rules", () => {
    expect(
      verdict('<b id="t" class="x"></b>', "<style>@layer base{.x{display:none}}</style>"),
    ).toBe("unknown:conditional");
    expect(
      verdict(
        '<b id="t" class="x"></b>',
        "<style>@supports (display:grid){.x{visibility:hidden}}</style>",
      ),
    ).toBe("unknown:conditional");
    expect(
      verdict(
        '<b id="t"></b>',
        "<style>@keyframes fade{from{visibility:visible}to{visibility:hidden}}@font-face{font-family:x}</style>",
      ),
    ).toBe("shown");
  });

  test("a stylesheet larger than the scan budget leaves every CSS verdict unknown", () => {
    const filler = ".f{color:red}".repeat(80_000);
    expect(verdict('<b id="t"></b>', `<style>${filler}</style>`)).toBe("unknown:truncated");
    // Markup-proven hiding still holds.
    expect(
      verdict('<div aria-hidden="true"><b id="t"></b></div>', `<style>${filler}</style>`),
    ).toBe("hidden");
  });
});

describe("static-hidden: cases a browser shows that a naive read would hide", () => {
  test("a later declaration in the same block wins, and !important beats it", () => {
    expect(verdict('<b id="t"></b>', "<style>b{display:none;display:block}</style>")).toBe("shown");
    expect(
      verdict('<b id="t"></b>', "<style>b{visibility:hidden;visibility:visible}</style>"),
    ).toBe("shown");
    expect(
      verdict('<b id="t"></b>', "<style>b{display:none!important;display:block}</style>"),
    ).toBe("hidden");
    expect(verdict('<b id="t"></b>', "<style>b{display:none;display:nope}</style>")).toBe("hidden");
  });

  test("a comment before a property does not hide the declaration", () => {
    expect(
      verdict('<b id="t"></b>', "<style>b{display:none}b{/* override */display:block}</style>"),
    ).toBe("shown");
    expect(verdict('<b id="t" style="/* x */display:none"></b>')).toBe("hidden");
  });

  test("escapes in attribute values are decoded", () => {
    expect(
      verdict('<b id="t" data-x="a"></b>', '<style>b:not([data-x="\\61"]){display:none}</style>'),
    ).toBe("shown");
  });

  test("an @layer rule may beat an unlayered !important one, whatever its specificity", () => {
    expect(
      verdict(
        '<b id="t"></b>',
        "<style>#t{display:none!important}@layer fixes{b{display:block!important}}</style>",
      ),
    ).toBe("unknown:conditional");
  });

  test("a selector argument not evaluated leaves the specificity unknown too", () => {
    expect(
      verdict(
        '<div id="p"><b id="t"></b></div>',
        "<style>#t{display:none}b:is(#p > b){display:block}</style>",
      ),
    ).toBe("unknown:selector");
  });

  test("inheriting visibility from an unsettled parent is unsettled", () => {
    expect(
      verdict(
        '<div class="p"><b id="t"></b></div>',
        "<style>.p{visibility:hidden}.p:hover{visibility:visible}b{visibility:hidden}.p:hover b{visibility:inherit}</style>",
      ),
    ).toBe("unknown:interactive");
  });

  test("an invalid selector voids the whole rule, so its valid siblings only may apply", () => {
    expect(verdict('<b id="t"></b>', "<style>b > {display:none}</style>")).toBe("unknown:selector");
    expect(verdict('<b id="t"></b>', "<style>b, i::-moz-placeholder{display:none}</style>")).toBe(
      "unknown:selector",
    );
    // A standard pseudo-element is valid: the rest of the list applies.
    expect(verdict('<b id="t"></b>', "<style>b, i::before{display:none}</style>")).toBe("hidden");
  });

  test("deeply nested selectors and huge selector lists stay bounded", () => {
    const nested = `${":is(".repeat(20_000)}b${")".repeat(20_000)}`;
    expect(["unknown:selector", "shown"]).toContain(
      verdict('<b id="t"></b>', `<style>${nested}{display:none}</style>`),
    );
    const list = Array.from({ length: 20_000 }, () => "*").join(",");
    const started = performance.now();
    expect(
      verdict('<b id="t"></b>', `<style>${list}{${"display:none;".repeat(20_000)}}</style>`),
    ).toBe("hidden");
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("static-hidden: second review round", () => {
  test("a certain match of unknown specificity cannot settle the cascade", () => {
    expect(
      verdict('<b id="t"></b>', "<style>#t{display:none}:is(b, :has(#x)){display:block}</style>"),
    ).toBe("unknown:selector");
  });

  test("a comment splits a token: `n/**/one` is not `none`", () => {
    expect(verdict('<b id="t" style="display:n/**/one"></b>')).toBe("shown");
    expect(verdict('<b id="t" class="a"></b>', "<style>.a/**/b{display:none}</style>")).toBe(
      "unknown:selector",
    );
  });

  test("an escaped combinator character stays inside a loosely read subject", () => {
    expect(
      verdict(
        '<b id="t" class="foo+bar"></b>',
        "<style>b{display:none}*|b.foo\\+bar{display:block}</style>",
      ),
    ).toBe("unknown:selector");
  });

  test("a vendor pseudo-element rule alone styles no element", () => {
    expect(verdict('<b id="t"></b>', "<style>::-webkit-scrollbar{display:none}</style>")).toBe(
      "shown",
    );
    expect(verdict('<b id="t"></b>', "<style>b::-webkit-scrollbar{display:none}</style>")).toBe(
      "shown",
    );
  });

  test("an empty entry or an unknown pseudo-element voids the whole list", () => {
    expect(verdict('<b id="t"></b>', "<style>b, {display:none}</style>")).toBe("unknown:selector");
    expect(verdict('<b id="t"></b>', "<style>b, i::madeup{display:none}</style>")).toBe(
      "unknown:selector",
    );
  });

  test("deeply nested at-rules stay bounded and read as conditional", () => {
    const css = `${"@media all{".repeat(20_000)}${"b{display:none}".repeat(19_000)}${"}".repeat(20_000)}`;
    const started = performance.now();
    expect(verdict('<b id="t"></b>', `<style>${css}</style>`)).toBe("unknown:conditional");
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("selectors that cannot be parsed still spend the page budget", () => {
    const css = "&{display:none}".repeat(19_000);
    const buttons = "<b></b>".repeat(2_000);
    const { document } = parseHTML(
      `<!doctype html><html><head><style>${css}</style></head><body>${buttons}<b id="t"></b></body></html>`,
    );
    const resolver = createStaticVisibility(document, { ariaHidden: false });
    const started = performance.now();
    for (const b of document.querySelectorAll("b")) resolver.visibility(b as unknown as Element);
    expect(performance.now() - started).toBeLessThan(3_000);
    const last = resolver.visibility(document.querySelector("#t") as unknown as Element);
    expect(last.state).toBe("unknown");
  });
});
