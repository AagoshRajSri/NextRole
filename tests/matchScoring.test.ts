import { describe, it, expect } from 'vitest';
import { calculateMatchScore, isCrossPlatformDuplicate } from '../lib/matchScoring';

describe('Match Scoring Engine', () => {
  it('should score a job correctly based on role match', () => {
    const job = { title: 'Senior Software Engineer', companyName: 'Google', location: 'Remote' };
    const profile = {
      targetRoles: ['Software Engineer'],
      watchlistCompanies: [],
      locations: [],
    };
    const result = calculateMatchScore(job, profile);
    expect(result.score).toBeGreaterThan(0);
    expect(result.breakdown.roleMatch.matched).toBe(true);
  });

  it('should drop jobs that do not match watchlist companies if watchlist is provided', () => {
    const job = { title: 'Software Engineer', companyName: 'Unknown Startup', location: 'Remote' };
    const profile = {
      targetRoles: ['Software Engineer'],
      watchlistCompanies: ['Google', 'Amazon'],
      locations: [],
    };
    const result = calculateMatchScore(job, profile);
    expect(result.score).toBe(0);
    expect(result.breakdown.companyMatch.matched).toBe(false);
  });

  it('should drop jobs that do not match locations if locations are provided', () => {
    const job = { title: 'Software Engineer', companyName: 'Google', location: 'New York, NY' };
    const profile = {
      targetRoles: ['Software Engineer'],
      watchlistCompanies: [],
      locations: ['San Francisco, CA', 'Remote'],
    };
    const result = calculateMatchScore(job, profile);
    expect(result.score).toBe(0);
    expect(result.breakdown.locationMatch.matched).toBe(false);
  });
});

describe('Cross-Platform Deduplication', () => {
  it('should identify a duplicate job based on fuzzy title and company', () => {
    const newJob: any = { title: 'Backend Dev', companyName: 'Stripe', firstSeenAt: Date.now() };
    const existingJobs: any[] = [
      { title: 'Backend Developer', companyName: 'Stripe Inc.', firstSeenAt: Date.now() }
    ];
    expect(isCrossPlatformDuplicate(newJob, existingJobs)).toBe(true);
  });

  it('should not identify a duplicate if company differs', () => {
    const newJob: any = { title: 'Backend Dev', companyName: 'Stripe', firstSeenAt: Date.now() };
    const existingJobs: any[] = [
      { title: 'Backend Developer', companyName: 'Square', firstSeenAt: Date.now() }
    ];
    expect(isCrossPlatformDuplicate(newJob, existingJobs)).toBe(false);
  });
});
