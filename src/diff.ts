import type { Finding, JsonLdEntity, PageFingerprint, Snapshot } from './types.js';

/**
 * The point of the diff engine: a field being *reworded* and a field being
 * *removed* are different events. Auditors collapse both into "current state".
 * We classify by transition, so CI can fail on regressions while ignoring the
 * ordinary content churn that happens on every deploy.
 */
function transition(
  before: string | null,
  after: string | null,
): 'unchanged' | 'added' | 'removed' | 'changed' {
  if (before === after) return 'unchanged';
  if (before === null) return 'added';
  if (after === null) return 'removed';
  return 'changed';
}

interface FieldRule {
  field: keyof PageFingerprint;
  label: string;
  code: string;
  onRemoved: Finding['severity'];
  onChanged: Finding['severity'];
  onAdded: Finding['severity'];
}

const SCALAR_FIELDS: FieldRule[] = [
  { field: 'title', label: 'Title', code: 'title', onRemoved: 'error', onChanged: 'info', onAdded: 'info' },
  { field: 'description', label: 'Meta description', code: 'description', onRemoved: 'warn', onChanged: 'info', onAdded: 'info' },
  { field: 'canonical', label: 'Canonical', code: 'canonical', onRemoved: 'error', onChanged: 'warn', onAdded: 'info' },
  // A route that starts redirecting still answers, so nothing else in the
  // fingerprint reports it: the surface simply becomes the destination's.
  { field: 'redirectsTo', label: 'Redirect', code: 'redirect', onRemoved: 'info', onChanged: 'warn', onAdded: 'warn' },
];

/**
 * Keyed by @id where available so a reordered @graph is not reported as a
 * change. Most templates emit no @id at all, and several entities of one type
 * on a page is the norm (a category page of Products, a FAQPage of Questions),
 * so those fall back to a positional key: keying on the bare type would collapse
 * them into one and hide every removal but the last.
 */
function indexEntities(entities: JsonLdEntity[]): Map<string, JsonLdEntity> {
  const map = new Map<string, JsonLdEntity>();
  const seen = new Map<string, number>();
  for (const entity of entities) {
    if (entity.id !== undefined && !map.has(entity.id)) {
      map.set(entity.id, entity);
      continue;
    }
    const nth = (seen.get(entity.type) ?? 0) + 1;
    seen.set(entity.type, nth);
    map.set(`${entity.type}#${nth}`, entity);
  }
  return map;
}

export function diffPage(before: PageFingerprint, after: PageFingerprint): Finding[] {
  const findings: Finding[] = [];
  const route = after.route;
  const push = (code: string, severity: Finding['severity'], message: string, extra: Partial<Finding> = {}) =>
    findings.push({ code, severity, route, message, ...extra });

  for (const rule of SCALAR_FIELDS) {
    const b = (before[rule.field] ?? null) as string | null;
    const a = (after[rule.field] ?? null) as string | null;
    switch (transition(b, a)) {
      case 'removed':
        push(`${rule.code}.removed`, rule.onRemoved, `${rule.label} was removed.`, { before: b });
        break;
      case 'added':
        push(`${rule.code}.added`, rule.onAdded, `${rule.label} was added.`, { after: a });
        break;
      case 'changed':
        push(`${rule.code}.changed`, rule.onChanged, `${rule.label} changed.`, { before: b, after: a });
        break;
    }
  }

  // Indexability transitions are the highest-cost silent regression there is.
  const wasNoindex = before.robots?.includes('noindex') ?? false;
  const isNoindex = after.robots?.includes('noindex') ?? false;
  if (!wasNoindex && isNoindex)
    push('robots.noindex.added', 'error', 'Page became noindex.', { before: before.robots, after: after.robots });
  if (wasNoindex && !isNoindex)
    push('robots.noindex.removed', 'info', 'Page is no longer noindex.', { before: before.robots });

  const wasNofollow = before.robots?.includes('nofollow') ?? false;
  const isNofollow = after.robots?.includes('nofollow') ?? false;
  if (!wasNofollow && isNofollow)
    push('robots.nofollow.added', 'warn', 'Page became nofollow.', { after: after.robots });

  const beforeEntities = indexEntities(before.jsonLd);
  const afterEntities = indexEntities(after.jsonLd);

  for (const [key, entity] of beforeEntities) {
    if (!afterEntities.has(key)) {
      push('jsonld.entity.removed', 'error', `Structured data entity ${entity.type} was removed.`, {
        before: entity,
      });
    }
  }
  for (const [key, entity] of afterEntities) {
    if (!beforeEntities.has(key)) {
      push('jsonld.entity.added', 'info', `Structured data entity ${entity.type} was added.`, { after: entity });
      continue;
    }
    const prev = beforeEntities.get(key)!;
    const dropped = prev.properties.filter((p) => !entity.properties.includes(p));
    if (dropped.length > 0) {
      push('jsonld.property.removed', 'error', `${entity.type} lost structured data properties.`, {
        before: prev.properties,
        after: entity.properties,
      });
    }
  }

  // Open Graph / Twitter Card removals break social and some AI previews.
  for (const [group, label] of [
    ['og', 'Open Graph'],
    ['twitter', 'Twitter Card'],
  ] as const) {
    const b = before[group];
    const a = after[group];
    const dropped = Object.keys(b).filter((k) => !(k in a));
    if (dropped.length > 0)
      push(`${group}.removed`, 'warn', `${label} tags were removed.`, { before: dropped });
  }

  // A link that breaks between deploys is the regression; one that was already
  // broken is the audit's business, and repeating it here would fail CI for a
  // problem this build did not introduce.
  const brokenBefore = before.brokenLinks ?? [];
  const brokenAfter = after.brokenLinks ?? [];
  for (const target of brokenAfter.filter((t) => !brokenBefore.includes(t)))
    push('link.broken.added', 'error', `Links to ${target}, which does not exist.`, {
      after: target,
    });
  for (const target of brokenBefore.filter((t) => !brokenAfter.includes(t)))
    push('link.broken.removed', 'info', `Link to ${target} was fixed or removed.`, {
      before: target,
    });

  const deadBefore = before.deadExternal ?? [];
  const deadAfter = after.deadExternal ?? [];
  for (const target of deadAfter.filter((t) => !deadBefore.includes(t)))
    push('link.external.dead.added', 'warn', `Links out to ${target}, which answers 404.`, {
      after: target,
    });

  const droppedHreflang = Object.keys(before.hreflang).filter((k) => !(k in after.hreflang));
  if (droppedHreflang.length > 0)
    push('hreflang.removed', 'warn', 'hreflang alternates were removed.', {
      before: droppedHreflang,
    });

  if (before.h1.length > 0 && after.h1.length === 0)
    push('h1.removed', 'error', 'The <h1> was removed.', { before: before.h1 });

  if (before.headingOutline.join('>') !== after.headingOutline.join('>'))
    push('headings.changed', 'info', 'Heading outline changed.', {
      before: before.headingOutline.length,
      after: after.headingOutline.length,
    });

  // A large content drop usually means a render failure or a template regression,
  // not an edit.
  if (before.wordCount > 0) {
    const ratio = after.wordCount / before.wordCount;
    if (ratio < 0.5)
      push('content.dropped', 'error', 'Word count fell by more than half.', {
        before: before.wordCount,
        after: after.wordCount,
      });
  }

  return findings;
}

export function diffSite(before: Snapshot['site'], after: Snapshot['site']): Finding[] {
  const findings: Finding[] = [];
  const push = (code: string, severity: Finding['severity'], message: string, extra: Partial<Finding> = {}) =>
    findings.push({ code, severity, route: null, message, ...extra });

  if (before.robotsTxt?.present && !after.robotsTxt?.present)
    push('robotstxt.removed', 'error', 'robots.txt disappeared.');

  if (before.robotsTxt && after.robotsTxt) {
    for (const [agent, state] of Object.entries(before.robotsTxt.aiAgents)) {
      const next = after.robotsTxt.aiAgents[agent];
      if (state === 'allowed' && next === 'disallowed')
        push('aeo.crawler.newly_blocked', 'error', `robots.txt now blocks ${agent}.`, { after: agent });
      if (state === 'disallowed' && next === 'allowed')
        push('aeo.crawler.unblocked', 'info', `robots.txt now allows ${agent}.`, { after: agent });
    }
    const droppedSitemaps = before.robotsTxt.sitemaps.filter(
      (s) => !after.robotsTxt!.sitemaps.includes(s),
    );
    if (droppedSitemaps.length > 0)
      push('robotstxt.sitemap.removed', 'warn', `Sitemap declaration removed: ${droppedSitemaps.join(', ')}.`);
  }

  if (before.llmsTxt?.present && !after.llmsTxt?.present)
    push('aeo.llmstxt.removed', 'error', '/llms.txt disappeared.');

  if (before.llmsTxt?.present && after.llmsTxt?.present) {
    const dropped = before.llmsTxt.sections.filter((s) => !after.llmsTxt!.sections.includes(s));
    if (dropped.length > 0)
      push('aeo.llmstxt.sections.removed', 'warn', `llms.txt sections removed: ${dropped.join(', ')}.`);
    if (after.llmsTxt.bytes < before.llmsTxt.bytes * 0.5)
      push('aeo.llmstxt.truncated', 'warn', 'llms.txt shrank by more than half.', {
        before: before.llmsTxt.bytes,
        after: after.llmsTxt.bytes,
      });
  }

  return findings;
}

export function diffSnapshots(before: Snapshot, after: Snapshot): Finding[] {
  const findings: Finding[] = diffSite(before.site, after.site);

  for (const route of Object.keys(before.pages)) {
    if (!(route in after.pages)) {
      findings.push({
        code: 'page.removed',
        severity: 'warn',
        route,
        message: 'Page is no longer present.',
      });
    }
  }

  for (const [route, page] of Object.entries(after.pages)) {
    const previous = before.pages[route];
    if (!previous) {
      findings.push({ code: 'page.added', severity: 'info', route, message: 'New page.' });
      continue;
    }
    findings.push(...diffPage(previous, page));
  }

  return findings;
}
