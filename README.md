# pagetrace

A lockfile for your SEO and AEO surface. Snapshot it, diff every build, fail CI on regressions.

Existing SEO and AEO tools tell you your score **right now**. They don't tell you that this deploy dropped the canonical tag from 400 pages, that a layout refactor added `noindex`, that a CMS migration stripped `Product` schema, or that someone quietly blocked `GPTBot` in `robots.txt`. Those regressions are silent for weeks until traffic moves.

`pagetrace` records the search-visible surface of your site into a committed `pagetrace.lock.json`, then diffs every build against it. It classifies by *transition*, not by state: a reworded title is `info`, a removed canonical is `error`. So you can fail the build on real regressions without drowning in noise from ordinary content edits.

## Install

```bash
npm install -D pagetrace
```


## Use

Record a baseline from your build output:

```bash
npx pagetrace snapshot --dir ./out
git add pagetrace.lock.json
```

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

Exit code is `1` when anything at or above `--fail-on` (default `error`) is found.

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
ERROR 2 pages canonicalise to https://acme.test/shop.                          (1)
  Several pages pointing at one canonical means those pages are declaring
  themselves duplicates and will not rank independently.
  Fix: A common symptom of a plugin canonicalising every archive page to the parent.

ERROR Page has no <h1>.                                                        (1)
  The h1 anchors the document outline used for passage extraction.
  Fix: Many themes render the post title as h2 inside archive templates.
       Check single.php or the block template for this post type.
  /tag/widgets
```

Auditing runs cross-page rules the per-page checks cannot see: duplicate titles and descriptions, several pages canonicalising to one URL, canonicals pointing away from their own path, and a full hreflang check.

The hreflang rules are the ones hardest to run by hand. Google discards an entire hreflang cluster when the annotations are not reciprocal — if `/en/about` points at `/ml/about` but `/ml/about` does not point back, *every* link in that group is ignored, not just the broken one, and nothing reports it. `pagetrace` checks reciprocity across the whole crawl, plus self-references, `x-default`, malformed language codes, and alternates that point at noindexed pages. Sites with no hreflang anywhere are left alone.

Counts are per issue, not per page: one template defect on 400 pages reads as a single item labelled `template-wide`, so you triage the fix once.

`--format html` writes a self-contained report with no external assets and no scripts, suitable for sending to a client. `--format json` gives the same data keyed by stable finding codes. Detected platforms: WordPress, Next.js, Shopify, Webflow, Wix, Squarespace, Drupal.

Route discovery follows `robots.txt` sitemap declarations, then falls back through `/sitemap.xml`, `/sitemap_index.xml` and `/wp-sitemap.xml`.

### Against a live site

```bash
npx pagetrace snapshot --url https://example.com --limit 200
```

Routes are discovered from `robots.txt` sitemap declarations, falling back to `/sitemap.xml`. Sitemap indexes are followed one level.

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
| `og.removed` / `hreflang.removed` | warn | Social or i18n tags dropped |
| `title.changed` | info | Ordinary copy edit |

Alongside the diff, `check` runs absolute rules: missing title, canonical, `h1`, or description; JSON-LD required and recommended properties for the twenty Schema.org types Google supports as rich results; thin content; images without `alt`; and AEO signals like whether the page opens with something an answer engine can quote. Disable with `--no-audit`.

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

`siteUrl` is only needed for a `--dir` crawl, and only to detect canonicals pointing at another host — a staging hostname leaking into production canonicals. A `--url` crawl infers it.

Every finding has a stable `code`. Set any code to `error`, `warn`, `info`, or `off`.

## CI

```yaml
- run: npm run build
- run: npx pagetrace check --dir ./out --format github
```

`--format` accepts `pretty`, `json`, `markdown` (sized for a PR comment), and `github` (workflow annotations).

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
