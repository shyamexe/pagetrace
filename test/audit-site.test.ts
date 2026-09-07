import { describe, expect, it } from 'vitest';
import { auditCrossPage, auditSite } from '../src/audit.js';
import { detectPlatform, withGuidance, GUIDANCE } from '../src/rules/guidance.js';
import { aggregate, formatAuditHtml, formatAuditMarkdown, formatAuditPretty, formatSarif } from '../src/report.js';
import type { Aggregate, Finding, PageFingerprint, Snapshot } from '../src/types.js';

function page(route: string, overrides: Partial<PageFingerprint> = {}): PageFingerprint {
  return {
    route,
    title: `Title for ${route}`,
    description: `Description for ${route}`,
    canonical: `https://example.com${route === '/' ? '/' : route}`,
    robots: null,
    og: {},
    twitter: {},
    hreflang: {},
    h1: ['Heading'],
    headingOutline: ['h1'],
    jsonLd: [],
    wordCount: 800,
    images: { total: 0, missingAlt: 0 },
    leadAnswerWords: 40,
    generator: null,
    ...overrides,
  };
}

function snapshot(pages: PageFingerprint[]): Snapshot {
  return {
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    site: { robotsTxt: null, llmsTxt: null },
    pages: Object.fromEntries(pages.map((p) => [p.route, p])),
  };
}

const codes = (findings: Finding[]) => findings.map((f) => f.code);

describe('auditCrossPage', () => {
  it('flags a canonical that points at a URL which redirects', () => {
    const findings = auditCrossPage(
      snapshot([
        page('/gold', { canonical: 'https://example.com/gold-rate' }),
        page('/gold-rate', { redirectsTo: '/rates/gold' }),
      ]),
    );
    const redirects = findings.filter((f) => f.code === 'canonical.redirects');
    expect(redirects).toEqual([
      expect.objectContaining({ route: '/gold', severity: 'warn' }),
    ]);
  });

  it('stays quiet when the canonical target was never crawled', () => {
    const findings = auditCrossPage(
      snapshot([page('/gold', { canonical: 'https://example.com/never-fetched' })]),
    );
    expect(findings.map((f) => f.code)).not.toContain('canonical.redirects');
  });

  it('passes a site with unique metadata', () => {
    const findings = auditCrossPage(snapshot([page('/'), page('/about'), page('/contact')]));
    expect(findings).toEqual([]);
  });

  it('flags templated duplicate titles and names the affected routes', () => {
    const findings = auditCrossPage(
      snapshot([
        page('/shop/a', { title: 'Shop' }),
        page('/shop/b', { title: 'Shop' }),
        page('/shop/c', { title: 'Shop' }),
      ]),
    );
    const dupes = findings.filter((f) => f.code === 'duplicate.title');
    // One per affected route, so the rollup can name the pages involved.
    expect(dupes.map((f) => f.route)).toEqual(['/shop/a', '/shop/b', '/shop/c']);
    expect(dupes[0].message).toContain('3 pages');
    expect(dupes[0].after).toEqual(['/shop/a', '/shop/b', '/shop/c']);
    // The message is constant within the group, so aggregation collapses them.
    expect(new Set(dupes.map((f) => f.message)).size).toBe(1);
  });

  it('names the pages involved in a duplicate, which is the actionable part', () => {
    const findings = auditCrossPage(
      snapshot([
        page('/a', { description: 'Same words.' }),
        page('/b', { description: 'Same words.' }),
        page('/c', { description: 'Different.' }),
      ]),
    );
    const [group] = aggregate(findings.filter((f) => f.code === 'duplicate.description'));
    expect(group.count).toBe(2);
    expect(group.routes).toEqual(['/a', '/b']);
  });

  it('treats several pages canonicalising to one URL as an error', () => {
    const findings = auditCrossPage(
      snapshot([
        page('/blog/page/2', { canonical: 'https://example.com/blog' }),
        page('/blog/page/3', { canonical: 'https://example.com/blog' }),
      ]),
    );
    expect(findings.find((f) => f.code === 'duplicate.canonical')?.severity).toBe('error');
  });

  it('flags a canonical pointing at another path', () => {
    const findings = auditCrossPage(
      snapshot([page('/services', { canonical: 'https://example.com/home' })]),
    );
    const finding = findings.find((f) => f.code === 'canonical.crosspath');
    expect(finding?.route).toBe('/services');
    expect(finding?.after).toBe('https://example.com/home');
  });

  it('flags a canonical pointing at another host', () => {
    const snap = snapshot([page('/services', { canonical: 'https://staging.example.net/services' })]);
    snap.site.origin = 'https://example.com';
    const finding = auditCrossPage(snap).find((f) => f.code === 'canonical.offsite');
    expect(finding?.route).toBe('/services');
    expect(finding?.severity).toBe('error');
    // The path matches, so the path-only rule saw nothing wrong with it.
    expect(codes(auditCrossPage(snap))).not.toContain('canonical.crosspath');
  });

  it('says nothing about hosts when the site origin is unknown', () => {
    // A --dir crawl with no siteUrl configured: any host would be a guess.
    const snap = snapshot([page('/services', { canonical: 'https://staging.example.net/services' })]);
    expect(codes(auditCrossPage(snap))).not.toContain('canonical.offsite');
  });

  it('leaves paginated archives and AMP variants alone', () => {
    const quiet = snapshot([
      page('/blog', { canonical: 'https://example.com/blog' }),
      page('/blog/page/2', { canonical: 'https://example.com/blog' }),
      page('/blog/p/3', { canonical: 'https://example.com/blog' }),
      page('/article/amp', { canonical: 'https://example.com/article' }),
      page('/amp/guide', { canonical: 'https://example.com/guide' }),
    ]);
    expect(codes(auditCrossPage(quiet))).not.toContain('canonical.crosspath');
  });

  it('still flags a page canonicalising to an unrelated path', () => {
    const findings = auditCrossPage(
      snapshot([page('/blog/page/2', { canonical: 'https://example.com/pricing' })]),
    );
    expect(codes(findings)).toContain('canonical.crosspath');
  });

  it('accepts a self-referencing canonical with a trailing slash', () => {
    const findings = auditCrossPage(
      snapshot([page('/services', { canonical: 'https://example.com/services/' })]),
    );
    expect(codes(findings)).not.toContain('canonical.crosspath');
  });

  it('ignores pages with no canonical rather than double-reporting', () => {
    const findings = auditCrossPage(snapshot([page('/a', { canonical: null })]));
    expect(codes(findings)).toEqual([]);
  });
});

describe('detectPlatform', () => {
  it('reads the generator tag', () => {
    expect(detectPlatform(['WordPress 6.7.1'])).toBe('wordpress');
    expect(detectPlatform(['Next.js'])).toBe('nextjs');
    expect(detectPlatform(['Drupal 10 (https://www.drupal.org)'])).toBe('drupal');
  });

  it('falls back to asset URL shape', () => {
    expect(detectPlatform([null], ['https://site.test/wp-content/uploads/og.png'])).toBe('wordpress');
    expect(detectPlatform([null], ['https://site.test/_next/image?url=x'])).toBe('nextjs');
  });

  it('returns unknown when there is no signal', () => {
    expect(detectPlatform([null, null], ['https://site.test/og.png'])).toBe('unknown');
  });
});

describe('withGuidance', () => {
  it('attaches why and fix text', () => {
    const result = withGuidance({ code: 'canonical.missing' });
    expect(result.detail).toBeTruthy();
    expect(result.fix).toBe(GUIDANCE['canonical.missing'].fix);
  });

  it('prefers platform-specific advice when the platform is known', () => {
    const generic = withGuidance({ code: 'canonical.missing' }, 'unknown');
    const wp = withGuidance({ code: 'canonical.missing' }, 'wordpress');
    expect(wp.fix).not.toBe(generic.fix);
    expect(wp.fix).toContain('Yoast');
  });

  it('leaves findings without guidance untouched', () => {
    const result = withGuidance({ code: 'some.unmapped.code' });
    expect(result.detail).toBeUndefined();
  });
});

describe('aggregate', () => {
  const findings: Finding[] = [
    { code: 'canonical.missing', severity: 'error', route: '/a', message: 'no canonical' },
    { code: 'canonical.missing', severity: 'error', route: '/b', message: 'no canonical' },
    { code: 'og.image.missing', severity: 'warn', route: '/a', message: 'no og:image' },
    { code: 'aeo.llmstxt.missing', severity: 'info', route: null, message: 'no llms.txt' },
  ];

  it('keeps type-specific messages in separate rows', () => {
    const mixed: Finding[] = [
      { code: 'jsonld.recommended.missing', severity: 'info', route: '/a', message: 'Organization is missing recommended: sameAs.' },
      { code: 'jsonld.recommended.missing', severity: 'info', route: '/b', message: 'Product is missing recommended: brand.' },
      { code: 'jsonld.recommended.missing', severity: 'info', route: '/c', message: 'Product is missing recommended: brand.' },
    ];
    const groups = aggregate(mixed);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.message.startsWith('Organization'))!.routes).toEqual(['/a']);
    expect(groups.find((g) => g.message.startsWith('Product'))!.routes).toEqual(['/b', '/c']);
  });

  it('rolls repeated findings into one row with a route list', () => {
    const groups = aggregate(findings);
    expect(groups).toHaveLength(3);
    const canonical = groups.find((g) => g.code === 'canonical.missing')!;
    expect(canonical.count).toBe(2);
    expect(canonical.routes).toEqual(['/a', '/b']);
  });

  it('orders by severity then by how many pages are affected', () => {
    expect(aggregate(findings).map((g) => g.code)).toEqual([
      'canonical.missing',
      'og.image.missing',
      'aeo.llmstxt.missing',
    ]);
  });

  it('keeps site-wide findings with an empty route list', () => {
    expect(aggregate(findings).find((g) => g.code === 'aeo.llmstxt.missing')!.routes).toEqual([]);
  });
});

describe('audit reporters', () => {
  const groups: Aggregate[] = [
    {
      code: 'canonical.missing',
      severity: 'error',
      count: 43,
      routes: ['/a', '/b'],
      message: 'Page has no canonical URL.',
      detail: 'Duplicates compete.',
      fix: 'Add a self-referencing canonical.',
    },
  ];
  const meta = {
    target: 'https://example.com',
    platform: 'wordpress' as const,
    pageCount: 120,
    generatedAt: '2026-09-06',
  };

  it('includes the fix and affected count in markdown', () => {
    const md = formatAuditMarkdown(groups, meta);
    expect(md).toContain('affects 43 pages');
    expect(md).toContain('**Fix.** Add a self-referencing canonical.');
    expect(md).toContain('WordPress');
  });

  it('produces a self-contained HTML document', () => {
    const html = formatAuditHtml(groups, meta);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).not.toContain('<script');
    expect(html).toContain('120 pages crawled');
  });

  it('escapes untrusted page content in HTML output', () => {
    const hostile: Aggregate[] = [
      { ...groups[0], message: '<img src=x onerror=alert(1)>', routes: ['/"><b>'] },
    ];
    const html = formatAuditHtml(hostile, meta);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
});

/**
 * picocolors enables colour whenever CI is set in the environment, so these
 * assertions have to measure the rendered text rather than the escape codes.
 * Locally they passed without this and failed on every CI runner.
 */
const plain = (value: string) => value.replace(/\u001b\[[0-9;]*m/g, '');

describe('formatAuditPretty', () => {
  const meta = {
    target: 'https://example.com',
    platform: 'unknown' as const,
    pageCount: 12,
    generatedAt: '2026-09-06',
  };
  const group = (over: Partial<Aggregate> = {}): Aggregate => ({
    code: 'h1.missing',
    severity: 'error',
    count: 3,
    routes: ['/about', '/experiment', '/projects'],
    message: 'Page has no <h1>.',
    detail: 'The h1 tells both crawlers and answer engines what the page is about, and it anchors the document outline used for passage extraction.',
    fix: 'Add exactly one h1 that matches the page topic.',
    ...over,
  });

  it('wraps prose to the terminal instead of running off it', () => {
    const out = plain(formatAuditPretty([group()], meta, 60));
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(60);
  });

  it('keeps the affected routes on their own line', () => {
    const out = formatAuditPretty([group()], meta, 80);
    expect(out).toContain('/about, /experiment, /projects');
  });

  it('groups findings under a rule per severity', () => {
    const out = formatAuditPretty(
      [group(), group({ severity: 'warn', code: 'og.image.missing', message: 'Missing og:image.' })],
      meta,
      80,
    );
    expect(plain(out)).toMatch(/ERRORS\s+─+\s+1/);
    expect(plain(out)).toMatch(/WARNINGS\s+─+\s+1/);
    expect(out.indexOf('ERRORS')).toBeLessThan(out.indexOf('WARNINGS'));
  });

  it('wraps a headline too long to share a line with the page count', () => {
    const long = group({ message: 'x'.repeat(90) });
    const out = plain(formatAuditPretty([long], meta, 80));
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(80);
    expect(out).toContain('3 pages');
  });

  it('does not say "1 findings"', () => {
    const out = plain(formatAuditPretty([group({ count: 1, routes: ['/a'] })], meta, 80));
    expect(out).toContain('1 finding across 12 pages');
    expect(out).not.toContain('1 findings');
  });

  it('says so plainly when there is nothing wrong', () => {
    expect(plain(formatAuditPretty([], meta, 80))).toContain('No issues found across 12 pages');
  });
});

describe('sitemap health rules', () => {
  const withSitemap = (pages: PageFingerprint[], sitemap: { routes: string[]; dead: string[] }) => {
    const snap = snapshot(pages);
    snap.site.sitemap = sitemap;
    return snap;
  };

  it('reports a sitemap URL that 404s as an error and one that redirects as a warning', () => {
    const findings = auditSite(
      withSitemap([page('/a', { redirectsTo: '/b' })], { routes: ['/a', '/gone'], dead: ['/gone'] }),
    );
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'sitemap.dead', severity: 'error', route: '/gone' }),
        expect.objectContaining({ code: 'sitemap.redirect', severity: 'warn', route: '/a' }),
      ]),
    );
  });

  it('says nothing about sitemaps for a filesystem crawl', () => {
    const codes = auditSite(snapshot([page('/a')])).map((f) => f.code);
    expect(codes.filter((c) => c.startsWith('sitemap.'))).toEqual([]);
  });

  it('explains both codes in the guidance table', () => {
    expect(GUIDANCE['sitemap.dead']).toBeDefined();
    expect(GUIDANCE['sitemap.redirect']).toBeDefined();
    expect(GUIDANCE['canonical.redirects']).toBeDefined();
  });
});

describe('formatSarif', () => {
  const findings: Finding[] = [
    { code: 'canonical.removed', severity: 'error', route: '/gold', message: 'Canonical was removed.' },
    { code: 'title.long', severity: 'warn', route: '/gold', message: 'Title is too long.' },
    { code: 'robotstxt.missing', severity: 'info', route: null, message: 'No robots.txt found.' },
  ];

  it('maps severities onto the three levels GitHub understands', () => {
    const sarif = JSON.parse(formatSarif(findings));
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].results.map((r: { level: string }) => r.level)).toEqual([
      'error',
      'warning',
      'note',
    ]);
  });

  it('gives every result a location, using the route as the artifact', () => {
    const sarif = JSON.parse(formatSarif(findings));
    const uris = sarif.runs[0].results.map(
      (r: { locations: { physicalLocation: { artifactLocation: { uri: string } } }[] }) =>
        r.locations[0].physicalLocation.artifactLocation.uri,
    );
    // A site-wide finding has no route, and SARIF still requires somewhere to
    // hang it, or GitHub drops the result on upload.
    expect(uris).toEqual(['gold', 'gold', 'site']);
  });

  it('declares each rule once, however many results share it', () => {
    const sarif = JSON.parse(formatSarif(findings));
    const ids = sarif.runs[0].tool.driver.rules.map((r: { id: string }) => r.id);
    expect(ids).toEqual(['canonical.removed', 'title.long', 'robotstxt.missing']);
  });
});
