import { RICH_RESULT_RULES } from './rules/rich-results.js';
import type { Config, Finding, PageFingerprint, Snapshot } from './types.js';

/**
 * Rules that hold regardless of history. These overlap with what any auditor
 * reports; the diff engine in `diff.ts` is what catches regressions.
 */
export function auditPage(page: PageFingerprint, config: Config = {}): Finding[] {
  const findings: Finding[] = [];
  const at = (code: string, severity: Finding['severity'], message: string, extra: Partial<Finding> = {}) =>
    findings.push({ code, severity, route: page.route, message, ...extra });

  if (!page.title) at('title.missing', 'error', 'Page has no <title>.');
  else if (page.title.length > 65)
    at('title.long', 'info', 'Title is long enough that it will likely be truncated in results.', {
      after: page.title.length,
    });

  if (!page.description) at('description.missing', 'warn', 'Page has no meta description.');

  if (!page.canonical) at('canonical.missing', 'error', 'Page has no canonical URL.');

  if (page.robots?.includes('noindex')) at('robots.noindex', 'warn', 'Page is marked noindex.');

  if (page.h1.length === 0) at('h1.missing', 'error', 'Page has no <h1>.');
  else if (page.h1.length > 1)
    at('h1.multiple', 'warn', 'Page has more than one <h1>.', { after: page.h1 });

  if (!page.og['og:title']) at('og.title.missing', 'warn', 'Missing og:title.');
  if (!page.og['og:image']) at('og.image.missing', 'warn', 'Missing og:image.');

  if (page.jsonLd.length === 0)
    at('jsonld.missing', 'warn', 'Page has no JSON-LD structured data.');

  for (const entity of page.jsonLd) {
    if (entity.type === '__parse_error__') {
      at('jsonld.invalid', 'error', 'A JSON-LD block failed to parse.');
      continue;
    }
    const rule = RICH_RESULT_RULES[entity.type];
    if (!rule) continue;

    const present = new Set(entity.properties);
    const missing = rule.required.filter((p) => !present.has(p));
    if (missing.length > 0) {
      at(
        'jsonld.required.missing',
        'error',
        `${entity.type} is missing required ${missing.length === 1 ? 'property' : 'properties'}: ${missing.join(', ')}.`,
        { after: entity.properties },
      );
    }
    for (const group of rule.oneOf ?? []) {
      if (!group.some((p) => present.has(p))) {
        at(
          'jsonld.oneof.missing',
          'error',
          `${entity.type} needs at least one of: ${group.join(', ')}.`,
        );
      }
    }
    const missingRecommended = rule.recommended.filter((p) => !present.has(p));
    if (missingRecommended.length > 0) {
      at(
        'jsonld.recommended.missing',
        'info',
        `${entity.type} is missing recommended: ${missingRecommended.join(', ')}.`,
      );
    }
  }

  const minWords = config.minWordCount ?? 150;
  if (page.wordCount < minWords)
    at('content.thin', 'warn', `Page has fewer than ${minWords} words.`, {
      after: page.wordCount,
    });

  // AEO: answer engines extract the opening passage. Nothing quotable there is
  // a missed citation, and an overlong lead tends to be chunked badly.
  if (page.leadAnswerWords === 0)
    at('aeo.lead.missing', 'warn', 'No substantive opening paragraph for an answer engine to quote.');
  else if (page.leadAnswerWords > 120)
    at('aeo.lead.long', 'info', 'Opening paragraph is long; under ~80 words extracts better.', {
      after: page.leadAnswerWords,
    });

  if (page.images.missingAlt > 0)
    at('images.alt.missing', 'warn', 'Page has images with no alt attribute.', {
      after: { missingAlt: page.images.missingAlt, total: page.images.total },
    });

  return findings;
}

export function auditSite(snapshot: Snapshot): Finding[] {
  const findings: Finding[] = [];
  const { site } = snapshot;

  if (!site.robotsTxt?.present) {
    findings.push({ code: 'robotstxt.missing', severity: 'warn', route: null, message: 'No robots.txt found.' });
  } else {
    const blocked = Object.entries(site.robotsTxt.aiAgents)
      .filter(([, state]) => state === 'disallowed')
      .map(([agent]) => agent);
    if (blocked.length > 0) {
      findings.push({
        code: 'aeo.crawler.blocked',
        severity: 'info',
        route: null,
        message: `robots.txt blocks ${blocked.length} AI crawler(s): ${blocked.join(', ')}.`,
        after: blocked,
      });
    }
    if (site.robotsTxt.sitemaps.length === 0) {
      findings.push({
        code: 'robotstxt.sitemap.missing',
        severity: 'warn',
        route: null,
        message: 'robots.txt does not declare a sitemap.',
      });
    }
  }

  if (!site.llmsTxt?.present) {
    findings.push({
      code: 'aeo.llmstxt.missing',
      severity: 'info',
      route: null,
      message: 'No /llms.txt found.',
    });
  }

  return findings;
}

/** Path portion of a canonical or hreflang href, normalized to match a snapshot route. */
function pathOf(href: string): string | null {
  try {
    const path = new URL(href, 'https://placeholder.invalid').pathname.replace(/\/+$/, '');
    return path === '' ? '/' : path;
  } catch {
    return null;
  }
}

/**
 * Rules that only exist when you look at the whole site at once. These are the
 * findings that matter most on a large CMS site, where the defects come from
 * templates rather than individual pages.
 */
export function auditCrossPage(snapshot: Snapshot): Finding[] {
  const findings: Finding[] = [];
  const pages = Object.values(snapshot.pages);

  const group = <T>(key: (p: (typeof pages)[number]) => T | null) => {
    const map = new Map<T, string[]>();
    for (const page of pages) {
      const value = key(page);
      if (value === null || value === undefined || value === '') continue;
      if (!map.has(value)) map.set(value, []);
      map.get(value)!.push(page.route);
    }
    return map;
  };

  for (const [title, routes] of group((p) => p.title)) {
    if (routes.length > 1) {
      findings.push({
        code: 'duplicate.title',
        severity: 'warn',
        route: null,
        message: `${routes.length} pages share the title "${title}".`,
        after: routes,
      });
    }
  }

  for (const [, routes] of group((p) => p.description)) {
    if (routes.length > 1) {
      findings.push({
        code: 'duplicate.description',
        severity: 'warn',
        route: null,
        message: `${routes.length} pages share the same meta description.`,
        after: routes,
      });
    }
  }

  for (const [canonical, routes] of group((p) => p.canonical)) {
    if (routes.length > 1) {
      findings.push({
        code: 'duplicate.canonical',
        severity: 'error',
        route: null,
        message: `${routes.length} pages canonicalise to ${canonical}.`,
        after: routes,
      });
    }
  }

  for (const page of pages) {
    if (!page.canonical) continue;
    const normalized = pathOf(page.canonical);
    if (normalized !== null && normalized !== page.route) {
      findings.push({
        code: 'canonical.crosspath',
        severity: 'warn',
        route: page.route,
        message: 'Canonical points to a different path.',
        before: page.route,
        after: page.canonical,
      });
    }
  }

  return findings;
}

const LANG_TAG = /^[a-z]{2,3}(-[a-zA-Z0-9]{2,8})*$/i;

/**
 * hreflang is the rule set most worth automating: Google requires the
 * annotations to be reciprocal, and a one-sided set is silently ignored rather
 * than reported anywhere. You cannot see this from a single page, which is why
 * it lives here rather than in auditPage.
 */
export function auditHreflang(snapshot: Snapshot): Finding[] {
  const findings: Finding[] = [];
  const pages = Object.values(snapshot.pages);
  const annotated = pages.filter((p) => Object.keys(p.hreflang).length > 0);

  // Only meaningful on a site that uses hreflang somewhere. A monolingual site
  // should not be nagged about it.
  if (annotated.length === 0) return findings;

  const byRoute = new Map(pages.map((p) => [p.route, p]));

  // Routes another page names as an alternate. Restricting hreflang.missing to
  // these keeps the rule honest on a partial crawl: a page nobody points at
  // proves nothing, exactly as an absent page proves nothing about reciprocity.
  const claimed = new Set<string>();
  for (const page of annotated) {
    for (const href of Object.values(page.hreflang)) {
      const target = pathOf(href);
      if (target !== null && target !== page.route) claimed.add(target);
    }
  }

  for (const page of pages) {
    const entries = Object.entries(page.hreflang);

    if (entries.length === 0) {
      if (claimed.has(page.route)) {
        findings.push({
          code: 'hreflang.missing',
          severity: 'warn',
          route: page.route,
          message: 'Page is named as an hreflang alternate but declares none of its own.',
        });
      }
      continue;
    }

    const invalid = entries
      .map(([lang]) => lang)
      .filter((lang) => lang !== 'x-default' && !LANG_TAG.test(lang));
    if (invalid.length > 0) {
      findings.push({
        code: 'hreflang.invalid',
        severity: 'warn',
        route: page.route,
        message: 'Page has malformed hreflang language codes.',
        after: invalid,
      });
    }

    const targets = [
      ...new Set(
        entries.map(([, href]) => pathOf(href)).filter((p): p is string => p !== null),
      ),
    ];

    if (!targets.includes(page.route)) {
      findings.push({
        code: 'hreflang.self.missing',
        severity: 'warn',
        route: page.route,
        message: 'Page does not include a self-referencing hreflang.',
      });
    }

    if (!entries.some(([lang]) => lang === 'x-default')) {
      findings.push({
        code: 'hreflang.xdefault.missing',
        severity: 'info',
        route: page.route,
        message: 'Page has hreflang alternates but no x-default.',
      });
    }

    // Reciprocity. Only checked against pages actually in the snapshot, so a
    // partial crawl does not manufacture findings.
    const broken: string[] = [];
    for (const target of targets) {
      if (target === page.route) continue;
      const other = byRoute.get(target);
      if (!other) continue;
      const returns = Object.values(other.hreflang)
        .map(pathOf)
        .includes(page.route);
      if (!returns) broken.push(target);
    }
    if (broken.length > 0) {
      findings.push({
        code: 'hreflang.nonreciprocal',
        severity: 'error',
        route: page.route,
        message: 'Page points at alternates that do not point back.',
        after: broken,
      });
    }

    for (const target of targets) {
      if (target === page.route) continue;
      const other = byRoute.get(target);
      if (other?.robots?.includes('noindex')) {
        findings.push({
          code: 'hreflang.noindex.target',
          severity: 'error',
          route: page.route,
          message: 'Page declares an hreflang alternate that is noindexed.',
          after: target,
        });
      }
    }
  }

  return findings;
}

export function auditSnapshot(snapshot: Snapshot, config: Config = {}): Finding[] {
  return [
    ...auditSite(snapshot),
    ...auditCrossPage(snapshot),
    ...auditHreflang(snapshot),
    ...Object.values(snapshot.pages).flatMap((page) => auditPage(page, config)),
  ];
}
