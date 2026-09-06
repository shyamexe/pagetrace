/**
 * Required and recommended properties for the Schema.org types Google supports
 * as rich results. Sourced from Google Search Central's structured data
 * reference. Deliberately a plain data table so it can be updated without
 * touching the engine, and so consumers can extend it.
 */
export interface RichResultRule {
  required: string[];
  recommended: string[];
  /** Groups where at least one member must be present. */
  oneOf?: string[][];
}

export const RICH_RESULT_RULES: Record<string, RichResultRule> = {
  Article: {
    required: ['headline'],
    recommended: ['author', 'datePublished', 'dateModified', 'image'],
  },
  NewsArticle: {
    required: ['headline'],
    recommended: ['author', 'datePublished', 'dateModified', 'image'],
  },
  BlogPosting: {
    required: ['headline'],
    recommended: ['author', 'datePublished', 'dateModified', 'image'],
  },
  Product: {
    required: ['name'],
    recommended: ['image', 'description', 'brand'],
    oneOf: [['offers', 'review', 'aggregateRating']],
  },
  Offer: {
    required: ['price', 'priceCurrency'],
    recommended: ['availability', 'url'],
  },
  FAQPage: {
    required: ['mainEntity'],
    recommended: [],
  },
  HowTo: {
    required: ['name', 'step'],
    recommended: ['image', 'totalTime', 'supply', 'tool'],
  },
  Recipe: {
    required: ['name', 'image'],
    recommended: ['author', 'datePublished', 'description', 'recipeIngredient', 'recipeInstructions'],
  },
  Event: {
    required: ['name', 'startDate', 'location'],
    recommended: ['endDate', 'description', 'image', 'offers'],
  },
  JobPosting: {
    required: ['title', 'description', 'datePosted', 'hiringOrganization'],
    recommended: ['jobLocation', 'baseSalary', 'validThrough', 'employmentType'],
  },
  Organization: {
    required: ['name'],
    recommended: ['url', 'logo', 'sameAs', 'contactPoint'],
  },
  LocalBusiness: {
    required: ['name', 'address'],
    recommended: ['telephone', 'openingHoursSpecification', 'geo', 'priceRange', 'image'],
  },
  BreadcrumbList: {
    required: ['itemListElement'],
    recommended: [],
  },
  VideoObject: {
    required: ['name', 'description', 'thumbnailUrl', 'uploadDate'],
    recommended: ['duration', 'contentUrl', 'embedUrl'],
  },
  Review: {
    required: ['itemReviewed', 'reviewRating', 'author'],
    recommended: ['datePublished', 'reviewBody'],
  },
  AggregateRating: {
    required: ['ratingValue'],
    recommended: ['reviewCount', 'ratingCount', 'bestRating'],
  },
  Course: {
    required: ['name', 'description'],
    recommended: ['provider', 'offers', 'hasCourseInstance'],
  },
  SoftwareApplication: {
    required: ['name', 'applicationCategory'],
    recommended: ['operatingSystem', 'offers', 'aggregateRating'],
  },
  WebSite: {
    required: ['name', 'url'],
    recommended: ['potentialAction'],
  },
  Person: {
    required: ['name'],
    recommended: ['url', 'jobTitle', 'sameAs', 'image'],
  },
};

/** AI crawler user agents checked against robots.txt by default. */
export const DEFAULT_AI_AGENTS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-User',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Applebot-Extended',
  'CCBot',
  'Bytespider',
  'meta-externalagent',
];
