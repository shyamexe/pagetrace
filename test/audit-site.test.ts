import { describe, expect, it } from 'vitest';
import { auditCrossPage } from '../src/audit.js';
import { detectPlatform, withGuidance, GUIDANCE } from '../src/rules/guidance.js';
import { aggregate, formatAuditHtml, formatAuditMarkdown } from '../src/report.js';
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
    const dupe = findings.find((f) => f.code === 'duplicate.title');
    expect(dupe?.message).toContain('3 pages');
    expect(dupe?.after).toEqual(['/shop/a', '/shop/b', '/shop/c']);
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
    expect(finding?.message).toContain('/home');
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
