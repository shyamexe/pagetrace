# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is below 1.0.0, breaking changes ship in a minor release.

## [0.2.0] - 2026-09-06

A correctness pass over the whole surface. No finding codes were renamed, so
integrations keying on `canonical.removed` and friends are unaffected. Several
finding *messages* changed, which is deliberate — see Fixed.

### Removed

- **Breaking.** The `pgt` bin alias. The CLI is `pagetrace` only. One name is
  easier to remember, to document and to search for than two, and three-letter
  bins collide freely across packages.

### Changed

- **Breaking.** `hreflang.missing` now fires only for a page that another
  annotated page names as an alternate, instead of for every unannotated page on
  a site that uses hreflang anywhere. The old rule produced a warning per page on
  any partly translated site, and 48 warnings on a `--limit 50` crawl that
  happened to include two annotated pages. Cross-page rules have to degrade
  safely on a partial crawl; this one did not.
- **Breaking.** A page that fails to fetch mid-crawl now aborts the run instead
  of being skipped. Skipping it is what let a transient outage report the whole
  site as deleted.
- Several messages are now constant per finding, with the varying values moved to
  `before` / `after`: `content.dropped`, `jsonld.property.removed`,
  `og.removed`, `twitter.removed`, `hreflang.removed`, `canonical.crosspath`.
  Reports aggregate by code *and* message, so a per-page number in the message
  produced one row per page and defeated the template-wide rollup — a
  400-page canonical defect read as 400 separate issues.
- `--version` is injected from `package.json` at build time rather than
  hardcoded in the CLI.

### Fixed

- `fetchText` swallowed every network error into "not found", so an unreachable
  page was indistinguishable from a deleted one and `check` failed CI with
  fabricated regressions during a 503 or a DNS blip. It now returns `null` only
  for 404 and 410 and throws otherwise. The declared `signal` parameter was also
  never passed by any caller, so no timeout ever applied and a hung origin hung
  the CI job; requests now carry a 15s default timeout, configurable via the
  `timeout` crawl option.
- `--fail-on` was passed through unvalidated. An unrecognised value (`warning`,
  `ERROR`, a typo) made every severity comparison false, so the exit gate never
  fired and CI went green over a page of errors. Both the CLI and `shouldFail`
  now reject an unknown severity.
- Meta and link keywords are matched case-insensitively. CSS attribute selectors
  are case-sensitive but the HTML keywords are not, so `<meta NAME="Description">`
  and `<link rel="Canonical">` extracted as `null` and produced a false
  `description.missing` and a false `canonical.missing`. Also affects
  `name="Robots"` (a noindex regression went unreported), `name="Generator"`
  (platform detection fell back to unknown), `application/ld+json`, and
  `rel="alternate"` inside a multi-token `rel`.
- Sitemap `<loc>` values are XML-entity decoded and CDATA-wrapped locations are
  matched. XML requires `&` to be escaped, so every URL with a query string was
  fetched at the wrong address, and a CDATA-emitting sitemap discovered zero
  pages.
- JSON-LD entities without an `@id` are keyed positionally rather than by type.
  Keying on the bare type collapsed several entities of one type — three
  `Product`s, a `FAQPage`'s `Question`s — into one, so a page dropping from three
  to one reported no change at all.
- `hreflang.noindex.target` no longer flags a page against itself, and duplicate
  targets are collapsed. A noindexed page whose `en` and `x-default` shared an
  href produced four findings, two of them the page accusing itself.
- `check` writes its status messages to stderr. They were going to stdout ahead
  of the report, so `--format json` did not parse and `--format github`
  annotations were interleaved with prose.
- Route collisions no longer silently drop a page. `snapshotFromDir` walks files
  in sorted order and reports a collision (`blog.html` and `blog/index.html` both
  map to `/blog`) instead of letting readdir order decide the winner; the origin
  crawl discards sitemap URLs from another host, which `routeFromUrl` would have
  folded onto the same route.
- Sitemap index expansion deduplicates, caps nested fetches at 50, and stops once
  `--limit` is satisfied. A 200-child index cost 200 serial round-trips before
  slicing to 10 targets. Gzipped children are recognised so they are no longer
  crawled as pages and parsed as HTML, which had emitted three false errors each;
  their contents are still not read.
- `formatMarkdown` escapes pipes. A title containing one — `Buy Widgets | Acme`,
  a common CMS template — split the table row and swallowed the finding code.
- `leadAnswer` measures the first paragraph after the `h1`, scoped to
  `main`/`article` and ignoring `header`, `nav`, `footer` and `aside`, as its
  docstring always claimed. It was taking the first `<p>` anywhere in the
  document, so a cookie banner stood in for the lead — and edits to that banner
  showed up as content changes in the lockfile.

### Added

- `test/snapshot.test.ts` covers the crawl layer, which had no tests of its own:
  404-versus-failure, an unreachable origin, a server error mid-crawl, off-host
  filtering, sitemap index expansion and the `--limit` short-circuit.

## [0.1.0] - 2026-09-06

Initial release. `snapshot`, `check` and `audit` commands; filesystem and HTTP
crawling; diff classified by transition; absolute, cross-page and hreflang audit
rules; pretty, JSON, markdown, GitHub and HTML reporters.

[0.2.0]: https://github.com/shyamexe/pagetrace/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/shyamexe/pagetrace/releases/tag/v0.1.0
