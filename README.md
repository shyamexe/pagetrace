# pagetrace

[![npm](https://img.shields.io/npm/v/pagetrace.svg)](https://www.npmjs.com/package/pagetrace)
[![CI](https://github.com/shyamexe/pagetrace/actions/workflows/ci.yml/badge.svg)](https://github.com/shyamexe/pagetrace/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/pagetrace.svg)](https://www.npmjs.com/package/pagetrace)
[![license](https://img.shields.io/npm/l/pagetrace.svg)](./LICENSE)

A lockfile for your SEO and AEO surface. Snapshot it, diff every build, fail CI on regressions.

Existing SEO and AEO tools tell you your score **right now**. They don't tell you that this deploy dropped the canonical tag from 400 pages, that a layout refactor added `noindex`, that a CMS migration stripped `Product` schema, or that someone quietly blocked `GPTBot` in `robots.txt`. Those regressions are silent for weeks until traffic moves.

`pagetrace` records the search-visible surface of your site into a committed `pagetrace.lock.json`, then diffs every build against it. It classifies by *transition*, not by state: a reworded title is `info`, a removed canonical is `error`. So you can fail the build on real regressions without drowning in noise from ordinary content edits.

## Install

```bash
npm install -D pagetrace
```

Requires Node 20.19 or newer. No native modules, three small dependencies.

## Use

Set up a config file and the first baseline in one step:

```bash
npx pagetrace init --dir ./out
```

Or record the baseline on its own:

```bash
npx pagetrace snapshot --dir ./out
git add pagetrace.lock.json
```

`init` never overwrites an existing config; it refreshes the lockfile and leaves your edits alone.

Check every build against it:

```bash
npx pagetrace check --dir ./out
```

```
(site-wide)
  error robots.txt now blocks GPTBot.                        aeo.crawler.newly_blocked
  warn  llms.txt sections removed: Locations.                aeo.llmstxt.sections.removed

/
  error Canonical was removed.                               canonical.removed
  error Page became noindex.                                 robots.noindex.added
  error Structured data entity LocalBusiness was removed.    jsonld.entity.removed
  warn  Open Graph tags removed: og:title.                   og.removed

5 error, 9 warning, 2 info
```

Exit codes are `0` for clean, `1` for findings at or above `--fail-on`, and `2` when the run itself failed — bad flags, an unreadable build directory, an unreachable origin. CI can tell "the site regressed" from "the tool broke". `--fail-on` takes `error` (the default), `warn` or `info`, and rejects anything else rather than quietly letting the build pass.

Note that `check` runs the absolute rules as well as the diff, so it can fail on a problem your build did not introduce. Use `--no-audit` for a pure regression gate.

The lockfile is only rewritten when the surface actually changed, so an unchanged site leaves it byte-identical and produces no git diff.

Accept the new state once you've reviewed it:

```bash
npx pagetrace check --dir ./out --update
```

### Auditing an existing site

`snapshot` and `check` are for guarding a site you control. To assess a site as it stands — a WordPress install you have just inherited, a client site before a rebuild — use `audit`. No lockfile needed.

```bash
npx pagetrace audit --url https://example.com --limit 300
npx pagetrace audit --url https://example.com --format html --out audit.html
```

Findings are rolled up by issue rather than by page, so one template defect reads as a single row affecting 43 pages instead of 43 separate lines. Each row carries why it matters and how to fix it, and the fix is platform-aware — `pagetrace` reads the generator tag and asset paths, so a WordPress site gets Yoast and Rank Math instructions rather than generic advice.

```
pagetrace · https://acme.test
43 pages · WordPress · 2026-09-06

ERRORS ─────────────────────────────────────────────────────────────────────── 2

✗ 2 pages canonicalise to https://acme.test/shop.                        2 pages
  Several pages pointing at one canonical means those pages are declaring
  themselves duplicates and will not rank independently.
  → A common symptom of a plugin canonicalising every archive page to the
    parent.
  /shop/page/2, /shop/page/3

✗ Page has no <h1>.                                                       1 page
  The h1 anchors the document outline used for passage extraction.
  → Many themes render the post title as h2 inside archive templates. Check
    single.php or the block template for this post type.
  /tag/widgets

────────────────────────────────────────────────────────────────────────────────
2 issues  2 errors
3 findings across 43 pages
```

Auditing runs cross-page rules the per-page checks cannot see: duplicate titles and descriptions, several pages canonicalising to one URL, canonicals pointing away from their own path or at another host entirely, and a full hreflang check. Paginated archives and AMP variants are left alone, since canonicalising those to their parent is correct.

The hreflang rules are the ones hardest to run by hand. Google discards an entire hreflang cluster when the annotations are not reciprocal — if `/en/about` points at `/ml/about` but `/ml/about` does not point back, *every* link in that group is ignored, not just the broken one, and nothing reports it. `pagetrace` checks reciprocity across the whole crawl, plus self-references, `x-default`, malformed language codes, and alternates that point at noindexed pages. Sites with no hreflang anywhere are left alone.

Counts are per issue, not per page: one template defect on 400 pages reads as a single item labelled `template-wide`, so you triage the fix once.

`--format html` writes a self-contained report with no external assets and no scripts, suitable for sending to a client. `--format json` gives the same data keyed by stable finding codes. Detected platforms: WordPress, Next.js, Shopify, Webflow, Wix, Squarespace, Drupal.

Route discovery follows `robots.txt` sitemap declarations, then falls back through `/sitemap.xml`, `/sitemap_index.xml` and `/wp-sitemap.xml`.

### Against a live site

```bash
npx pagetrace snapshot --url https://example.com --limit 200
```

Routes are discovered from `robots.txt` sitemap declarations, falling back to `/sitemap.xml`. Sitemap indexes are followed one level, up to 50 children, and expansion stops once `--limit` is satisfied. Gzipped children are recognised but not read.

Paths that `robots.txt` disallows are skipped, with the longest matching rule winning so an `Allow` exception still gets crawled. A staging origin that serves `Disallow: /` would therefore yield nothing — pass `--ignore-robots` (or set `"ignoreRobots": true` in the config) to crawl a site you own anyway.

URLs pointing at another host are skipped. A page that cannot be fetched stops the run with an error rather than being dropped from the snapshot — a page silently missing from a crawl is indistinguishable from a page you deleted, and reporting a transient outage as a site-wide deletion is worse than failing.

### Version and updates

```bash
pagetrace                     # command list (same as --help)
pagetrace <command> --help    # flags for one command
pagetrace --version           # installed version
pagetrace update --check      # ask npm whether a newer one exists
pagetrace update              # install it globally
```

`update` refuses to install globally over a project-local copy and prints the package-manager command instead. Unrelated to `check --update`, which rewrites the lockfile.

## What it records

**Per page** — title, meta description, canonical, robots directives, Open Graph and Twitter Card tags, hreflang alternates, `h1` text, heading outline, every JSON-LD entity with its property list, word count, images missing `alt`, and the length of the first quotable paragraph.

**Site-wide** — `robots.txt` crawlability per AI user agent (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, Applebot-Extended, CCBot and others), declared sitemaps, and `llms.txt` presence with its section headings and size.

## What it catches

| Code | Severity | Fires when |
| --- | --- | --- |
| `canonical.removed` | error | A page lost its canonical tag |
| `robots.noindex.added` | error | A page became noindex |
| `jsonld.entity.removed` | error | A structured data entity disappeared |
| `jsonld.property.removed` | error | An entity lost a property it used to have |
| `content.dropped` | error | Word count fell by more than half — usually a render failure |
| `canonical.offsite` | error | A canonical points at a host other than your own |
| `aeo.crawler.newly_blocked` | error | `robots.txt` started blocking an AI crawler |
| `aeo.llmstxt.removed` | error | `/llms.txt` disappeared |
| `page.removed` | warn | A route in the lockfile is no longer there |
| `redirect.added` | warn | A route that used to answer directly now redirects |
| `redirect.changed` | warn | A route redirects somewhere new |
| `canonical.redirects` | warn | A canonical points at a URL that redirects |
| `link.broken.added` | error | A page started linking to a URL that does not exist |
| `sitemap.dead` | error | The sitemap lists a URL that answers 404 |
| `sitemap.redirect` | warn | The sitemap lists a URL that redirects |
| `og.removed` / `hreflang.removed` | warn | Social or i18n tags dropped |
| `title.changed` | info | Ordinary copy edit |

Internal links are checked too. Only the broken ones are stored, so a site's navigation never lands in the lockfile: `link.broken` for a link that is already dead, `link.broken.added` for one this build broke. A `--dir` crawl is authoritative — the build directory is the whole site — while a crawl confirms each candidate with a real request first, because a sitemap routinely omits pages that are live. External links are deliberately not checked: a Cloudflare 403 and a rate limit both look like a dead page, and that is where link checkers earn their reputation for false positives.

Redirects are recorded from the response itself, so they cost no extra requests. A redirect that only adds or drops a trailing slash is server configuration rather than drift and is not reported. `canonical.redirects` is only raised when the canonical's target was actually crawled, so a `--limit` run cannot invent it.

Alongside the diff, `check` runs absolute rules: missing title, canonical, `h1`, or description; JSON-LD required and recommended properties for the thirty-three Schema.org types Google supports as rich results; thin content; images without `alt`; and AEO signals like whether the page opens with something an answer engine can quote. Disable with `--no-audit`.

## Config

`pagetrace.config.json`:

```json
{
  "siteUrl": "https://example.com",
  "ignoreRoutes": ["/preview/*", "/draft"],
  "minWordCount": 300,
  "severity": {
    "title.changed": "off",
    "content.thin": "error"
  },
  "aiAgents": ["GPTBot", "ClaudeBot", "MyCustomBot"]
}
```

`siteUrl` is what the site calls itself, which is not always where you are crawling it. It is what `canonical.offsite` compares against, so set it when checking a `--dir` build, and when crawling a local build or a preview deployment whose pages carry production canonicals. A plain crawl of production infers it.

Every finding has a stable `code`. Set any code to `error`, `warn`, `info`, or `off`.

## CI

The GitHub Action is the shortest path. It diffs the build against the baseline committed on your default branch and leaves the result as a pull request comment, updating that same comment on each push rather than stacking new ones.

```yaml
- uses: actions/checkout@v5
- run: npm ci && npm run build
- uses: shyamexe/pagetrace@v1
  with:
    dir: ./out
    baseline-branch: main
```

`baseline-branch` reads the lockfile out of a git ref rather than the working tree, so feature branches never carry one and you get no lockfile churn in pull requests. Commit the lockfile on your default branch only:

```bash
npx pagetrace snapshot --dir ./out
git add pagetrace.lock.json
```

Needs `pull-requests: write` for the comment. Set `comment: false` to skip it, or `audit: false` for a pure regression gate.

Without the Action:

```yaml
- run: npx pagetrace check --dir ./out --baseline-branch origin/main --format github
```

`--format` accepts `pretty`, `json`, `markdown` (sized for a PR comment), `github` (workflow annotations) and `sarif`.

SARIF puts the findings in the Security tab and on the pull request itself, which survives longer than a comment:

```yaml
- run: npx pagetrace check --dir ./out --baseline-branch origin/main --format sarif > pagetrace.sarif
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: pagetrace.sarif
```

Needs `security-events: write`. Routes are not source files, so GitHub lists each finding without anchoring it to a line in the diff.

## Programmatic API

```ts
import { extractPage, diffPage, auditPage, snapshotFromDir } from 'pagetrace';

const before = extractPage(oldHtml, '/pricing');
const after = extractPage(newHtml, '/pricing');

for (const finding of diffPage(before, after)) {
  console.log(finding.severity, finding.code, finding.message);
}
```

`extractPage`, `diffPage`, `diffSnapshots`, `auditPage`, `auditSnapshot`, `applyConfig` and the reporters are all pure functions over plain objects, so they compose into whatever pipeline you already have.

## Notes

Pages are fingerprinted from rendered HTML. For client-rendered apps, point `--dir` at a pre-rendered or statically exported build, or `--url` at a deployed preview — otherwise you are snapshotting an empty shell.

The `llms.txt` convention and AI crawler behaviour are still moving. Treat those rules as signals worth tracking, not settled standards.

## Notes on the name

`pagetrace` here means a trace of a page's search-visible surface over time. It is unrelated to memory page tracing in the Linux kernel or the Go runtime, which share the name.

## License

MIT
