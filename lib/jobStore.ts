// Types
export interface JobCard {
  id: string              // LinkedIn job ID from URL
  company: string
  companySlug: string
  companyLogoUrl: string
  role: string
  location: string
  postedAt: string        // relative string: '2 hours ago'
  detectedAt: number      // Date.now()
  applyUrl: string
  matchScore: number      // 0-100
  status: 'new' | 'seen' | 'applied'
}

export interface FollowedCompany {
  slug: string
  name: string
  logoUrl: string
  companyId?: string // [FIX-1] Added companyId
  lastScannedAt?: number // Added for chunked scanning
}

export interface JobStore {
  jobs: JobCard[]
  lastScannedAt: number | null
  followedCompanies: FollowedCompany[]
  followedCompaniesLastFetchedAt: number | null
}

import { browser } from 'wxt/browser';

export async function getJobStore(): Promise<JobStore> {
  try {
    const data = await browser.storage.local.get('nr_job_store');
    if (data.nr_job_store) {
      return data.nr_job_store as JobStore;
    }
  } catch (err) {
    console.error('[NextRole:Store]', err);
  }
  return { jobs: [], lastScannedAt: null, followedCompanies: [], followedCompaniesLastFetchedAt: null };
}

export async function saveJobStore(store: JobStore): Promise<void> {
  try {
    await browser.storage.local.set({ nr_job_store: store });
  } catch (err) {
    console.error('[NextRole:Store]', err);
  }
}

export async function addJobs(newJobs: Omit<JobCard, 'status'>[]): Promise<JobCard[]> {
  const store = await getJobStore();
  const existingIds = new Set(store.jobs.map(j => j.id));
  
  const genuinelyNew: JobCard[] = [];
  for (const job of newJobs) {
    if (!existingIds.has(job.id)) {
      genuinelyNew.push({ ...job, status: 'new' });
    }
  }

  if (genuinelyNew.length > 0) {
    const combined = [...genuinelyNew, ...store.jobs];
    if (combined.length > 500) {
      store.jobs = combined.slice(0, 500);
    } else {
      store.jobs = combined;
    }
    await saveJobStore(store);
  }

  return genuinelyNew;
}

export async function markJobSeen(jobId: string): Promise<void> {
  const store = await getJobStore();
  let changed = false;
  for (const job of store.jobs) {
    if (job.id === jobId && job.status === 'new') {
      job.status = 'seen';
      changed = true;
    }
  }
  if (changed) await saveJobStore(store);
}

export async function markJobApplied(jobId: string): Promise<void> {
  const store = await getJobStore();
  let changed = false;
  for (const job of store.jobs) {
    if (job.id === jobId && job.status !== 'applied') {
      job.status = 'applied';
      changed = true;
    }
  }
  if (changed) await saveJobStore(store);
}

export async function getNewJobCount(): Promise<number> {
  const store = await getJobStore();
  let count = 0;
  for (const job of store.jobs) {
    if (job.status === 'new') count++;
  }
  return count;
}

export async function clearOldJobs(): Promise<void> {
  const store = await getJobStore();
  const threshold = Date.now() - (7 * 24 * 60 * 60 * 1000);
  const filtered = store.jobs.filter(j => j.detectedAt >= threshold);
  if (filtered.length < store.jobs.length) {
    store.jobs = filtered;
    await saveJobStore(store);
  }
}

export async function saveFollowedCompanies(companies: FollowedCompany[]): Promise<void> {
  const store = await getJobStore();
  const existingMap = new Map(store.followedCompanies.map(c => [c.slug, c.lastScannedAt]));
  for (const c of companies) {
    if (existingMap.has(c.slug)) {
      c.lastScannedAt = existingMap.get(c.slug);
    }
  }
  store.followedCompanies = companies;
  store.followedCompaniesLastFetchedAt = Date.now();
  await saveJobStore(store);
}
