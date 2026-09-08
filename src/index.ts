export { auditCrossPage, auditHreflang, auditPage, auditSite, auditSnapshot } from './audit.js';
export { diffPage, diffSite, diffSnapshots } from './diff.js';
export {
  extractJsonLd,
  extractLinks,
  extractLlmsTxt,
  extractPage,
  extractRobotsTxt,
  extractSitemapUrls,
  isCrawlable,
} from './extract.js';
export { detectPlatform, withGuidance, GUIDANCE } from './rules/guidance.js';
export type { Guidance } from './rules/guidance.js';
export {
  aggregate,
  applyConfig,
  formatAuditHtml,
  formatAuditMarkdown,
  formatAuditPretty,
  formatGithub,
  formatJson,
  formatMarkdown,
  formatPretty,
  formatSarif,
  shouldFail,
  summarize,
} from './report.js';
export { RICH_RESULT_RULES, DEFAULT_AI_AGENTS } from './rules/rich-results.js';
export {
  routeFromFilePath,
  routeFromUrl,
  sameSurface,
  shouldIgnore,
  snapshotFromGitRef,
  snapshotFromDir,
  snapshotFromOrigin,
  snapshotFromPage,
} from './snapshot.js';
export type { AuditMeta } from './report.js';
export type {
  Aggregate,
  Config,
  Finding,
  JsonLdEntity,
  PageFingerprint,
  Platform,
  Severity,
  SiteFingerprint,
  Snapshot,
} from './types.js';
