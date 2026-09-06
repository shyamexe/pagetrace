import pc from 'picocolors';
import type { Aggregate, Config, Finding, Platform, Severity } from './types.js';

const ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

/** Apply user severity overrides and drop anything switched off. */
export function applyConfig(findings: Finding[], config: Config = {}): Finding[] {
  const overrides = config.severity ?? {};
  const out: Finding[] = [];
  for (const finding of findings) {
    const override = overrides[finding.code];
    if (override === 'off') continue;
    out.push(override ? { ...finding, severity: override } : finding);
  }
  return out.sort(
    (a, b) => ORDER[a.severity] - ORDER[b.severity] || (a.route ?? '').localeCompare(b.route ?? ''),
  );
}

export function summarize(findings: Finding[]) {
  return {
    error: findings.filter((f) => f.severity === 'error').length,
    warn: findings.filter((f) => f.severity === 'warn').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };
}

export function shouldFail(findings: Finding[], failOn: Severity): boolean {
  const threshold = ORDER[failOn];
  // An unknown severity would make every comparison false and silently disable
  // the gate, which is the one failure mode a CI check must not have.
  if (threshold === undefined) {
    throw new Error(`Unknown severity "${failOn}". Expected one of: error, warn, info.`);
  }
  return findings.some((f) => ORDER[f.severity] <= threshold);
}

const BADGE: Record<Severity, (s: string) => string> = {
  error: (s) => pc.red(s),
  warn: (s) => pc.yellow(s),
  info: (s) => pc.dim(s),
};

export function formatPretty(findings: Finding[]): string {
  if (findings.length === 0) return pc.green('No SEO/AEO changes or issues found.');

  const byRoute = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = finding.route ?? '(site-wide)';
    if (!byRoute.has(key)) byRoute.set(key, []);
    byRoute.get(key)!.push(finding);
  }

  const lines: string[] = [];
  for (const [route, group] of byRoute) {
    lines.push(pc.bold(route));
    for (const f of group) {
      lines.push(`  ${BADGE[f.severity](f.severity.padEnd(5))} ${f.message} ${pc.dim(f.code)}`);
    }
    lines.push('');
  }

  const s = summarize(findings);
  lines.push(`${s.error} error, ${s.warn} warning, ${s.info} info`);
  return lines.join('\n');
}

export function formatJson(findings: Finding[]): string {
  return JSON.stringify({ schemaVersion: 1, summary: summarize(findings), findings }, null, 2);
}

/**
 * A pipe splits the row ("Buy Widgets | Acme"), and an angle bracket is parsed
 * as inline HTML, so `The <h1> was removed.` renders as `The  was removed.` —
 * silently dropping the part that matters. This reporter exists to be read in a
 * PR comment, so both have to survive.
 */
const escapeCell = (value: string) =>
  value.replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Markdown table, sized for a PR comment. */
export function formatMarkdown(findings: Finding[]): string {
  const s = summarize(findings);
  if (findings.length === 0) return '### pagetrace\n\nNo SEO/AEO changes or issues found.';

  const rows = findings.map(
    (f) => `| ${f.severity} | \`${escapeCell(f.route ?? '—')}\` | ${escapeCell(f.message)} | \`${f.code}\` |`,
  );
  return [
    '### pagetrace',
    '',
    `${s.error} error · ${s.warn} warning · ${s.info} info`,
    '',
    '| Severity | Route | Finding | Code |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/** GitHub Actions workflow-command annotations. */
export function formatGithub(findings: Finding[]): string {
  return findings
    .filter((f) => f.severity !== 'info')
    .map((f) => {
      const level = f.severity === 'error' ? 'error' : 'warning';
      return `::${level} title=${f.code}::${f.route ?? 'site'} — ${f.message}`;
    })
    .join('\n');
}

/**
 * Roll findings up by issue rather than by page. On a large CMS site the same
 * template defect produces hundreds of identical findings; the useful unit is
 * "canonical missing on 43 pages", not 43 separate lines.
 */
export function aggregate(findings: Finding[]): Aggregate[] {
  const map = new Map<string, Aggregate>();
  for (const finding of findings) {
    // Keyed by code *and* message: several rules embed type-specific detail in
    // the message, and merging those would attach one type's message to another
    // type's routes. Rules whose message would otherwise vary per page keep the
    // varying number in `after` instead.
    const key = `${finding.code}::${finding.message}`;
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
      if (finding.route) existing.routes.push(finding.route);
      continue;
    }
    map.set(key, {
      code: finding.code,
      severity: finding.severity,
      count: 1,
      routes: finding.route ? [finding.route] : [],
      message: finding.message,
      detail: finding.detail,
      fix: finding.fix,
    });
  }
  return [...map.values()].sort(
    (a, b) => ORDER[a.severity] - ORDER[b.severity] || b.count - a.count,
  );
}

export interface AuditMeta {
  target: string;
  platform: Platform;
  pageCount: number;
  generatedAt: string;
}

const PLATFORM_LABEL: Record<Platform, string> = {
  wordpress: 'WordPress',
  nextjs: 'Next.js',
  shopify: 'Shopify',
  webflow: 'Webflow',
  wix: 'Wix',
  squarespace: 'Squarespace',
  drupal: 'Drupal',
  unknown: 'Unknown platform',
};

/**
 * An issue on nearly every page is one template defect, not N problems.
 * Labelling it keeps the reader from triaging the same fix forty times.
 */
export function isTemplateWide(group: Aggregate, pageCount: number): boolean {
  return pageCount >= 5 && group.routes.length >= Math.ceil(pageCount * 0.8);
}

/** Counts of distinct issues, and of page instances, by severity. */
export function countIssues(groups: Aggregate[]) {
  const blank = () => ({ error: 0, warn: 0, info: 0 }) as Record<Severity, number>;
  const issues = blank();
  const instances = blank();
  for (const group of groups) {
    issues[group.severity] += 1;
    instances[group.severity] += group.count;
  }
  return { issues, instances, total: groups.length };
}

function sampleRoutes(routes: string[], limit = 5): string {
  if (routes.length === 0) return 'site-wide';
  const shown = routes.slice(0, limit).join(', ');
  return routes.length > limit ? `${shown} +${routes.length - limit} more` : shown;
}

export function formatAuditPretty(groups: Aggregate[], meta: AuditMeta): string {
  const lines: string[] = [
    pc.bold(meta.target),
    pc.dim(`${PLATFORM_LABEL[meta.platform]} · ${meta.pageCount} pages · ${meta.generatedAt}`),
    '',
  ];

  if (groups.length === 0) {
    lines.push(pc.green('No issues found.'));
    return lines.join('\n');
  }

  for (const group of groups) {
    const scope = isTemplateWide(group, meta.pageCount)
      ? pc.dim(`(${group.count} pages — one template fix)`)
      : pc.dim(`(${group.count})`);
    lines.push(`${BADGE[group.severity](group.severity.toUpperCase())} ${pc.bold(group.message)} ${scope}`);
    if (group.detail) lines.push(`  ${group.detail}`);
    if (group.fix) lines.push(`  ${pc.cyan('Fix:')} ${group.fix}`);
    if (group.routes.length > 0) lines.push(`  ${pc.dim(sampleRoutes(group.routes))}`);
    lines.push('');
  }

  const { issues, instances, total } = countIssues(groups);
  lines.push(
    `${total} issue${total === 1 ? '' : 's'}: ${issues.error} error, ${issues.warn} warning, ${issues.info} info`,
  );
  lines.push(
    pc.dim(
      `across ${instances.error + instances.warn + instances.info} page findings on ${meta.pageCount} pages`,
    ),
  );
  return lines.join('\n');
}

export function formatAuditMarkdown(groups: Aggregate[], meta: AuditMeta): string {
  const lines = [
    `# SEO & AEO audit — ${meta.target}`,
    '',
    `${PLATFORM_LABEL[meta.platform]} · ${meta.pageCount} pages crawled · ${meta.generatedAt}`,
    '',
  ];
  if (groups.length === 0) {
    lines.push('No issues found.');
    return lines.join('\n');
  }
  for (const group of groups) {
    lines.push(`## ${group.message}`, '');
    const scope = isTemplateWide(group, meta.pageCount)
      ? `affects ${group.count} pages — one template fix`
      : `affects ${group.count} page${group.count === 1 ? '' : 's'}`;
    lines.push(`**${group.severity.toUpperCase()}** · ${scope} · \`${group.code}\``, '');
    if (group.detail) lines.push(group.detail, '');
    if (group.fix) lines.push(`**Fix.** ${group.fix}`, '');
    if (group.routes.length > 0) {
      lines.push('<details><summary>Affected pages</summary>', '');
      for (const route of group.routes.slice(0, 50)) lines.push(`- \`${route}\``);
      if (group.routes.length > 50) lines.push(`- …and ${group.routes.length - 50} more`);
      lines.push('', '</details>', '');
    }
  }
  return lines.join('\n');
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Self-contained HTML report, suitable for handing to a client. */
export function formatAuditHtml(groups: Aggregate[], meta: AuditMeta): string {
  const { issues } = countIssues(groups);

  const cards = groups
    .map((group) => {
      const scope = isTemplateWide(group, meta.pageCount)
        ? `<span class="tmpl">template-wide</span>`
        : '';
      const routes =
        group.routes.length > 0
          ? `<details><summary>${group.routes.length} affected page${group.routes.length === 1 ? '' : 's'}</summary><ul>${group.routes
              .slice(0, 100)
              .map((r) => `<li><code>${escapeHtml(r)}</code></li>`)
              .join('')}</ul></details>`
          : '';
      return `<article class="f ${group.severity}">
  <header><span class="sev">${group.severity}</span><h2>${escapeHtml(group.message)}</h2>${scope}<span class="count">${group.count}</span></header>
  ${group.detail ? `<p>${escapeHtml(group.detail)}</p>` : ''}
  ${group.fix ? `<p class="fix"><strong>Fix.</strong> ${escapeHtml(group.fix)}</p>` : ''}
  ${routes}
  <code class="code">${escapeHtml(group.code)}</code>
</article>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SEO &amp; AEO audit — ${escapeHtml(meta.target)}</title>
<style>
:root{--fg:#16181d;--muted:#6b7280;--line:#e5e7eb;--err:#b42318;--warn:#b54708;--info:#475467;--bg:#fff}
*{box-sizing:border-box}
body{margin:0;padding:48px 24px;font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:820px;margin:0 auto}
h1{font-size:28px;margin:0 0 6px;letter-spacing:-.02em}
.meta{color:var(--muted);font-size:14px;margin:0 0 28px}
.totals{display:flex;gap:12px;margin:0 0 36px;padding:0;list-style:none}
.totals li{flex:1;border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.totals b{display:block;font-size:26px;line-height:1.2}
.totals span{color:var(--muted);font-size:13px;text-transform:uppercase;letter-spacing:.06em}
.f{border:1px solid var(--line);border-left-width:4px;border-radius:10px;padding:18px 20px;margin:0 0 16px}
.f.error{border-left-color:var(--err)} .f.warn{border-left-color:var(--warn)} .f.info{border-left-color:var(--info)}
.f header{display:flex;align-items:baseline;gap:10px;margin-bottom:8px}
.f h2{font-size:17px;margin:0;flex:1;letter-spacing:-.01em}
.sev{font-size:11px;text-transform:uppercase;letter-spacing:.08em;font-weight:700}
.error .sev{color:var(--err)} .warn .sev{color:var(--warn)} .info .sev{color:var(--info)}
.count{font-variant-numeric:tabular-nums;color:var(--muted);font-size:14px}
.tmpl{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);border:1px solid var(--line);border-radius:99px;padding:2px 8px}
.f p{margin:0 0 10px;font-size:15px}
.fix{color:#065f46}
details{font-size:14px;margin:10px 0}
summary{cursor:pointer;color:var(--muted)}
details ul{margin:8px 0 0;padding-left:20px;max-height:260px;overflow:auto}
.code{font-size:12px;color:var(--muted)}
footer{margin-top:40px;color:var(--muted);font-size:13px;border-top:1px solid var(--line);padding-top:16px}
</style></head>
<body><main>
<h1>SEO &amp; AEO audit</h1>
<p class="meta">${escapeHtml(meta.target)} · ${PLATFORM_LABEL[meta.platform]} · ${meta.pageCount} pages crawled · ${escapeHtml(meta.generatedAt)}</p>
<ul class="totals">
  <li><b>${issues.error}</b><span>Errors</span></li>
  <li><b>${issues.warn}</b><span>Warnings</span></li>
  <li><b>${issues.info}</b><span>Notes</span></li>
</ul>
${cards || '<p>No issues found.</p>'}
<footer>Generated by pagetrace. Findings are heuristic; verify structured data with Google&rsquo;s Rich Results Test before shipping fixes.</footer>
</main></body></html>`;
}
