import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';

chromium.use(stealth());

export interface ScrapedJob {
  id: string;
  title: string;
  location: string;
  url: string;
  company?: string;
}

// Rotating user agents for anti-bot evasion
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
];

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function jitter(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min)) + min;
}

export async function scrapeJobs(targetUrl: string): Promise<ScrapedJob[]> {
  console.log(`[Scraper] Launching Playwright: ${targetUrl}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const context = await browser.newContext({ userAgent: randomUA() });
    const page = await context.newPage();

    await page.waitForTimeout(jitter(300, 800));
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(jitter(500, 1500));

    const url = targetUrl.toLowerCase();
    let jobs: ScrapedJob[] = [];

    if (url.includes('boards.greenhouse.io') || url.includes('greenhouse.io')) {
      jobs = await parseGreenhouse(page);
    } else if (url.includes('jobs.lever.co') || url.includes('lever.co')) {
      jobs = await parseLever(page);
    } else if (url.includes('myworkdayjobs.com') || url.includes('workday.com')) {
      jobs = await parseWorkday(page);
    } else if (url.includes('linkedin.com')) {
      jobs = await parseLinkedIn(page);
    } else if (url.includes('amazon.jobs')) {
      jobs = await parseAmazon(page);
    } else if (url.includes('naukri.com')) {
      jobs = await parseNaukri(page);
    } else {
      // Auto-detect by DOM structure, then generic fallback
      console.log('[Scraper] Unknown platform, auto-detecting...');
      const ghCount = await page.locator('.opening').count();
      const lvCount = await page.locator('.posting').count();

      if (ghCount > 0) {
        jobs = await parseGreenhouse(page);
      } else if (lvCount > 0) {
        jobs = await parseLever(page);
      } else {
        jobs = await parseGeneric(page);
      }
    }

    console.log(`[Scraper] Scraped ${jobs.length} jobs from ${targetUrl}`);
    return jobs;
  } catch (err) {
    console.error(`[Scraper] Error scraping ${targetUrl}:`, err);
    throw err;
  } finally {
    await browser.close();
  }
}

// ════════════════════════════════════════════════════════
// GREENHOUSE
// ════════════════════════════════════════════════════════
async function parseGreenhouse(page: any): Promise<ScrapedJob[]> {
  try {
    await page.waitForSelector('.opening', { timeout: 10000 });
  } catch {
    console.log('[Scraper] No .opening elements found (Greenhouse).');
    return [];
  }

  return page.evaluate(() => {
    const results: any[] = [];
    document.querySelectorAll('.opening').forEach((el: any) => {
      const link = el.querySelector('a');
      const loc = el.querySelector('.location');
      if (link) {
        const href = link.getAttribute('href') || '';
        const title = link.innerText.trim();
        const location = loc ? loc.innerText.trim() : 'Remote / Unspecified';
        const absUrl = href.startsWith('http') ? href : new URL(href, window.location.href).href;
        const match = absUrl.match(/\/jobs\/(\d+)/);
        const id = match ? match[1] : absUrl.split('/').pop() || String(Math.random());
        results.push({ id, title, location, url: absUrl });
      }
    });
    return results;
  });
}

// ════════════════════════════════════════════════════════
// LEVER
// ════════════════════════════════════════════════════════
async function parseLever(page: any): Promise<ScrapedJob[]> {
  try {
    await page.waitForSelector('.posting', { timeout: 10000 });
  } catch {
    console.log('[Scraper] No .posting elements found (Lever).');
    return [];
  }

  return page.evaluate(() => {
    const results: any[] = [];
    document.querySelectorAll('.posting').forEach((el: any) => {
      const link = el.querySelector('a.posting-title') || el.querySelector('a');
      const titleEl = el.querySelector('h5') || el.querySelector('.posting-title');
      const locEl = el.querySelector('.sort-by-location') || el.querySelector('.posting-category');
      if (link) {
        const url = link.getAttribute('href') || '';
        const title = titleEl ? titleEl.innerText.trim() : link.innerText.trim();
        const location = locEl ? locEl.innerText.trim() : 'Remote / Unspecified';
        const parts = url.split('/');
        const id = parts.pop() || parts.pop() || String(Math.random());
        results.push({ id, title, location, url });
      }
    });
    return results;
  });
}

// ════════════════════════════════════════════════════════
// WORKDAY
// ════════════════════════════════════════════════════════
async function parseWorkday(page: any): Promise<ScrapedJob[]> {
  try {
    await page.waitForSelector('[data-automation-id="jobPostingTitle"]', { timeout: 15000 });
  } catch {
    console.log('[Scraper] No Workday job titles found.');
    return [];
  }

  return page.evaluate(() => {
    const results: any[] = [];
    document.querySelectorAll('[data-automation-id="jobPostingTitle"]').forEach((el: any) => {
      const link = el.closest('a') || el.querySelector('a') || el;
      const card = el.closest('li') || el.closest('[role="listitem"]') || el.parentElement?.parentElement;
      const title = el.innerText.trim();
      const href = link.getAttribute('href') || '';
      const absUrl = href.startsWith('http') ? href : new URL(href, window.location.href).href;

      let location = 'Remote / Unspecified';
      if (card) {
        const locEl = card.querySelector('[data-automation-id="locations"]') || card.querySelector('[data-automation-id="subtitle"]');
        if (locEl) location = locEl.innerText.trim();
      }

      const parts = absUrl.split('/');
      const last = parts.pop() || '';
      const id = last.includes('_') ? last.split('_').pop() || last : last || String(Math.random());
      results.push({ id, title, location, url: absUrl });
    });
    return results;
  });
}

// ════════════════════════════════════════════════════════
// LINKEDIN (public, no login)
// ════════════════════════════════════════════════════════
async function parseLinkedIn(page: any): Promise<ScrapedJob[]> {
  // LinkedIn public company jobs page shows limited results without login
  try {
    await page.waitForTimeout(jitter(2000, 4000)); // Extra wait — LinkedIn is slow
    // Try multiple selectors — LinkedIn changes DOM frequently
    const selectors = [
      '.jobs-search__results-list .job-search-card',
      '.base-card',
      '[data-entity-urn]',
      '.job-result-card',
    ];

    let foundSelector = '';
    for (const sel of selectors) {
      const count = await page.locator(sel).count();
      if (count > 0) {
        foundSelector = sel;
        break;
      }
    }

    if (!foundSelector) {
      console.log('[Scraper] LinkedIn: no job cards found (may require login).');
      return [];
    }

    return page.evaluate((selector: string) => {
      const results: any[] = [];
      document.querySelectorAll(selector).forEach((card: any) => {
        const titleEl = card.querySelector('.job-search-card__title') ||
          card.querySelector('.base-search-card__title') ||
          card.querySelector('h3') ||
          card.querySelector('[class*="title"]');
        const compEl = card.querySelector('.job-search-card__subtitle') ||
          card.querySelector('.base-search-card__subtitle') ||
          card.querySelector('h4');
        const locEl = card.querySelector('.job-search-card__location') ||
          card.querySelector('.job-result-card__location') ||
          card.querySelector('[class*="location"]');
        const linkEl = card.querySelector('a[href*="/jobs/view/"]') ||
          card.querySelector('a');

        if (titleEl && linkEl) {
          const title = titleEl.innerText.trim();
          const company = compEl ? compEl.innerText.trim() : '';
          const location = locEl ? locEl.innerText.trim() : 'Remote / Unspecified';
          const href = linkEl.getAttribute('href') || '';
          const absUrl = href.startsWith('http') ? href : new URL(href, window.location.href).href;

          // Extract LinkedIn job ID from URL: /jobs/view/1234567890/
          const idMatch = absUrl.match(/\/jobs\/view\/(\d+)/);
          const id = idMatch ? idMatch[1] : `li-${results.length}-${Date.now()}`;

          results.push({ id, title, location, url: absUrl, company });
        }
      });
      return results;
    }, foundSelector);
  } catch (err) {
    console.error('[Scraper] LinkedIn parse error:', err);
    return [];
  }
}

// ════════════════════════════════════════════════════════
// AMAZON.JOBS
// ════════════════════════════════════════════════════════
async function parseAmazon(page: any): Promise<ScrapedJob[]> {
  try {
    await page.waitForTimeout(jitter(1000, 2500));

    const selectors = [
      '.job-tile',
      '[data-job-id]',
      '.job-card',
      '.result-card',
    ];

    let foundSelector = '';
    for (const sel of selectors) {
      const count = await page.locator(sel).count();
      if (count > 0) {
        foundSelector = sel;
        break;
      }
    }

    if (!foundSelector) {
      console.log('[Scraper] Amazon.jobs: no job cards found.');
      return [];
    }

    return page.evaluate((selector: string) => {
      const results: any[] = [];
      document.querySelectorAll(selector).forEach((card: any, idx: number) => {
        const titleEl = card.querySelector('.job-title') ||
          card.querySelector('h3') ||
          card.querySelector('[class*="title"]');
        const locEl = card.querySelector('.location-and-id') ||
          card.querySelector('.job-location') ||
          card.querySelector('[class*="location"]');
        const linkEl = card.querySelector('a');
        const jobId = card.getAttribute('data-job-id');

        if (titleEl) {
          const title = titleEl.innerText.trim();
          const location = locEl ? locEl.innerText.trim() : 'Unspecified';
          let url = '';
          if (linkEl) {
            const href = linkEl.getAttribute('href') || '';
            url = href.startsWith('http') ? href : new URL(href, window.location.href).href;
          }
          const id = jobId || `amz-${idx}-${Date.now()}`;
          results.push({ id, title, location, url: url || window.location.href, company: 'Amazon' });
        }
      });
      return results;
    }, foundSelector);
  } catch (err) {
    console.error('[Scraper] Amazon parse error:', err);
    return [];
  }
}

// ════════════════════════════════════════════════════════
// NAUKRI
// ════════════════════════════════════════════════════════
async function parseNaukri(page: any): Promise<ScrapedJob[]> {
  try {
    await page.waitForTimeout(jitter(1000, 2000));

    const selectors = [
      '.jobTuple',
      'article[data-job-id]',
      '.srp-jobtuple-wrapper',
      '.cust-job-tuple',
    ];

    let foundSelector = '';
    for (const sel of selectors) {
      const count = await page.locator(sel).count();
      if (count > 0) {
        foundSelector = sel;
        break;
      }
    }

    if (!foundSelector) {
      console.log('[Scraper] Naukri: no job tuples found.');
      return [];
    }

    return page.evaluate((selector: string) => {
      const results: any[] = [];
      document.querySelectorAll(selector).forEach((card: any, idx: number) => {
        const titleEl = card.querySelector('.title') ||
          card.querySelector('a.title') ||
          card.querySelector('[class*="jobTitle"]') ||
          card.querySelector('h2 a');
        const compEl = card.querySelector('.comp-name') ||
          card.querySelector('.subTitle') ||
          card.querySelector('[class*="companyName"]');
        const locEl = card.querySelector('.loc') ||
          card.querySelector('.locWdth') ||
          card.querySelector('[class*="location"]');
        const jobId = card.getAttribute('data-job-id') || card.getAttribute('data-jobid');

        if (titleEl) {
          const title = titleEl.innerText.trim();
          const company = compEl ? compEl.innerText.trim() : '';
          const location = locEl ? locEl.innerText.trim() : 'India';
          const linkEl = titleEl.closest('a') || titleEl.querySelector('a') || card.querySelector('a');
          let url = '';
          if (linkEl) {
            const href = linkEl.getAttribute('href') || '';
            url = href.startsWith('http') ? href : new URL(href, window.location.href).href;
          }
          const id = jobId || `nk-${idx}-${Date.now()}`;
          results.push({ id, title, location, url: url || window.location.href, company });
        }
      });
      return results;
    }, foundSelector);
  } catch (err) {
    console.error('[Scraper] Naukri parse error:', err);
    return [];
  }
}

// ════════════════════════════════════════════════════════
// GENERIC FALLBACK (improved)
// ════════════════════════════════════════════════════════
async function parseGeneric(page: any): Promise<ScrapedJob[]> {
  return page.evaluate(() => {
    const results: any[] = [];
    const seen = new Set<string>();

    // Strategy 1: Look for list items containing links with job-like hrefs
    const listItems = document.querySelectorAll('li, [role="listitem"], [class*="job"], [class*="card"], [class*="posting"]');
    listItems.forEach((item: any, idx: number) => {
      const anchor = item.querySelector('a');
      if (!anchor) return;

      const href = anchor.getAttribute('href') || '';
      const isJobLink = /\/(job|jobs|careers|opening|position|apply|posting)/i.test(href);
      if (!isJobLink) return;

      // Extract title: first heading or prominent text
      const titleEl = item.querySelector('h1, h2, h3, h4, h5, [class*="title"]') || anchor;
      const title = titleEl.innerText.trim();
      if (title.length < 5 || title.length > 120) return;

      // Extract location
      let location = 'Unspecified';
      const locEl = item.querySelector('[class*="location"], [class*="loc"], [class*="city"]');
      if (locEl) {
        location = locEl.innerText.trim();
      } else {
        // Look for pin emoji or nearby short text
        const spans = item.querySelectorAll('span, div, p');
        for (const sp of spans) {
          const t = (sp as any).innerText.trim();
          if (t !== title && t.length > 2 && t.length < 50 && !t.includes('\n')) {
            const hasLocHint = /📍|location|city|remote|office/i.test(t);
            if (hasLocHint || t.split(',').length <= 3) {
              location = t;
              break;
            }
          }
        }
      }

      const absUrl = href.startsWith('http') ? href : new URL(href, window.location.href).href;
      const dedup = `${title.toLowerCase()}::${absUrl}`;
      if (seen.has(dedup)) return;
      seen.add(dedup);

      // Derive ID from URL
      const urlParts = absUrl.split('/').filter(Boolean);
      const lastPart = urlParts.pop() || '';
      const idMatch = lastPart.match(/(\d+)/) || absUrl.match(/[?&]id=(\d+)/);
      const id = idMatch ? idMatch[1] : `gen-${idx}-${lastPart}`;

      results.push({ id, title, location, url: absUrl });
    });

    // Strategy 2: Fallback to raw anchor scanning if strategy 1 found too few
    if (results.length < 3) {
      document.querySelectorAll('a').forEach((a: any, idx: number) => {
        const href = a.getAttribute('href') || '';
        const text = a.innerText.trim();
        const isJobLink = /\/(job|jobs|career|opening|position|apply)/i.test(href);
        if (!isJobLink || text.length < 5 || text.length > 80) return;

        const absUrl = href.startsWith('http') ? href : new URL(href, window.location.href).href;
        const dedup = `${text.toLowerCase()}::${absUrl}`;
        if (seen.has(dedup)) return;
        seen.add(dedup);

        let location = 'Unspecified';
        const parent = a.parentElement;
        if (parent) {
          const sibling = parent.innerText.replace(text, '').trim().split('\n')[0]?.trim();
          if (sibling && sibling.length < 50) location = sibling;
        }

        results.push({
          id: `gen-${idx}-${absUrl.split('/').pop()}`,
          title: text,
          location,
          url: absUrl,
        });
      });
    }

    return results;
  });
}
