// ────────────────────────────────────────────────────────
// TYPES (single source of truth)
// ────────────────────────────────────────────────────────

export interface UserProfile {
  name: string;
  phone: string;
  email: string;
  linkedinUrl: string;
  targetRoles: string[];
  locations: string[];
  watchlistCompanies: string[];
  experienceLevel: 'fresher' | '1-3' | '3-7' | '7+';
  alertMode: 'instant' | 'daily' | 'weekly';
  emailAlerts: boolean;
  timezone?: string;
  isOnboarded: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TrackedPage {
  id: string;
  url: string;
  displayUrl?: string;
  normalizedUrl: string;
  label: string;
  subtitle: string;
  addedAt: number;
  lastScrapedAt: number | null;
  lastScrapeStatus: 'ok' | 'empty' | 'error' | 'pending' | 'blocked' | 'partial' | null;
  lastScrapeError: string | null;
  newJobCount: number;
  isPending: boolean;
  platform?: string;
}

export interface StoredJob {
  id: string;
  title: string;
  companyName: string;
  location: string;
  url: string;
  sourcePageUrl: string;
  sourceDomain: string;
  matchReason: string;
  matchScore?: number;
  matchBreakdown?: any;
  postDate?: string;
  firstSeenAt: number;
  seenAt: number | null;
  snoozedUntil: number | null;
  dismissed: boolean;
  appliedAt: number | null;
  applicationStatus: 'applied' | 'phone_screen' | 'technical_interview' | 'final_interview' | 'offer' | 'rejected' | 'accepted' | null;
}

export interface MonitorState {
  active: boolean;
  lastPollAt: number | null;
  lastCycleMatchCount: number;
  totalJobsFound: number;
  totalAlertsCount: number;
}

// ────────────────────────────────────────────────────────
// STORAGE ITEMS (typed, single definition)
// ────────────────────────────────────────────────────────

export const profileStorage = storage.defineItem<UserProfile | null>('local:profile', {
  fallback: null,
});

export const trackedPagesStorage = storage.defineItem<TrackedPage[]>('local:trackedPages', {
  fallback: [],
});

export const unseenJobsStorage = storage.defineItem<StoredJob[]>('local:unseenJobs', {
  fallback: [],
});

export const monitorStateStorage = storage.defineItem<MonitorState>('local:monitorState', {
  fallback: {
    active: false,
    lastPollAt: null,
    lastCycleMatchCount: 0,
    totalJobsFound: 0,
    totalAlertsCount: 0,
  },
});

export const dismissedJobIdsStorage = storage.defineItem<string[]>('local:dismissedJobIds', {
  fallback: [],
});

export const appliedJobsStorage = storage.defineItem<StoredJob[]>('local:appliedJobs', {
  fallback: [],
});

export const remoteSelectorsStorage = storage.defineItem<Record<string, any>>('local:remoteSelectors', {
  fallback: {},
});

export const userIdStorage = storage.defineItem<string | null>('local:userId', {
  fallback: null,
});

// ────────────────────────────────────────────────────────
// UTILITIES
// ────────────────────────────────────────────────────────

export function extractReadableLabel(url: string): { title: string; subtitle: string } {
  try {
    const u = new URL(url);
    const host = u.hostname.replace('www.', '');
    const path = u.pathname;

    // LinkedIn company page
    const liMatch = path.match(/\/company\/([^/]+)\/jobs/);
    if (liMatch) {
      return {
        title: liMatch[1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        subtitle: 'LinkedIn Jobs',
      };
    }

    // Greenhouse
    if (host.includes('greenhouse.io')) {
      const co = path.split('/')[1] || host;
      return {
        title: co.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        subtitle: 'Greenhouse',
      };
    }

    // Lever
    if (host.includes('lever.co')) {
      const co = path.split('/')[1] || host;
      return {
        title: co.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        subtitle: 'Lever',
      };
    }

    // Ashby
    if (host.includes('ashbyhq.com')) {
      const co = path.split('/')[1] || host;
      return {
        title: co.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        subtitle: 'Ashby',
      };
    }

    // Workable
    if (host.includes('workable.com')) {
      const co = path.split('/')[2] || host;
      return {
        title: co.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        subtitle: 'Workable',
      };
    }

    // Amazon jobs
    if (host === 'amazon.jobs') {
      const label = path.replace(/-/g, ' ').replace(/\//g, ' ').trim().replace(/\b\w/g, l => l.toUpperCase());
      return { title: 'Amazon Jobs', subtitle: label.slice(0, 40) };
    }

    // careers.company.com or jobs.company.com
    if (host.startsWith('careers.') || host.startsWith('jobs.')) {
      const company = host.split('.')[1];
      return {
        title: company.replace(/\b\w/g, l => l.toUpperCase()),
        subtitle: host,
      };
    }

    // Generic: use hostname + first path segment
    const seg = path.split('/').filter(Boolean)[0] || '';
    return { title: host, subtitle: seg || u.pathname };
  } catch {
    return { title: url.slice(0, 40), subtitle: '' };
  }
}

export function isCareerPage(url: string, doc?: Document): boolean {
  try {
    const { hostname: h, pathname: p } = new URL(url)
    const host = h.toLowerCase()
    const path = p.toLowerCase()
    
    const atsDomains = [
      'greenhouse.io', 'lever.co', 'myworkdayjobs.com', 'ashbyhq.com',
      'wellfound.com', 'workable.com', 'smartrecruiters.com', 'amazon.jobs',
      'naukri.com', 'instahyre.com', 'eightfold.ai', 'taleo.net', 'icims.com',
      'successfactors.com', 'successfactors.eu', 'jobvite.com', 'brassring.com',
      'ultipro.com', 'ukg.com', 'iimjobs.com', 'internshala.com',
    ]
    if (atsDomains.some(d => host.endsWith(d))) return true
    
    if (host.includes('linkedin.com') && path.includes('/jobs')) return true
    
    const careerHosts = [
      'careers.google.com', 'jobs.apple.com', 'www.metacareers.com',
      'careers.microsoft.com', 'jobs.netflix.com', 'careers.stripe.com',
      'careers.shopify.com', 'careers.databricks.com', 'careers.openai.com',
      'careers.airbnb.com', 'careers.figma.com',
    ]
    if (careerHosts.includes(host)) return true
    
    if (host.startsWith('careers.') || host.startsWith('jobs.') || host.startsWith('hiring.')) return true
    
    const careerPaths = ['/careers', '/jobs', '/job-openings', '/open-roles',
                          '/openings', '/positions', '/opportunities', '/join-us',
                          '/join-our-team', '/work-with-us', '/work-here',
                          '/about/careers', '/company/careers', '/en/careers']
    if (careerPaths.some(cp => path === cp || path.startsWith(cp + '/') || path.startsWith(cp + '?'))) return true
    
    if (host.includes('google.com') && path.includes('/careers')) return true
    
    if (doc) {
      const scripts = doc.querySelectorAll('script[type="application/ld+json"]')
      for (const s of scripts) {
        try {
          const data = JSON.parse(s.textContent || '')
          const types = [data['@type']].flat()
          if (types.includes('JobPosting')) return true
          if (data['@graph']?.some((g: any) => g['@type'] === 'JobPosting')) return true
        } catch {}
      }
      
      const title = doc.title.toLowerCase()
      const metaDesc = doc.querySelector('meta[name="description"]')?.getAttribute('content')?.toLowerCase() || ''
      const careerSignals = ['careers at', 'jobs at', 'we are hiring', "we're hiring",
                             'open positions', 'join our team', 'current openings',
                             'work with us', 'explore opportunities']
      if (careerSignals.some(s => title.includes(s) || metaDesc.includes(s))) return true
      
      const h1 = doc.querySelector('h1')?.textContent?.toLowerCase() || ''
      if (['careers', 'open roles', 'open positions', 'join us', 'work with us',
           'we are hiring', 'opportunities'].some(s => h1.includes(s))) return true
    }
    
    return false
  } catch { return false }
}

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
