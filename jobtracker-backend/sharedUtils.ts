/**
 * jobtracker-backend/sharedUtils.ts
 *
 * Single source of truth for URL normalization, platform detection, and company extraction.
 * Shared between the frontend extension and the backend service.
 *
 * NOTE: Do not import any browser-specific (e.g. browser.*) or Node-specific (e.g. crypto, fs) APIs here.
 */

// ─── Shared tracking params ─────────────────────────────────────────────────
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'ref', 'referral', 'source', 'tracking', 'trk', 'trkInfo',
  'refId', 'sessionId', 'originalSubdomain', 'hl',
  'gclid', 'gcclid', 'fbclid', 'msclkid',
]);

// Helper to capitalize words
function toTitleCase(str: string): string {
  return str
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// ─── normalizeCareerUrl ─────────────────────────────────────────────────────
export function normalizeCareerUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw.trim().toLowerCase();
  }

  u.hostname = u.hostname.toLowerCase();
  u.hash = '';

  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
  }

  // LinkedIn company jobs → canonical slug URL
  const liCompanyMatch = u.pathname.match(/\/company\/([^/]+)\/jobs/i);
  if (u.hostname.includes('linkedin.com') && liCompanyMatch) {
    return `https://www.linkedin.com/company/${liCompanyMatch[1].toLowerCase()}/jobs/`;
  }

  // LinkedIn job search → keep keywords + location only
  if (u.hostname.includes('linkedin.com') && u.pathname.includes('/jobs/search')) {
    const kw  = u.searchParams.get('keywords') || '';
    const loc = u.searchParams.get('location') || '';
    const out = new URL('https://www.linkedin.com/jobs/search/');
    if (kw)  out.searchParams.set('keywords', kw.toLowerCase());
    if (loc) out.searchParams.set('location', loc.toLowerCase());
    return out.toString();
  }

  // Greenhouse: strip trailing slash
  if (u.hostname.includes('greenhouse.io')) {
    u.pathname = u.pathname.replace(/\/$/, '');
    return u.toString();
  }

  // Lever: company page
  if (u.hostname.includes('lever.co')) {
    const company = u.pathname.split('/')[1];
    if (company && company !== 'jobs') {
      u.pathname = `/${company}`;
      return u.toString().toLowerCase();
    }
  }

  u.pathname = u.pathname.replace(/\/$/, '');
  const out = u.toString();
  return out;
}

// ─── detectPlatform ─────────────────────────────────────────────────────────
export function detectPlatform(url: string): string {
  try {
    const { hostname: host, pathname: path } = new URL(url);
    const h = host.toLowerCase();
    const p = path.toLowerCase();

    if (h.includes('greenhouse.io'))  return 'greenhouse';
    if (h.includes('lever.co'))       return 'lever';
    if (h.includes('myworkdayjobs.com') || (h.includes('workday.com') && p.includes('jobs'))) return 'workday';
    if (h.includes('ashbyhq.com'))    return 'ashby';
    if (h.includes('wellfound.com') || h.includes('angel.co')) return 'wellfound';
    if (h.includes('workable.com') || h.includes('apply.workable.com')) return 'workable';
    if (h.includes('smartrecruiters.com')) return 'smartrecruiters';
    if (h === 'amazon.jobs')          return 'amazon_jobs';
    if (h.includes('naukri.com'))     return 'naukri';
    if (h.includes('instahyre.com')) return 'instahyre';
    if (h.includes('linkedin.com'))  return 'linkedin';
    if (h.includes('eightfold.ai'))  return 'eightfold';
    if (h.includes('taleo.net'))     return 'taleo';
    if (h.includes('icims.com'))     return 'icims';
    if (h.includes('successfactors.com') || h.includes('successfactors.eu')) return 'successfactors';
    if (h.includes('jobvite.com'))   return 'jobvite';
    if (h.includes('brassring.com') || h.includes('kenexa.com')) return 'brassring';
    if (h.includes('myworkday.com')) return 'workday';
    if (h.includes('ultipro.com') || h.includes('ukg.com')) return 'ultipro';
    if (h === 'careers.google.com' || (h.includes('google.com') && p.includes('/careers'))) return 'google';
    if (h.includes('microsoft.com') && (h.includes('eightfold') || p.includes('careers'))) return 'eightfold';
    if (h.includes('apple.com') && p.includes('job')) return 'apple';
    if (h.startsWith('careers.') || h.startsWith('jobs.')) return 'generic';
    if (p.includes('/careers') || p.includes('/jobs')) return 'generic';
    return 'generic';
  } catch {
    return 'generic';
  }
}

// ─── extractCompanyFromUrl ──────────────────────────────────────────────────
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
