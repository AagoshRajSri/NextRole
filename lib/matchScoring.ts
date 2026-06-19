// ────────────────────────────────────────────────────────
// MATCH SCORING ENGINE
// Extracted from background.ts for testability and reuse.
// ────────────────────────────────────────────────────────

import type { StoredJob } from './storage';

export interface MatchProfile {
  targetRoles: string[];
  watchlistCompanies: string[];
  locations?: string[];
  experienceLevel?: string;
}

export interface JobCandidate {
  title: string;
  companyName?: string;
  location?: string;
}

export interface MatchBreakdown {
  roleMatch: { matched: boolean; keyword?: string };
  companyMatch: { matched: boolean; company?: string };
  locationMatch: { matched: boolean; location?: string };
  seniorityMatch: { matched: boolean; note?: string };
}

export interface MatchResult {
  score: number;
  reason: string;
  breakdown: MatchBreakdown;
}

const SENIOR_TERMS = ['senior', 'staff', 'principal', 'lead', 'director', 'vp', 'head of'];
const JUNIOR_TERMS = ['junior', 'associate', 'entry', 'intern', 'graduate', 'fresher'];

/**
 * Scores a job against a user profile.
 *
 * Matching rules:
 * - Role match is REQUIRED — if no role keyword hits, score is 0.
 * - If the user has companies in their watchlist, company match is REQUIRED.
 * - If the user has locations set, location match is REQUIRED.
 * - Seniority adjusts score as a bonus/penalty.
 */
export function calculateMatchScore(job: JobCandidate, profile: MatchProfile): MatchResult {
  let score = 0;
  const title = (job.title ?? '').toLowerCase();
  const company = (job.companyName ?? '').toLowerCase();
  const location = (job.location ?? '').toLowerCase();

  const breakdown: MatchBreakdown = {
    roleMatch: { matched: false },
    companyMatch: { matched: false },
    locationMatch: { matched: false },
    seniorityMatch: { matched: false },
  };
  let reason = '';

  const isSeniorRole = SENIOR_TERMS.some(s => title.includes(s));
  const isJuniorRole = JUNIOR_TERMS.some(s => title.includes(s));
  const isJuniorProfile = ['fresher', '1-3'].includes(profile.experienceLevel ?? '');

  // ── Role match (required) ──
  for (const role of profile.targetRoles || []) {
    const r = role.trim().toLowerCase();
    if (!r) continue;
    if (title === r) {
      score += 50; reason = `role:${role}`;
      breakdown.roleMatch = { matched: true, keyword: role }; break;
    }
    if (title.includes(r)) {
      score += 40; reason = `role:${role}`;
      breakdown.roleMatch = { matched: true, keyword: role }; break;
    }
    if (r.split(' ').every(w => title.includes(w))) {
      score += 30; reason = `role:${role}`;
      breakdown.roleMatch = { matched: true, keyword: role }; break;
    }
  }
  if (score === 0) return { score: 0, reason: '', breakdown };

  // ── Company match (required if watchlist is non-empty) ──
  for (const co of profile.watchlistCompanies || []) {
    const c = co.trim().toLowerCase();
    if (c && (company.includes(c) || c.includes(company))) {
      score += 25;
      if (!reason) reason = `company:${co}`; else reason += `,company:${co}`;
      breakdown.companyMatch = { matched: true, company: co }; break;
    }
  }

  const hasCompanies = (profile.watchlistCompanies || []).length > 0;
  if (hasCompanies && !breakdown.companyMatch.matched) return { score: 0, reason: '', breakdown };

  // ── Location match (required if locations are set) ──
  const locs = profile.locations || [];
  const hasRemote = locs.some(l => l.toLowerCase().includes('remote'));
  const hasAnywhere = locs.some(l => l.toLowerCase().includes('anywhere'));
  const isRemote = location.includes('remote') || location.includes('anywhere');

  if (hasAnywhere) {
    // "Anywhere" means accept all locations
    score += 20;
    breakdown.locationMatch = { matched: true, location: 'Anywhere' };
  } else if (isRemote && hasRemote) {
    score += 20;
    breakdown.locationMatch = { matched: true, location: 'Remote' };
  } else if (locs.some(l => {
    const term = l.toLowerCase();
    return location.includes(term) || term.includes(location) && location.length > 2;
  })) {
    score += 20;
    breakdown.locationMatch = { matched: true, location };
  }

  const hasLocations = locs.length > 0;
  if (hasLocations && !breakdown.locationMatch.matched) return { score: 0, reason: '', breakdown };

  // ── Seniority bonus/penalty ──
  if (profile.experienceLevel === '7+' && isSeniorRole) {
    score += 5; breakdown.seniorityMatch = { matched: true, note: 'Senior match' };
  }
  if (isJuniorProfile && isJuniorRole) {
    score += 5; breakdown.seniorityMatch = { matched: true, note: 'Entry-level match' };
  }
  if (isJuniorProfile && isSeniorRole) {
    score -= 10; breakdown.seniorityMatch = { matched: false, note: 'Overqualified role' };
  }

  return { score: Math.min(100, Math.max(0, score)), reason, breakdown };
}

/**
 * Returns true if `newJob` is a duplicate of something already in `existing`,
 * using fuzzy title+company matching across different ATS platforms.
 */
export function isCrossPlatformDuplicate(newJob: StoredJob, existing: StoredJob[]): boolean {
  const t = newJob.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const c = newJob.companyName.toLowerCase().trim();
  if (!c) return false;
  const recent = existing.filter(j => Date.now() - j.firstSeenAt < 7 * 86400000);
  return recent.some(j => {
    const et = j.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    const ec = j.companyName.toLowerCase().trim();
    const titleSim = et === t || et.includes(t) || t.includes(et);
    const compSame = ec === c || ec.includes(c) || c.includes(ec);
    return titleSim && compSame;
  });
}
