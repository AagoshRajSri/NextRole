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
  isOnboarded: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TrackedPage {
  id: string;
  url: string;
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
  firstSeenAt: number;
  seenAt: number | null;
  snoozedUntil: number | null;
  dismissed: boolean;
  appliedAt: number | null;
  applicationStatus: 'applied' | 'phone_screen' | 'interview' | 'offer' | 'rejected' | null;
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

export const userIdStorage = storage.defineItem<string | null>('local:userId', {
  fallback: null,
});

// ────────────────────────────────────────────────────────
// UTILITIES
// ────────────────────────────────────────────────────────

export function normalizeCareerUrl(url: string): string {
  try {
    const u = new URL(url);
    // Remove tracking params, trailing slashes
    const cleanPath = u.pathname.replace(/\/$/, '') || '/';
    return `${u.hostname}${cleanPath}`;
  } catch {
    return url;
  }
}

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
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();

    // Explicit ATS domains
    const atsDomains = [
      'greenhouse.io', 'boards.greenhouse.io',
      'lever.co', 'jobs.lever.co',
      'myworkdayjobs.com', 'wd1.myworkdayjobs.com', 'wd3.myworkdayjobs.com',
      'wellfound.com', 'angel.co',
      'amazon.jobs',
      'naukri.com',
      'instahyre.com',
      'iimjobs.com',
      'internshala.com',
      'glassdoor.com',
      'indeed.com',
      'ziprecruiter.com',
      'smartrecruiters.com',
      'ashbyhq.com', 'jobs.ashbyhq.com',
      'apply.workable.com',
    ];
    if (atsDomains.some(d => host === d || host.endsWith(`.${d}`))) return true;

    // LinkedIn company jobs
    if (host.includes('linkedin.com') && path.includes('/jobs')) return true;

    // Career path patterns
    const careerPaths = [
      '/careers', '/jobs', '/job-openings', '/open-roles',
      '/work-with-us', '/join-us', '/join-the-team',
      '/opportunities', '/openings', '/positions',
      '/hiring', '/job-board', '/vacancies',
    ];
    if (careerPaths.some(p => path.startsWith(p) || path.includes(p + '/'))) return true;

    // Subdomain patterns
    if (host.startsWith('careers.') || host.startsWith('jobs.') ||
        host.startsWith('hiring.') || host.startsWith('work.')) return true;

    // Page content check
    if (doc) {
      const jsonLds = doc.querySelectorAll('script[type="application/ld+json"]');
      for (const el of jsonLds) {
        try {
          const data = JSON.parse(el.textContent || '');
          const hasJobPosting = (obj: any): boolean => {
            if (!obj) return false;
            if (obj['@type'] === 'JobPosting') return true;
            if (Array.isArray(obj)) return obj.some(hasJobPosting);
            if (obj['@graph']) return hasJobPosting(obj['@graph']);
            return false;
          };
          if (hasJobPosting(data)) return true;
        } catch {}
      }

      const title = doc.title.toLowerCase();
      const metaDesc = doc.querySelector('meta[name="description"]')?.getAttribute('content')?.toLowerCase() || '';
      const hints = [
        'careers at', 'jobs at', 'join our team', 'we are hiring', "we're hiring",
        'open positions', 'current openings', 'job openings',
      ];
      if (hints.some(k => title.includes(k) || metaDesc.includes(k))) return true;
    }

    return false;
  } catch {
    return false;
  }
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
