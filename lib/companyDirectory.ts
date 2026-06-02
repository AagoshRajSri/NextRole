// ────────────────────────────────────────────────────────
// COMPANY CAREERS DIRECTORY
// Maps known company names to their careers page URLs.
// When a user adds a company to their watchlist, we resolve
// the URL(s) and auto-track them for scraping.
// ────────────────────────────────────────────────────────

export interface CompanyEntry {
  /** Canonical display name */
  name: string;
  /** One or more careers page URLs to track */
  urls: string[];
  /** ATS platform hint (speeds up first scrape) */
  platform?: string;
}

/**
 * Curated directory of well-known tech company career pages.
 * Keys are lowercase, trimmed company names.
 */
const DIRECTORY: Record<string, CompanyEntry> = {
  // ── FAANG / Big Tech ──
  'google': {
    name: 'Google',
    urls: ['https://www.google.com/about/careers/applications/jobs/results/'],
    platform: 'google',
  },
  'alphabet': {
    name: 'Alphabet (Google)',
    urls: ['https://www.google.com/about/careers/applications/jobs/results/'],
    platform: 'google',
  },
  'amazon': {
    name: 'Amazon',
    urls: ['https://amazon.jobs/en/search?base_query=&loc_query='],
    platform: 'amazon_jobs',
  },
  'aws': {
    name: 'Amazon Web Services',
    urls: ['https://amazon.jobs/en/search?base_query=AWS&loc_query='],
    platform: 'amazon_jobs',
  },
  'apple': {
    name: 'Apple',
    urls: ['https://jobs.apple.com/en-us/search?sort=newest'],
    platform: 'apple',
  },
  'meta': {
    name: 'Meta',
    urls: ['https://www.metacareers.com/jobs/'],
    platform: 'generic',
  },
  'facebook': {
    name: 'Meta (Facebook)',
    urls: ['https://www.metacareers.com/jobs/'],
    platform: 'generic',
  },
  'microsoft': {
    name: 'Microsoft',
    urls: ['https://careers.microsoft.com/us/en/search-results'],
    platform: 'eightfold',
  },
  'netflix': {
    name: 'Netflix',
    urls: ['https://jobs.netflix.com/search'],
    platform: 'generic',
  },

  // ── Cloud / Infra ──
  'nvidia': {
    name: 'NVIDIA',
    urls: ['https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite'],
    platform: 'workday',
  },
  'salesforce': {
    name: 'Salesforce',
    urls: ['https://careers.salesforce.com/en/jobs/'],
    platform: 'generic',
  },
  'oracle': {
    name: 'Oracle',
    urls: ['https://careers.oracle.com/jobs/'],
    platform: 'generic',
  },
  'ibm': {
    name: 'IBM',
    urls: ['https://www.ibm.com/careers/search'],
    platform: 'generic',
  },
  'snowflake': {
    name: 'Snowflake',
    urls: ['https://careers.snowflake.com/us/en/search-results'],
    platform: 'eightfold',
  },
  'databricks': {
    name: 'Databricks',
    urls: ['https://www.databricks.com/company/careers/open-positions'],
    platform: 'generic',
  },
  'cloudflare': {
    name: 'Cloudflare',
    urls: ['https://boards.greenhouse.io/cloudflare'],
    platform: 'greenhouse',
  },

  // ── Fintech / Payments ──
  'stripe': {
    name: 'Stripe',
    urls: ['https://stripe.com/jobs/search'],
    platform: 'generic',
  },
  'paypal': {
    name: 'PayPal',
    urls: ['https://paypal.eightfold.ai/careers'],
    platform: 'eightfold',
  },
  'square': {
    name: 'Square (Block)',
    urls: ['https://block.xyz/careers'],
    platform: 'generic',
  },
  'block': {
    name: 'Block',
    urls: ['https://block.xyz/careers'],
    platform: 'generic',
  },
  'plaid': {
    name: 'Plaid',
    urls: ['https://plaid.com/careers/#open-roles'],
    platform: 'generic',
  },
  'razorpay': {
    name: 'Razorpay',
    urls: ['https://razorpay.com/jobs/'],
    platform: 'generic',
  },

  // ── Consumer / Social ──
  'spotify': {
    name: 'Spotify',
    urls: ['https://www.lifeatspotify.com/jobs?l=all-locations'],
    platform: 'generic',
  },
  'uber': {
    name: 'Uber',
    urls: ['https://www.uber.com/us/en/careers/list/'],
    platform: 'generic',
  },
  'airbnb': {
    name: 'Airbnb',
    urls: ['https://careers.airbnb.com/positions/'],
    platform: 'generic',
  },
  'doordash': {
    name: 'DoorDash',
    urls: ['https://careers.doordash.com/open-positions'],
    platform: 'generic',
  },
  'twitter': {
    name: 'X (Twitter)',
    urls: ['https://careers.twitter.com/en/roles.html'],
    platform: 'generic',
  },
  'x': {
    name: 'X (Twitter)',
    urls: ['https://careers.twitter.com/en/roles.html'],
    platform: 'generic',
  },
  'snap': {
    name: 'Snap',
    urls: ['https://careers.snap.com/jobs'],
    platform: 'generic',
  },
  'snapchat': {
    name: 'Snap',
    urls: ['https://careers.snap.com/jobs'],
    platform: 'generic',
  },
  'reddit': {
    name: 'Reddit',
    urls: ['https://boards.greenhouse.io/reddit'],
    platform: 'greenhouse',
  },
  'pinterest': {
    name: 'Pinterest',
    urls: ['https://www.pinterestcareers.com/jobs/'],
    platform: 'generic',
  },
  'discord': {
    name: 'Discord',
    urls: ['https://discord.com/careers'],
    platform: 'generic',
  },

  // ── SaaS / Dev Tools ──
  'atlassian': {
    name: 'Atlassian',
    urls: ['https://www.atlassian.com/company/careers/all-jobs'],
    platform: 'generic',
  },
  'twilio': {
    name: 'Twilio',
    urls: ['https://boards.greenhouse.io/twilio'],
    platform: 'greenhouse',
  },
  'github': {
    name: 'GitHub',
    urls: ['https://www.github.careers/careers-home/jobs'],
    platform: 'generic',
  },
  'gitlab': {
    name: 'GitLab',
    urls: ['https://boards.greenhouse.io/gitlab'],
    platform: 'greenhouse',
  },
  'notion': {
    name: 'Notion',
    urls: ['https://boards.greenhouse.io/notion'],
    platform: 'greenhouse',
  },
  'figma': {
    name: 'Figma',
    urls: ['https://boards.greenhouse.io/figma'],
    platform: 'greenhouse',
  },
  'vercel': {
    name: 'Vercel',
    urls: ['https://vercel.com/careers#openings'],
    platform: 'generic',
  },
  'hashicorp': {
    name: 'HashiCorp',
    urls: ['https://www.hashicorp.com/careers/open-positions'],
    platform: 'generic',
  },
  'elastic': {
    name: 'Elastic',
    urls: ['https://jobs.elastic.co/jobs/'],
    platform: 'generic',
  },
  'mongodb': {
    name: 'MongoDB',
    urls: ['https://www.mongodb.com/company/careers'],
    platform: 'generic',
  },
  'supabase': {
    name: 'Supabase',
    urls: ['https://boards.greenhouse.io/supabase'],
    platform: 'greenhouse',
  },

  // ── Cybersecurity ──
  'crowdstrike': {
    name: 'CrowdStrike',
    urls: ['https://crowdstrike.wd5.myworkdayjobs.com/crowdstrikecareers'],
    platform: 'workday',
  },
  'palo alto networks': {
    name: 'Palo Alto Networks',
    urls: ['https://jobs.paloaltonetworks.com/en/jobs/'],
    platform: 'generic',
  },
  'paloalto': {
    name: 'Palo Alto Networks',
    urls: ['https://jobs.paloaltonetworks.com/en/jobs/'],
    platform: 'generic',
  },
  'fortinet': {
    name: 'Fortinet',
    urls: ['https://edel.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/jobs'],
    platform: 'generic',
  },
  'zscaler': {
    name: 'Zscaler',
    urls: ['https://boards.greenhouse.io/zscaler'],
    platform: 'greenhouse',
  },
  'okta': {
    name: 'Okta',
    urls: ['https://www.okta.com/company/careers/#702702702702702702702702702702'],
    platform: 'generic',
  },
  'snyk': {
    name: 'Snyk',
    urls: ['https://boards.greenhouse.io/snyk'],
    platform: 'greenhouse',
  },
  'hackerone': {
    name: 'HackerOne',
    urls: ['https://www.hackerone.com/careers#job_list'],
    platform: 'generic',
  },
  'rapid7': {
    name: 'Rapid7',
    urls: ['https://careers.rapid7.com/careers-home/jobs'],
    platform: 'generic',
  },
  'tenable': {
    name: 'Tenable',
    urls: ['https://careers.tenable.com/search/jobs'],
    platform: 'generic',
  },

  // ── AI / ML ──
  'openai': {
    name: 'OpenAI',
    urls: ['https://openai.com/careers/search/'],
    platform: 'generic',
  },
  'anthropic': {
    name: 'Anthropic',
    urls: ['https://boards.greenhouse.io/anthropic'],
    platform: 'greenhouse',
  },
  'deepmind': {
    name: 'DeepMind',
    urls: ['https://deepmind.google/about/careers/'],
    platform: 'google',
  },
  'cohere': {
    name: 'Cohere',
    urls: ['https://jobs.lever.co/cohere'],
    platform: 'lever',
  },
  'hugging face': {
    name: 'Hugging Face',
    urls: ['https://apply.workable.com/huggingface/'],
    platform: 'workable',
  },
  'huggingface': {
    name: 'Hugging Face',
    urls: ['https://apply.workable.com/huggingface/'],
    platform: 'workable',
  },
  'stability ai': {
    name: 'Stability AI',
    urls: ['https://stability.ai/careers'],
    platform: 'generic',
  },

  // ── E-commerce ──
  'shopify': {
    name: 'Shopify',
    urls: ['https://www.shopify.com/careers/search'],
    platform: 'generic',
  },
  'flipkart': {
    name: 'Flipkart',
    urls: ['https://www.flipkartcareers.com/#!/joblist'],
    platform: 'generic',
  },
  'instacart': {
    name: 'Instacart',
    urls: ['https://instacart.careers/current-openings/'],
    platform: 'generic',
  },

  // ── Indian Tech ──
  'infosys': {
    name: 'Infosys',
    urls: ['https://www.infosys.com/careers/apply.html'],
    platform: 'generic',
  },
  'tcs': {
    name: 'TCS',
    urls: ['https://ibegin.tcs.com/iBegin/jobs/search'],
    platform: 'generic',
  },
  'wipro': {
    name: 'Wipro',
    urls: ['https://careers.wipro.com/careers-home/jobs'],
    platform: 'generic',
  },
  'zoho': {
    name: 'Zoho',
    urls: ['https://careers.zohocorp.com/jobs/Ede'],
    platform: 'generic',
  },
  'freshworks': {
    name: 'Freshworks',
    urls: ['https://careers.freshworks.com/jobs'],
    platform: 'generic',
  },
  'zerodha': {
    name: 'Zerodha',
    urls: ['https://zerodha.com/careers/'],
    platform: 'generic',
  },
  'swiggy': {
    name: 'Swiggy',
    urls: ['https://careers.swiggy.com/#/'],
    platform: 'generic',
  },
  'zomato': {
    name: 'Zomato',
    urls: ['https://www.zomato.com/careers'],
    platform: 'generic',
  },
  'phonepe': {
    name: 'PhonePe',
    urls: ['https://www.phonepe.com/careers/'],
    platform: 'generic',
  },
  'cred': {
    name: 'CRED',
    urls: ['https://careers.cred.club/openings'],
    platform: 'generic',
  },

  // ── Gaming ──
  'valve': {
    name: 'Valve',
    urls: ['https://www.valvesoftware.com/en/jobs'],
    platform: 'generic',
  },
  'riot': {
    name: 'Riot Games',
    urls: ['https://www.riotgames.com/en/work-with-us#702702702702702702702'],
    platform: 'generic',
  },
  'riot games': {
    name: 'Riot Games',
    urls: ['https://www.riotgames.com/en/work-with-us#702702702702702702702'],
    platform: 'generic',
  },
  'epic games': {
    name: 'Epic Games',
    urls: ['https://boards.greenhouse.io/epicgames'],
    platform: 'greenhouse',
  },

  // ── Others ──
  'tesla': {
    name: 'Tesla',
    urls: ['https://www.tesla.com/careers/search/'],
    platform: 'generic',
  },
  'spacex': {
    name: 'SpaceX',
    urls: ['https://boards.greenhouse.io/spacex'],
    platform: 'greenhouse',
  },
  'palantir': {
    name: 'Palantir',
    urls: ['https://www.palantir.com/careers/#702702702702702702702702702702702'],
    platform: 'generic',
  },
  'coinbase': {
    name: 'Coinbase',
    urls: ['https://www.coinbase.com/careers/positions'],
    platform: 'generic',
  },
  'robinhood': {
    name: 'Robinhood',
    urls: ['https://robinhood.com/us/en/careers/openings/'],
    platform: 'generic',
  },
  'adobe': {
    name: 'Adobe',
    urls: ['https://careers.adobe.com/us/en/search-results'],
    platform: 'eightfold',
  },
  'intel': {
    name: 'Intel',
    urls: ['https://jobs.intel.com/en/search-jobs'],
    platform: 'generic',
  },
  'cisco': {
    name: 'Cisco',
    urls: ['https://jobs.cisco.com/jobs/SearchJobs/'],
    platform: 'generic',
  },
  'vmware': {
    name: 'VMware',
    urls: ['https://careers.vmware.com/main/jobs'],
    platform: 'generic',
  },
  'dell': {
    name: 'Dell',
    urls: ['https://jobs.dell.com/search-jobs'],
    platform: 'generic',
  },
  'accenture': {
    name: 'Accenture',
    urls: ['https://www.accenture.com/us-en/careers/jobsearch'],
    platform: 'generic',
  },
  'deloitte': {
    name: 'Deloitte',
    urls: ['https://apply.deloitte.com/careers/SearchJobs'],
    platform: 'generic',
  },
};

/**
 * Look up a company name and return its known careers URL(s).
 * Tries exact match first, then fuzzy substring match.
 */
export function resolveCompanyUrls(companyName: string): CompanyEntry | null {
  const key = companyName.trim().toLowerCase();
  if (!key) return null;

  // 1. Exact match
  if (DIRECTORY[key]) return DIRECTORY[key];

  // 2. Fuzzy: check if input is a substring of any key, or vice versa
  for (const [dirKey, entry] of Object.entries(DIRECTORY)) {
    if (dirKey.includes(key) || key.includes(dirKey)) return entry;
  }

  return null;
}

/**
 * Generate a LinkedIn company search URL as fallback
 * when we don't have a curated careers page.
 */
export function buildLinkedInCompanySearchUrl(companyName: string): string {
  const encoded = encodeURIComponent(companyName.trim());
  return `https://www.linkedin.com/jobs/search/?keywords=${encoded}&f_TPR=r86400&sortBy=DD`;
}

/**
 * Returns all URLs to track for a given company name.
 * Uses directory if available, falls back to LinkedIn search.
 */
export function getCompanyTrackingUrls(companyName: string): { urls: string[]; source: 'directory' | 'linkedin'; displayName: string } {
  const entry = resolveCompanyUrls(companyName);
  if (entry) {
    return { urls: entry.urls, source: 'directory', displayName: entry.name };
  }
  return {
    urls: [buildLinkedInCompanySearchUrl(companyName)],
    source: 'linkedin',
    displayName: companyName,
  };
}
