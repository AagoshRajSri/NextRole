import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseRobotsContent,
  isMalformedRobotsTxt,
  clearRobotsCache,
  isPathAllowed,
  BOT_USER_AGENT,
} from '../jobtracker-backend/lib/robotsChecker';

describe('robotsChecker — parseRobotsContent Unit Tests', () => {
  beforeEach(() => {
    clearRobotsCache();
  });

  it('allows access to an allowed path when robots.txt rules permit it', () => {
    const robotsTxt = `
      User-agent: *
      Disallow: /admin/
      Disallow: /private/
      Allow: /public/
    `;

    const parsed = parseRobotsContent('https://example.com/robots.txt', robotsTxt, 200);
    expect(parsed.isMalformed).toBe(false);
    expect(parsed.isAllowed('https://example.com/public/jobs', BOT_USER_AGENT)).toBe(true);
  });

  it('disallows access to a disallowed path when specified for bot or wildcard', () => {
    const robotsTxt = `
      User-agent: NextRole-Bot/1.0
      Disallow: /careers/secret

      User-agent: *
      Disallow: /private/
    `;

    const parsed = parseRobotsContent('https://example.com/robots.txt', robotsTxt, 200);
    expect(parsed.isMalformed).toBe(false);
    expect(parsed.isAllowed('https://example.com/careers/secret', BOT_USER_AGENT)).toBe(false);
    expect(parsed.isAllowed('https://example.com/private/job-1', BOT_USER_AGENT)).toBe(false);
  });

  it('defaults to allowed when robots.txt returns 404 Not Found', () => {
    const parsed = parseRobotsContent('https://example.com/robots.txt', null, 404);
    expect(parsed.isNotFound).toBe(true);
    expect(parsed.isMalformed).toBe(false);
    expect(parsed.isAllowed('https://example.com/careers/openings', BOT_USER_AGENT)).toBe(true);
  });

  it('fails safe (disallows access) when robots.txt is malformed HTML', () => {
    const malformedHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>500 Internal Server Error</title></head>
        <body>Something went wrong</body>
      </html>
    `;

    expect(isMalformedRobotsTxt(malformedHtml)).toBe(true);

    const parsed = parseRobotsContent('https://example.com/robots.txt', malformedHtml, 200);
    expect(parsed.isMalformed).toBe(true);
    // Fail safe requirement: treat as disallowed
    expect(parsed.isAllowed('https://example.com/careers', BOT_USER_AGENT)).toBe(false);
  });

  it('fails safe (disallows access) when robots.txt contains garbage syntax', () => {
    const garbageTxt = `
      This is random text with no colons or directives.
      Just arbitrary non-robots content.
    `;

    expect(isMalformedRobotsTxt(garbageTxt)).toBe(true);

    const parsed = parseRobotsContent('https://example.com/robots.txt', garbageTxt, 200);
    expect(parsed.isMalformed).toBe(true);
    expect(parsed.isAllowed('https://example.com/careers', BOT_USER_AGENT)).toBe(false);
  });
});
