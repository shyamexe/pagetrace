import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditCrossPage } from '../src/audit.js';
import { sameSurface, snapshotFromGitRef, snapshotFromOrigin } from '../src/snapshot.js';

const ORIGIN = 'https://example.com';

const html = (title: string) =>
  `<html><head><title>${title}</title><link rel="canonical" href="${ORIGIN}/"></head><body><h1>${title}</h1></body></html>`;

/**
 * A route table stands in for the network. `null` is a 404; an Error is thrown
 * from fetch itself, the way a DNS failure or a connection reset arrives.
 */
function stubNetwork(routes: Record<string, string | Error | null>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url);
    const body = routes[url];
    if (body instanceof Error) throw body;
    if (body === undefined || body === null) {
      return new Response('nope', { status: 404 });
    }
    return new Response(body, { status: 200 });
  });
  return calls;
}

/**
 * Same as stubNetwork, but each route may answer from a different final URL,
 * the way fetch reports a followed redirect. `response.url` is a prototype
 * getter, so the instance shadows it.
 */
function stubRedirects(routes: Record<string, { body: string; from?: string }>) {
  vi.stubGlobal('fetch', async (url: string) => {
    const hit = routes[url];
    if (!hit) return new Response('nope', { status: 404 });
    const response = new Response(hit.body, { status: 200 });
    Object.defineProperty(response, 'url', { value: hit.from ?? url });
    return response;
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('redirects', () => {
  const sitemap = `<urlset><url><loc>${ORIGIN}/a</loc></url></urlset>`;

  it('records where a route landed, keyed by the route asked for', async () => {
    stubRedirects({
      [`${ORIGIN}/sitemap.xml`]: { body: sitemap },
      [`${ORIGIN}/a`]: { body: html('B'), from: `${ORIGIN}/b` },
    });
    const snapshot = await snapshotFromOrigin(ORIGIN);
    expect(Object.keys(snapshot.pages)).toEqual(['/a']);
    expect(snapshot.pages['/a'].redirectsTo).toBe('/b');
  });

  it('leaves a direct answer with no redirect at all', async () => {
    stubRedirects({
      [`${ORIGIN}/sitemap.xml`]: { body: sitemap },
      [`${ORIGIN}/a`]: { body: html('A') },
    });
    const snapshot = await snapshotFromOrigin(ORIGIN);
    expect(snapshot.pages['/a'].redirectsTo).toBeNull();
  });

  it('ignores a trailing-slash redirect, which is configuration rather than drift', async () => {
    stubRedirects({
      [`${ORIGIN}/sitemap.xml`]: { body: sitemap },
      [`${ORIGIN}/a`]: { body: html('A'), from: `${ORIGIN}/a/` },
    });
    const snapshot = await snapshotFromOrigin(ORIGIN);
    expect(snapshot.pages['/a'].redirectsTo).toBeNull();
  });

  it('keeps the absolute URL when the redirect leaves the site', async () => {
    stubRedirects({
      [`${ORIGIN}/sitemap.xml`]: { body: sitemap },
      [`${ORIGIN}/a`]: { body: html('A'), from: 'https://elsewhere.test/a' },
    });
    const snapshot = await snapshotFromOrigin(ORIGIN);
    expect(snapshot.pages['/a'].redirectsTo).toBe('https://elsewhere.test/a');
  });

  it('records no redirect when the client does not report a final URL', async () => {
    // A synthesised Response has an empty `url`. That is missing information,
    // not a redirect to "" — which the diff would report on every page.
    stubNetwork({
      [`${ORIGIN}/sitemap.xml`]: sitemap,
      [`${ORIGIN}/a`]: html('A'),
    });
    const snapshot = await snapshotFromOrigin(ORIGIN);
    expect(snapshot.pages['/a'].redirectsTo).toBeNull();
  });
});

describe('siteUrl against a local build', () => {
  it('compares canonicals to the configured site, not the crawl URL', async () => {
    // A preview deployment or `next start` on localhost serves pages whose
    // canonicals point at production. Without siteUrl every page would report
    // canonical.offsite, which would make the check useless exactly where it is
    // most wanted.
    stubNetwork({
      'http://localhost:3000/sitemap.xml':
        '<urlset><url><loc>http://localhost:3000/a</loc></url></urlset>',
      'http://localhost:3000/a':
        '<html><head><title>A</title><link rel="canonical" href="https://example.com/a"></head><body><h1>A</h1></body></html>',
    });

    const snapshot = await snapshotFromOrigin('http://localhost:3000', {
      siteUrl: 'https://example.com',
    });
    expect(snapshot.site.origin).toBe('https://example.com');

    const offsite = auditCrossPage(snapshot).filter((f) => f.code === 'canonical.offsite');
    expect(offsite).toEqual([]);
  });

  it('falls back to the crawled origin when siteUrl is not set', async () => {
    stubNetwork({
      'http://localhost:3000/sitemap.xml':
        '<urlset><url><loc>http://localhost:3000/a</loc></url></urlset>',
      'http://localhost:3000/a':
        '<html><head><title>A</title><link rel="canonical" href="https://example.com/a"></head><body><h1>A</h1></body></html>',
    });
    const snapshot = await snapshotFromOrigin('http://localhost:3000');
    expect(snapshot.site.origin).toBe('http://localhost:3000');
    expect(auditCrossPage(snapshot).some((f) => f.code === 'canonical.offsite')).toBe(true);
  });
});

describe('robots.txt during a crawl', () => {
  const routes = {
    [`${ORIGIN}/robots.txt`]: 'User-agent: *\nDisallow: /admin',
    [`${ORIGIN}/sitemap.xml`]: `<urlset><url><loc>${ORIGIN}/a</loc></url><url><loc>${ORIGIN}/admin/secret</loc></url></urlset>`,
    [`${ORIGIN}/a`]: html('A'),
    [`${ORIGIN}/admin/secret`]: html('Secret'),
  };

  it('skips a path robots.txt disallows', async () => {
    stubNetwork(routes);
    const snapshot = await snapshotFromOrigin(ORIGIN);
    expect(Object.keys(snapshot.pages)).toEqual(['/a']);
  });

  it('crawls it anyway with ignoreRobots, for a site you own', async () => {
    stubNetwork(routes);
    const snapshot = await snapshotFromOrigin(ORIGIN, { ignoreRobots: true });
    expect(Object.keys(snapshot.pages).sort()).toEqual(['/a', '/admin/secret']);
  });
});

describe('sitemap health', () => {
  it('records a sitemap entry that answers 404 without failing the crawl', async () => {
    stubNetwork({
      [`${ORIGIN}/sitemap.xml`]: `<urlset><url><loc>${ORIGIN}/a</loc></url><url><loc>${ORIGIN}/gone</loc></url></urlset>`,
      [`${ORIGIN}/a`]: html('A'),
    });
    const snapshot = await snapshotFromOrigin(ORIGIN);
    expect(snapshot.site.sitemap?.dead).toEqual(['/gone']);
    expect(snapshot.site.sitemap?.routes).toEqual(['/a', '/gone']);
  });

  it('records no sitemap at all when there was none to read', async () => {
    stubNetwork({ [`${ORIGIN}/`]: html('Home') });
    const snapshot = await snapshotFromOrigin(ORIGIN);
    expect(snapshot.site.sitemap).toBeUndefined();
  });
});

describe('snapshotFromGitRef', () => {
  let repo: string;
  const cwd = process.cwd();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'pagetrace-git-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    writeFileSync(join(repo, 'pagetrace.lock.json'), JSON.stringify({ schemaVersion: 1, createdAt: 'x', site: {}, pages: { '/': { route: '/' } } }));
    git('add', '-A');
    git('commit', '-qm', 'baseline');
    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it('reads a lockfile committed on another ref', async () => {
    const snapshot = await snapshotFromGitRef('main', 'pagetrace.lock.json');
    expect(Object.keys(snapshot!.pages)).toEqual(['/']);
  });

  it('returns null when the ref has no lockfile, an ordinary first run', async () => {
    expect(await snapshotFromGitRef('main', 'nope.lock.json')).toBeNull();
  });

  it('throws on an unresolvable ref rather than reading it as an empty baseline', async () => {
    // A typo here must not silently mean "nothing changed".
    await expect(snapshotFromGitRef('no-such-branch', 'pagetrace.lock.json')).rejects.toThrow(
      /Cannot resolve git ref/,
    );
  });
});

describe('sameSurface', () => {
  const base = {
    schemaVersion: 1 as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    site: { origin: ORIGIN, robotsTxt: null, llmsTxt: null },
    pages: {},
  };

  it('ignores the timestamp, so an unchanged site does not churn the lockfile', () => {
    expect(sameSurface(base, { ...base, createdAt: '2026-06-06T12:00:00.000Z' })).toBe(true);
  });

  it('still notices a real change', () => {
    const changed = { ...base, site: { ...base.site, llmsTxt: { present: true, sections: [], bytes: 10 } } };
    expect(sameSurface(base, changed)).toBe(false);
  });
});

describe('fetchText retries', () => {
  it('recovers from a transient 503 instead of failing the crawl', async () => {
    let hits = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (url === `${ORIGIN}/sitemap.xml`)
        return new Response(`<urlset><url><loc>${ORIGIN}/a</loc></url></urlset>`, { status: 200 });
      if (url === `${ORIGIN}/a`) {
        hits += 1;
        if (hits < 3) return new Response('later', { status: 503 });
        return new Response(html('A'), { status: 200 });
      }
      return new Response('nope', { status: 404 });
    });

    const snapshot = await snapshotFromOrigin(ORIGIN);
    expect(hits).toBe(3);
    expect(snapshot.pages['/a'].title).toBe('A');
  });

  it('gives up after repeated failures rather than pretending the page is gone', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url === `${ORIGIN}/sitemap.xml`)
        return new Response(`<urlset><url><loc>${ORIGIN}/a</loc></url></urlset>`, { status: 200 });
      if (url === `${ORIGIN}/a`) return new Response('down', { status: 503 });
      return new Response('nope', { status: 404 });
    });
    await expect(snapshotFromOrigin(ORIGIN)).rejects.toThrow(/HTTP 503/);
  });

  it('does not retry a 4xx, which is an answer rather than a hiccup', async () => {
    let hits = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (url === `${ORIGIN}/sitemap.xml`)
        return new Response(`<urlset><url><loc>${ORIGIN}/a</loc></url></urlset>`, { status: 200 });
      if (url === `${ORIGIN}/a`) {
        hits += 1;
        return new Response('nope', { status: 403 });
      }
      return new Response('nope', { status: 404 });
    });
    await expect(snapshotFromOrigin(ORIGIN)).rejects.toThrow(/HTTP 403/);
    expect(hits).toBe(1);
  });
});

describe('snapshotFromOrigin', () => {
  it('treats a 404 as absent rather than as a failure', async () => {
    stubNetwork({
      [`${ORIGIN}/sitemap.xml`]: `<urlset><url><loc>${ORIGIN}/</loc></url></urlset>`,
      [`${ORIGIN}/`]: html('Home'),
    });

    const snapshot = await snapshotFromOrigin(ORIGIN);
    expect(snapshot.site.robotsTxt).toBeNull();
    expect(snapshot.site.llmsTxt).toBeNull();
    expect(Object.keys(snapshot.pages)).toEqual(['/']);
  });

  it('fails loudly on an unreachable origin instead of reporting an empty site', async () => {
    // Swallowing this into "no pages" is what makes `check` invent a wall of
    // page.removed findings during a transient outage.
    stubNetwork({ [`${ORIGIN}/robots.txt`]: new Error('getaddrinfo ENOTFOUND') });
    await expect(snapshotFromOrigin(ORIGIN)).rejects.toThrow(/Could not reach/);
  });

  it('fails loudly when a page in the sitemap returns a server error', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      if (url === `${ORIGIN}/sitemap.xml`)
        return new Response(`<urlset><url><loc>${ORIGIN}/a</loc></url></urlset>`, { status: 200 });
      if (url === `${ORIGIN}/a`) return new Response('boom', { status: 503 });
      return new Response('nope', { status: 404 });
    });
    await expect(snapshotFromOrigin(ORIGIN)).rejects.toThrow(/HTTP 503/);
  });

  it('ignores sitemap entries from another host', async () => {
    stubNetwork({
      [`${ORIGIN}/sitemap.xml`]:
        `<urlset><url><loc>${ORIGIN}/x</loc></url><url><loc>https://other.test/x</loc></url></urlset>`,
      [`${ORIGIN}/x`]: html('Ours'),
      'https://other.test/x': html('Theirs'),
    });

    const snapshot = await snapshotFromOrigin(ORIGIN);
    // routeFromUrl drops the host, so both would land on /x and one would win.
    expect(snapshot.pages['/x'].title).toBe('Ours');
  });

  it('follows a sitemap index without crawling a gzipped child as a page', async () => {
    const calls = stubNetwork({
      [`${ORIGIN}/robots.txt`]: `Sitemap: ${ORIGIN}/sitemap_index.xml`,
      [`${ORIGIN}/sitemap_index.xml`]:
        `<sitemapindex><sitemap><loc>${ORIGIN}/posts.xml</loc></sitemap>` +
        `<sitemap><loc>${ORIGIN}/pages.xml.gz</loc></sitemap></sitemapindex>`,
      [`${ORIGIN}/posts.xml`]: `<urlset><url><loc>${ORIGIN}/post</loc></url></urlset>`,
      [`${ORIGIN}/post`]: html('Post'),
    });

    const snapshot = await snapshotFromOrigin(ORIGIN);
    expect(Object.keys(snapshot.pages)).toEqual(['/post']);
    expect(calls).not.toContain(`${ORIGIN}/pages.xml.gz`);
  });

  it('stops expanding a sitemap index once the limit is met', async () => {
    const children = Array.from({ length: 40 }, (_, i) => `${ORIGIN}/s${i}.xml`);
    const routes: Record<string, string> = {
      [`${ORIGIN}/robots.txt`]: `Sitemap: ${ORIGIN}/sitemap_index.xml`,
      [`${ORIGIN}/sitemap_index.xml`]: `<sitemapindex>${children
        .map((c) => `<sitemap><loc>${c}</loc></sitemap>`)
        .join('')}</sitemapindex>`,
    };
    for (const [i, child] of children.entries()) {
      routes[child] = `<urlset><url><loc>${ORIGIN}/p${i}</loc></url></urlset>`;
      routes[`${ORIGIN}/p${i}`] = html(`P${i}`);
    }
    const calls = stubNetwork(routes);

    const snapshot = await snapshotFromOrigin(ORIGIN, { limit: 3 });
    expect(Object.keys(snapshot.pages)).toHaveLength(3);
    // The point of --limit: it must not cost 40 round-trips to fetch 3 pages.
    expect(calls.filter((url) => url.endsWith('.xml')).length).toBeLessThanOrEqual(5);
  });
});
