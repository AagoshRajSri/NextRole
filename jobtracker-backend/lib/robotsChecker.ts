import robotsParserModule from 'robots-parser';
const robotsParser: any = (robotsParserModule as any).default || robotsParserModule;
import pino from 'pino';

const logger = pino({ name: 'robots-checker' });

export const BOT_USER_AGENT = 'NextRole-Bot/1.0';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry {
  parser: any;
  isMalformed: boolean;
  isNotFound: boolean;
  cachedAt: number;
}

const robotsCache = new Map<string, CacheEntry>();

/**
 * Clear the in-memory robots.txt cache (primarily for unit tests).
 */
export function clearRobotsCache(): void {
  robotsCache.clear();
}

/**
 * Detect if a robots.txt body is malformed (e.g. HTML error page or invalid syntax).
 */
export function isMalformedRobotsTxt(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;

  // HTML content served instead of plain text robots.txt
  if (
    trimmed.toLowerCase().startsWith('<!doctype html') ||
    trimmed.toLowerCase().startsWith('<html') ||
    trimmed.toLowerCase().startsWith('<head') ||
    trimmed.toLowerCase().startsWith('<body')
  ) {
    return true;
  }

  // Check if content has valid directives or comments
  const lines = trimmed.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (lines.length === 0) return false;

  // Valid lines should contain a colon (Directive: Value)
  const validDirectivePattern = /^[a-zA-Z0-9_-]+\s*:/;
  const hasValidDirectives = lines.some(l => validDirectivePattern.test(l));

  return !hasValidDirectives;
}

/**
 * Parse robots.txt string content into an evaluator object.
 */
export function parseRobotsContent(
  robotsUrl: string,
  content: string | null,
  statusCode: number = 200,
) {
  // 404/410 Not Found -> Default to allowed
  if (statusCode === 404 || statusCode === 410 || content === null) {
    return {
      isAllowed: (_url: string, _ua?: string) => true,
      isMalformed: false,
      isNotFound: true,
    };
  }

  const malformed = isMalformedRobotsTxt(content);
  if (malformed) {
    // Fail safe: Malformed robots.txt treats paths as disallowed
    return {
      isAllowed: (_url: string, _ua?: string) => false,
      isMalformed: true,
      isNotFound: false,
    };
  }

  try {
    const parser = robotsParser(robotsUrl, content);
    return {
      isAllowed: (targetUrl: string, ua: string = BOT_USER_AGENT) => {
        const resUa = parser.isAllowed(targetUrl, ua);
        const resWildcard = parser.isAllowed(targetUrl, '*');

        if (resUa === false || resWildcard === false) return false;
        if (resUa === true || resWildcard === true) return true;
        return true;
      },
      isMalformed: false,
      isNotFound: false,
    };
  } catch {
    // Fail safe on parser exception
    return {
      isAllowed: (_url: string, _ua?: string) => false,
      isMalformed: true,
      isNotFound: false,
    };
  }
}

/**
 * Fetch robots.txt from a domain origin.
 */
export async function fetchRobotsTxt(origin: string): Promise<{ content: string | null; statusCode: number }> {
  const robotsUrl = `${origin}/robots.txt`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(robotsUrl, {
      headers: { 'User-Agent': BOT_USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.status === 404 || res.status === 410) {
      return { content: null, statusCode: res.status };
    }

    if (!res.ok) {
      return { content: null, statusCode: res.status };
    }

    const text = await res.text();
    return { content: text, statusCode: res.status };
  } catch {
    // On fetch error / network failure, return null content
    return { content: null, statusCode: 500 };
  }
}

/**
 * Check whether a target URL path is allowed according to the domain's robots.txt.
 * Uses 24-hour in-memory domain caching.
 */
export async function isPathAllowed(
  targetUrl: string,
  ua: string = BOT_USER_AGENT,
): Promise<{ allowed: boolean; reason?: string }> {
  try {
    const u = new URL(targetUrl);
    const origin = u.origin;
    const robotsUrl = `${origin}/robots.txt`;

    const cached = robotsCache.get(origin);
    const now = Date.now();

    let entry: CacheEntry;

    if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
      entry = cached;
    } else {
      const { content, statusCode } = await fetchRobotsTxt(origin);
      const parsed = parseRobotsContent(robotsUrl, content, statusCode);

      entry = {
        parser: parsed,
        isMalformed: parsed.isMalformed,
        isNotFound: parsed.isNotFound,
        cachedAt: now,
      };
      robotsCache.set(origin, entry);
    }

    if (entry.isMalformed) {
      logger.warn({ domain: u.hostname, path: u.pathname }, 'robots.txt is malformed — failing safe (disallowing)');
      return { allowed: false, reason: 'malformed-robots-txt' };
    }

    const allowed = entry.parser.isAllowed(targetUrl, ua);
    if (!allowed) {
      logger.warn({ domain: u.hostname, path: u.pathname }, 'robots.txt disallows scraping this path');
      return { allowed: false, reason: 'disallowed' };
    }

    return { allowed: true };
  } catch (err: any) {
    logger.warn({ url: targetUrl, error: err.message }, 'Error checking robots.txt — disallowing as fail safe');
    return { allowed: false, reason: 'error' };
  }
}
