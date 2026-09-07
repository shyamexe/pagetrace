import { describe, expect, it } from 'vitest';
import { diffPage, diffSite, diffSnapshots } from '../src/diff.js';
import type { PageFingerprint, SiteFingerprint, Snapshot } from '../src/types.js';

function page(overrides: Partial<PageFingerprint> = {}): PageFingerprint {
  return {
    route: '/gold',
    title: 'Gold Rate Today',
    description: 'Live rates.',
    canonical: 'https://example.com/gold',
    robots: 'index, follow',
    og: { 'og:title': 'Gold', 'og:image': 'https://example.com/og.png' },
    twitter: { 'twitter:card': 'summary' },
    hreflang: { en: 'https://example.com/en' },
    h1: ['Gold Rate Today'],
    headingOutline: ['h1', 'h2'],
    jsonLd: [{ type: 'FAQPage', properties: ['mainEntity'] }],
    wordCount: 400,
    images: { total: 2, missingAlt: 0 },
    leadAnswerWords: 30,
    generator: null,
    ...overrides,
  };
}

const codes = (findings: { code: string }[]) => findings.map((f) => f.code);

describe('diffPage', () => {
  it('reports nothing when the surface is unchanged', () => {
    expect(diffPage(page(), page())).toEqual([]);
  });

  it('separates a reworded title from a removed one', () => {
    const reworded = diffPage(page(), page({ title: 'Gold Rate in Kerala Today' }));
    expect(reworded).toHaveLength(1);
    expect(reworded[0].code).toBe('title.changed');
    expect(reworded[0].severity).toBe('info');

    const removed = diffPage(page(), page({ title: null }));
    expect(removed[0].code).toBe('title.removed');
    expect(removed[0].severity).toBe('error');
  });

  it('reports a route that starts redirecting, and where it lands', () => {
    const findings = diffPage(page(), page({ redirectsTo: '/gold-rate' }));
    expect(findings).toEqual([
      expect.objectContaining({
        code: 'redirect.added',
        severity: 'warn',
        route: '/gold',
        after: '/gold-rate',
      }),
    ]);
  });

  it('separates a redirect that moved from one that went away', () => {
    const moved = diffPage(page({ redirectsTo: '/a' }), page({ redirectsTo: '/b' }));
    expect(moved[0]).toMatchObject({ code: 'redirect.changed', severity: 'warn', before: '/a' });

    const gone = diffPage(page({ redirectsTo: '/a' }), page());
    expect(gone[0]).toMatchObject({ code: 'redirect.removed', severity: 'info' });
  });

  it('does not read a lockfile written before redirects were recorded as a change', () => {
    const { redirectsTo: _omitted, ...legacy } = page({ redirectsTo: null });
    expect(diffPage(legacy as PageFingerprint, page({ redirectsTo: null }))).toEqual([]);
  });

  it('fails on a link that broke this build, and names it', () => {
    const findings = diffPage(page(), page({ brokenLinks: ['/pricing-old'] }));
    expect(findings).toEqual([
      expect.objectContaining({
        code: 'link.broken.added',
        severity: 'error',
        message: 'Links to /pricing-old, which does not exist.',
      }),
    ]);
  });

  it('says nothing about a link that was already broken', () => {
    // The audit reports standing breakage. Repeating it here would fail CI for
    // a problem this build did not introduce.
    expect(diffPage(page({ brokenLinks: ['/old'] }), page({ brokenLinks: ['/old'] }))).toEqual([]);
  });

  it('notes a repaired link as information, not a problem', () => {
    const findings = diffPage(page({ brokenLinks: ['/old'] }), page());
    expect(findings[0]).toMatchObject({ code: 'link.broken.removed', severity: 'info' });
  });

  it('treats a lost canonical as an error and a changed one as a warning', () => {
    expect(diffPage(page(), page({ canonical: null }))[0]).toMatchObject({
      code: 'canonical.removed',
      severity: 'error',
    });
    expect(diffPage(page(), page({ canonical: 'https://example.com/gold-rate' }))[0]).toMatchObject({
      code: 'canonical.changed',
      severity: 'warn',
    });
  });

  it('catches a page silently becoming noindex', () => {
    const findings = diffPage(page(), page({ robots: 'noindex, follow' }));
    expect(codes(findings)).toContain('robots.noindex.added');
    expect(findings.find((f) => f.code === 'robots.noindex.added')?.severity).toBe('error');
  });

  it('does not flag a page that stays noindex', () => {
    const before = page({ robots: 'noindex' });
    expect(diffPage(before, page({ robots: 'noindex' }))).toEqual([]);
  });

  it('detects structured data disappearing', () => {
    const findings = diffPage(page(), page({ jsonLd: [] }));
    expect(codes(findings)).toContain('jsonld.entity.removed');
  });

  it('detects a property being dropped from an existing entity', () => {
    const before = page({
      jsonLd: [{ type: 'Product', properties: ['name', 'offers', 'image'] }],
    });
    const after = page({ jsonLd: [{ type: 'Product', properties: ['name', 'image'] }] });
    const finding = diffPage(before, after).find((f) => f.code === 'jsonld.property.removed');
    // The message stays constant per type so the rollup can collapse a template
    // defect; the properties themselves live in before/after.
    expect(finding?.before).toEqual(['name', 'offers', 'image']);
    expect(finding?.after).toEqual(['name', 'image']);
    expect(finding?.severity).toBe('error');
  });

  it('notices repeated entities of one type disappearing without an @id', () => {
    const three = page({
      jsonLd: [
        { type: 'Product', properties: ['name'] },
        { type: 'Product', properties: ['name'] },
        { type: 'Product', properties: ['name'] },
      ],
    });
    const one = page({ jsonLd: [{ type: 'Product', properties: ['name'] }] });
    const removed = diffPage(three, one).filter((f) => f.code === 'jsonld.entity.removed');
    expect(removed).toHaveLength(2);
  });

  it('matches entities by @id so a reordered @graph is not a change', () => {
    const before = page({
      jsonLd: [
        { type: 'Organization', id: '#org', properties: ['name'] },
        { type: 'WebSite', id: '#site', properties: ['url'] },
      ],
    });
    const after = page({
      jsonLd: [
        { type: 'WebSite', id: '#site', properties: ['url'] },
        { type: 'Organization', id: '#org', properties: ['name'] },
      ],
    });
    expect(diffPage(before, after)).toEqual([]);
  });

  it('reports removed social and hreflang tags', () => {
    const findings = diffPage(
      page(),
      page({ og: { 'og:title': 'Gold' }, hreflang: {} }),
    );
    expect(codes(findings)).toContain('og.removed');
    expect(codes(findings)).toContain('hreflang.removed');
  });

  it('flags a large content drop as a likely render failure', () => {
    const findings = diffPage(page(), page({ wordCount: 40 }));
    const drop = findings.find((f) => f.code === 'content.dropped');
    expect(drop?.severity).toBe('error');
    expect(drop?.before).toBe(400);
    expect(drop?.after).toBe(40);
  });

  it('ignores ordinary content edits', () => {
    const findings = diffPage(page(), page({ wordCount: 430 }));
    expect(codes(findings)).not.toContain('content.dropped');
  });
});

describe('diffSite', () => {
  const site = (overrides: Partial<SiteFingerprint> = {}): SiteFingerprint => ({
    robotsTxt: {
      present: true,
      aiAgents: { GPTBot: 'allowed', ClaudeBot: 'allowed' },
      sitemaps: ['https://example.com/sitemap.xml'],
    },
    llmsTxt: { present: true, sections: ['Docs', 'Pricing'], bytes: 900 },
    ...overrides,
  });

  it('flags an AI crawler that was newly blocked', () => {
    const after = site({
      robotsTxt: {
        present: true,
        aiAgents: { GPTBot: 'disallowed', ClaudeBot: 'allowed' },
        sitemaps: ['https://example.com/sitemap.xml'],
      },
    });
    const finding = diffSite(site(), after)[0];
    expect(finding.code).toBe('aeo.crawler.newly_blocked');
    expect(finding.severity).toBe('error');
  });

  it('flags llms.txt disappearing and shrinking', () => {
    expect(codes(diffSite(site(), site({ llmsTxt: null })))).toContain('aeo.llmstxt.removed');

    const shrunk = site({ llmsTxt: { present: true, sections: ['Docs'], bytes: 200 } });
    const found = codes(diffSite(site(), shrunk));
    expect(found).toContain('aeo.llmstxt.sections.removed');
    expect(found).toContain('aeo.llmstxt.truncated');
  });
});

describe('diffSnapshots', () => {
  const snapshot = (pages: Record<string, PageFingerprint>): Snapshot => ({
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    site: { robotsTxt: null, llmsTxt: null },
    pages,
  });

  it('reports pages that vanished and pages that appeared', () => {
    const before = snapshot({ '/gold': page(), '/silver': page({ route: '/silver' }) });
    const after = snapshot({ '/gold': page(), '/platinum': page({ route: '/platinum' }) });
    const findings = diffSnapshots(before, after);

    expect(findings).toContainEqual(
      expect.objectContaining({ code: 'page.removed', route: '/silver', severity: 'warn' }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ code: 'page.added', route: '/platinum', severity: 'info' }),
    );
  });

  it('attributes findings to the right route', () => {
    const before = snapshot({ '/gold': page(), '/silver': page({ route: '/silver' }) });
    const after = snapshot({
      '/gold': page(),
      '/silver': page({ route: '/silver', canonical: null }),
    });
    const findings = diffSnapshots(before, after);
    expect(findings).toHaveLength(1);
    expect(findings[0].route).toBe('/silver');
  });
});
