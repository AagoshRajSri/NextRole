export interface SortConfig {
  param: string          // URL parameter name
  value: string          // URL parameter value for "newest first"
  strategy: 'query'      // how to inject (always query string for now)
  removeParams?: string[] // conflicting params to remove when injecting
  notes?: string         // platform-specific notes
}

export const PLATFORM_SORT_PARAMS: Record<string, SortConfig> = {
  
  // --- ATS PLATFORMS ---
  
  eightfold: {
    param: 'sort_by',
    value: 'timestamp',
    strategy: 'query',
    removeParams: ['sort_by'],
    notes: 'Works on all Eightfold-powered sites: Microsoft, Mastercard, Cisco etc.'
  },
  
  greenhouse: {
    param: 'sort_by',
    value: 'date',       // Greenhouse doesn't have a public sort param on boards
    strategy: 'query',   // but some boards support ?sort_by=date
    notes: 'Greenhouse boards do not reliably support sort — leave URL as-is'
  },
  
  lever: {
    // Lever has no sort param on public boards
    // Jobs are already shown newest-first by default on most Lever boards
    param: '',
    value: '',
    strategy: 'query',
    notes: 'Lever shows newest first by default — no param needed'
  },
  
  ashby: {
    // Ashby has no public sort param
    param: '',
    value: '',
    strategy: 'query',
    notes: 'Ashby API is used internally — results already sorted by recency'
  },
  
  workday: {
    // Workday does not expose a sort param on public pages
    param: '',
    value: '',
    strategy: 'query',
    notes: 'Workday SPA — no reliable public sort param'
  },
  
  workable: {
    param: 'sort',
    value: 'recent',
    strategy: 'query',
    removeParams: ['sort'],
  },
  
  smartrecruiters: {
    param: 'createdOnFrom',
    value: '__LAST_30_DAYS__',             // calculated dynamically: 30 days ago ISO date
    strategy: 'query',
    notes: 'Use dynamic date: new Date(Date.now() - 30*86400000).toISOString().split("T")[0]'
  },
  
  icims: {
    param: 'sortColumn',
    value: 'requisitionDate',
    strategy: 'query',
    removeParams: ['sortColumn', 'sortDirection'],
    // Also add: sortDirection=desc
  },
  
  taleo: {
    param: 'sortField',
    value: 'PostedDate',
    strategy: 'query',
    removeParams: ['sortField', 'sortOrder'],
    // Also add: sortOrder=DESC
  },
  
  jobvite: {
    param: 'sortColumn',
    value: 'date',
    strategy: 'query',
    removeParams: ['sortColumn', 'sortDirection'],
  },
  
  successfactors: {
    // SuccessFactors URL params vary by company config — not reliable
    param: '',
    value: '',
    strategy: 'query',
    notes: 'Sort not reliable via URL params'
  },
  
  amazon_jobs: {
    param: 'sortBy',
    value: 'recent',
    strategy: 'query',
    removeParams: ['sortBy'],
    // Amazon Jobs also supports: base_query, loc_query, job_type etc
  },
  
  naukri: {
    param: 'sort',
    value: '1',            // 1 = date posted on Naukri
    strategy: 'query',
    removeParams: ['sort'],
  },
  
  wellfound: {
    param: 'sort',
    value: 'recently_added',
    strategy: 'query',
    removeParams: ['sort'],
  },
  
  // --- COMPANY-SPECIFIC CAREER PAGES ---
  
  google: {
    param: 'sort_by',
    value: 'date',
    strategy: 'query',
    removeParams: ['sort_by'],
    notes: 'Google Careers supports sort_by=date on results pages'
  },
  
  linkedin_search: {
    // LinkedIn job search (not company page)
    // f_TPR filters by time: r3600=1hr, r86400=24hr, r604800=1week
    param: 'f_TPR',
    value: 'r86400',       // past 24 hours — aggressive but effective
    strategy: 'query',
    removeParams: ['f_TPR', 'f_WT', 'sortBy'],
    // Also add: sortBy=DD (date descending)
  },
  
  // Generic fallback — no sort param
  generic: {
    param: '',
    value: '',
    strategy: 'query',
    notes: 'Unknown platform — do not modify URL'
  },
}

// Platforms where sort injection is confirmed working
export const SORT_SUPPORTED_PLATFORMS = new Set([
  'eightfold', 'workable', 'amazon_jobs', 'naukri', 'wellfound',
  'google', 'linkedin_search', 'icims', 'taleo', 'jobvite',
])
