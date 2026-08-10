/**
 * jobtracker-backend/utils.ts
 *
 * Backend utility facade. URL helpers (normalizeCareerUrl, detectPlatform,
 * extractCompanyFromUrl) are sourced from the single canonical implementation
 * in ./sharedUtils.ts, which is shared by both the backend and the extension
 * (lib/utils.ts). Backend-only helpers (AES-256-GCM crypto, job matching)
 * live here.
 */

export { normalizeCareerUrl, detectPlatform, extractCompanyFromUrl } from './sharedUtils.js';




/**
 * Keyword matching for free tier (no embeddings).
 */
export interface UserPrefs {
  targetRoles: string[];
  watchlistCompanies: string[];
  locations: string[];
  experienceLevel?: string;
}

export interface MatchResult {
  matched: boolean;
  reason: string;
}

export function jobMatchesPrefs(
  job: { title: string; companyName?: string | null; location?: string | null },
  prefs: UserPrefs,
): MatchResult {
  const title = (job.title ?? '').toLowerCase();
  const company = (job.companyName ?? '').toLowerCase();
  const location = (job.location ?? '').toLowerCase();

  // 1. Role keyword match
  for (const role of prefs.targetRoles) {
    if (role.trim() && title.includes(role.trim().toLowerCase())) {
      return { matched: true, reason: `role: ${role}` };
    }
  }

  // 2. Company watchlist match
  for (const co of prefs.watchlistCompanies) {
    const coLower = co.trim().toLowerCase();
    if (!coLower) continue;
    if (company.includes(coLower) || coLower.includes(company)) {
      if (profileConflictsWithSeniority(job.title, prefs.experienceLevel)) continue;
      return { matched: true, reason: `company: ${co}` };
    }
  }

  return { matched: false, reason: '' };
}

function profileConflictsWithSeniority(title: string, experienceLevel?: string): boolean {
  if (!experienceLevel || experienceLevel === '7+') return false;
  const seniorTerms = ['senior', 'staff', 'principal', 'lead', 'director', 'vp', 'head of'];
  const t = (title ?? '').toLowerCase();
  if (['fresher', '1-3 yrs'].includes(experienceLevel)) {
    return seniorTerms.some(s => t.includes(s));
  }
  return false;
}

