import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => vi.unstubAllGlobals());

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
