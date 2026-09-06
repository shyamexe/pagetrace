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

async function fetchText(url: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch(url, {
      signal,
      headers: { 'user-agent': 'pagetrace (+https://npmjs.com/package/pagetrace)' },
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/** Build a snapshot from a directory of pre-rendered HTML (next export, dist, out). */
export async function snapshotFromDir(dir: string, config: Config = {}): Promise<Snapshot> {
  const files = await walkHtml(dir);
  const pages: Record<string, PageFingerprint> = {};

  for (const file of files) {
    const route = routeFromFilePath(dir, file);
    if (shouldIgnore(route, config.ignoreRoutes)) continue;
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
}

/** Build a snapshot by fetching a live origin, discovering routes via sitemap. */
export async function snapshotFromOrigin(
  origin: string,
  options: CrawlOptions = {},
): Promise<Snapshot> {
  const base = new URL(origin);
  const agents = options.aiAgents ?? DEFAULT_AI_AGENTS;
  const site: SiteFingerprint = { robotsTxt: null, llmsTxt: null };

  const robots = await fetchText(new URL('/robots.txt', base).href);
  if (robots !== null) site.robotsTxt = extractRobotsTxt(robots, agents);

  const llms = await fetchText(new URL('/llms.txt', base).href);
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
  for (const sitemapUrl of sitemapUrls) {
    if (discovered.size > 0 && !site.robotsTxt?.sitemaps.length) break;
    const xml = await fetchText(sitemapUrl);
    if (!xml) continue;
    for (const loc of extractSitemapUrls(xml)) {
      // A sitemap index points at more sitemaps; follow one level.
      if (/\.xml($|\?)/i.test(loc)) {
        const nested = await fetchText(loc);
        if (nested) for (const url of extractSitemapUrls(nested)) discovered.add(url);
      } else {
        discovered.add(loc);
      }
    }
  }
  if (discovered.size === 0) discovered.add(base.href);

  const targets = [...discovered]
    .filter((url) => !shouldIgnore(routeFromUrl(url), options.ignoreRoutes))
    .slice(0, options.limit ?? 200);

  const pages: Record<string, PageFingerprint> = {};
  const concurrency = Math.max(1, options.concurrency ?? 5);
  const queue = [...targets];

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const url = queue.shift()!;
        const html = await fetchText(url);
        if (html === null) continue;
        const route = routeFromUrl(url);
        pages[route] = extractPage(html, route);
      }
    }),
  );

  return { schemaVersion: 1, createdAt: new Date().toISOString(), site, pages };
}
