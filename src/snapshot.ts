import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  extractLlmsTxt,
  extractPage,
  extractRobotsTxt,
  extractSitemapUrls,
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

/**
 * `null` means the resource is genuinely absent; anything else throws.
 *
 * The distinction is the whole point: swallowing a 503 or a DNS failure into
 * "not found" makes an unreachable site look like a deleted one, and `check`
 * then reports a wall of removals that never happened.
 */
async function fetchText(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'pagetrace (+https://npmjs.com/package/pagetrace)' },
    });
  } catch (cause) {
    throw new Error(`Could not reach ${url}: ${(cause as Error).message}`, { cause });
  }
  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok) throw new Error(`Could not reach ${url}: HTTP ${response.status}.`);
  return await response.text();
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
  const site: SiteFingerprint = { robotsTxt: null, llmsTxt: null };

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
  const site: SiteFingerprint = { robotsTxt: null, llmsTxt: null };
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
  if (discovered.size === 0) discovered.add(base.href);

  // routeFromUrl drops the host, so an off-origin URL would silently overwrite
  // the same route from this site.
  const targets = [...discovered]
    .filter((url) => {
      try {
        return new URL(url).origin === base.origin;
      } catch {
        return false;
      }
    })
    .filter((url) => !shouldIgnore(routeFromUrl(url), options.ignoreRoutes))
    .slice(0, limit);

  const pages: Record<string, PageFingerprint> = {};
  const concurrency = Math.max(1, options.concurrency ?? 5);
  const queue = [...targets];

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const url = queue.shift()!;
        const html = await fetchText(url, timeout);
        if (html === null) continue;
        const route = routeFromUrl(url);
        pages[route] = extractPage(html, route);
      }
    }),
  );

  return { schemaVersion: 1, createdAt: new Date().toISOString(), site, pages };
}
