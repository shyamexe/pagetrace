import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import {
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
        headers: { 'user-agent': 'pagetrace (+https://npmjs.com/package/pagetrace)' },
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

  for (const file of files.sort()) {
    const route = routeFromFilePath(dir, file);
    if (shouldIgnore(route, config.ignoreRoutes)) continue;
    if (route in pages) {
      // e.g. both blog.html and blog/index.html. Silently overwriting makes the
      // survivor depend on readdir order, which flips between runs.
      console.error(`pagetrace: ${file} maps to ${route}, already taken. Skipping.`);
      continue;
    }
    pages[route] = extractPage(await readFile(file, 'utf8'), route);
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

  return { schemaVersion: 1, createdAt: new Date().toISOString(), site, pages };
}
