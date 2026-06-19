import { describe, it, expect } from 'vitest';
import { calculateMatchScore, isCrossPlatformDuplicate } from '../lib/matchScoring';

// ─────────────────────────────────────────────────────────
// calculateMatchScore
// ─────────────────────────────────────────────────────────
describe('calculateMatchScore — role matching', () => {
  it('exact role match scores 50 pts', () => {
    const r = calculateMatchScore(
      { title: 'software engineer', companyName: 'ACME', location: 'Remote' },
      { targetRoles: ['software engineer'], watchlistCompanies: [], locations: [] }
    );
    expect(r.score).toBe(50);
    expect(r.breakdown.roleMatch.matched).toBe(true);
  });

  it('partial role match (includes) scores 40 pts', () => {
    const r = calculateMatchScore(
      { title: 'Senior Software Engineer', companyName: 'X', location: '' },
      { targetRoles: ['Software Engineer'], watchlistCompanies: [], locations: [] }
    );
    expect(r.score).toBe(40);
  });

  it('zero score when no role keywords match', () => {
    const r = calculateMatchScore(
      { title: 'Sales Manager', companyName: 'Corp', location: 'NYC' },
      { targetRoles: ['Software Engineer'], watchlistCompanies: [], locations: [] }
    );
    expect(r.score).toBe(0);
    expect(r.breakdown.roleMatch.matched).toBe(false);
  });

  it('returns score 0 immediately if role not matched — watchlist irrelevant', () => {
    const r = calculateMatchScore(
      { title: 'Cook', companyName: 'Google', location: '' },
      { targetRoles: ['Engineer'], watchlistCompanies: ['Google'], locations: [] }
    );
    expect(r.score).toBe(0);
  });
});

describe('calculateMatchScore — company watchlist', () => {
  it('zero if watchlist set but company does not match', () => {
    const r = calculateMatchScore(
      { title: 'Software Engineer', companyName: 'Unknown Startup', location: 'Remote' },
      { targetRoles: ['Software Engineer'], watchlistCompanies: ['Google', 'Amazon'], locations: [] }
    );
    expect(r.score).toBe(0);
    expect(r.breakdown.companyMatch.matched).toBe(false);
  });

  it('company match adds 25 pts when watchlist matches', () => {
    const r = calculateMatchScore(
      { title: 'Software Engineer', companyName: 'Google Inc', location: '' },
      { targetRoles: ['Software Engineer'], watchlistCompanies: ['Google'], locations: [] }
    );
    expect(r.breakdown.companyMatch.matched).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(40 + 25);
  });

  it('empty watchlist does not require company match', () => {
    const r = calculateMatchScore(
      { title: 'Software Engineer', companyName: 'Random Corp', location: '' },
      { targetRoles: ['Software Engineer'], watchlistCompanies: [], locations: [] }
    );
    expect(r.score).toBeGreaterThan(0);
  });
});

describe('calculateMatchScore — location', () => {
  it('zero if location set and not matching', () => {
    const r = calculateMatchScore(
      { title: 'Software Engineer', companyName: 'Google', location: 'New York, NY' },
      { targetRoles: ['Software Engineer'], watchlistCompanies: [], locations: ['San Francisco, CA', 'Remote'] }
    );
    expect(r.score).toBe(0);
    expect(r.breakdown.locationMatch.matched).toBe(false);
  });

  it('remote job matches "Remote" preference', () => {
    const r = calculateMatchScore(
      { title: 'Software Engineer', companyName: 'X', location: 'Remote' },
      { targetRoles: ['Software Engineer'], watchlistCompanies: [], locations: ['Remote'] }
    );
    expect(r.breakdown.locationMatch.matched).toBe(true);
    expect(r.score).toBeGreaterThan(0);
  });

  it('"Anywhere" preference accepts all job locations', () => {
    const r = calculateMatchScore(
      { title: 'Software Engineer', companyName: 'X', location: 'Tokyo, Japan' },
      { targetRoles: ['Software Engineer'], watchlistCompanies: [], locations: ['Anywhere'] }
    );
    expect(r.breakdown.locationMatch.matched).toBe(true);
  });

  it('empty locations array skips location gate', () => {
    const r = calculateMatchScore(
      { title: 'Software Engineer', companyName: 'X', location: 'Mars' },
      { targetRoles: ['Software Engineer'], watchlistCompanies: [], locations: [] }
    );
    expect(r.score).toBeGreaterThan(0);
  });
});

describe('calculateMatchScore — seniority', () => {
  it('senior role + 7+ experience adds 5 pt bonus over non-senior role', () => {
    // Both use partial (includes) match = 40 pts base
    // Senior role gets +5 seniority bonus
    const nonSenior = calculateMatchScore(
      { title: 'Software Engineer II', companyName: 'X', location: '' },
      { targetRoles: ['Software Engineer'], watchlistCompanies: [], locations: [], experienceLevel: '7+' }
    );
    const senior = calculateMatchScore(
      { title: 'Senior Software Engineer', companyName: 'X', location: '' },
      { targetRoles: ['Software Engineer'], watchlistCompanies: [], locations: [], experienceLevel: '7+' }
    );
    expect(senior.score).toBeGreaterThan(nonSenior.score);
    expect(senior.breakdown.seniorityMatch.matched).toBe(true);
  });

  it('senior role penalised for fresher/1-3 yrs profile', () => {
    const r = calculateMatchScore(
      { title: 'Senior Software Engineer', companyName: 'X', location: '' },
      { targetRoles: ['Software Engineer'], watchlistCompanies: [], locations: [], experienceLevel: 'fresher' }
    );
    expect(r.breakdown.seniorityMatch.matched).toBe(false);
    expect(r.breakdown.seniorityMatch.note).toBe('Overqualified role');
  });
});

// ─────────────────────────────────────────────────────────
// isCrossPlatformDuplicate
// ─────────────────────────────────────────────────────────
describe('isCrossPlatformDuplicate', () => {
  const base = { firstSeenAt: Date.now() } as any;

  it('detects duplicate when title and company fuzzy-match', () => {
    const newJob = { ...base, title: 'Backend Dev', companyName: 'Stripe' };
    const existing = [{ ...base, title: 'Backend Developer', companyName: 'Stripe Inc.' }];
    expect(isCrossPlatformDuplicate(newJob, existing)).toBe(true);
  });

  it('no duplicate if companies differ', () => {
    const newJob = { ...base, title: 'Backend Dev', companyName: 'Stripe' };
    const existing = [{ ...base, title: 'Backend Developer', companyName: 'Square' }];
    expect(isCrossPlatformDuplicate(newJob, existing)).toBe(false);
  });

  it('no duplicate if titles are completely different', () => {
    const newJob = { ...base, title: 'Product Manager', companyName: 'Stripe' };
    const existing = [{ ...base, title: 'Software Engineer', companyName: 'Stripe' }];
    expect(isCrossPlatformDuplicate(newJob, existing)).toBe(false);
  });

  it('ignores jobs older than 7 days', () => {
    const oldJob = { title: 'Backend Dev', companyName: 'Stripe', firstSeenAt: Date.now() - 8 * 86400000 } as any;
    const newJob = { ...base, title: 'Backend Dev', companyName: 'Stripe' };
    expect(isCrossPlatformDuplicate(newJob, [oldJob])).toBe(false);
  });

  it('no duplicate for empty existing list', () => {
    const newJob = { ...base, title: 'Engineer', companyName: 'X' };
    expect(isCrossPlatformDuplicate(newJob, [])).toBe(false);
  });
});
