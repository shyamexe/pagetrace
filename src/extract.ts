import { parse, type HTMLElement } from 'node-html-parser';
import type { JsonLdEntity, PageFingerprint } from './types.js';

const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const NON_CONTENT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG']);

function text(el: HTMLElement | null): string | null {
  if (!el) return null;
  const value = el.textContent.replace(/\s+/g, ' ').trim();
  return value.length > 0 ? value : null;
}

/**
 * HTML keywords are case-insensitive (`<meta NAME="Description">`, `rel="Canonical"`)
 * but CSS attribute selectors are not, so we match on lowercased values rather
 * than through querySelector.
 */
function metaContent(root: HTMLElement, name: string): string | null {
  for (const el of root.querySelectorAll('meta')) {
    if (el.getAttribute('name')?.trim().toLowerCase() !== name) continue;
    const value = el.getAttribute('content')?.trim();
    if (value) return value;
  }
  return null;
}

/** `rel` is a space-separated token list, e.g. `rel="alternate stylesheet"`. */
function hasRel(el: HTMLElement, rel: string): boolean {
  const value = el.getAttribute('rel');
  if (!value) return false;
  return value.trim().toLowerCase().split(/\s+/).includes(rel);
}

function linkHref(root: HTMLElement, rel: string): string | null {
  for (const el of root.querySelectorAll('link')) {
    if (!hasRel(el, rel)) continue;
    const href = el.getAttribute('href')?.trim();
    if (href) return href;
  }
  return null;
}

/**
 * Collect a namespaced meta group (og:*, twitter:*) into a flat record.
 * Open Graph uses `property`, Twitter Cards use `name`; some sites mix them,
 * so we read both.
 */
function metaGroup(root: HTMLElement, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const el of root.querySelectorAll('meta')) {
    const key = el.getAttribute('property') ?? el.getAttribute('name');
    if (!key || !key.toLowerCase().startsWith(`${prefix}:`)) continue;
    const content = el.getAttribute('content')?.trim();
    if (!content) continue;
    out[key.toLowerCase()] = content;
  }
  return out;
}

function hreflangMap(root: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const el of root.querySelectorAll('link')) {
    if (!hasRel(el, 'alternate')) continue;
    const lang = el.getAttribute('hreflang');
    const href = el.getAttribute('href');
    if (lang && href) out[lang.toLowerCase()] = href.trim();
  }
  return out;
}

/** Flatten @graph containers and arrays into a single list of entities. */
function flattenJsonLd(node: unknown, out: JsonLdEntity[]): void {
  if (Array.isArray(node)) {
    for (const item of node) flattenJsonLd(item, out);
    return;
  }
  if (typeof node !== 'object' || node === null) return;

  const obj = node as Record<string, unknown>;
  if ('@graph' in obj) {
    flattenJsonLd(obj['@graph'], out);
    // A wrapper carrying only @context/@graph is not itself an entity.
    const rest = Object.keys(obj).filter((k) => k !== '@graph' && k !== '@context');
    if (rest.length === 0) return;
  }

  const rawType = obj['@type'];
  const type = Array.isArray(rawType) ? String(rawType[0]) : rawType ? String(rawType) : null;
  if (!type) return;

  out.push({
    type,
    ...(typeof obj['@id'] === 'string' ? { id: obj['@id'] } : {}),
    properties: Object.keys(obj)
      .filter((k) => !k.startsWith('@'))
      .sort(),
  });
}

export function extractJsonLd(root: HTMLElement): JsonLdEntity[] {
  const entities: JsonLdEntity[] = [];
  for (const script of root.querySelectorAll('script')) {
    if (script.getAttribute('type')?.trim().toLowerCase() !== 'application/ld+json') continue;
    try {
      flattenJsonLd(JSON.parse(script.textContent), entities);
    } catch {
      entities.push({ type: '__parse_error__', properties: [] });
    }
  }
  return entities;
}

/** Visible word count, excluding scripts, styles and inline SVG. */
function countWords(root: HTMLElement): number {
  const body = root.querySelector('body') ?? root;
  const clone = parse(body.outerHTML);
  for (const tag of NON_CONTENT) {
    for (const el of clone.querySelectorAll(tag.toLowerCase())) el.remove();
  }
  const words = clone.textContent.replace(/\s+/g, ' ').trim();
  return words.length === 0 ? 0 : words.split(' ').length;
}

/**
 * Answer engines favour pages that answer the question up front. We measure the
 * length of the first substantive paragraph after the h1 as a proxy: too short
 * and there is nothing to quote, too long and it will not be extracted cleanly.
 */
function leadAnswer(root: HTMLElement): number {
  const scope =
    root.querySelector('main') ??
    root.querySelector('article') ??
    root.querySelector('body') ??
    root;

  // Cookie banners, promo strips and breadcrumbs are paragraphs too, and they
  // sit above the h1. Anchor on the h1 so they cannot stand in for the lead.
  const candidates = scope
    .querySelectorAll('h1, p')
    .filter((el) => !el.closest('header, nav, footer, aside'));
  const firstH1 = candidates.findIndex((el) => el.tagName?.toUpperCase() === 'H1');

  for (const el of candidates.slice(firstH1 + 1)) {
    if (el.tagName?.toUpperCase() !== 'P') continue;
    const value = text(el);
    if (!value) continue;
    const words = value.split(' ').length;
    if (words >= 8) return words;
  }
  return 0;
}

export function extractPage(html: string, route: string): PageFingerprint {
  const root = parse(html, { blockTextElements: { script: true, style: true } });

  const headings: string[] = [];
  const h1: string[] = [];
  for (const el of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const tag = el.tagName?.toUpperCase();
    if (!tag || !HEADING_TAGS.has(tag)) continue;
    headings.push(tag.toLowerCase());
    if (tag === 'H1') {
      const value = text(el);
      if (value) h1.push(value);
    }
  }

  const imgs = root.querySelectorAll('img');
  const missingAlt = imgs.filter((img) => {
    const alt = img.getAttribute('alt');
    return alt === undefined || alt === null;
  }).length;

  return {
    route,
    title: text(root.querySelector('title')),
    description: metaContent(root, 'description'),
    canonical: linkHref(root, 'canonical'),
    robots: metaContent(root, 'robots')?.toLowerCase() ?? null,
    og: metaGroup(root, 'og'),
    twitter: metaGroup(root, 'twitter'),
    hreflang: hreflangMap(root),
    h1,
    headingOutline: headings,
    jsonLd: extractJsonLd(root).sort((a, b) => a.type.localeCompare(b.type)),
    wordCount: countWords(root),
    images: { total: imgs.length, missingAlt },
    leadAnswerWords: leadAnswer(root),
    generator: metaContent(root, 'generator'),
  };
}

/** Parse robots.txt into per-agent crawlability of the site root. */
export function extractRobotsTxt(body: string, agents: string[]) {
  const sitemaps: string[] = [];
  type Group = { agents: string[]; disallowAll: boolean; disallow: string[]; allow: string[] };
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'sitemap') {
      sitemaps.push(value);
      continue;
    }
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], disallowAll: false, disallow: [], allow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field === 'disallow' && current) {
      if (value === '/') current.disallowAll = true;
      if (value !== '') current.disallow.push(value);
    }
    if (field === 'allow' && current) {
      if (value === '/') current.disallowAll = false;
      current.allow.push(value);
    }
  }

  // The rules a plain crawler obeys: its own group if robots.txt names it,
  // otherwise the wildcard group.
  const ours = groups.find((g) => g.agents.includes('pagetrace')) ?? groups.find((g) => g.agents.includes('*'));

  const aiAgents: Record<string, 'allowed' | 'disallowed'> = {};
  for (const agent of agents) {
    const lower = agent.toLowerCase();
    const specific = groups.find((g) => g.agents.includes(lower));
    const wildcard = groups.find((g) => g.agents.includes('*'));
    const group = specific ?? wildcard;
    aiAgents[agent] = group?.disallowAll ? 'disallowed' : 'allowed';
  }

  return {
    present: true,
    aiAgents,
    sitemaps,
    disallow: ours?.disallow ?? [],
    allow: ours?.allow ?? [],
  };
}

/**
 * robots.txt path matching: `*` stands for any run of characters and a trailing
 * `$` anchors the end. Everything else is a literal prefix.
 */
function robotsPattern(rule: string): RegExp {
  const anchored = rule.endsWith('$');
  const body = anchored ? rule.slice(0, -1) : rule;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

/**
 * Whether a path may be crawled. The longest matching rule wins, and Allow wins
 * a tie — the behaviour Google and the RFC both specify, and the reason
 * `Disallow: /` with `Allow: /blog` is a crawlable blog rather than a dead site.
 */
export function isCrawlable(
  path: string,
  rules: { disallow?: string[]; allow?: string[] } | null | undefined,
): boolean {
  if (!rules) return true;
  const longest = (patterns: string[] = []) =>
    patterns
      .filter((rule) => rule !== '' && robotsPattern(rule).test(path))
      .reduce((max, rule) => Math.max(max, rule.length), -1);
  return longest(rules.allow) >= longest(rules.disallow);
}

/**
 * Internal-looking hrefs on the page, deduplicated, in document order.
 *
 * Resolution happens in snapshot.ts, which is the only layer that knows the
 * page's own URL and the full set of routes. Anything with a scheme is somebody
 * else's problem: an external link checker fans out to hosts you do not
 * control, where a Cloudflare 403 and a rate limit both look like a dead page.
 */
export function extractLinks(html: string): string[] {
  const root = parse(html);
  const hrefs = new Set<string>();
  for (const anchor of root.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href')?.trim();
    if (!href) continue;
    // Fragments, mailto:, tel:, javascript:, protocol-relative and absolute
    // URLs. A bare "#" section link is the same page by definition.
    if (href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
    hrefs.add(href);
  }
  return [...hrefs];
}

/** Parse llms.txt, capturing section headings so truncation is detectable. */
export function extractLlmsTxt(body: string) {
  const sections = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith('## '))
    .map((line) => line.slice(3).trim());
  return { present: true, sections, bytes: Buffer.byteLength(body, 'utf8') };
}

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** XML requires `&` in a URL to be escaped, so every query string arrives encoded. */
function decodeXml(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (match, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return XML_ENTITIES[String(name).toLowerCase()] ?? match;
  });
}

/** Pull <loc> entries out of a sitemap or sitemap index. */
export function extractSitemapUrls(xml: string): string[] {
  const pattern = /<loc>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*?))\s*<\/loc>/gi;
  return [...xml.matchAll(pattern)]
    // CDATA is literal by definition; only the escaped form needs decoding.
    .map((m) => (m[1] !== undefined ? m[1] : decodeXml(m[2] ?? '')).trim())
    .filter((url) => url.length > 0);
}
