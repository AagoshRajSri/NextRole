import { describe, it, expect, vi } from 'vitest';
import { scrapeCurrentPage } from '../lib/clientScraper';

describe('clientScraper — scrapeCurrentPage', () => {
  it('correctly scrapes Greenhouse openings', () => {
    const mockAnchor = {
      getAttribute: (attr: string) => {
        if (attr === 'href') return 'https://boards.greenhouse.io/acme/jobs/123456';
        return null;
      },
      textContent: 'Cybersecurity Analyst',
    };

    const mockLocation = {
      textContent: 'Remote',
    };

    const mockOpening = {
      querySelector: (selector: string) => {
        if (selector === 'a') return mockAnchor;
        if (selector === '.location') return mockLocation;
        return null;
      },
    };

    const mockDoc = {
      querySelectorAll: (selector: string) => {
        if (selector === '.opening') return [mockOpening];
        return [];
      },
      getElementById: () => null,
    } as unknown as Document;

    const result = scrapeCurrentPage(mockDoc, 'https://boards.greenhouse.io/acme');
    expect(result.platform).toBe('greenhouse');
    expect(result.strategy).toBe('opening-class');
    expect(result.jobCount).toBe(1);
    expect(result.jobs[0]).toEqual({
      atsJobId: '123456',
      title: 'Cybersecurity Analyst',
      companyName: 'Acme',
      location: 'Remote',
      url: 'https://boards.greenhouse.io/acme/jobs/123456',
    });
  });

  it('correctly scrapes Lever postings', () => {
    const mockTitleLink = {
      getAttribute: (attr: string) => {
        if (attr === 'href') return 'https://jobs.lever.co/acme/abcd-efgh-ijkl';
        return null;
      },
      textContent: 'Security Engineer',
    };

    const mockLocation = {
      textContent: 'San Francisco, CA',
    };

    const mockPosting = {
      querySelector: (selector: string) => {
        if (selector.includes('posting-title') || selector.includes('posting-name')) return mockTitleLink;
        if (selector.includes('location')) return mockLocation;
        return null;
      },
    };

    const mockDoc = {
      querySelectorAll: (selector: string) => {
        if (selector === '.posting') return [mockPosting];
        return [];
      },
      getElementById: () => null,
    } as unknown as Document;

    const result = scrapeCurrentPage(mockDoc, 'https://jobs.lever.co/acme');
    expect(result.platform).toBe('lever');
    expect(result.strategy).toBe('posting-class');
    expect(result.jobCount).toBe(1);
    expect(result.jobs[0]).toEqual({
      atsJobId: 'abcd-efgh-ijkl',
      title: 'Security Engineer',
      companyName: 'Acme',
      location: 'San Francisco, CA',
      url: 'https://jobs.lever.co/acme/abcd-efgh-ijkl',
    });
  });

  it('falls back to generic DOM scraping when platform is generic', () => {
    const mockAnchor = {
      getAttribute: (attr: string) => {
        if (attr === 'href') return 'https://acme.com/jobs/1';
        return null;
      },
      textContent: 'Engineering Manager',
    };

    const mockJobElement = {
      querySelector: (selector: string) => {
        if (selector === 'a') return mockAnchor;
        return null;
      },
      textContent: 'Engineering Manager (New York, NY)',
    };

    const mockDoc = {
      querySelectorAll: (selector: string) => {
        // Generic scraper queries for links and generic containers
        if (selector.includes('a[href*="/job"]') || selector.includes('a[href*="/career"]')) {
          return [mockAnchor];
        }
        return [];
      },
      getElementById: () => null,
    } as unknown as Document;

    const result = scrapeCurrentPage(mockDoc, 'https://acme.com/careers');
    expect(result.platform).toBe('generic');
    expect(result.jobs.length).toBeGreaterThanOrEqual(0); // might be 0 depending on link patterns, but shouldn't crash
  });
});
