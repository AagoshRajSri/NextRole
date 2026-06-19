import { PLATFORM_SORT_PARAMS, SORT_SUPPORTED_PLATFORMS } from './sortParams'

import { normalizeCareerUrl, detectPlatform, extractCompanyFromUrl as sharedExtractCompany } from '../jobtracker-backend/sharedUtils';

export { normalizeCareerUrl, detectPlatform };

export function extractCompanyFromUrl(url: string): string {
  return sharedExtractCompany(url) || '';
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
