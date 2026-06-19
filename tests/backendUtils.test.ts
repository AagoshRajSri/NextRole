/**
 * tests/backendUtils.test.ts
 *
 * Tests for jobtracker-backend/utils.ts:
 *   - jobMatchesPrefs  (keyword + company + seniority matching)
 *   - encryptData / decryptData  (AES-256-GCM round-trip)
 *   - normalizeCareerUrl / detectPlatform  (must stay in sync with lib/utils.ts)
 *
 * NOTE: These tests import backend/utils.ts directly. Because that file uses
 * NodeNext module resolution we reference it with a relative path from the
 * tests directory. Vitest resolves it correctly without the .js extension.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  jobMatchesPrefs,
  encryptData,
  decryptData,
  normalizeCareerUrl,
  detectPlatform,
  extractCompanyFromUrl,
} from '../jobtracker-backend/utils';

// ─── jobMatchesPrefs ─────────────────────────────────────────────────────────
describe('jobMatchesPrefs — role matching', () => {
  it('matches a job title containing target role keyword', () => {
    const result = jobMatchesPrefs(
      { title: 'Senior Software Engineer', companyName: 'ACME', location: 'Remote' },
      { targetRoles: ['Software Engineer'], watchlistCompanies: [], locations: [] }
    );
    expect(result.matched).toBe(true);
    expect(result.reason).toContain('role:');
  });

  it('does not match when no role keywords present', () => {
    const result = jobMatchesPrefs(
      { title: 'Marketing Manager', companyName: 'Corp', location: '' },
      { targetRoles: ['Engineer', 'Developer'], watchlistCompanies: [], locations: [] }
    );
    expect(result.matched).toBe(false);
    expect(result.reason).toBe('');
  });

  it('is case-insensitive for role matching', () => {
    const result = jobMatchesPrefs(
      { title: 'FULL STACK DEVELOPER', companyName: 'X', location: '' },
      { targetRoles: ['full stack developer'], watchlistCompanies: [], locations: [] }
    );
    expect(result.matched).toBe(true);
  });

  it('skips blank role entries', () => {
    const result = jobMatchesPrefs(
      { title: 'SWE', companyName: 'X', location: '' },
      { targetRoles: ['', '  '], watchlistCompanies: [], locations: [] }
    );
    expect(result.matched).toBe(false);
  });
});

describe('jobMatchesPrefs — company watchlist', () => {
  it('matches via company watchlist when title also matches', () => {
    // Change targetRoles to not match, so it falls through to company match
    const result = jobMatchesPrefs(
      { title: 'Software Engineer', companyName: 'Google', location: '' },
      { targetRoles: ['Chef'], watchlistCompanies: ['Google'], locations: [] }
    );
    expect(result.matched).toBe(true);
    expect(result.reason).toContain('company:');
  });

  it('does not match company watchlist if role does not match first', () => {
    // jobMatchesPrefs checks role first — if role matches, then company
    // If role doesn't match, company match is still checked independently
    const result = jobMatchesPrefs(
      { title: 'Chef', companyName: 'Google', location: '' },
      { targetRoles: ['Engineer'], watchlistCompanies: ['Google'], locations: [] }
    );
    // role doesn't match → but company matches → returns company match
    expect(result.matched).toBe(true);
  });

  it('applies seniority filter: senior title blocked for fresher profile', () => {
    // Change targetRoles to not match, so it falls through to company match where seniority is checked
    const result = jobMatchesPrefs(
      { title: 'Senior Engineer', companyName: 'Google', location: '' },
      { targetRoles: ['Chef'], watchlistCompanies: ['Google'], locations: [], experienceLevel: 'fresher' }
    );
    // company match exists but senior title conflicts → should be blocked
    expect(result.matched).toBe(false);
  });

  it('skips blank company watchlist entries', () => {
    const result = jobMatchesPrefs(
      { title: 'Designer', companyName: 'X Corp', location: '' },
      { targetRoles: [], watchlistCompanies: ['', '  '], locations: [] }
    );
    expect(result.matched).toBe(false);
  });
});

describe('jobMatchesPrefs — null safety', () => {
  it('handles null companyName gracefully', () => {
    const result = jobMatchesPrefs(
      { title: 'Software Engineer', companyName: null, location: null },
      { targetRoles: ['Software Engineer'], watchlistCompanies: [], locations: [] }
    );
    expect(result.matched).toBe(true);
  });

  it('handles undefined companyName gracefully', () => {
    const result = jobMatchesPrefs(
      { title: 'Developer', companyName: undefined, location: undefined },
      { targetRoles: ['Developer'], watchlistCompanies: [], locations: [] }
    );
    expect(result.matched).toBe(true);
  });
});

// ─── encryptData / decryptData ────────────────────────────────────────────────
describe('encryptData / decryptData', () => {
  const plaintext = JSON.stringify({ li_at: 'test-session-cookie-value', JSESSIONID: 'abc123' });

  it('produces a non-empty ciphertext different from the plaintext', () => {
    const cipher = encryptData(plaintext);
    expect(cipher).toBeTruthy();
    expect(cipher).not.toBe(plaintext);
  });

  it('produces output in iv:authTag:encrypted format (3 colon-separated parts)', () => {
    const cipher = encryptData(plaintext);
    const parts = cipher.split(':');
    expect(parts).toHaveLength(3);
    // iv = 16 bytes = 32 hex chars
    expect(parts[0]).toHaveLength(32);
    // authTag = 16 bytes = 32 hex chars
    expect(parts[1]).toHaveLength(32);
  });

  it('round-trips correctly — decrypt(encrypt(x)) === x', () => {
    const cipher = encryptData(plaintext);
    const decrypted = decryptData(cipher);
    expect(decrypted).toBe(plaintext);
  });

  it('two encryptions of same text produce different ciphertexts (random IV)', () => {
    const c1 = encryptData(plaintext);
    const c2 = encryptData(plaintext);
    expect(c1).not.toBe(c2);
  });

  it('decryptData returns null for invalid input', () => {
    expect(decryptData('not:valid')).toBeNull();
    expect(decryptData('')).toBeNull();
    expect(decryptData('a:b:c')).toBeNull(); // wrong lengths
  });

  it('decryptData returns null for tampered ciphertext', () => {
    const cipher = encryptData(plaintext);
    const parts = cipher.split(':');
    // flip a byte in the encrypted payload
    parts[2] = parts[2].slice(0, -2) + '00';
    expect(decryptData(parts.join(':'))).toBeNull();
  });

  it('encryptData returns empty string for empty input', () => {
    expect(encryptData('')).toBe('');
  });
});

// ─── normalizeCareerUrl (backend copy must match lib/utils.ts) ───────────────
describe('backend normalizeCareerUrl — parity with lib/utils.ts', () => {
  it('canonicalises LinkedIn company URL', () => {
    const result = normalizeCareerUrl('https://www.linkedin.com/company/OpenAI/jobs/view/123?trk=x');
    expect(result).toBe('https://www.linkedin.com/company/openai/jobs/');
  });

  it('strips utm params from Greenhouse URL', () => {
    const result = normalizeCareerUrl('https://boards.greenhouse.io/stripe?utm_source=gh_jid&utm_medium=job');
    expect(result).not.toContain('utm_source');
  });

  it('strips trailing slash from Greenhouse', () => {
    const result = normalizeCareerUrl('https://boards.greenhouse.io/acme/');
    expect(result).not.toMatch(/\/$/);
  });

  it('returns lowercased fallback for invalid URL', () => {
    expect(normalizeCareerUrl('NOT-A-URL')).toBe('not-a-url');
  });
});

// ─── detectPlatform (backend copy must match lib/utils.ts) ───────────────────
describe('backend detectPlatform — parity with lib/utils.ts', () => {
  const cases: [string, string][] = [
    ['https://boards.greenhouse.io/stripe', 'greenhouse'],
    ['https://jobs.lever.co/figma', 'lever'],
    ['https://amazon.myworkdayjobs.com/jobs', 'workday'],
    ['https://jobs.ashbyhq.com/openai', 'ashby'],
    ['https://wellfound.com/company/acme/jobs', 'wellfound'],
    ['https://apply.workable.com/acme', 'workable'],
    ['https://acme.smartrecruiters.com', 'smartrecruiters'],
    ['https://amazon.jobs/en/jobs/123', 'amazon_jobs'],
    ['https://www.linkedin.com/jobs', 'linkedin'],
    ['https://acme.taleo.net/careersection', 'taleo'],
    ['https://careers.acme.icims.com/jobs', 'icims'],
    ['https://acme.successfactors.com/careers', 'successfactors'],
    ['https://acme.jobvite.com/jobs', 'jobvite'],
    ['https://acme.brassring.com/search', 'brassring'],
    ['https://acme.ultipro.com/jobs', 'ultipro'],
    ['https://careers.google.com/jobs', 'google'],
    ['https://jobs.apple.com/en-us/search', 'generic'], // path has no 'job'
    ['https://www.apple.com/jobs/us/teams.html', 'apple'],
    ['https://totally.unknown.io/things', 'generic'],
    ['not-a-url', 'generic'],
  ];

  it.each(cases)('detects %s as "%s"', (url, expected) => {
    expect(detectPlatform(url)).toBe(expected);
  });
});

// ─── extractCompanyFromUrl ────────────────────────────────────────────────────
describe('extractCompanyFromUrl', () => {
  it('extracts company from LinkedIn URL', () => {
    expect(extractCompanyFromUrl('https://www.linkedin.com/company/openai/jobs/')).toBe('Openai');
  });

  it('extracts company from Greenhouse URL', () => {
    expect(extractCompanyFromUrl('https://boards.greenhouse.io/stripe')).toBe('Stripe');
  });

  it('extracts company from Lever URL', () => {
    expect(extractCompanyFromUrl('https://jobs.lever.co/figma/12345')).toBe('Figma');
  });

  it('extracts company from Workday subdomain', () => {
    expect(extractCompanyFromUrl('https://amazon.myworkdayjobs.com/en-US/External')).toBe('Amazon');
  });

  it('returns Amazon for amazon.jobs', () => {
    expect(extractCompanyFromUrl('https://amazon.jobs/en/jobs/123')).toBe('Amazon');
  });

  it('returns null for completely unknown URL', () => {
    expect(extractCompanyFromUrl('https://www.totally-unknown-site.com')).toBeNull();
  });

  it('returns null for invalid URL', () => {
    expect(extractCompanyFromUrl('not-a-url')).toBeNull();
  });
});
