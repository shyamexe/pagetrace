import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  extractLinks,
  extractLlmsTxt,
  extractPage,
  extractRobotsTxt,
  extractSitemapUrls,
  isCrawlable,
} from './extract.js';
import { DEFAULT_AI_AGENTS } from './rules/rich-results.js';
import type { Config, PageFingerprint, SiteFingerprint, Snapshot } from './types.js';

export function routeFromFilePath(root: string, filePath: string): string {
  const rel = relative(root, filePath).split(sep).join('/');
  const withoutExt = rel.replace(/\.html?$/i, '');
  const route = withoutExt === 'index' ? '/' : `/${withoutExt.replace(/\/index$/, '')}`;
  return route === '//' ? '/' : route;
}

export function routeFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '');
    return path === '' ? '/' : path;
  } catch {
    return url;
  }
}

const exec = promisify(execFile);

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Read a committed lockfile out of a git ref rather than the working tree, so a
 * pull request can diff against the baseline on `main` without carrying a
 * lockfile of its own. Returns null when the ref has no lockfile at that path —
 * an ordinary first run — but throws when the ref itself is unresolvable, since
 * a typo in `--baseline-branch` must not read as "nothing to compare".
 */
export async function snapshotFromGitRef(ref: string, path: string): Promise<Snapshot | null> {
  try {
    await exec('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch (cause) {
    throw new Error(
      `Cannot resolve git ref "${ref}". Fetch it first — a shallow CI checkout often has only the PR head.`,
      { cause },
    );
  }

  let stdout: string;
  try {
    ({ stdout } = await exec('git', ['show', `${ref}:${path}`], { maxBuffer: 256 * 1024 * 1024 }));
  } catch {
    return null;
  }

  try {
    return JSON.parse(stdout) as Snapshot;
  } catch (cause) {
    throw new Error(`${path} at ${ref} is not valid JSON.`, { cause });
  }
}

/**
 * Whether two snapshots describe the same surface, ignoring when they were
 * taken. The lockfile is meant to be committed, so writing a fresh timestamp on
 * every run put a diff in front of the reviewer even when nothing had changed.
 * That trains people to discard lockfile changes without reading them, which is
 * the one habit this tool cannot afford.
 */
export function sameSurface(a: Snapshot, b: Snapshot): boolean {
  const strip = (s: Snapshot) => JSON.stringify({ ...s, createdAt: '' });
  return strip(a) === strip(b);
}

export function shouldIgnore(route: string, patterns: string[] = []): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith('*') ? route.startsWith(pattern.slice(0, -1)) : route === pattern,
  );
}

async function walkHtml(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      await walkHtml(full, acc);
    } else if (/\.html?$/i.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

const USER_AGENT = 'pagetrace (+https://npmjs.com/package/pagetrace)';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 300;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 429 and 5xx are worth retrying; a 4xx is an answer, not a hiccup. */
function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * `null` means the resource is genuinely absent; anything else throws.
 *
 * The distinction is the whole point: swallowing a 503 or a DNS failure into
 * "not found" makes an unreachable site look like a deleted one, and `check`
 * then reports a wall of removals that never happened. Being strict about it
 * is only practical with a retry, or one flaky response aborts a 200-page
 * crawl.
 */
interface FetchedDoc {
  text: string;
  /** The URL the response actually came from, after any redirects. */
  url: string;
}

async function fetchDoc(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<FetchedDoc | null> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await sleep(RETRY_BASE_MS * 3 ** (attempt - 2));

    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': USER_AGENT },
      });
    } catch (cause) {
      lastError = new Error(`Could not reach ${url}: ${(cause as Error).message}`, { cause });
      continue;
    }

    if (response.status === 404 || response.status === 410) return null;
    if (response.ok) return { text: await response.text(), url: response.url };

    lastError = new Error(`Could not reach ${url}: HTTP ${response.status}.`);
    if (!isTransient(response.status)) break;
  }

  throw lastError;
}

/** Callers that only want the body: robots.txt, llms.txt, sitemaps. */
async function fetchText(url: string, timeoutMs?: number): Promise<string | null> {
  return (await fetchDoc(url, timeoutMs))?.text ?? null;
}

/** For speculative URLs, where a failure is a miss rather than a problem. */
function tryFetchText(url: string, timeoutMs?: number): Promise<string | null> {
  return fetchText(url, timeoutMs).catch(() => null);
}

/** Build a snapshot from a directory of pre-rendered HTML (next export, dist, out). */
export async function snapshotFromDir(dir: string, config: Config = {}): Promise<Snapshot> {
  const files = await walkHtml(dir);
  const pages: Record<string, PageFingerprint> = {};
  const links: Record<string, string[]> = {};

  for (const file of files.sort()) {
    const route = routeFromFilePath(dir, file);
    if (shouldIgnore(route, config.ignoreRoutes)) continue;
    if (route in pages) {
      // e.g. both blog.html and blog/index.html. Silently overwriting makes the
      // survivor depend on readdir order, which flips between runs.
      console.error(`pagetrace: ${file} maps to ${route}, already taken. Skipping.`);
      continue;
    }
    const html = await readFile(file, 'utf8');
    pages[route] = extractPage(html, route);
    links[route] = extractLinks(html);
  }

  const agents = config.aiAgents ?? DEFAULT_AI_AGENTS;
  const site: SiteFingerprint = {
    origin: config.siteUrl ? new URL(config.siteUrl).origin : null,
    robotsTxt: null,
    llmsTxt: null,
    sitemap: null,
  };

  const robots = await readFile(join(dir, 'robots.txt'), 'utf8').catch(() => null);
  if (robots !== null) site.robotsTxt = extractRobotsTxt(robots, agents);

  const llms = await readFile(join(dir, 'llms.txt'), 'utf8').catch(() => null);
  if (llms !== null) site.llmsTxt = extractLlmsTxt(llms);

  // A build directory is the whole site, so a link resolving to no file here is
  // broken, with nothing to confirm over the network.
  const origin = site.origin ?? 'https://pagetrace.invalid';
  await resolveBrokenLinks(pages, links, origin);
  if (config.checkExternal) await resolveDeadExternal(pages, links, origin, 5);

  return { schemaVersion: 1, createdAt: new Date().toISOString(), site, pages };
}

/**
 * A link target is only a candidate for being broken if it is meant to be a
 * page at all. A trailing `.png` or `.pdf` is an asset the crawl never
 * fingerprints, and reporting those would bury the real breakage.
 *
 * ponytail: an extension test, not a content-type check. Extensionless asset
 * routes will be treated as pages; verify them if a real site trips on it.
 */
const ASSET_PATH = /\.(?!html?$)[a-z0-9]+$/i;

/**
 * Resolve an href against the page it appeared on. Null means "not a page here".
 *
 * Relative hrefs are resolved as though every route were a directory, which is
 * what static output (`/blog/index.html`, served at `/blog/`) actually does.
 * A site serving `/blog` without the trailing slash resolves `contact` to
 * `/contact` instead — rare enough, and absolute hrefs are unaffected.
 */
function linkTarget(href: string, from: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(href, `${origin}${from === '/' ? '' : from}/`);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  if (ASSET_PATH.test(url.pathname)) return null;
  return routeFromUrl(url.href);
}

/**
 * Links that point at no page in this snapshot. `verify` exists because absence
 * only proves breakage when the route set is complete: a directory of built
 * HTML is complete by construction, while a sitemap crawl routinely misses
 * pages that are live but unlisted, so those candidates are confirmed with a
 * real request before being reported.
 *
 * ponytail: verification is capped, so a site with hundreds of unlisted pages
 * reports only the first MAX_LINK_CHECKS. Raise it if that bites.
 */
const MAX_LINK_CHECKS = 100;

async function resolveBrokenLinks(
  pages: Record<string, PageFingerprint>,
  links: Record<string, string[]>,
  origin: string,
  verify?: (route: string) => Promise<boolean>,
): Promise<void> {
  const known = new Set(Object.keys(pages));
  const candidates = new Map<string, string[]>();

  for (const [route, hrefs] of Object.entries(links)) {
    const missing = [
      ...new Set(
        hrefs
          .map((href) => linkTarget(href, route, origin))
          .filter((target): target is string => target !== null && !known.has(target)),
      ),
    ];
    if (missing.length > 0) candidates.set(route, missing);
  }

  const broken = new Set<string>();
  if (verify) {
    const targets = [...new Set([...candidates.values()].flat())].slice(0, MAX_LINK_CHECKS);
    for (const target of targets) {
      if (await verify(target)) broken.add(target);
    }
  }

  for (const [route, missing] of candidates) {
    const confirmed = verify ? missing.filter((target) => broken.has(target)) : missing;
    if (confirmed.length > 0) pages[route].brokenLinks = confirmed.sort();
  }
}

/** Absolute http(s) URL for an href that leaves the site, or null. */
function externalUrl(href: string, from: string, origin: string): string | null {
  try {
    const url = new URL(href, `${origin}${from === '/' ? '' : from}/`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.origin === origin) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/**
 * ponytail: capped, so a link-heavy site checks the first MAX_EXTERNAL_CHECKS
 * unique URLs. Raise it if a real site needs more; it is a request each.
 */
const MAX_EXTERNAL_CHECKS = 200;

/**
 * Only 404 and 410 count as dead. A 403 from a bot wall, a 429, a timeout, a
 * TLS failure — all of those say something about the request, not about the
 * page, and reporting them is exactly how link checkers become noise nobody
 * reads. HEAD first, since most of these bodies are wasted bytes.
 */
async function findDeadExternal(
  urls: string[],
  concurrency: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Set<string>> {
  const dead = new Set<string>();
  const queue = urls.slice(0, MAX_EXTERNAL_CHECKS);
  const request = (url: string, method: 'HEAD' | 'GET') =>
    fetch(url, {
      method,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': USER_AGENT },
    });

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const url = queue.shift()!;
        try {
          let response = await request(url, 'HEAD');
          // Plenty of servers refuse HEAD outright, which says nothing about
          // whether the page is there.
          if (response.status === 405 || response.status === 501) {
            response = await request(url, 'GET');
          }
          if (response.status === 404 || response.status === 410) dead.add(url);
        } catch {
          // Unreachable is unknown, and unknown must not become a finding.
        }
      }
    }),
  );
  return dead;
}

async function resolveDeadExternal(
  pages: Record<string, PageFingerprint>,
  links: Record<string, string[]>,
  origin: string,
  concurrency: number,
  timeoutMs?: number,
): Promise<void> {
  const perPage = new Map<string, string[]>();
  const unique = new Set<string>();

  for (const [route, hrefs] of Object.entries(links)) {
    const external = [
      ...new Set(
        hrefs
          .map((href) => externalUrl(href, route, origin))
          .filter((url): url is string => url !== null),
      ),
    ];
    if (external.length === 0) continue;
    perPage.set(route, external);
    for (const url of external) unique.add(url);
  }

  const dead = await findDeadExternal([...unique], concurrency, timeoutMs);
  for (const [route, external] of perPage) {
    const found = external.filter((url) => dead.has(url)).sort();
    if (found.length > 0) pages[route].deadExternal = found;
  }
}

/**
 * One page, checked properly. No sitemap, no route discovery: the snapshot
 * holds a single page, so every link on it is a candidate and every candidate
 * is confirmed with a real request. That is the opposite trade from a crawl,
 * and the right one here — one page's worth of links is a bounded cost, and
 * "is this page's linking sound" is a question a crawl answers slowly.
 */
export async function snapshotFromPage(
  pageUrl: string,
  options: CrawlOptions = {},
): Promise<Snapshot> {
  const target = new URL(pageUrl);
  const site: SiteFingerprint = {
    origin: options.siteUrl ? new URL(options.siteUrl).origin : target.origin,
    robotsTxt: null,
    llmsTxt: null,
    sitemap: null,
  };

  const doc = await fetchDoc(target.href, options.timeout);
  if (doc === null) throw new Error(`${target.href} answered 404 — nothing to check.`);

  const route = routeFromUrl(target.href);
  const page = extractPage(doc.text, route);
  const landed = !doc.url
    ? route
    : originOf(doc.url) === target.origin
      ? routeFromUrl(doc.url)
      : doc.url;
  page.redirectsTo = landed === route ? null : landed;

  const pages = { [route]: page };
  const links = { [route]: extractLinks(doc.text) };
  const origin = site.origin ?? target.origin;

  await resolveBrokenLinks(pages, links, origin, async (candidate) => {
    try {
      return (await fetchDoc(new URL(candidate, target.origin).href, options.timeout)) === null;
    } catch {
      return false;
    }
  });

  if (options.checkExternal) {
    await resolveDeadExternal(pages, links, origin, Math.max(1, options.concurrency ?? 5), options.timeout);
  }

  return { schemaVersion: 1, createdAt: new Date().toISOString(), site, pages };
}

export interface CrawlOptions extends Config {
  /** Cap the number of pages fetched. */
  limit?: number;
  /** Parallel requests. */
  concurrency?: number;
  /** Per-request timeout in milliseconds. */
  timeout?: number;
}

/** A sitemap index can list hundreds of children; we do not need all of them. */
const MAX_NESTED_SITEMAPS = 50;

/** Build a snapshot by fetching a live origin, discovering routes via sitemap. */
export async function snapshotFromOrigin(
  origin: string,
  options: CrawlOptions = {},
): Promise<Snapshot> {
  const base = new URL(origin);
  const agents = options.aiAgents ?? DEFAULT_AI_AGENTS;
  const timeout = options.timeout;
  // Where we crawl and what the site calls itself are not always the same. A
  // local build or a preview deployment serves pages whose canonicals point at
  // production, so config.siteUrl wins when it is set — otherwise every page
  // would report canonical.offsite against localhost.
  const site: SiteFingerprint = {
    origin: options.siteUrl ? new URL(options.siteUrl).origin : base.origin,
    robotsTxt: null,
    llmsTxt: null,
  };
  const limit = options.limit ?? 200;

  const robots = await fetchText(new URL('/robots.txt', base).href, timeout);
  if (robots !== null) site.robotsTxt = extractRobotsTxt(robots, agents);

  const llms = await fetchText(new URL('/llms.txt', base).href, timeout);
  if (llms !== null) site.llmsTxt = extractLlmsTxt(llms);

  // Fall back through the conventional locations. WordPress core serves
  // /wp-sitemap.xml; Yoast and Rank Math replace it with sitemap_index.xml.
  const sitemapUrls = site.robotsTxt?.sitemaps.length
    ? site.robotsTxt.sitemaps
    : [
        new URL('/sitemap.xml', base).href,
        new URL('/sitemap_index.xml', base).href,
        new URL('/wp-sitemap.xml', base).href,
      ];

  const discovered = new Set<string>();
  const fetched = new Set<string>();
  let nestedFetches = 0;

  for (const sitemapUrl of sitemapUrls) {
    if (discovered.size >= limit) break;
    if (discovered.size > 0 && !site.robotsTxt?.sitemaps.length) break;
    if (fetched.has(sitemapUrl)) continue;
    fetched.add(sitemapUrl);
    // A guessed location that is not there is a miss, not a failure.
    const xml = site.robotsTxt?.sitemaps.length
      ? await fetchText(sitemapUrl, timeout)
      : await tryFetchText(sitemapUrl, timeout);
    if (!xml) continue;

    for (const loc of extractSitemapUrls(xml)) {
      if (discovered.size >= limit) break;
      // A sitemap index points at more sitemaps; follow one level.
      if (!/\.xml(\.gz)?($|\?)/i.test(loc)) {
        discovered.add(loc);
        continue;
      }
      // ponytail: a gzipped child is recognised, so it is not crawled as a page
      // and parsed as HTML, but its URLs are not discovered either. Pipe the
      // body through node:zlib if a real site needs them.
      if (/\.gz($|\?)/i.test(loc)) continue;
      if (nestedFetches >= MAX_NESTED_SITEMAPS || fetched.has(loc)) continue;
      fetched.add(loc);
      nestedFetches += 1;
      const nested = await tryFetchText(loc, timeout);
      if (nested) for (const url of extractSitemapUrls(nested)) discovered.add(url);
    }
  }
  // Distinguishes "the sitemap listed nothing" from "there was no sitemap":
  // only the first is a fact about the site worth auditing.
  const hadSitemap = discovered.size > 0;
  if (discovered.size === 0) discovered.add(base.href);

  // routeFromUrl drops the host, so an off-origin URL would silently overwrite
  // the same route from this site.
  const crawlable = [...discovered]
    .filter((url) => {
      try {
        return new URL(url).origin === base.origin;
      } catch {
        return false;
      }
    })
    .filter((url) => !shouldIgnore(routeFromUrl(url), options.ignoreRoutes))
    // Crawling what a site asked crawlers not to touch is rude even when the
    // site is yours, and a disallowed path is usually disallowed because its
    // SEO surface is not meant to be judged.
    .filter(
      (url) => options.ignoreRobots || isCrawlable(new URL(url).pathname, site.robotsTxt),
    );

  if (hadSitemap) {
    site.sitemap = { routes: crawlable.map(routeFromUrl), dead: [] };
  }

  const targets = crawlable.slice(0, limit);

  const pages: Record<string, PageFingerprint> = {};
  const links: Record<string, string[]> = {};
  const concurrency = Math.max(1, options.concurrency ?? 5);
  const queue = [...targets];

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const url = queue.shift()!;
        const doc = await fetchDoc(url, timeout);
        if (doc === null) {
          // A 404 behind a sitemap entry is the sitemap's problem, not a crawl
          // failure: the URL exists as a claim and answers as if it does not.
          site.sitemap?.dead.push(routeFromUrl(url));
          continue;
        }
        const route = routeFromUrl(url);
        // Keyed by the route asked for, not the one served: the question a diff
        // answers is what this URL does now, and it used to serve a page.
        // The fingerprint therefore describes the destination's HTML, so a new
        // redirect also reports the title and canonical it now resolves to.
        const page = extractPage(doc.text, route);
        links[route] = extractLinks(doc.text);
        // An empty response.url means the client did not tell us where the body
        // came from, which is no evidence of a redirect — never a redirect to "".
        const landed = !doc.url
          ? route
          : originOf(doc.url) === base.origin
            ? routeFromUrl(doc.url)
            : doc.url;
        page.redirectsTo = landed === route ? null : landed;
        pages[route] = page;
      }
    }),
  );

  // A sitemap is not a site map: pages that are live but unlisted are ordinary,
  // so every candidate is confirmed with a real request before it is reported.
  await resolveBrokenLinks(pages, links, base.origin, async (route) => {
    try {
      return (await fetchDoc(new URL(route, base).href, timeout)) === null;
    } catch {
      // Unreachable is not the same as absent, and a flaky response must not
      // become a finding about the site's links.
      return false;
    }
  });

  if (options.checkExternal) {
    await resolveDeadExternal(pages, links, base.origin, concurrency, timeout);
  }

  return { schemaVersion: 1, createdAt: new Date().toISOString(), site, pages };
}
