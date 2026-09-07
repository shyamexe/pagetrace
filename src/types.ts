export type Severity = 'error' | 'warn' | 'info';

/** A single structured-data entity found on a page. */
export interface JsonLdEntity {
  type: string;
  id?: string;
  /** Sorted list of top-level property names present on the entity. */
  properties: string[];
}

/** The normalized SEO/AEO surface of one page. */
export interface PageFingerprint {
  route: string;
  title: string | null;
  description: string | null;
  canonical: string | null;
  /** Content of <meta name="robots">, lowercased. */
  robots: string | null;
  og: Record<string, string>;
  twitter: Record<string, string>;
  /** hreflang value -> href */
  hreflang: Record<string, string>;
  h1: string[];
  /** Heading tag sequence in document order, e.g. ["h1","h2","h2","h3"]. */
  headingOutline: string[];
  jsonLd: JsonLdEntity[];
  wordCount: number;
  images: { total: number; missingAlt: number };
  /** Whether the page exposes an answer-shaped opening paragraph (AEO signal). */
  leadAnswerWords: number;
  /** Content of <meta name="generator">, used for platform detection. */
  generator: string | null;
  /**
   * Where the route ended up after redirects, when that differs from the route
   * asked for: a path for a same-origin redirect, an absolute URL for one that
   * leaves the site. Null for a direct 200, and absent for a filesystem crawl
   * and for lockfiles written before 0.10.0.
   *
   * A redirect that only adds or drops a trailing slash normalises to the same
   * route and is not recorded — that is server configuration, not drift.
   */
  redirectsTo?: string | null;
  /**
   * Internal links from this page that do not resolve to a page. Only the
   * broken ones are kept: storing every link would put a site's whole
   * navigation into the lockfile and make its diff unreadable, which is the one
   * property the lockfile has to have.
   */
  brokenLinks?: string[];
}

/** Site-wide signals that live outside any single page. */
export interface SiteFingerprint {
  /**
   * The origin this snapshot was crawled from, e.g. "https://example.com".
   * Absent for a filesystem crawl and for lockfiles written before 0.2.0.
   */
  origin?: string | null;
  robotsTxt: {
    present: boolean;
    /** agent name -> whether the root path is crawlable */
    aiAgents: Record<string, 'allowed' | 'disallowed'>;
    sitemaps: string[];
    /**
     * Path rules that apply to a generic crawler, in the order written.
     * Absent for lockfiles written before 0.10.0.
     */
    disallow?: string[];
    allow?: string[];
  } | null;
  /**
   * What the sitemap claimed, and what answering those URLs actually did.
   * Null for a filesystem crawl, which has no sitemap to check against.
   */
  sitemap?: {
    /** Same-origin routes the sitemap listed, before --limit truncated them. */
    routes: string[];
    /** Of those we fetched, the ones that answered 404 or 410. */
    dead: string[];
  } | null;
  llmsTxt: {
    present: boolean;
    /** H2 section titles, used to detect silent truncation. */
    sections: string[];
    bytes: number;
  } | null;
}

export interface Snapshot {
  schemaVersion: 1;
  createdAt: string;
  site: SiteFingerprint;
  pages: Record<string, PageFingerprint>;
}

export type Platform =
  | 'wordpress'
  | 'nextjs'
  | 'shopify'
  | 'webflow'
  | 'wix'
  | 'squarespace'
  | 'drupal'
  | 'unknown';

export interface Finding {
  /** Stable machine code, e.g. "canonical.removed". Integrations key on this. */
  code: string;
  severity: Severity;
  route: string | null;
  message: string;
  before?: unknown;
  after?: unknown;
  /** Why this matters, for audit output. */
  detail?: string;
  /** How to fix it, platform-specific where known. */
  fix?: string;
}

/** One issue rolled up across every route it affects. */
export interface Aggregate {
  code: string;
  severity: Severity;
  count: number;
  routes: string[];
  message: string;
  detail?: string;
  fix?: string;
}

export interface Config {
  /** Per-code severity overrides. Set to "off" to silence a rule. */
  severity?: Record<string, Severity | 'off'>;
  /** Routes to skip entirely (exact match or trailing-* prefix). */
  ignoreRoutes?: string[];
  /** Extra AI user agents to check in robots.txt. */
  aiAgents?: string[];
  /** Minimum word count before a page is flagged as thin. */
  minWordCount?: number;
  /**
   * The site's own origin, e.g. "https://example.com". Used to detect canonicals
   * pointing at another host. A --dir crawl has no other source for it, and an
   * origin crawl of a local build or preview deployment needs it to override the
   * URL being crawled, since those serve production canonicals.
   */
  siteUrl?: string;
  /**
   * Crawl paths that robots.txt disallows. Off by default: a staging origin
   * commonly serves `Disallow: /`, and silently returning zero pages there is
   * worse than crawling a site you already own.
   */
  ignoreRobots?: boolean;
}
