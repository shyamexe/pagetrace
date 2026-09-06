# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is below 1.0.0, breaking changes ship in a minor release.

## [0.8.1] - 2026-09-06

### Fixed

- The report summary said "1 findings across 13 pages". Both counts are now
  pluralised properly.

## [0.8.0] - 2026-09-06

### Fixed

- `siteUrl` now overrides the crawled origin for an origin crawl, not just a
  `--dir` crawl. Checking a local build or a preview deployment means crawling
  `http://localhost:3000` while every page's canonical points at production, so
  `canonical.offsite` fired on every page and made the check useless in exactly
  the setup it is most wanted. Where you crawl and what the site calls itself are
  separate things; `siteUrl` is now the authority on the latter. Without it the
  crawled origin is still used, so nothing changes for a plain production crawl.

## [0.7.0] - 2026-09-06

### Changed

- The terminal audit report is laid out rather than printed. Findings sit under a
  rule per severity, prose wraps to the terminal instead of running off the right
  edge, the affected routes get their own line, and the page count is right
  aligned against the headline. The old output put explanation, fix and routes at
  the same indent with no wrapping, so on a real site the useful part was the
  hardest part to find.
- `formatAuditPretty(groups, meta, columns?)` takes an optional terminal width,
  defaulting to 80. The CLI passes `process.stdout.columns`, which keeps
  `report.ts` free of environment reads. Piped output falls back to 80 and drops
  colour, so it stays readable in a CI log.

### Fixed

- A word longer than the terminal is hard-broken instead of overflowing. A
  canonical URL is a single word and is routinely longer than 80 characters, so
  `duplicate.canonical` could push a line well past the edge.

## [0.6.0] - 2026-09-06

### Changed

- **Breaking.** `duplicate.title`, `duplicate.description` and
  `duplicate.canonical` now emit one finding per affected route instead of a
  single finding with `route: null`. Integrations reading `route` on these three
  codes will see a path where they saw null; the codes themselves are unchanged.

  Found by auditing a real site. The report said "2 pages share the same meta
  description" and could not say which two, because the routes lived in `after`,
  which the rollup drops — leaving the only actionable part of the finding
  invisible. Per-route findings also make the counts truthful and point
  `--format github` annotations at the pages rather than at "site".

## [0.5.0] - 2026-09-06

### Added

- `check --baseline-branch <ref>` reads the baseline lockfile out of a git ref
  instead of the working tree, so a pull request can diff against `main` without
  carrying a lockfile of its own. Commit the lockfile on the default branch only
  and feature branches stop churning it. An unresolvable ref throws rather than
  reading as an empty baseline, since a typo must not mean "nothing changed"; a
  ref that simply has no lockfile yet returns nothing, which is an ordinary
  first run.
- A composite GitHub Action (`action.yml`). Three lines in a workflow run the
  check and post the findings as a pull request comment, editing the previous
  comment on each push rather than stacking new ones. It fetches the baseline ref
  first, since a shallow CI checkout usually has only the PR head. The comment is
  skipped for pull requests from a fork, which run with a read-only token and
  would otherwise fail with a 403 through no fault of the contributor; the
  findings still reach the step summary and still set the exit code.
- `snapshotFromGitRef(ref, path)` is exported.
- `examples/site`, a small deliberately correct site with a committed baseline.
  The action runs against it on every pull request to this repo, so a change
  that breaks the action's own wiring fails here rather than in someone else's
  CI. It doubles as a worked example of what a clean surface looks like.

### Fixed

- `formatMarkdown` escapes angle brackets. `The <h1> was removed.` rendered as
  `The  was removed.` on GitHub, which parses a tag name in a table cell as
  inline HTML and drops it — losing the part of the message that mattered, in
  the reporter whose whole purpose is the pull request comment.

## [0.4.0] - 2026-09-06

### Changed

- **Breaking.** A failed run now exits `2` rather than `1`. `1` means findings at
  or above `--fail-on`; `2` means the run itself failed — invalid flags, an
  unreadable build directory, an unreachable origin, no pages found. CI could not
  previously distinguish "the site regressed" from "the tool broke", which are
  opposite situations: one should fail the build, the other should page someone.
- The lockfile is only rewritten when the surface actually changed. It carries a
  `createdAt` timestamp, so every run used to produce a git diff even on an
  unchanged site — which teaches reviewers to discard lockfile changes without
  reading them, the one habit this tool cannot afford. `snapshot` and
  `check --update` now say "already up to date" and leave the file alone.
- Source maps are no longer published. They were 61% of the package: 715 kB
  unpacked down to 281 kB. Nobody steps through a built CLI.
- Build target moved from `node18` to `node20`, matching the engines floor.

### Added

- Failed requests are retried up to three times with backoff, on network errors,
  429 and 5xx. 0.2.0 made an unreachable page abort the crawl rather than be
  silently dropped, which is correct but brittle without a retry — one flaky
  response could end a 200-page crawl. A 4xx is an answer, not a hiccup, and is
  not retried.
- `sameSurface(a, b)` is exported: compares two snapshots ignoring when they were
  taken.
- The release workflow creates a GitHub Release from each tag, using that
  version's changelog section as the notes. A tag on its own does not appear in
  the repo UI, so the project read as unreleased despite being on npm.

## [0.3.0] - 2026-09-06

### Changed

- **Breaking.** `engines.node` is now `>=20.19.0`, up from `>=18.17`. The old
  value was wrong rather than generous: `cac`, a runtime dependency, declares
  `>=20.19.0`, so the package never actually supported the range it advertised.
  Node 18 reached end of life in April 2025.

### Fixed

- CI runs the test suite against Node 20.19, 22 and 24, so the `engines` floor is
  tested rather than asserted — the mismatch above had gone unnoticed because CI
  only ever ran one version.
- CI fails if `npm pack` reports that npm would auto-correct `package.json`,
  which is how the `bin` path issue in 0.2.0 reached the registry unnoticed.
- The release workflow refuses to publish when the tag disagrees with
  `package.json`, or when that version is already on the registry. A published
  version is immutable, so both mistakes are expensive after the fact.
- Workflow actions moved to `actions/checkout@v5` and `actions/setup-node@v5`,
  clearing the Node 20 runner deprecation warning.

## [0.2.0] - 2026-09-06

A correctness pass over the whole surface. No finding codes were renamed, so
integrations keying on `canonical.removed` and friends are unaffected. Several
finding *messages* changed, which is deliberate — see Fixed.

### Removed

- **Breaking.** The `pgt` bin alias. The CLI is `pagetrace` only. One name is
  easier to remember, to document and to search for than two, and three-letter
  bins collide freely across packages.

### Added

- `canonical.offsite` (error): a canonical pointing at a host other than the
  site's own. A staging or CDN hostname leaking into canonicals removes the live
  site from results, and `canonical.crosspath` could not see it — that rule
  compares paths only, so `/services` canonicalising to
  `https://staging.example.net/services` looked correct. Checked only when the
  site's own origin is known: an origin crawl records it, and a `--dir` crawl
  takes it from the new `siteUrl` config option. Inferring it from the canonicals
  themselves would miss the site-wide leak, which is the case that matters.
- `siteUrl` config option, and `site.origin` on the snapshot.

### Changed

- `canonical.crosspath` no longer fires on paginated archives (`/blog/page/2`,
  `/blog/p/3`) or AMP variants (`/article/amp`, `/amp/guide`) whose canonical
  points at the parent they are a variant of. Both are ordinary CMS output; the
  rule flagged one per page and buried the real canonical mistakes. A paginated
  page canonicalising somewhere unrelated is still flagged.
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

- `test/snapshot.test.ts` covers the crawl layer, which had no tests of its own:
  404-versus-failure, an unreachable origin, a server error mid-crawl, off-host
  filtering, sitemap index expansion and the `--limit` short-circuit.

## [0.1.0] - 2026-09-06

Initial release. `snapshot`, `check` and `audit` commands; filesystem and HTTP
crawling; diff classified by transition; absolute, cross-page and hreflang audit
rules; pretty, JSON, markdown, GitHub and HTML reporters.

[0.8.1]: https://github.com/shyamexe/pagetrace/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/shyamexe/pagetrace/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/shyamexe/pagetrace/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/shyamexe/pagetrace/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/shyamexe/pagetrace/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/shyamexe/pagetrace/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/shyamexe/pagetrace/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/shyamexe/pagetrace/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/shyamexe/pagetrace/releases/tag/v0.1.0
