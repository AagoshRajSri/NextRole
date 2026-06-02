import { PLATFORM_SORT_PARAMS, SORT_SUPPORTED_PLATFORMS } from './sortParams'

export function normalizeCareerUrl(url: string): string {
  try {
    const u = new URL(url);
    // Remove all tracking/session params
    const paramsToRemove = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content',
      'utm_term', 'ref', 'source', 'trk', 'trkInfo', 'refId',
      'sessionId', 'gcclid', 'fbclid', 'gclid'];
    paramsToRemove.forEach(p => u.searchParams.delete(p));

    // LinkedIn: normalize company jobs URL
    const liMatch = u.pathname.match(/\/company\/([^/]+)\/jobs/);
    if (u.hostname.includes('linkedin.com') && liMatch) {
      return `https://www.linkedin.com/company/${liMatch[1]}/jobs/`;
    }

    // LinkedIn job search: keep keywords and location params only
    if (u.hostname.includes('linkedin.com') && u.pathname.includes('/jobs/search')) {
      const keywords = u.searchParams.get('keywords') || '';
      const location = u.searchParams.get('location') || '';
      const normalized = new URL('https://www.linkedin.com/jobs/search/');
      if (keywords) normalized.searchParams.set('keywords', keywords.toLowerCase());
      if (location) normalized.searchParams.set('location', location.toLowerCase());
      return normalized.toString();
    }

    // Greenhouse: strip trailing /jobs or /jobs/ for company page
    if (u.hostname.includes('greenhouse.io')) {
      return `${u.origin}${u.pathname.replace(/\/$/, '')}`;
    }

    // Lever: company page
    if (u.hostname.includes('lever.co')) {
      const company = u.pathname.split('/')[1];
      if (company && company !== 'jobs') return `https://jobs.lever.co/${company}`;
    }

    // Generic: lowercase hostname, remove trailing slash, remove fragment
    u.hash = '';
    const normalized = `${u.origin}${u.pathname}`.replace(/\/$/, '');
    return normalized.toLowerCase();
  } catch {
    return url.toLowerCase().replace(/\/$/, '');
  }
}

export function detectPlatform(url: string): string {
  try {
    const { hostname: host, pathname: path } = new URL(url)
    const h = host.toLowerCase()
    const p = path.toLowerCase()
    
    // Existing ATS platforms
    if (h.includes('greenhouse.io') || h.includes('boards.greenhouse.io')) return 'greenhouse'
    if (h.includes('lever.co')) return 'lever'
    if (h.includes('myworkdayjobs.com') || (h.includes('workday.com') && p.includes('jobs'))) return 'workday'
    if (h.includes('ashbyhq.com')) return 'ashby'
    if (h.includes('wellfound.com') || h.includes('angel.co')) return 'wellfound'
    if (h.includes('workable.com') || h.includes('apply.workable.com')) return 'workable'
    if (h.includes('smartrecruiters.com')) return 'smartrecruiters'
    if (h === 'amazon.jobs') return 'amazon_jobs'
    if (h.includes('naukri.com')) return 'naukri'
    if (h.includes('instahyre.com')) return 'instahyre'
    if (h.includes('linkedin.com')) return 'linkedin'
    
    // New platforms
    if (h.includes('eightfold.ai')) return 'eightfold'
    if (h.includes('taleo.net')) return 'taleo'
    if (h.includes('icims.com')) return 'icims'
    if (h.includes('successfactors.com') || h.includes('successfactors.eu')) return 'successfactors'
    if (h.includes('jobvite.com')) return 'jobvite'
    if (h.includes('brassring.com') || h.includes('kenexa.com')) return 'brassring'
    if (h.includes('myworkday.com')) return 'workday'
    if (h.includes('ultipro.com') || h.includes('ukg.com')) return 'ultipro'
    
    // Well-known company career pages (by exact hostname)
    if (h === 'careers.google.com' || (h.includes('google.com') && p.includes('/careers'))) return 'google'
    if (h.includes('microsoft.com') && (h.includes('eightfold') || p.includes('careers'))) return 'eightfold'
    if (h === 'amazon.jobs') return 'amazon_jobs'
    if (h.includes('apple.com') && p.includes('job')) return 'generic'
    if (h.includes('meta.com') && p.includes('careers')) return 'generic'
    
    // Detect by URL structure (generic platforms)
    if (h.startsWith('careers.') || h.startsWith('jobs.')) return 'generic'
    if (p.includes('/careers') || p.includes('/jobs')) return 'generic'
    
    return 'generic'
  } catch { return 'generic' }
}

export function buildJobId(job: { atsJobId: string }, pageUrl: string): string {
  try {
    const domain = new URL(pageUrl).hostname.replace('www.', '');
    return `${domain}::${job.atsJobId}`;
  } catch {
    return `unknown::${job.atsJobId}`;
  }
}

// For URLs matching linkedin.com/jobs/search:
function injectLinkedInFilters(url: string): string {
  try {
    const u = new URL(url)
    if (!u.hostname.includes('linkedin.com')) return url
    if (!u.pathname.includes('/jobs/search')) return url
    
    // f_TPR: time range filter
    // r3600   = past 1 hour (too aggressive for most users)
    // r86400  = past 24 hours (good default)
    // r604800 = past week
    if (!u.searchParams.has('f_TPR')) {
      u.searchParams.set('f_TPR', 'r86400')
    }
    
    // sortBy=DD = date descending (newest first)
    if (!u.searchParams.has('sortBy')) {
      u.searchParams.set('sortBy', 'DD')
    }
    
    return u.toString()
  } catch { return url }
}

export function injectSortParam(url: string, platform: string): string {
  if (url.includes('linkedin.com/jobs/search')) {
    return injectLinkedInFilters(url)
  }

  // Only inject if we have a confirmed sort param for this platform
  if (!SORT_SUPPORTED_PLATFORMS.has(platform)) return url
  
  const config = PLATFORM_SORT_PARAMS[platform]
  if (!config || !config.param || !config.value) return url
  
  try {
    const u = new URL(url)
    
    // Remove conflicting params first
    if (config.removeParams) {
      config.removeParams.forEach(p => u.searchParams.delete(p))
    }
    
    // Handle dynamic values
    let value = config.value
    if (value === '__LAST_30_DAYS__') {
      value = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]
    }
    
    // Inject the sort param
    u.searchParams.set(config.param, value)
    
    // Special cases: platforms that need additional params alongside sort
    if (platform === 'icims') {
      u.searchParams.set('sortDirection', 'desc')
    }
    if (platform === 'taleo') {
      u.searchParams.set('sortOrder', 'DESC')
    }
    if (platform === 'linkedin_search') {
      u.searchParams.set('sortBy', 'DD')  // DD = date descending
    }
    
    return u.toString()
  } catch {
    return url  // if URL is malformed, return original
  }
}

// Check if a URL already has the correct sort param applied
export function hasSortParam(url: string, platform: string): boolean {
  if (!SORT_SUPPORTED_PLATFORMS.has(platform)) return true  // not needed = already "ok"
  
  const config = PLATFORM_SORT_PARAMS[platform]
  if (!config?.param) return true
  
  try {
    const u = new URL(url)
    return u.searchParams.get(config.param) === config.value
  } catch {
    return false
  }
}
