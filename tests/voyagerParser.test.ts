import { describe, it, expect } from 'vitest';
import { parseVoyagerResponse } from '../lib/voyagerParser';

const NOW = Date.now();

// ─── helpers ────────────────────────────────────────────────────────────────
const SLUG = 'openai';
const NAME = 'OpenAI';
const LOGO = 'https://cdn.logo/openai.png';

// Structure A element
function makeStructureA(id: string, title: string, location = 'Remote', listedAt = NOW) {
  return {
    jobCardUnion: {
      jobPostingCard: {
        jobPostingId: id,
        title,
        secondaryDescription: { text: location },
        listedAt,
      },
    },
  };
}

// Structure C element
function makeStructureC(id: string, title: string, location = 'New York', listedAt = NOW) {
  return { id, title, formattedLocation: location, listedAt };
}

// ─── Structure A ─────────────────────────────────────────────────────────────
describe('parseVoyagerResponse — Structure A (elements[].jobCardUnion)', () => {
  it('parses a valid Structure A response', () => {
    const raw = {
      elements: [makeStructureA('111', 'ML Engineer'), makeStructureA('222', 'Backend Engineer', 'NYC')],
    };
    const result = parseVoyagerResponse(raw, SLUG, NAME, LOGO);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('111');
    expect(result[0].role).toBe('ML Engineer');
    expect(result[0].company).toBe(NAME);
    expect(result[0].companySlug).toBe(SLUG);
    expect(result[0].applyUrl).toBe('https://www.linkedin.com/jobs/view/111/');
  });

  it('skips entries with missing id or title', () => {
    const raw = {
      elements: [
        makeStructureA('', 'No ID job'),
        makeStructureA('333', ''),
        makeStructureA('444', 'Valid Job'),
      ],
    };
    const result = parseVoyagerResponse(raw, SLUG, NAME, LOGO);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('444');
  });

  it('deduplicates by job id within same response', () => {
    const raw = {
      elements: [makeStructureA('555', 'Engineer'), makeStructureA('555', 'Engineer Duplicate')],
    };
    const result = parseVoyagerResponse(raw, SLUG, NAME, LOGO);
    expect(result).toHaveLength(1);
  });
});

// ─── Structure B ─────────────────────────────────────────────────────────────
describe('parseVoyagerResponse — Structure B (data.elements)', () => {
  it('parses a valid Structure B response', () => {
    const raw = {
      data: {
        elements: [makeStructureA('701', 'Data Scientist', 'London')],
      },
    };
    const result = parseVoyagerResponse(raw, SLUG, NAME, LOGO);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('701');
    expect(result[0].location).toBe('London');
  });
});

// ─── Structure C ─────────────────────────────────────────────────────────────
describe('parseVoyagerResponse — Structure C (flat elements with id+title)', () => {
  it('parses a flat elements list', () => {
    const raw = {
      elements: [makeStructureC('801', 'Product Manager', 'San Francisco')],
    };
    const result = parseVoyagerResponse(raw, SLUG, NAME, LOGO);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('Product Manager');
    expect(result[0].location).toBe('San Francisco');
  });
});

// ─── Structure D ─────────────────────────────────────────────────────────────
describe('parseVoyagerResponse — Structure D (included[].JobPosting)', () => {
  it('parses an included[] response with entityUrn', () => {
    const raw = {
      included: [
        {
          $type: 'com.linkedin.voyager.jobs.JobPosting',
          entityUrn: 'urn:li:jobPosting:9001',
          title: 'DevOps Lead',
          formattedLocation: 'Seattle, WA',
          listedAt: NOW,
        },
      ],
    };
    const result = parseVoyagerResponse(raw, SLUG, NAME, LOGO);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('9001');
    expect(result[0].role).toBe('DevOps Lead');
  });

  it('skips included entries without a numeric entityUrn match', () => {
    const raw = {
      included: [
        {
          $type: 'com.linkedin.voyager.jobs.JobPosting',
          entityUrn: 'urn:li:something:notAnId',
          title: 'Ghost Job',
        },
      ],
    };
    const result = parseVoyagerResponse(raw, SLUG, NAME, LOGO);
    expect(result).toHaveLength(0);
  });
});

// ─── Structure E ─────────────────────────────────────────────────────────────
describe('parseVoyagerResponse — Structure E (jobs[] guest response)', () => {
  it('parses a jobs[] guest format', () => {
    const raw = {
      jobs: [
        { id: '5001', title: 'Security Engineer', location: 'Remote', listedAt: NOW },
        { id: '5002', title: 'Cloud Architect', location: 'Berlin', listedAt: NOW },
      ],
    };
    const result = parseVoyagerResponse(raw, SLUG, NAME, LOGO);
    expect(result.length).toBeGreaterThanOrEqual(2);
    const titles = result.map(r => r.role);
    expect(titles).toContain('Security Engineer');
    expect(titles).toContain('Cloud Architect');
  });

  it('skips guest entries missing id or title', () => {
    const raw = {
      jobs: [
        { id: '', title: 'No ID', location: 'X' },
        { id: '5003', title: '', location: 'Y' },
        { id: '5004', title: 'Valid', location: 'Z' },
      ],
    };
    const result = parseVoyagerResponse(raw, SLUG, NAME, LOGO);
    expect(result.some(r => r.id === '5004')).toBe(true);
  });
});

// ─── postedAt formatting ──────────────────────────────────────────────────────
describe('parseVoyagerResponse — postedAt formatting', () => {
  it('shows "Just now" for jobs listed < 60s ago', () => {
    const raw = { elements: [makeStructureA('1', 'Engineer', 'Remote', NOW - 5000)] };
    const [job] = parseVoyagerResponse(raw, SLUG, NAME, LOGO);
    expect(job.postedAt).toBe('Just now');
  });

  it('shows minutes for jobs listed < 1h ago', () => {
    const raw = { elements: [makeStructureA('2', 'Engineer', 'Remote', NOW - 30 * 60 * 1000)] };
    const [job] = parseVoyagerResponse(raw, SLUG, NAME, LOGO);
    expect(job.postedAt).toMatch(/^\d+m ago$/);
  });

  it('shows hours for jobs listed < 24h ago', () => {
    const raw = { elements: [makeStructureA('3', 'Engineer', 'Remote', NOW - 3 * 3600 * 1000)] };
    const [job] = parseVoyagerResponse(raw, SLUG, NAME, LOGO);
    expect(job.postedAt).toMatch(/^\d+h ago$/);
  });

  it('shows days for jobs listed < 7d ago', () => {
    const raw = { elements: [makeStructureA('4', 'Engineer', 'Remote', NOW - 3 * 86400 * 1000)] };
    const [job] = parseVoyagerResponse(raw, SLUG, NAME, LOGO);
    expect(job.postedAt).toMatch(/^\d+d ago$/);
  });

  it('shows weeks for jobs listed >= 7d ago', () => {
    const raw = { elements: [makeStructureA('5', 'Engineer', 'Remote', NOW - 14 * 86400 * 1000)] };
    const [job] = parseVoyagerResponse(raw, SLUG, NAME, LOGO);
    expect(job.postedAt).toMatch(/^\d+w ago$/);
  });
});

// ─── edge cases ───────────────────────────────────────────────────────────────
describe('parseVoyagerResponse — edge cases', () => {
  it('returns [] for null input', () => {
    expect(parseVoyagerResponse(null, SLUG, NAME, LOGO)).toEqual([]);
  });

  it('returns [] for empty object', () => {
    expect(parseVoyagerResponse({}, SLUG, NAME, LOGO)).toEqual([]);
  });

  it('returns [] for non-object input', () => {
    expect(parseVoyagerResponse(42, SLUG, NAME, LOGO)).toEqual([]);
  });

  it('does not throw for malformed elements array', () => {
    const raw = { elements: [null, undefined, {}, 'bad'] };
    expect(() => parseVoyagerResponse(raw, SLUG, NAME, LOGO)).not.toThrow();
  });
});
