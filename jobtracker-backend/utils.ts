/**
 * URL Utilities — shared between server.ts, worker.ts, and scraper.ts
 */

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'ref', 'referral', 'source', 'tracking', 'trk', 'trkInfo',
  'originalSubdomain', 'hl', 'gclid', 'fbclid', 'msclkid',
]);

/**
 * Normalise a career page URL:
 * - Remove UTM / tracking query params
 * - Remove trailing slash & fragments
 * - Lowercase hostname
 * - Canonicalise known ATS URLs
 */
export function normalizeCareerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return raw.trim().toLowerCase();
  }

  // Lowercase hostname
  url.hostname = url.hostname.toLowerCase();

  // Remove fragment
  url.hash = '';

  // Strip tracking params
  const params = new URLSearchParams(url.search);
  for (const key of [...params.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) {
      params.delete(key);
    }
  }
  url.search = params.toString();

  // LinkedIn canonicalisation: linkedin.com/company/SLUG/jobs/* → canonical
  const liMatch = url.pathname.match(/^\/company\/([^/]+)\/jobs/i);
  if (url.hostname.includes('linkedin.com') && liMatch) {
    url.pathname = `/company/${liMatch[1].toLowerCase()}/jobs/`;
    url.search = '';
  }

  // Remove trailing slash from all other paths
  let result = url.toString();
  if (result.endsWith('/') && url.pathname !== '/') {
    result = result.slice(0, -1);
  }

  return result;
}

/**
 * Extract a human-readable company name from a career page URL.
 * Returns null for unknown patterns (will be derived from page title by scraper).
 */
export function extractCompanyFromUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  // linkedin.com/company/SLUG/jobs
  const liMatch = path.match(/\/company\/([^/]+)\/jobs/i);
  if (host.includes('linkedin.com') && liMatch) {
    return toTitleCase(liMatch[1].replace(/-/g, ' '));
  }

  // boards.greenhouse.io/COMPANY  or  greenhouse.io/COMPANY
  if (host.includes('greenhouse.io')) {
    const parts = path.split('/').filter(Boolean);
    if (parts[0]) return toTitleCase(parts[0].replace(/-/g, ' '));
  }

  // jobs.lever.co/COMPANY  or  lever.co/COMPANY
  if (host.includes('lever.co')) {
    const parts = path.split('/').filter(Boolean);
    if (parts[0]) return toTitleCase(parts[0].replace(/-/g, ' '));
  }

  // COMPANY.myworkdayjobs.com / COMPANY.workday.com
  if (host.includes('myworkdayjobs.com') || host.includes('workday.com')) {
    const sub = host.split('.')[0];
    if (sub && sub !== 'www') return toTitleCase(sub.replace(/-/g, ' '));
  }

  // wellfound.com/company/SLUG/jobs  or  angel.co/company/SLUG
  const wfMatch = path.match(/\/company\/([^/]+)/i);
  if ((host.includes('wellfound.com') || host.includes('angel.co')) && wfMatch) {
    return toTitleCase(wfMatch[1].replace(/-/g, ' '));
  }

  // amazon.jobs — keep null; company is "Amazon"
  if (host === 'amazon.jobs' || host.includes('amazon.jobs')) {
    return 'Amazon';
  }

  // jobs.COMPANY.com  or  careers.COMPANY.com
  const subMatch = host.match(/^(?:jobs|careers)\.([\w-]+)\./);
  if (subMatch) {
    return toTitleCase(subMatch[1].replace(/-/g, ' '));
  }

  // COMPANY.jobs.com pattern
  const companyJobsMatch = host.match(/^([\w-]+)\.jobs\.com/);
  if (companyJobsMatch) {
    return toTitleCase(companyJobsMatch[1].replace(/-/g, ' '));
  }

  return null;
}

function toTitleCase(str: string): string {
  return str
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Detect which ATS platform a URL belongs to.
 */
export function detectPlatform(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes('greenhouse.io')) return 'greenhouse';
  if (lower.includes('lever.co')) return 'lever';
  if (lower.includes('myworkdayjobs.com') || lower.includes('workday.com')) return 'workday';
  if (lower.includes('linkedin.com')) return 'linkedin';
  if (lower.includes('wellfound.com') || lower.includes('angel.co')) return 'wellfound';
  if (lower.includes('amazon.jobs')) return 'amazon';
  if (lower.includes('naukri.com')) return 'naukri';
  if (lower.includes('instahyre.com')) return 'instahyre';
  return 'generic';
}

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

import crypto from 'crypto';

const ENCRYPTION_KEY = process.env.COOKIE_ENCRYPTION_KEY || 'default_secret_key_32_bytes_long_!!!'; // Must be 32 bytes
const IV_LENGTH = 16;

export function encryptData(text: string): string {
  if (!text) return text;
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function decryptData(text: string): string | null {
  if (!text) return null;
  try {
    const parts = text.split(':');
    if (parts.length !== 3) return null;
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encryptedText = parts[2];
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    return null;
  }
}
