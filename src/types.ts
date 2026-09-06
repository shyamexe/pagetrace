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
}

/** Site-wide signals that live outside any single page. */
export interface SiteFingerprint {
  robotsTxt: {
    present: boolean;
    /** agent name -> whether the root path is crawlable */
    aiAgents: Record<string, 'allowed' | 'disallowed'>;
    sitemaps: string[];
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
}
