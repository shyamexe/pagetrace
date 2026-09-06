import { parse, type HTMLElement } from 'node-html-parser';
import type { JsonLdEntity, PageFingerprint } from './types.js';

const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const NON_CONTENT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG']);

function text(el: HTMLElement | null): string | null {
  if (!el) return null;
  const value = el.textContent.replace(/\s+/g, ' ').trim();
  return value.length > 0 ? value : null;
}

function attr(root: HTMLElement, selector: string, name = 'content'): string | null {
  const el = root.querySelector(selector);
  if (!el) return null;
  const value = el.getAttribute(name);
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
  for (const el of root.querySelectorAll('link[rel="alternate"]')) {
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
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
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
  const paragraphs = root.querySelectorAll('p');
  for (const p of paragraphs) {
    const value = text(p);
    if (value && value.split(' ').length >= 8) return value.split(' ').length;
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
    description: attr(root, 'meta[name="description"]'),
    canonical: attr(root, 'link[rel="canonical"]', 'href'),
    robots: attr(root, 'meta[name="robots"]')?.toLowerCase() ?? null,
    og: metaGroup(root, 'og'),
    twitter: metaGroup(root, 'twitter'),
    hreflang: hreflangMap(root),
    h1,
    headingOutline: headings,
    jsonLd: extractJsonLd(root).sort((a, b) => a.type.localeCompare(b.type)),
    wordCount: countWords(root),
    images: { total: imgs.length, missingAlt },
    leadAnswerWords: leadAnswer(root),
    generator: attr(root, 'meta[name="generator"]'),
  };
}

/** Parse robots.txt into per-agent crawlability of the site root. */
export function extractRobotsTxt(body: string, agents: string[]) {
  const sitemaps: string[] = [];
  const groups: { agents: string[]; disallowAll: boolean }[] = [];
  let current: { agents: string[]; disallowAll: boolean } | null = null;
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
        current = { agents: [], disallowAll: false };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field === 'disallow' && current && value === '/') current.disallowAll = true;
    if (field === 'allow' && current && value === '/') current.disallowAll = false;
  }

  const aiAgents: Record<string, 'allowed' | 'disallowed'> = {};
  for (const agent of agents) {
    const lower = agent.toLowerCase();
    const specific = groups.find((g) => g.agents.includes(lower));
    const wildcard = groups.find((g) => g.agents.includes('*'));
    const group = specific ?? wildcard;
    aiAgents[agent] = group?.disallowAll ? 'disallowed' : 'allowed';
  }

  return { present: true, aiAgents, sitemaps };
}

/** Parse llms.txt, capturing section headings so truncation is detectable. */
export function extractLlmsTxt(body: string) {
  const sections = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith('## '))
    .map((line) => line.slice(3).trim());
  return { present: true, sections, bytes: Buffer.byteLength(body, 'utf8') };
}

/** Pull <loc> entries out of a sitemap or sitemap index. */
export function extractSitemapUrls(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
}
