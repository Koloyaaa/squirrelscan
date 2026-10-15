// Types a page declares in microdata (`itemtype`) and RDFa (`typeof`) markup.
//
// The parser's `schemas` collection reads JSON-LD only. A rule that says "this page
// declares no Product" must not say it about a page that declares one in microdata,
// which older themes and some shop platforms still emit instead of JSON-LD, so the
// rules that make a "declares none" claim read these too.

/** Upper bound on annotated elements read, so a hostile page cannot make this walk unbounded. */
const MAX_ANNOTATED_ELEMENTS = 5000;

/** `https://schema.org/Product`, `schema:Product` and `Product` all read as `Product`. */
export function bareTypeName(raw: string): string {
  const parts = raw.trim().split(/[/#:]/);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]) return parts[i]!;
  }
  return "";
}

/**
 * The bare type names from every `itemtype` and `typeof` attribute, in document
 * order, with duplicates kept. Both attributes hold a space-separated list.
 */
export function microdataAndRdfaTypes(doc: Document | null | undefined): string[] {
  if (!doc) return [];
  const names: string[] = [];
  let seen = 0;
  for (const el of doc.querySelectorAll("[itemtype], [typeof]")) {
    if (++seen > MAX_ANNOTATED_ELEMENTS) break;
    for (const attr of ["itemtype", "typeof"] as const) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      for (const token of value.split(/\s+/)) {
        const bare = bareTypeName(token);
        if (bare) names.push(bare);
      }
    }
  }
  return names;
}
