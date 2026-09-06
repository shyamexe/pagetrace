import { describe, expect, it } from 'vitest';
import { auditHreflang } from '../src/audit.js';
import { countIssues, isTemplateWide } from '../src/report.js';
import type { Aggregate, Finding, PageFingerprint, Snapshot } from '../src/types.js';

function page(route: string, hreflang: Record<string, string> = {}): PageFingerprint {
  return {
    route,
    title: `Title ${route}`,
    description: 'A description.',
    canonical: `https://example.com${route}`,
    robots: null,
    og: {},
    twitter: {},
    hreflang,
    h1: ['Heading'],
    headingOutline: ['h1'],
    jsonLd: [],
    wordCount: 800,
    images: { total: 0, missingAlt: 0 },
    leadAnswerWords: 40,
    generator: null,
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

/** A correctly annotated bilingual pair, as on an /en + /ml site. */
const complete = () => [
  page('/en/about', {
    en: 'https://example.com/en/about',
    ml: 'https://example.com/ml/about',
    'x-default': 'https://example.com/en/about',
  }),
  page('/ml/about', {
    en: 'https://example.com/en/about',
    ml: 'https://example.com/ml/about',
    'x-default': 'https://example.com/en/about',
  }),
];

describe('auditHreflang', () => {
  it('stays silent on a monolingual site', () => {
    expect(auditHreflang(snapshot([page('/'), page('/about')]))).toEqual([]);
  });

  it('passes a fully reciprocal pair', () => {
    expect(auditHreflang(snapshot(complete()))).toEqual([]);
  });

  it('flags a one-sided annotation as an error', () => {
    const [en] = complete();
    const ml = page('/ml/about', { ml: 'https://example.com/ml/about' });
    const findings = auditHreflang(snapshot([en, ml]));
    const broken = findings.find((f) => f.code === 'hreflang.nonreciprocal');
    expect(broken?.route).toBe('/en/about');
    expect(broken?.after).toEqual(['/ml/about']);
    expect(broken?.severity).toBe('error');
  });

  it('does not invent reciprocity failures for uncrawled pages', () => {
    const en = page('/en/about', {
      en: 'https://example.com/en/about',
      de: 'https://example.com/de/about',
      'x-default': 'https://example.com/en/about',
    });
    // /de/about is not in the snapshot, so we cannot know either way.
    expect(codes(auditHreflang(snapshot([en])))).not.toContain('hreflang.nonreciprocal');
  });

  it('flags a page missing hreflang when the rest of the site has it', () => {
    const findings = auditHreflang(snapshot([...complete(), page('/en/contact')]));
    const missing = findings.find((f) => f.code === 'hreflang.missing');
    expect(missing?.route).toBe('/en/contact');
  });

  it('requires a self-reference', () => {
    const en = page('/en/about', {
      ml: 'https://example.com/ml/about',
      'x-default': 'https://example.com/ml/about',
    });
    expect(codes(auditHreflang(snapshot([en])))).toContain('hreflang.self.missing');
  });

  it('tolerates a trailing slash on the self-reference', () => {
    const en = page('/en/about', {
      en: 'https://example.com/en/about/',
      'x-default': 'https://example.com/en/about/',
    });
    expect(codes(auditHreflang(snapshot([en])))).not.toContain('hreflang.self.missing');
  });

  it('notes a missing x-default without treating it as a failure', () => {
    const en = page('/en/about', { en: 'https://example.com/en/about' });
    const finding = auditHreflang(snapshot([en])).find((f) => f.code === 'hreflang.xdefault.missing');
    expect(finding?.severity).toBe('info');
  });

  it('accepts region subtags and rejects malformed codes', () => {
    const good = page('/en/a', {
      'en-IN': 'https://example.com/en/a',
      'x-default': 'https://example.com/en/a',
    });
    expect(codes(auditHreflang(snapshot([good])))).not.toContain('hreflang.invalid');

    const bad = page('/en/b', {
      english: 'https://example.com/en/b',
      'x-default': 'https://example.com/en/b',
    });
    expect(codes(auditHreflang(snapshot([bad])))).toContain('hreflang.invalid');
  });

  it('flags an alternate that is noindexed', () => {
    const [en] = complete();
    const ml = { ...complete()[1], robots: 'noindex, follow' };
    const findings = auditHreflang(snapshot([en, ml]));
    expect(codes(findings)).toContain('hreflang.noindex.target');
  });
});

describe('issue counting', () => {
  const group = (severity: Finding['severity'], count: number, routes: string[]): Aggregate => ({
    code: `c${count}`,
    severity,
    count,
    routes,
    message: 'm',
  });

  it('counts distinct issues separately from page instances', () => {
    const result = countIssues([
      group('info', 40, Array.from({ length: 40 }, (_, i) => `/p${i}`)),
      group('warn', 2, ['/a', '/b']),
    ]);
    expect(result.total).toBe(2);
    expect(result.issues).toEqual({ error: 0, warn: 1, info: 1 });
    expect(result.instances).toEqual({ error: 0, warn: 1 + 1, info: 40 });
  });
});

describe('isTemplateWide', () => {
  const wide = (n: number) => ({
    code: 'x',
    severity: 'info' as const,
    count: n,
    routes: Array.from({ length: n }, (_, i) => `/p${i}`),
    message: 'm',
  });

  it('marks an issue hitting nearly every page as one template fix', () => {
    expect(isTemplateWide(wide(40), 40)).toBe(true);
    expect(isTemplateWide(wide(32), 40)).toBe(true);
  });

  it('leaves a partial issue unmarked', () => {
    expect(isTemplateWide(wide(20), 40)).toBe(false);
  });

  it('does not apply to tiny sites where the ratio is meaningless', () => {
    expect(isTemplateWide(wide(3), 3)).toBe(false);
  });
});
