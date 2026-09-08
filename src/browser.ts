/**
 * Browser entry: the pure half of pagetrace, for the website's playground.
 *
 * Deliberately excludes snapshot.ts and cli.ts — those do filesystem and
 * network work and would drag node builtins into the bundle. What is left is
 * the part that can honestly run in a tab, which is the whole rule engine.
 */
export {
  extractPage,
  extractLinks,
  extractRobotsTxt,
  extractLlmsTxt,
  extractSitemapUrls,
} from './extract.js';
export { auditPage, auditCrossPage, auditHreflang, auditSite, auditSnapshot } from './audit.js';
export { diffPage, diffSnapshots } from './diff.js';
export { GUIDANCE, withGuidance, detectPlatform } from './rules/guidance.js';
export { RICH_RESULT_RULES } from './rules/rich-results.js';
