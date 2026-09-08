import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditCrossPage } from '../src/audit.js';
import {
  sameSurface,
  snapshotFromDir,
  snapshotFromGitRef,
  snapshotFromOrigin,
  snapshotFromPage,
} from '../src/snapshot.js';

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

describe('broken internal links', () => {
  const linking = (href: string) =>
    `<html><head><title>A</title></head><body><a href="${href}">go</a></body></html>`;

  it('reports a link to a page the build does not contain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pagetrace-links-'));
    writeFileSync(join(dir, 'index.html'), linking('/missing'));
    writeFileSync(join(dir, 'about.html'), linking('/'));
    const snapshot = await snapshotFromDir(dir);
    expect(snapshot.pages['/'].brokenLinks).toEqual(['/missing']);
    expect(snapshot.pages['/about'].brokenLinks).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not mistake an asset for a missing page', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pagetrace-links-'));
    writeFileSync(join(dir, 'index.html'), linking('/logo.png'));
    const snapshot = await snapshotFromDir(dir);
    expect(snapshot.pages['/'].brokenLinks).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('confirms a candidate over the network before reporting it on a crawl', async () => {
    // A sitemap routinely omits live pages, so absence from the crawl is not
    // evidence. /live answers, /gone does not.
    stubNetwork({
      [`${ORIGIN}/sitemap.xml`]: `<urlset><url><loc>${ORIGIN}/a</loc></url></urlset>`,
      [`${ORIGIN}/a`]: `<html><head><title>A</title></head><body><a href="/live">l</a><a href="/gone">g</a></body></html>`,
      [`${ORIGIN}/live`]: html('Live'),
    });
    const snapshot = await snapshotFromOrigin(ORIGIN);
    expect(snapshot.pages['/a'].brokenLinks).toEqual(['/gone']);
  });

  it('stays silent when the check itself could not reach the target', async () => {
    stubNetwork({
      [`${ORIGIN}/sitemap.xml`]: `<urlset><url><loc>${ORIGIN}/a</loc></url></urlset>`,
      [`${ORIGIN}/a`]: `<html><head><title>A</title></head><body><a href="/flaky">f</a></body></html>`,
      [`${ORIGIN}/flaky`]: new Error('ECONNRESET'),
    });
    const snapshot = await snapshotFromOrigin(ORIGIN);
    expect(snapshot.pages['/a'].brokenLinks).toBeUndefined();
  });
});

describe('snapshotFromPage', () => {
  const post = `<html><head><title>Post</title></head><body>
    <a href="/live">live</a><a href="/dead">dead</a>
    <a href="https://elsewhere.test/gone">out</a></body></html>`;

  const stub = () =>
    vi.stubGlobal('fetch', async (url: string) => {
      const ok: Record<string, string> = {
        [`${ORIGIN}/blog/post`]: post,
        [`${ORIGIN}/live`]: html('Live'),
      };
      if (ok[url]) return new Response(ok[url], { status: 200 });
      return new Response('nope', { status: 404 });
    });

  it('checks every link on the page, since there is no route set to trust', async () => {
    stub();
    const snapshot = await snapshotFromPage(`${ORIGIN}/blog/post`);
    expect(Object.keys(snapshot.pages)).toEqual(['/blog/post']);
    expect(snapshot.pages['/blog/post'].brokenLinks).toEqual(['/dead']);
  });

  it('leaves external links alone unless asked', async () => {
    stub();
    const snapshot = await snapshotFromPage(`${ORIGIN}/blog/post`);
    expect(snapshot.pages['/blog/post'].deadExternal).toBeUndefined();
  });

  it('checks external links when asked', async () => {
    stub();
    const snapshot = await snapshotFromPage(`${ORIGIN}/blog/post`, { checkExternal: true });
    expect(snapshot.pages['/blog/post'].deadExternal).toEqual(['https://elsewhere.test/gone']);
  });

  it('refuses a page that is not there rather than reporting an empty one', async () => {
    stub();
    await expect(snapshotFromPage(`${ORIGIN}/no-such-post`)).rejects.toThrow(/answered 404/);
  });

  it('ignores the sitemap entirely — the URL given is the one checked', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url);
      if (url === `${ORIGIN}/blog/post`) return new Response(html('Post'), { status: 200 });
      return new Response('nope', { status: 404 });
    });
    await snapshotFromPage(`${ORIGIN}/blog/post`);
    expect(asked.some((u) => u.includes('sitemap'))).toBe(false);
    expect(asked.some((u) => u.includes('robots.txt'))).toBe(false);
  });
});

describe('external links', () => {
  const page = (hrefs: string[]) =>
    `<html><head><title>A</title></head><body>${hrefs.map((h) => `<a href="${h}">l</a>`).join('')}</body></html>`;

  const stubExternal = (statuses: Record<string, number>) => {
    const asked: { url: string; method: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string }) => {
      asked.push({ url, method: init?.method ?? 'GET' });
      const routes: Record<string, string> = {
        [`${ORIGIN}/sitemap.xml`]: `<urlset><url><loc>${ORIGIN}/a</loc></url></urlset>`,
        [`${ORIGIN}/a`]: page(Object.keys(statuses)),
      };
      if (routes[url]) return new Response(routes[url], { status: 200 });
      if (url in statuses) return new Response('', { status: statuses[url] });
      return new Response('nope', { status: 404 });
    });
    return asked;
  };

  it('does nothing unless asked, since the hosts are not yours', async () => {
    const asked = stubExternal({ 'https://elsewhere.test/gone': 404 });
    const snapshot = await snapshotFromOrigin(ORIGIN);
    expect(snapshot.pages['/a'].deadExternal).toBeUndefined();
    expect(asked.some((a) => a.url.startsWith('https://elsewhere.test'))).toBe(false);
  });

  it('reports only 404 and 410, never a bot wall or a rate limit', async () => {
    stubExternal({
      'https://elsewhere.test/gone': 404,
      'https://elsewhere.test/retired': 410,
      'https://elsewhere.test/botwall': 403,
      'https://elsewhere.test/ratelimited': 429,
      'https://elsewhere.test/broken': 500,
      'https://elsewhere.test/fine': 200,
    });
    const snapshot = await snapshotFromOrigin(ORIGIN, { checkExternal: true });
    expect(snapshot.pages['/a'].deadExternal).toEqual([
      'https://elsewhere.test/gone',
      'https://elsewhere.test/retired',
    ]);
  });

  it('asks with HEAD, and falls back to GET when the server refuses it', async () => {
    const asked = stubExternal({ 'https://elsewhere.test/nohead': 405 });
    await snapshotFromOrigin(ORIGIN, { checkExternal: true });
    const forUrl = asked.filter((a) => a.url === 'https://elsewhere.test/nohead');
    expect(forUrl.map((a) => a.method)).toEqual(['HEAD', 'GET']);
  });

  it('treats an unreachable host as unknown rather than dead', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url === `${ORIGIN}/sitemap.xml`)
        return new Response(`<urlset><url><loc>${ORIGIN}/a</loc></url></urlset>`, { status: 200 });
      if (url === `${ORIGIN}/a`) return new Response(page(['https://elsewhere.test/x']), { status: 200 });
      if (url.startsWith('https://elsewhere.test')) throw new Error('ENOTFOUND');
      return new Response('nope', { status: 404 });
    });
    const snapshot = await snapshotFromOrigin(ORIGIN, { checkExternal: true });
    expect(snapshot.pages['/a'].deadExternal).toBeUndefined();
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
