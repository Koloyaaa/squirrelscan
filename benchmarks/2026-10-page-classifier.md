# 2026-10 Page classifier

What the bundled page classifier costs, and what it adds to link findings
(squirrelscan/repo#2307). It reads each page's DOM once, after the crawl
parses it, and names the part of the page a link sits in where the markup
says nothing. The model ships inside the executable.

Machine: 16 GB Apple M2, macOS 15, other work running (load average 3 to 12,
swap nearly full), so absolute milliseconds are inflated. Compare the paired
rows. Bun 1.3.14.
Method: [`apps/cli/scripts/bench-classifier.ts`](../apps/cli/scripts/bench-classifier.ts).
Each page is parsed three times per variant, alternating, and the minimum is
kept. The model is loaded before timing starts and reported on its own.

## Per page

`parsePage` with and without the classifier hook, milliseconds per page.

| pages | HTML size | without, p50 / p95 | with, p50 / p95 | overhead p50 / p95 / max |
|---|---|---|---|---|
| 100 synthetic (`packages/synthetic-site`) | p50 58 KB, max 78 KB | 3.8 / 6.2 | 8.6 / 13.5 | 4.8 / 8.0 / 18.3 |
| 117 real pages from squirrelscan's own public sites | p50 106 KB, max 415 KB | 7.2 / 22.8 | 18.6 / 65.9 | 11.4 / 43.1 / 47.3 |

Model load is 17 to 31 ms, once, on the first classified page. No page hit the
500 ms per-page budget.

## Whole audit

`squirrel audit` of a 100-page synthetic site served locally (`--offline`,
`--max-pages 100`), three rounds, off and on interleaved, wall time:

| classifier | min | median |
|---|---|---|
| off (`--no-classifier`) | 3.76 s | 4.07 s |
| on | 4.15 s | 4.19 s |

About 4 ms a page, which is the per-page overhead above. Real sites are
fetch-bound, so the classifier is a small share of an audit.

## Binary and startup

| | before | after |
|---|---|---|
| `bun build --compile --splitting --minify` | 72.6 MB | 81.3 MB |
| `squirrel --version`, median of 11 cold runs | 37 ms | 37 ms |

The artifact is embedded as a file and read on the first classified page, so
commands that never audit do not parse it.

## What it adds

On sites with good markup, little. Of 14,477 links on 60 pages of squirrelscan's
own sites, 78 sat outside every landmark, and for those the model said "site
furniture" (which a finding cannot quote) or nothing. It named no section
purpose on any of them. The model is for pages without landmarks.

To see that, `--stripped` rewrites `nav`, `header`, `footer`, `aside`, `main`
and `article` to `div` and drops the roles, then asks the model alone where each
link sits, against what the original markup said (117 pages, 26,866 links).
It answers 11.4% of them, by design: every class has a threshold chosen for
precision. What it answers agrees with the markup:

| original markup | model, footer | model, content | model, navigation | model, no answer |
|---|---|---|---|---|
| footer | 1,185 | 0 | 0 | 900 |
| content | 9 | 1,323 | 0 | 656 |
| header | 0 | 0 | 462 | 628 |
| navigation | 40 | 1 | 0 | 10,779 |
| sidebar | 0 | 1 | 31 | 10,697 |

The artifact measured here is the v2.2 featurizer's, which is a placeholder for
the release artifact. Re-run both modes when it is swapped in.
