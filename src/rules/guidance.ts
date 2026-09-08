import type { Platform } from '../types.js';

export interface Guidance {
  /** Why the issue costs you traffic or citations. */
  why: string;
  /** Generic remedy. */
  fix: string;
  /** Platform-specific remedy, used when the platform is detected. */
  byPlatform?: Partial<Record<Platform, string>>;
}

/**
 * Explanations attached to findings in audit output. Diff output stays terse —
 * you already know what a canonical is when you are reviewing a regression.
 * An audit handed to a client or a content team needs the reasoning.
 */
export const GUIDANCE: Record<string, Guidance> = {
  'title.missing': {
    why: 'The title is the strongest on-page ranking signal and the clickable line in results. Without one, search engines invent a title from page content, usually badly.',
    fix: 'Add a unique <title> of roughly 50-60 characters that leads with the primary term.',
    byPlatform: {
      wordpress: 'Set the SEO title in Yoast or Rank Math for this post, or fix the title template under the plugin\'s Search Appearance settings.',
      nextjs: 'Export `metadata.title` from the route segment, or set a `title.template` in the root layout.',
    },
  },
  'title.long': {
    why: 'Titles beyond roughly 60 characters get truncated in results, so the tail of the title does no work.',
    fix: 'Trim to under 60 characters, keeping the distinguishing words at the front.',
  },
  'description.missing': {
    why: 'Without a meta description the engine writes its own snippet from page text, which is often a nav menu or boilerplate.',
    fix: 'Write a 140-160 character description that states what the page offers.',
    byPlatform: {
      wordpress: 'Fill the meta description field in the Yoast or Rank Math box below the editor, or set a template for this post type.',
      nextjs: 'Add `description` to the route\'s exported `metadata` object.',
    },
  },
  'link.broken': {
    why: 'A link to a page that does not exist wastes the crawl that follows it, drops the ranking signal the link was passing, and sends readers to a 404. Internal links are entirely within your control, so a broken one is a defect rather than a fact about the web.',
    fix: 'Point the link at the current URL, or restore the page. If the target moved, redirect the old URL and update the link to the destination.',
    byPlatform: {
      wordpress: 'Usually a permalink or slug edit with the old URL still hard-coded in post content or a menu. Check Appearance > Menus as well as the posts themselves.',
      nextjs: 'A `<Link href>` pointing at a route that no longer exists. TypeScript will not catch it — typed routes are opt-in via `experimental.typedRoutes`.',
    },
  },
  'link.external.dead': {
    why: 'An outbound link to a page that is gone sends readers to a 404 and spends the trust the link was passing on nothing. Unlike an internal link, the page is not yours to restore.',
    fix: 'Point the link at the current URL, at an archived copy, or remove it. A link that has been dead a while is usually a citation worth replacing rather than deleting.',
  },
  'sitemap.dead': {
    why: 'A sitemap is a list of URLs you are asking to have crawled. Entries that 404 spend crawl budget on nothing and lower the trust placed in the rest of the file.',
    fix: 'Remove the URL from the sitemap, or restore the page. If it moved, redirect it and list the destination instead.',
    byPlatform: {
      wordpress: 'Usually a deleted post still cached in the SEO plugin\'s sitemap. Re-save permalinks, or clear the Yoast / Rank Math sitemap cache.',
    },
  },
  'sitemap.redirect': {
    why: 'A sitemap should list the URL you want indexed, not one that bounces to it. Every redirected entry is a wasted fetch and an ambiguous signal about which URL is canonical.',
    fix: 'List the destination URL directly in the sitemap.',
  },
  'canonical.redirects': {
    why: 'A canonical is a claim about which URL should rank. Pointing it at a URL that redirects contradicts itself, so the engine falls back to picking a canonical on its own — usually not the one you wanted.',
    fix: 'Point the canonical at the URL that answers with 200 directly, which is normally the redirect destination.',
    byPlatform: {
      wordpress: 'Usually a permalink change with the old slug still in the SEO plugin\'s canonical field. Clear the manual canonical so Yoast or Rank Math emits the current permalink.',
      nextjs: 'Check `alternates.canonical` against the redirects in next.config.js — a canonical is often left pointing at the source of a redirect rule.',
    },
  },
  'canonical.missing': {
    why: 'Without a canonical, duplicate URLs (query strings, pagination, tracking parameters, trailing-slash variants) compete against each other and split ranking signals.',
    fix: 'Emit a self-referencing canonical link on every indexable page.',
    byPlatform: {
      wordpress: 'Yoast and Rank Math both output canonicals by default — this usually means the SEO plugin is inactive on this template, or a theme is stripping wp_head().',
      nextjs: 'Set `alternates.canonical` in the route\'s metadata.',
    },
  },
  'h1.missing': {
    why: 'The h1 tells both crawlers and answer engines what the page is about, and it anchors the document outline used for passage extraction.',
    fix: 'Add exactly one h1 that matches the page topic.',
    byPlatform: {
      wordpress: 'Many themes render the post title as h2 inside archive templates. Check single.php or the block template for this post type.',
    },
  },
  'h1.multiple': {
    why: 'Multiple h1 elements make the document outline ambiguous, which weakens passage extraction for AI answers.',
    fix: 'Keep one h1 and demote the rest to h2.',
  },
  'robots.noindex': {
    why: 'This page is explicitly excluded from search results. If that is unintentional it is invisible traffic loss.',
    fix: 'Remove the noindex directive if the page should rank.',
    byPlatform: {
      wordpress: 'Check Settings → Reading for the site-wide discourage option, and the per-post Advanced tab in your SEO plugin.',
    },
  },
  'og.title.missing': {
    why: 'Without Open Graph tags, shared links render with whatever the platform can scrape, which is usually wrong.',
    fix: 'Add og:title, og:description, og:image and og:url.',
    byPlatform: {
      wordpress: 'Enable social meta in Yoast (Social tab) or Rank Math, and set a site-wide fallback image.',
    },
  },
  'og.image.missing': {
    why: 'Links without og:image get a plain text card in messaging apps and social feeds, which measurably lowers click-through.',
    fix: 'Add an og:image of at least 1200x630.',
  },
  'jsonld.missing': {
    why: 'Structured data is how you become eligible for rich results, and it is the most reliable signal answer engines use to identify entities on a page.',
    fix: 'Add JSON-LD appropriate to the page type — Article for posts, Product for products, LocalBusiness and Organization site-wide.',
    byPlatform: {
      wordpress: 'Rank Math and Yoast both emit a schema graph. If it is absent, the plugin is off for this template or the theme is not calling wp_head().',
    },
  },
  'jsonld.invalid': {
    why: 'A JSON-LD block that fails to parse is ignored entirely, so any valid markup in the same script tag is lost with it.',
    fix: 'Fix the JSON syntax — usually an unescaped quote or a trailing comma injected by a template.',
  },
  'jsonld.required.missing': {
    why: 'Google will not show a rich result when a required property is absent, even though the rest of the markup is valid.',
    fix: 'Add the named properties. Verify with the Rich Results Test before shipping.',
  },
  'jsonld.oneof.missing': {
    why: 'Some types need at least one of a group of properties to qualify for a rich result.',
    fix: 'Add one of the listed properties.',
  },
  'jsonld.recommended.missing': {
    why: 'Recommended properties are not required, but they widen the rich result and give answer engines more to work with.',
    fix: 'Add them where you have the data.',
  },
  'content.thin': {
    why: 'Short pages rarely rank for competitive terms and are almost never cited by answer engines, which need enough context to quote.',
    fix: 'Either expand the page substantively or consolidate it into a stronger one.',
    byPlatform: {
      wordpress: 'Tag and category archives commonly trip this. Consider noindexing thin archives rather than padding them.',
    },
  },
  'images.alt.missing': {
    why: 'Missing alt text is both an accessibility failure and lost context — image search and multimodal crawlers rely on it.',
    fix: 'Describe the image in alt, or use alt="" for purely decorative images so it is explicitly marked.',
    byPlatform: {
      wordpress: 'Set alt text in the Media Library so it applies everywhere the image is reused.',
    },
  },
  'aeo.lead.missing': {
    why: 'Answer engines extract and quote the opening passage. A page that starts with a hero image, a nav block or a one-line teaser gives them nothing to lift.',
    fix: 'Open with a self-contained paragraph of 40-80 words that directly answers the page\'s implied question.',
  },
  'aeo.lead.long': {
    why: 'A very long opening block gets chunked awkwardly and the quotable part may be split across chunks.',
    fix: 'Front-load a short direct answer, then expand below it.',
  },
  'robotstxt.missing': {
    why: 'Without robots.txt you have no control over crawler access and no place to declare your sitemap.',
    fix: 'Add a robots.txt at the site root with a Sitemap line.',
    byPlatform: {
      wordpress: 'WordPress serves a virtual robots.txt; a missing one usually means a plugin or the server is intercepting the request.',
    },
  },
  'robotstxt.sitemap.missing': {
    why: 'The sitemap declaration in robots.txt is the primary discovery path for crawlers that did not arrive through Search Console.',
    fix: 'Add a Sitemap line pointing at your sitemap index.',
    byPlatform: {
      wordpress: 'WordPress core exposes /wp-sitemap.xml; Yoast and Rank Math replace it with their own. Declare whichever is live.',
    },
  },
  'aeo.crawler.blocked': {
    why: 'A blocked AI crawler cannot fetch your pages, so your site cannot be cited in that assistant\'s answers. This is sometimes deliberate — worth confirming it is.',
    fix: 'Remove the Disallow for agents you want citing you, and keep it for the ones you do not.',
    byPlatform: {
      wordpress: 'Some security and SEO plugins add AI crawler blocks by default. Check the plugin that manages your robots.txt.',
    },
  },
  'aeo.llmstxt.missing': {
    why: 'llms.txt is an emerging convention giving assistants a curated map of your site. Adoption is still early, so treat this as an opportunity rather than a defect.',
    fix: 'Publish /llms.txt with a short site summary and links to your most important pages.',
  },
  'hreflang.missing': {
    why: 'The rest of the site declares language alternates but this page does not, so search engines treat it as having no localised counterparts and may serve the wrong language version.',
    fix: 'Add the full set of hreflang links, including a self-reference.',
    byPlatform: {
      wordpress: 'Usually a template the translation plugin does not cover. Check that WPML or Polylang is active for this post type.',
      nextjs: 'Set `alternates.languages` in the route\'s metadata, or generate it in the shared layout.',
    },
  },
  'hreflang.nonreciprocal': {
    why: 'Google requires hreflang annotations to be reciprocal. If page A points at B but B does not point back at A, the entire annotation is discarded — not just the one link — so the whole language cluster stops working.',
    fix: 'Make every page in a language group list every other page in that group, including itself.',
  },
  'hreflang.self.missing': {
    why: 'Each page in an hreflang set should reference itself. Without it, some engines will not associate the page with its own language.',
    fix: 'Add an hreflang link pointing at this page\'s own URL with its own language code.',
  },
  'hreflang.xdefault.missing': {
    why: 'x-default tells engines which version to serve to users whose language matches none of your alternates. Without it, that choice is made for you.',
    fix: 'Add an x-default link pointing at your default or language-selection page.',
  },
  'hreflang.invalid': {
    why: 'A malformed language code makes the annotation invalid and it is ignored.',
    fix: 'Use ISO 639-1 language codes, optionally with an ISO 3166-1 Alpha 2 region — `en`, `ml`, `en-IN` — or `x-default`.',
  },
  'hreflang.noindex.target': {
    why: 'An hreflang alternate that is noindexed cannot be served as a language variant, which invalidates that link in the cluster.',
    fix: 'Either remove the noindex from the target or drop it from the hreflang set.',
  },
  'duplicate.title': {
    why: 'Identical titles across pages make them compete for the same queries and signal thin or templated content.',
    fix: 'Make each title unique, usually by including the distinguishing attribute of the page.',
    byPlatform: {
      wordpress: 'Almost always a title template problem — check Search Appearance for the affected post type or archive.',
    },
  },
  'duplicate.description': {
    why: 'Repeated descriptions get discarded by search engines, which then write their own snippet.',
    fix: 'Vary the description per page, or leave it off and let the engine choose rather than repeating boilerplate.',
  },
  'duplicate.canonical': {
    why: 'Several pages pointing at one canonical means those pages are declaring themselves duplicates and will not rank independently. Correct for pagination and filters, a serious bug elsewhere.',
    fix: 'Confirm each canonical is self-referencing unless consolidation is intended.',
    byPlatform: {
      wordpress: 'A common symptom of a plugin canonicalising every archive page to the parent.',
    },
  },
  'canonical.offsite': {
    why: 'The canonical points at a different host, which tells search engines to index that host instead of this one. A staging or CDN hostname leaking into canonicals removes the live site from results.',
    fix: 'Point canonicals at the production origin. If the content is deliberately syndicated from another domain, this is correct and the rule can be switched off in config.',
    byPlatform: {
      wordpress: 'Check the Site Address (URL) setting, and any WP_HOME or WP_SITEURL override in wp-config.php, on the environment that built this.',
      nextjs: 'Check `metadataBase` — a wrong or missing value makes every relative canonical resolve against the wrong origin.',
    },
  },
  'canonical.crosspath': {
    why: 'The canonical points at a different path than the page itself, so this URL is asking not to be indexed in favour of another.',
    fix: 'Verify the target is correct. If this page should rank on its own, make the canonical self-referencing.',
  },
};

/** Detect the publishing platform from generator meta and URL shape. */
export function detectPlatform(generators: (string | null)[], urls: string[] = []): Platform {
  const gen = generators.filter(Boolean).join(' ').toLowerCase();
  if (gen.includes('wordpress')) return 'wordpress';
  if (gen.includes('drupal')) return 'drupal';
  if (gen.includes('wix')) return 'wix';
  if (gen.includes('squarespace')) return 'squarespace';
  if (gen.includes('webflow')) return 'webflow';
  if (gen.includes('shopify')) return 'shopify';
  if (gen.includes('next.js')) return 'nextjs';

  const joined = urls.join(' ').toLowerCase();
  if (joined.includes('/wp-content/') || joined.includes('/wp-json/')) return 'wordpress';
  if (joined.includes('/_next/')) return 'nextjs';
  if (joined.includes('cdn.shopify.com')) return 'shopify';
  return 'unknown';
}

/** Attach why/fix text to a finding, preferring platform-specific advice. */
export function withGuidance<T extends { code: string }>(
  finding: T,
  platform: Platform = 'unknown',
): T & { detail?: string; fix?: string } {
  const guidance = GUIDANCE[finding.code];
  if (!guidance) return finding;
  return {
    ...finding,
    detail: guidance.why,
    fix: guidance.byPlatform?.[platform] ?? guidance.fix,
  };
}
