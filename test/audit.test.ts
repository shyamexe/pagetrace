import { describe, expect, it } from 'vitest';
import { auditPage, auditSite } from '../src/audit.js';
import { applyConfig, formatJson, formatMarkdown, shouldFail, summarize } from '../src/report.js';
import { routeFromFilePath, routeFromUrl, shouldIgnore } from '../src/snapshot.js';
import type { Finding, PageFingerprint, Snapshot } from '../src/types.js';

function page(overrides: Partial<PageFingerprint> = {}): PageFingerprint {
  return {
    route: '/',
    title: 'A perfectly reasonable title',
    description: 'A description.',
    canonical: 'https://example.com/',
    robots: null,
    og: { 'og:title': 'A', 'og:image': 'https://example.com/og.png' },
    twitter: {},
    hreflang: {},
    h1: ['Heading'],
    headingOutline: ['h1'],
    jsonLd: [{ type: 'Article', properties: ['author', 'dateModified', 'datePublished', 'headline', 'image'] }],
    wordCount: 800,
    images: { total: 1, missingAlt: 0 },
    leadAnswerWords: 40,
    generator: null,
    ...overrides,
  };
}

const codes = (findings: Finding[]) => findings.map((f) => f.code);

describe('auditPage', () => {
  it('passes a well-formed page', () => {
    expect(auditPage(page())).toEqual([]);
  });

  it('flags the core missing fields', () => {
    const findings = auditPage(page({ title: null, canonical: null, h1: [] }));
    expect(codes(findings)).toEqual(
      expect.arrayContaining(['title.missing', 'canonical.missing', 'h1.missing']),
    );
    expect(findings.every((f) => f.route === '/')).toBe(true);
  });

  it('reports required rich-result properties by name', () => {
    const findings = auditPage(page({ jsonLd: [{ type: 'Product', properties: ['name'] }] }));
    const oneOf = findings.find((f) => f.code === 'jsonld.oneof.missing');
    expect(oneOf?.message).toContain('offers');
    expect(codes(findings)).not.toContain('jsonld.required.missing');
  });

  it('separates required from recommended severity', () => {
    const findings = auditPage(page({ jsonLd: [{ type: 'Event', properties: ['name'] }] }));
    const required = findings.find((f) => f.code === 'jsonld.required.missing');
    const recommended = findings.find((f) => f.code === 'jsonld.recommended.missing');
    expect(required?.severity).toBe('error');
    expect(required?.message).toContain('startDate');
    expect(recommended?.severity).toBe('info');
  });

  it('ignores schema types outside the rich-result table', () => {
    const findings = auditPage(page({ jsonLd: [{ type: 'CustomThing', properties: [] }] }));
    expect(codes(findings)).not.toContain('jsonld.required.missing');
  });

  it('flags an unquotable opening passage', () => {
    expect(codes(auditPage(page({ leadAnswerWords: 0 })))).toContain('aeo.lead.missing');
  });

  it('honours a custom thin-content threshold', () => {
    expect(codes(auditPage(page({ wordCount: 200 })))).not.toContain('content.thin');
    expect(codes(auditPage(page({ wordCount: 200 }), { minWordCount: 300 }))).toContain('content.thin');
    const thin = auditPage(page({ wordCount: 200 }), { minWordCount: 300 }).find(
      (f) => f.code === 'content.thin',
    );
    // The page count lives in `after`, not the message, so aggregation can
    // group every thin page under one row.
    expect(thin?.message).not.toContain('200');
    expect(thin?.after).toBe(200);
  });
});

describe('auditSite', () => {
  const snapshot = (site: Snapshot['site']): Snapshot => ({
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    site,
    pages: {},
  });

  it('reports missing robots.txt and llms.txt', () => {
    const findings = auditSite(snapshot({ robotsTxt: null, llmsTxt: null }));
    expect(codes(findings)).toEqual(
      expect.arrayContaining(['robotstxt.missing', 'aeo.llmstxt.missing']),
    );
  });

  it('lists blocked AI crawlers without treating it as a failure', () => {
    const findings = auditSite(
      snapshot({
        robotsTxt: {
          present: true,
          aiAgents: { GPTBot: 'disallowed', ClaudeBot: 'allowed' },
          sitemaps: ['https://example.com/sitemap.xml'],
        },
        llmsTxt: { present: true, sections: [], bytes: 10 },
      }),
    );
    const blocked = findings.find((f) => f.code === 'aeo.crawler.blocked');
    expect(blocked?.severity).toBe('info');
    expect(blocked?.message).toContain('GPTBot');
  });
});

describe('applyConfig', () => {
  const findings: Finding[] = [
    { code: 'title.changed', severity: 'info', route: '/b', message: 'x' },
    { code: 'canonical.removed', severity: 'error', route: '/a', message: 'y' },
  ];

  it('sorts errors first', () => {
    expect(applyConfig(findings)[0].code).toBe('canonical.removed');
  });

  it('applies severity overrides', () => {
    const result = applyConfig(findings, { severity: { 'title.changed': 'error' } });
    expect(result.every((f) => f.severity === 'error')).toBe(true);
  });

  it('drops rules switched off', () => {
    const result = applyConfig(findings, { severity: { 'canonical.removed': 'off' } });
    expect(codes(result)).toEqual(['title.changed']);
  });
});

describe('formatMarkdown', () => {
  it('escapes a pipe in a message so the table row does not split', () => {
    const finding: Finding = {
      code: 'duplicate.title',
      severity: 'warn',
      route: null,
      message: '3 pages share the title "Buy Widgets | Acme".',
    };
    const row = formatMarkdown([finding])
      .split('\n')
      .find((line) => line.includes('duplicate.title'))!;
    expect(row.match(/(?<!\\)\|/g)).toHaveLength(5);
    expect(row).toContain('Buy Widgets \\| Acme');
  });

  it('escapes angle brackets so a tag name is not eaten as inline HTML', () => {
    const finding: Finding = {
      code: 'h1.removed',
      severity: 'error',
      route: '/',
      message: 'The <h1> was removed.',
    };
    const row = formatMarkdown([finding])
      .split('\n')
      .find((line) => line.includes('h1.removed'))!;
    expect(row).toContain('The &lt;h1&gt; was removed.');
    expect(row).not.toContain('<h1>');
  });
});

describe('shouldFail', () => {
  it('throws rather than silently passing on an unknown severity', () => {
    // The gate going quiet on a typo is worse than the run failing.
    expect(() => shouldFail([], 'warning' as never)).toThrow(/Unknown severity/);
  });

  const findings: Finding[] = [{ code: 'a', severity: 'warn', route: '/', message: 'x' }];

  it('fails only at or above the configured threshold', () => {
    expect(shouldFail(findings, 'error')).toBe(false);
    expect(shouldFail(findings, 'warn')).toBe(true);
  });
});

describe('reporters', () => {
  const findings: Finding[] = [
    { code: 'canonical.removed', severity: 'error', route: '/a', message: 'Canonical was removed.' },
  ];

  it('emits a stable machine shape', () => {
    const parsed = JSON.parse(formatJson(findings));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.summary).toEqual({ error: 1, warn: 0, info: 0 });
    expect(parsed.findings[0].code).toBe('canonical.removed');
  });

  it('renders a markdown table for PR comments', () => {
    const md = formatMarkdown(findings);
    expect(md).toContain('| Severity | Route | Finding | Code |');
    expect(md).toContain('`canonical.removed`');
  });

  it('summarizes counts', () => {
    expect(summarize(findings)).toEqual({ error: 1, warn: 0, info: 0 });
  });
});

describe('route normalization', () => {
  it('maps index files to their directory route', () => {
    expect(routeFromFilePath('/out', '/out/index.html')).toBe('/');
    expect(routeFromFilePath('/out', '/out/blog/index.html')).toBe('/blog');
    expect(routeFromFilePath('/out', '/out/blog/post.html')).toBe('/blog/post');
  });

  it('strips origin and trailing slash from URLs', () => {
    expect(routeFromUrl('https://example.com/')).toBe('/');
    expect(routeFromUrl('https://example.com/blog/post/')).toBe('/blog/post');
  });

  it('supports exact and prefix ignores', () => {
    expect(shouldIgnore('/draft', ['/draft'])).toBe(true);
    expect(shouldIgnore('/preview/a', ['/preview/*'])).toBe(true);
    expect(shouldIgnore('/blog', ['/preview/*'])).toBe(false);
  });
});
