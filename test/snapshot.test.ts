import { afterEach, describe, expect, it, vi } from 'vitest';
import { snapshotFromOrigin } from '../src/snapshot.js';

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
