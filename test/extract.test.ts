import { describe, expect, it } from 'vitest';
import {
  extractJsonLd,
  extractLlmsTxt,
  extractPage,
  extractRobotsTxt,
  extractSitemapUrls,
} from '../src/extract.js';
import { parse } from 'node-html-parser';

const page = `
<!doctype html>
<html>
  <head>
    <title>Gold Rate Today in Kerala</title>
    <meta name="description" content="Live 22K and 24K gold rates." />
    <link rel="canonical" href="https://example.com/gold" />
    <meta name="robots" content="index, follow" />
    <meta property="og:title" content="Gold Rate Today" />
    <meta property="og:image" content="https://example.com/og.png" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="alternate" hreflang="en" href="https://example.com/en/gold" />
    <link rel="alternate" hreflang="ml" href="https://example.com/ml/gold" />
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}
    </script>
  </head>
  <body>
    <h1>Gold Rate Today</h1>
    <p>The 22K gold rate in Kerala today is tracked live and updated every morning from the local bullion association.</p>
    <h2>How it is calculated</h2>
    <p>Rates follow the international spot price adjusted for import duty.</p>
    <img src="/a.png" alt="chart" />
    <img src="/b.png" />
    <script>const noise = "should not be counted as words";</script>
  </body>
</html>`;

describe('extractPage', () => {
  const result = extractPage(page, '/gold');

  it('pulls the core indexable fields', () => {
    expect(result.title).toBe('Gold Rate Today in Kerala');
    expect(result.description).toBe('Live 22K and 24K gold rates.');
    expect(result.canonical).toBe('https://example.com/gold');
    expect(result.robots).toBe('index, follow');
  });

  it('reads og and twitter groups from both property and name', () => {
    expect(result.og['og:title']).toBe('Gold Rate Today');
    expect(result.og['og:image']).toBe('https://example.com/og.png');
    expect(result.twitter['twitter:card']).toBe('summary_large_image');
  });

  it('records hreflang alternates', () => {
    expect(result.hreflang).toEqual({
      en: 'https://example.com/en/gold',
      ml: 'https://example.com/ml/gold',
    });
  });

  it('captures the heading outline and h1 text', () => {
    expect(result.h1).toEqual(['Gold Rate Today']);
    expect(result.headingOutline).toEqual(['h1', 'h2']);
  });

  it('counts only images missing alt entirely', () => {
    expect(result.images).toEqual({ total: 2, missingAlt: 1 });
  });

  it('excludes script contents from the word count', () => {
    expect(result.wordCount).toBeGreaterThan(20);
    expect(result.wordCount).toBeLessThan(45);
  });

  it('measures the lead paragraph for answer extraction', () => {
    expect(result.leadAnswerWords).toBeGreaterThan(8);
  });

  it('reads meta and link keywords case-insensitively', () => {
    const shouty = extractPage(
      `<html><head>
         <meta NAME="Description" content="From a CMS that shouts.">
         <link REL="Canonical" href="https://example.com/x">
         <meta name="Robots" content="NOINDEX, follow">
         <meta name="Generator" content="WordPress 6.5">
         <link rel="Alternate stylesheet" hreflang="EN" href="https://example.com/en/x">
         <script type="Application/LD+JSON">{"@type":"Article"}</script>
       </head><body><h1>H</h1></body></html>`,
      '/x',
    );
    expect(shouty.description).toBe('From a CMS that shouts.');
    expect(shouty.canonical).toBe('https://example.com/x');
    expect(shouty.robots).toBe('noindex, follow');
    expect(shouty.generator).toBe('WordPress 6.5');
    expect(shouty.hreflang).toEqual({ en: 'https://example.com/en/x' });
    expect(shouty.jsonLd.map((e) => e.type)).toEqual(['Article']);
  });

  it('measures the lead after the h1, not a cookie banner above it', () => {
    const banner = extractPage(
      `<html><body>
         <header><p>We use cookies to improve your experience on this website, always.</p></header>
         <h1>Title</h1>
         <p>Short one.</p>
         <p>The actual lead paragraph runs long enough to be worth quoting in an answer engine.</p>
       </body></html>`,
      '/x',
    );
    expect(banner.leadAnswerWords).toBe(15);
  });

  it('returns nulls rather than throwing on an empty document', () => {
    const empty = extractPage('<html><body></body></html>', '/');
    expect(empty.title).toBeNull();
    expect(empty.canonical).toBeNull();
    expect(empty.h1).toEqual([]);
    expect(empty.jsonLd).toEqual([]);
  });
});

describe('extractJsonLd', () => {
  it('flattens @graph containers into individual entities', () => {
    const html = parse(`<script type="application/ld+json">
      {"@context":"https://schema.org","@graph":[
        {"@type":"Organization","@id":"#org","name":"Acme"},
        {"@type":"WebSite","name":"Acme","url":"https://acme.test"}
      ]}
    </script>`);
    const entities = extractJsonLd(html);
    expect(entities.map((e) => e.type)).toEqual(['Organization', 'WebSite']);
    expect(entities[0].id).toBe('#org');
    expect(entities[1].properties).toEqual(['name', 'url']);
  });

  it('handles a top-level array of entities', () => {
    const html = parse(`<script type="application/ld+json">
      [{"@type":"Article","headline":"A"},{"@type":"BreadcrumbList","itemListElement":[]}]
    </script>`);
    expect(extractJsonLd(html)).toHaveLength(2);
  });

  it('takes the first type when @type is an array', () => {
    const html = parse(`<script type="application/ld+json">
      {"@type":["LocalBusiness","Organization"],"name":"Clinic"}
    </script>`);
    expect(extractJsonLd(html)[0].type).toBe('LocalBusiness');
  });

  it('flags malformed JSON instead of throwing', () => {
    const html = parse(`<script type="application/ld+json">{ not json }</script>`);
    expect(extractJsonLd(html)[0].type).toBe('__parse_error__');
  });
});

describe('extractRobotsTxt', () => {
  it('resolves per-agent access with wildcard fallback', () => {
    const body = `
User-agent: *
Disallow:

User-agent: GPTBot
Disallow: /

Sitemap: https://example.com/sitemap.xml`;
    const result = extractRobotsTxt(body, ['GPTBot', 'ClaudeBot']);
    expect(result.aiAgents.GPTBot).toBe('disallowed');
    expect(result.aiAgents.ClaudeBot).toBe('allowed');
    expect(result.sitemaps).toEqual(['https://example.com/sitemap.xml']);
  });

  it('groups consecutive user-agent lines together', () => {
    const body = `User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /`;
    const result = extractRobotsTxt(body, ['GPTBot', 'ClaudeBot', 'PerplexityBot']);
    expect(result.aiAgents.GPTBot).toBe('disallowed');
    expect(result.aiAgents.ClaudeBot).toBe('disallowed');
    expect(result.aiAgents.PerplexityBot).toBe('allowed');
  });

  it('ignores comments', () => {
    const body = `# blocking everything\nUser-agent: *\nDisallow: / # for now`;
    expect(extractRobotsTxt(body, ['GPTBot']).aiAgents.GPTBot).toBe('disallowed');
  });
});

describe('extractLlmsTxt', () => {
  it('records section headings and size', () => {
    const result = extractLlmsTxt('# Site\n\n## Docs\n- a\n\n## Pricing\n- b\n');
    expect(result.sections).toEqual(['Docs', 'Pricing']);
    expect(result.bytes).toBeGreaterThan(0);
  });
});

describe('extractSitemapUrls', () => {
  it('decodes XML entities in a query string', () => {
    const xml = '<urlset><url><loc>https://a.test/p?b=1&amp;c=2</loc></url></urlset>';
    expect(extractSitemapUrls(xml)).toEqual(['https://a.test/p?b=1&c=2']);
  });

  it('reads CDATA-wrapped locations', () => {
    const xml = '<urlset><url><loc><![CDATA[https://a.test/p]]></loc></url></urlset>';
    expect(extractSitemapUrls(xml)).toEqual(['https://a.test/p']);
  });

  it('reads loc entries regardless of whitespace', () => {
    const xml = `<urlset><url><loc>https://a.test/</loc></url><url><loc>
      https://a.test/b </loc></url></urlset>`;
    expect(extractSitemapUrls(xml)).toEqual(['https://a.test/', 'https://a.test/b']);
  });
});
