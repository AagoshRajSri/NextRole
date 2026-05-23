import { Page } from 'playwright';
import { BrowserFactory, BrowserOptions } from './lib/browserFactory.js';

export interface ScrapedJob {
  atsJobId: string;
  title: string;
  location: string;
  url: string;
  companyName?: string;
}

export interface ScraperResult {
  jobs: ScrapedJob[];
  status: 'ok' | 'blocked' | 'empty' | 'error' | 'partial';
  jobsCount: number;
  scrapeDurationMs: number;
  platform: string;
  blockedReason?: string;     // why it was blocked if status === 'blocked'
  errorMessage?: string;      // error details if status === 'error'
  pageTitle?: string;         // useful for debugging wrong-URL issues
  screenshotBase64?: string;  // only if debug mode enabled
}

// Legacy compat wrapper (returns just the jobs array, logs errors):
export async function scrapeJobs(url: string): Promise<ScrapedJob[]> {
  const result = await scrapeJobsWithResult(url);
  if (result.status === 'error') console.error(`[scraper] ${result.errorMessage}`);
  if (result.status === 'blocked') console.warn(`[scraper] Blocked on ${result.platform}: ${result.blockedReason}`);
  return result.jobs;
}

function detectPlatform(url: string): string {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  
  if (host.includes('greenhouse.io')) return 'greenhouse';
  if (host.includes('lever.co')) return 'lever';
  if (host.includes('myworkdayjobs.com') || host.includes('workday.com')) return 'workday';
  if (host.includes('linkedin.com')) return 'linkedin';
  if (host === 'amazon.jobs') return 'amazon_jobs';
  if (host.includes('ashbyhq.com')) return 'ashby';
  if (host.includes('wellfound.com') || host.includes('angel.co')) return 'wellfound';
  if (host.includes('naukri.com')) return 'naukri';
  if (host.includes('smartrecruiters.com')) return 'smartrecruiters';
  if (host.includes('workable.com')) return 'workable';
  if (host.includes('apple.com')) return 'apple';
  if (host.includes('google.com') && url.includes('careers')) return 'google';
  return 'generic';
}

export async function scrapeJobsWithResult(url: string, options?: BrowserOptions): Promise<ScraperResult> {
  const platform = detectPlatform(url);
  
  switch (platform) {
    case 'greenhouse': return scrapeGreenhouse(url, options);
    case 'lever':      return scrapeLever(url, options);
    case 'workday':    return scrapeWorkday(url, options);
    case 'linkedin':   return scrapeLinkedIn(url, options);
    case 'amazon_jobs': return scrapeAmazonJobs(url, options);
    case 'ashby':      return scrapeAshby(url, options);
    case 'naukri':     return scrapeNaukri(url, options);
    case 'apple':      return scrapeApple(url);
    case 'google':     return scrapeGoogleCareers(url, options);
    default:           return scrapeGeneric(url, options);
  }
}

function detectBlock(page: Page, html: string, platform: string): string | null {
  const lc = html.toLowerCase();
  
  // Generic block signals
  if (lc.includes('access denied')) return 'access denied page';
  if (lc.includes('captcha') && lc.includes('solve')) return 'captcha challenge';
  if (lc.includes('are you a robot') || lc.includes('are you human')) return 'bot challenge';
  if ((lc.includes('429') && lc.includes('too many requests')) || lc.includes('status code 429')) return 'rate limited (429)';
  if (lc.includes('cf-error') || lc.includes('cloudflare') && lc.includes('error')) return 'Cloudflare block';
  if (lc.includes('blocked') && lc.includes('automated')) return 'automation detected';
  
  // LinkedIn-specific
  if (platform === 'linkedin') {
    if (lc.includes('authwall') || lc.includes('login') && lc.includes('sign in to view')) return 'LinkedIn auth wall';
    if (lc.includes('join now') && lc.includes('sign in') && !lc.includes('job-search-card')) return 'LinkedIn login gate';
    if (page.url().includes('linkedin.com/uas/login') || page.url().includes('linkedin.com/checkpoint')) return 'redirected to LinkedIn login';
  }
  
  return null;
}

// ════════════════════════════════════════════════════════
// APPLE
// ════════════════════════════════════════════════════════
async function scrapeApple(url: string): Promise<ScraperResult> {
  const start = Date.now();
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'en-US'
      }
    });
    
    if (!res.ok) {
      return { jobs: [], status: 'error', jobsCount: 0, platform: 'apple', errorMessage: `HTTP ${res.status}`, scrapeDurationMs: Date.now() - start };
    }
    
    const html = await res.text();
    const match = html.match(/window\.__staticRouterHydrationData\s*=\s*JSON\.parse\("(.+?)"\);<\/script>/s);
    if (!match) {
      return { jobs: [], status: 'empty', jobsCount: 0, platform: 'apple', scrapeDurationMs: Date.now() - start };
    }
    
    const jsonStr = match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '').replace(/\\r/g, '');
    const data = JSON.parse(jsonStr);
    const searchResults = data?.loaderData?.search?.searchResults || [];
    
    const jobs: ScrapedJob[] = searchResults.map((job: any) => {
      let loc = 'Remote / Unspecified';
      if (job.locations && job.locations.length > 0) {
        loc = job.locations[0].name || loc;
      }
      return {
        atsJobId: job.id,
        title: job.postingTitle || '',
        companyName: 'Apple',
        location: loc,
        url: `https://jobs.apple.com/en-us/details/${job.id}`
      };
    });
    
    return { jobs, status: jobs.length === 0 ? 'empty' : 'ok', jobsCount: jobs.length, platform: 'apple', scrapeDurationMs: Date.now() - start, pageTitle: 'Apple Jobs' };
  } catch (err: any) {
    return { jobs: [], status: 'error', jobsCount: 0, platform: 'apple', errorMessage: err.message, scrapeDurationMs: Date.now() - start };
  }
}

// ════════════════════════════════════════════════════════
// GOOGLE CAREERS
// ════════════════════════════════════════════════════════
async function scrapeGoogleCareers(url: string, options?: BrowserOptions): Promise<ScraperResult> {
  const start = Date.now();
  // Google is aggressive about headless detection. Stealth is required.
  const { page, cleanup } = await BrowserFactory.getPage({ ...options, stealth: true, disableResourceBlocking: true });
  
  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000); // Allow React to hydrate jobs
    
    const html = await page.content();
    const blocked = detectBlock(page, html, 'google');
    if (blocked) {
      return { jobs: [], status: 'blocked', jobsCount: 0, platform: 'google', blockedReason: blocked, scrapeDurationMs: Date.now() - start };
    }
    
    // Google job cards usually have class 'lLd3Je' or are list items inside 'ul'
    const jobs = await page.evaluate(() => {
      const results: ScrapedJob[] = [];
      const cards = document.querySelectorAll('li.lLd3Je, [jscontroller="xkZ6y"], div[class*="job-results"] li');
      
      cards.forEach((card) => {
        const titleEl = card.querySelector('h3, h2, [class*="title"]');
        const locEl = card.querySelector('[class*="location"], span.r0wTof, span[jsname="pwemIf"]');
        const linkEl = card.querySelector('a[href*="jobs/results/"]') || card.querySelector('a');
        
        if (titleEl && linkEl) {
          const title = titleEl.textContent?.trim() || '';
          const location = locEl?.textContent?.trim() || 'Remote / Unspecified';
          const href = linkEl.getAttribute('href') || '';
          let atsJobId = href.split('/').pop()?.split('?')[0] || String(Math.random());
          if (atsJobId.includes('-')) atsJobId = atsJobId.split('-').pop() || atsJobId;
          
          results.push({
            atsJobId,
            title,
            companyName: 'Google',
            location,
            url: href.startsWith('http') ? href : new URL(href, window.location.href).href,
          });
        }
      });
      return results;
    });
    
    return { jobs, status: jobs.length === 0 ? 'empty' : 'ok', jobsCount: jobs.length, platform: 'google', scrapeDurationMs: Date.now() - start, pageTitle: await page.title() };
  } catch (err: any) {
    return { jobs: [], status: 'error', jobsCount: 0, platform: 'google', errorMessage: err.message, scrapeDurationMs: Date.now() - start };
  } finally {
    await cleanup();
  }
}

// ════════════════════════════════════════════════════════
// GREENHOUSE
// ════════════════════════════════════════════════════════
async function scrapeGreenhouse(url: string, options?: BrowserOptions): Promise<ScraperResult> {
  const start = Date.now();
  const { page, cleanup } = await BrowserFactory.getPage(options);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const html = await page.content();
    const blocked = detectBlock(page, html, 'greenhouse');
    if (blocked) {
      return { jobs: [], status: 'blocked', jobsCount: 0, platform: 'greenhouse', blockedReason: blocked, scrapeDurationMs: Date.now() - start };
    }
    
    await page.waitForSelector('.opening', { timeout: 10000 }).catch(() => null);
    
    const jobs = await page.evaluate(() => {
      const results: ScrapedJob[] = [];
      document.querySelectorAll('.opening').forEach((el: any) => {
        const link = el.querySelector('a');
        const loc = el.querySelector('.location');
        if (link) {
          const href = link.getAttribute('href') || '';
          const title = link.innerText.trim();
          const location = loc ? loc.innerText.trim() : 'Remote / Unspecified';
          const absUrl = href.startsWith('http') ? href : new URL(href, window.location.href).href;
          const match = absUrl.match(/\/jobs\/(\d+)/);
          const atsJobId = match ? match[1] : absUrl.split('/').pop() || String(Math.random());
          results.push({ atsJobId, title, location, url: absUrl, companyName: '' });
        }
      });
      return results;
    });

    return { jobs, status: jobs.length === 0 ? 'empty' : 'ok', jobsCount: jobs.length, platform: 'greenhouse', scrapeDurationMs: Date.now() - start, pageTitle: await page.title() };
  } catch (err: any) {
    return { jobs: [], status: 'error', jobsCount: 0, platform: 'greenhouse', errorMessage: err.message, scrapeDurationMs: Date.now() - start };
  } finally {
    await cleanup();
  }
}

// ════════════════════════════════════════════════════════
// LEVER
// ════════════════════════════════════════════════════════
async function scrapeLever(url: string, options?: BrowserOptions): Promise<ScraperResult> {
  const start = Date.now();
  const { page, cleanup } = await BrowserFactory.getPage(options);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const html = await page.content();
    const blocked = detectBlock(page, html, 'lever');
    if (blocked) {
      return { jobs: [], status: 'blocked', jobsCount: 0, platform: 'lever', blockedReason: blocked, scrapeDurationMs: Date.now() - start };
    }
    
    await page.waitForSelector('.posting', { timeout: 10000 }).catch(() => null);
    
    const jobs = await page.evaluate(() => {
      const results: ScrapedJob[] = [];
      document.querySelectorAll('.posting').forEach((el: any) => {
        const link = el.querySelector('a.posting-title') || el.querySelector('a');
        const titleEl = el.querySelector('h5') || el.querySelector('.posting-title');
        const locEl = el.querySelector('.sort-by-location') || el.querySelector('.posting-category');
        if (link) {
          const linkUrl = link.getAttribute('href') || '';
          const title = titleEl ? titleEl.innerText.trim() : link.innerText.trim();
          const location = locEl ? locEl.innerText.trim() : 'Remote / Unspecified';
          const parts = linkUrl.split('/');
          const atsJobId = parts.pop() || parts.pop() || String(Math.random());
          results.push({ atsJobId, title, location, url: linkUrl, companyName: '' });
        }
      });
      return results;
    });

    return { jobs, status: jobs.length === 0 ? 'empty' : 'ok', jobsCount: jobs.length, platform: 'lever', scrapeDurationMs: Date.now() - start, pageTitle: await page.title() };
  } catch (err: any) {
    return { jobs: [], status: 'error', jobsCount: 0, platform: 'lever', errorMessage: err.message, scrapeDurationMs: Date.now() - start };
  } finally {
    await cleanup();
  }
}

// ════════════════════════════════════════════════════════
// WORKDAY
// ════════════════════════════════════════════════════════
async function scrapeWorkday(url: string, options?: BrowserOptions): Promise<ScraperResult> {
  const start = Date.now();
  const { page, cleanup } = await BrowserFactory.getPage(options);
  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    const html = await page.content();
    const blocked = detectBlock(page, html, 'workday');
    if (blocked) {
      return { jobs: [], status: 'blocked', jobsCount: 0, platform: 'workday', blockedReason: blocked, scrapeDurationMs: Date.now() - start };
    }
    
    await page.waitForSelector('[data-automation-id="jobPostingTitle"]', { timeout: 15000 }).catch(() => null);
    
    const jobs = await page.evaluate(() => {
      const results: ScrapedJob[] = [];
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
        const atsJobId = last.includes('_') ? last.split('_').pop() || last : last || String(Math.random());
        results.push({ atsJobId, title, location, url: absUrl, companyName: '' });
      });
      return results;
    });

    return { jobs, status: jobs.length === 0 ? 'empty' : 'ok', jobsCount: jobs.length, platform: 'workday', scrapeDurationMs: Date.now() - start, pageTitle: await page.title() };
  } catch (err: any) {
    return { jobs: [], status: 'error', jobsCount: 0, platform: 'workday', errorMessage: err.message, scrapeDurationMs: Date.now() - start };
  } finally {
    await cleanup();
  }
}

// ════════════════════════════════════════════════════════
// NAUKRI
// ════════════════════════════════════════════════════════
async function scrapeNaukri(url: string, options?: BrowserOptions): Promise<ScraperResult> {
  const start = Date.now();
  const { page, cleanup } = await BrowserFactory.getPage(options);
  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    const html = await page.content();
    const blocked = detectBlock(page, html, 'naukri');
    if (blocked) {
      return { jobs: [], status: 'blocked', jobsCount: 0, platform: 'naukri', blockedReason: blocked, scrapeDurationMs: Date.now() - start };
    }
    
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
      return { jobs: [], status: 'empty', jobsCount: 0, platform: 'naukri', scrapeDurationMs: Date.now() - start, pageTitle: await page.title() };
    }

    const jobs = await page.evaluate((selector: string) => {
      const results: ScrapedJob[] = [];
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
          const companyName = compEl ? compEl.innerText.trim() : '';
          const location = locEl ? locEl.innerText.trim() : 'India';
          const linkEl = titleEl.closest('a') || titleEl.querySelector('a') || card.querySelector('a');
          let linkUrl = '';
          if (linkEl) {
            const href = linkEl.getAttribute('href') || '';
            linkUrl = href.startsWith('http') ? href : new URL(href, window.location.href).href;
          }
          const atsJobId = jobId || `nk-${idx}-${Date.now()}`;
          results.push({ atsJobId, title, location, url: linkUrl || window.location.href, companyName });
        }
      });
      return results;
    }, foundSelector);

    return { jobs, status: jobs.length === 0 ? 'empty' : 'ok', jobsCount: jobs.length, platform: 'naukri', scrapeDurationMs: Date.now() - start, pageTitle: await page.title() };
  } catch (err: any) {
    return { jobs: [], status: 'error', jobsCount: 0, platform: 'naukri', errorMessage: err.message, scrapeDurationMs: Date.now() - start };
  } finally {
    await cleanup();
  }
}

// ════════════════════════════════════════════════════════
// LINKEDIN
// ════════════════════════════════════════════════════════
async function scrapeLinkedIn(url: string, options?: BrowserOptions): Promise<ScraperResult> {
  const start = Date.now()
  
  // Try Guest API first for company pages
  const companyMatch = url.match(/linkedin\.com\/company\/([^/]+)/)
  if (companyMatch) {
    try {
      const companySlug = companyMatch[1]
      const guestUrl = `https://www.linkedin.com/jobs/${companySlug}-jobs`
      const res = await fetch(guestUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' }
      })
      if (res.ok) {
        const html = await res.text()
        const jobs: ScrapedJob[] = []
        
        // Find all job list items
        let currentIndex = 0
        while (true) {
          const cardStart = html.indexOf('base-search-card', currentIndex)
          if (cardStart === -1) break
          const cardEnd = html.indexOf('base-search-card', cardStart + 1)
          const cardHtml = cardEnd === -1 ? html.substring(cardStart) : html.substring(cardStart, cardEnd)
          
          const idMatch = cardHtml.match(/data-entity-urn="urn:li:jobPosting:(\d+)"/)
          const titleMatch = cardHtml.match(/<h3 class="base-search-card__title">\s*(.+?)\s*<\/h3>/) || cardHtml.match(/<span class="sr-only">\s*(.+?)\s*<\/span>/)
          const compMatch = cardHtml.match(/<h4 class="base-search-card__subtitle">\s*<a[^>]*>\s*(.+?)\s*<\/a>/) || cardHtml.match(/<h4 class="base-search-card__subtitle">\s*(.+?)\s*<\/h4>/)
          const locMatch = cardHtml.match(/class="job-search-card__location"[^>]*>\s*(.+?)\s*<\/span>/)
          const hrefMatch = cardHtml.match(/href="([^"?]+)[^"]*"/)
          
          if (titleMatch && idMatch) {
            jobs.push({
              atsJobId: idMatch[1],
              title: titleMatch[1].trim(),
              companyName: compMatch ? compMatch[1].trim() : '',
              location: locMatch ? locMatch[1].trim() : '',
              url: hrefMatch ? hrefMatch[1] : `https://www.linkedin.com/jobs/view/${idMatch[1]}`,
            })
          }
          
          currentIndex = cardStart + 1
        }
        if (jobs.length > 0) {
          return { jobs, status: 'ok', jobsCount: jobs.length, platform: 'linkedin', scrapeDurationMs: Date.now() - start }
        }
      }
    } catch (e) {
      console.warn('LinkedIn Guest API failed:', e)
    }
  }

  const { page, cleanup } = await BrowserFactory.getPage({ stealth: true, disableResourceBlocking: true, ...options })
  
  try {
    // Step 1: Navigate with realistic behavior
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    
    // Human-like: random scroll before waiting for jobs
    await page.evaluate(() => window.scrollTo({ top: 200, behavior: 'smooth' }))
    await page.waitForTimeout(800 + Math.random() * 1200)
    
    // Step 2: Check for block
    const html = await page.content()
    const blocked = detectBlock(page, html, 'linkedin')
    if (blocked) {
      return { jobs: [], status: 'blocked', jobsCount: 0, platform: 'linkedin',
               blockedReason: blocked, scrapeDurationMs: Date.now() - start }
    }
    
    // Step 3: Try Strategy A — .job-search-card elements (most common public layout)
    let jobs = await tryLinkedInStrategyA(page)
    
    // Step 4: Try Strategy B — li[data-occludable-job-id] (alternate layout)
    if (jobs.length === 0) jobs = await tryLinkedInStrategyB(page)
    
    // Step 5: Try Strategy C — JSON-LD extraction (most reliable when available)
    if (jobs.length === 0) jobs = await tryLinkedInStrategyC(page)
    
    // Step 6: Infinite scroll — LinkedIn lazy-loads jobs
    // Only scroll if initial batch found > 0 (otherwise we're probably blocked)
    if (jobs.length > 0 && jobs.length < 25) {
      jobs = await scrollAndCollectLinkedIn(page, jobs)
    }
    
    const status = jobs.length === 0 ? 'empty' : 'ok'
    return { jobs, status, jobsCount: jobs.length, platform: 'linkedin',
             scrapeDurationMs: Date.now() - start, pageTitle: await page.title() }
  } catch (err: any) {
    return { jobs: [], status: 'error', jobsCount: 0, platform: 'linkedin',
             errorMessage: err.message, scrapeDurationMs: Date.now() - start }
  } finally {
    await cleanup()
  }
}

async function tryLinkedInStrategyA(page: Page): Promise<ScrapedJob[]> {
  try {
    await page.waitForSelector('.job-search-card, .jobs-search__results-list li', { timeout: 5000 })
    return await page.evaluate(() => {
      const cards = document.querySelectorAll('.job-search-card, .jobs-search__results-list li[data-entity-urn]')
      return Array.from(cards).map(card => {
        const titleEl = card.querySelector('.job-search-card__title, .base-search-card__title, h3')
        const companyEl = card.querySelector('.job-search-card__company-name, .base-search-card__subtitle, h4')
        const locationEl = card.querySelector('.job-search-card__location, .job-result-card__location, [class*="location"]')
        const linkEl = card.querySelector('a[href*="/jobs/view/"]')
        const href = linkEl?.getAttribute('href') || ''
        
        const idMatch = href.match(/\/jobs\/view\/(\d+)/)
        
        return {
          atsJobId: idMatch?.[1] || href,
          title: titleEl?.textContent?.trim() || '',
          companyName: companyEl?.textContent?.trim() || '',
          location: locationEl?.textContent?.trim() || '',
          url: href.startsWith('http') ? href : `https://www.linkedin.com${href.split('?')[0]}`,
        }
      }).filter(j => j.title && j.atsJobId)
    })
  } catch {
    return []
  }
}

async function tryLinkedInStrategyB(page: Page): Promise<ScrapedJob[]> {
  try {
    await page.waitForSelector('[data-occludable-job-id]', { timeout: 4000 })
    return await page.evaluate(() => {
      const items = document.querySelectorAll('[data-occludable-job-id]')
      return Array.from(items).map(item => {
        const jobId = item.getAttribute('data-occludable-job-id') || ''
        const titleEl = item.querySelector('[aria-label]') || item.querySelector('span[title]')
        const spans = item.querySelectorAll('span')
        return {
          atsJobId: jobId,
          title: titleEl?.getAttribute('aria-label') || titleEl?.textContent?.trim() || '',
          companyName: spans[1]?.textContent?.trim() || '',
          location: spans[2]?.textContent?.trim() || '',
          url: `https://www.linkedin.com/jobs/view/${jobId}/`,
        }
      }).filter(j => j.title && j.atsJobId)
    })
  } catch {
    return []
  }
}

async function tryLinkedInStrategyC(page: Page): Promise<ScrapedJob[]> {
  return await page.evaluate(() => {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]')
    const jobs: any[] = []
    
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent || '')
        const items = data['@type'] === 'ItemList'
          ? data.itemListElement?.map((e: any) => e.item) || []
          : data['@type'] === 'JobPosting' ? [data] : []
        
        for (const job of items) {
          if (job?.['@type'] === 'JobPosting') {
            const id = job.url?.match(/\/jobs\/view\/(\d+)/)?.[1] || job.identifier?.value || ''
            jobs.push({
              atsJobId: String(id),
              title: job.title || '',
              companyName: job.hiringOrganization?.name || '',
              location: job.jobLocation?.address?.addressLocality || job.jobLocation?.name || '',
              url: job.url || '',
            })
          }
        }
      } catch {}
    }
    return jobs.filter(j => j.title && j.atsJobId)
  })
}

async function scrollAndCollectLinkedIn(page: Page, initialJobs: ScrapedJob[]): Promise<ScrapedJob[]> {
  const seen = new Set(initialJobs.map(j => j.atsJobId))
  let allJobs = [...initialJobs]
  let noNewCount = 0
  
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollBy(0, 800))
    await page.waitForTimeout(1000 + Math.random() * 500)
    
    const currentJobs = await tryLinkedInStrategyA(page)
      .then(jobs => jobs.length > 0 ? jobs : tryLinkedInStrategyB(page))
    
    const newJobs = currentJobs.filter(j => !seen.has(j.atsJobId))
    if (newJobs.length === 0) {
      noNewCount++
      if (noNewCount >= 2) break
    } else {
      noNewCount = 0
      newJobs.forEach(j => seen.add(j.atsJobId))
      allJobs = [...allJobs, ...newJobs]
    }
  }
  
  return allJobs
}

// ════════════════════════════════════════════════════════
// AMAZON.JOBS
// ════════════════════════════════════════════════════════
async function scrapeAmazonJobs(url: string, options?: BrowserOptions): Promise<ScraperResult> {
  const start = Date.now()
  const { page, cleanup } = await BrowserFactory.getPage(options)
  
  try {
    await page.goto(url, { waitUntil: 'networkidle' })
    
    await page.waitForSelector('.job-tile, [data-job-id], .JobTile', { timeout: 15000 })
      .catch(() => null)
    
    const html = await page.content()
    const blocked = detectBlock(page, html, 'amazon_jobs')
    if (blocked) {
      return { jobs: [], status: 'blocked', jobsCount: 0, platform: 'amazon_jobs',
               blockedReason: blocked, scrapeDurationMs: Date.now() - start }
    }
    
    const jobs = await page.evaluate(() => {
      const tiles = document.querySelectorAll('[data-job-id]')
      if (tiles.length > 0) {
        return Array.from(tiles).map(tile => {
          const jobId = tile.getAttribute('data-job-id') || ''
          const titleEl = tile.querySelector('.job-title, h3, [class*="title"]')
          const locationEl = tile.querySelector('.location, [class*="location"], [class*="Location"]')
          const linkEl = tile.querySelector('a') || (tile.tagName === 'A' ? tile : null)
          const href = linkEl?.getAttribute('href') || `/jobs/${jobId}`
          return {
            atsJobId: jobId,
            title: titleEl?.textContent?.trim() || '',
            companyName: 'Amazon',
            location: locationEl?.textContent?.trim() || '',
            url: href.startsWith('http') ? href : `https://amazon.jobs${href}`,
          }
        }).filter(j => j.title && j.atsJobId)
      }
      
      const scripts = document.querySelectorAll('script')
      for (const s of scripts) {
        const text = s.textContent || ''
        if (text.includes('"jobId"') && text.includes('"title"')) {
          try {
            const match = text.match(/window\.__INITIAL_STATE__\s*=\s*({.+?});/)
            if (match) {
              const state = JSON.parse(match[1])
              const jobList = state?.jobs?.jobList || state?.search?.results || []
              return jobList.map((job: any) => ({
                atsJobId: String(job.jobId || job.id || ''),
                title: job.title || job.jobTitle || '',
                companyName: 'Amazon',
                location: job.location || job.city || '',
                url: `https://amazon.jobs/jobs/${job.jobId || job.id}`,
              })).filter((j: any) => j.title)
            }
          } catch {}
        }
      }
      return []
    })
    
    if (jobs.length === 0) {
      const countText = await page.$eval(
        '.results-count, [class*="resultsCount"], [class*="job-count"]',
        (el: any) => el.textContent || ''
      ).catch(() => '')
      
      if (countText && /\d+/.test(countText)) {
        return { jobs: [], status: 'partial', jobsCount: 0, platform: 'amazon_jobs',
                 errorMessage: `Page shows ${countText} but scraper found 0 — DOM may have changed`,
                 scrapeDurationMs: Date.now() - start }
      }
    }
    
    return { jobs, status: jobs.length === 0 ? 'empty' : 'ok', jobsCount: jobs.length,
             platform: 'amazon_jobs', scrapeDurationMs: Date.now() - start, pageTitle: await page.title() }
  } catch (err: any) {
    return { jobs: [], status: 'error', jobsCount: 0, platform: 'amazon_jobs',
             errorMessage: err.message, scrapeDurationMs: Date.now() - start }
  } finally {
    await cleanup()
  }
}

// ════════════════════════════════════════════════════════
// ASHBY
// ════════════════════════════════════════════════════════
async function scrapeAshby(url: string, options?: BrowserOptions): Promise<ScraperResult> {
  const start = Date.now()
  const { page, cleanup } = await BrowserFactory.getPage(options)
  
  try {
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.waitForSelector('[class*="PostingCard"], .ashby-job-posting-list-item', { timeout: 8000 })
      .catch(() => null)
    
    const companySlug = url.match(/jobs\.ashbyhq\.com\/([^/]+)/)?.[1]
    if (companySlug) {
      try {
        const apiResponse = await page.evaluate(async (slug: string) => {
          const res = await fetch('https://jobs.ashbyhq.com/api/non-user-graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              operationName: 'ApiJobBoardWithTeams',
              variables: { organizationHostedJobsPageName: slug },
              query: `query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) {
                jobBoard: jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) {
                  jobPostings { id title locationName employmentType externalLink }
                }
              }`
            })
          })
          return res.json()
        }, companySlug)
        
        const postings = apiResponse?.data?.jobBoard?.jobPostings || []
        if (postings.length > 0) {
          const jobs = postings.map((p: any) => ({
            atsJobId: p.id,
            title: p.title,
            companyName: companySlug,
            location: p.locationName || 'Remote',
            url: p.externalLink || `https://jobs.ashbyhq.com/${companySlug}/${p.id}`,
          }))
          return { jobs, status: 'ok', jobsCount: jobs.length, platform: 'ashby',
                   scrapeDurationMs: Date.now() - start, pageTitle: await page.title() }
        }
      } catch {} 
    }
    
    const jobs = await page.evaluate(() => {
      const cards = document.querySelectorAll('[class*="PostingCard"], .ashby-job-posting-list-item')
      return Array.from(cards).map(card => {
        const titleEl = card.querySelector('[class*="title"], h3, h2')
        const locationEl = card.querySelector('[class*="location"], [class*="Location"]')
        const linkEl = card.querySelector('a')
        const href = linkEl?.getAttribute('href') || ''
        const idMatch = href.match(/\/([a-f0-9-]{36})\/?$/)
        return {
          atsJobId: idMatch?.[1] || href,
          title: titleEl?.textContent?.trim() || '',
          companyName: '',
          location: locationEl?.textContent?.trim() || '',
          url: href.startsWith('http') ? href : `https://jobs.ashbyhq.com${href}`,
        }
      }).filter(j => j.title)
    })
    
    return { jobs, status: jobs.length === 0 ? 'empty' : 'ok', jobsCount: jobs.length,
             platform: 'ashby', scrapeDurationMs: Date.now() - start, pageTitle: await page.title() }
  } catch (err: any) {
    return { jobs: [], status: 'error', jobsCount: 0, platform: 'ashby',
             errorMessage: err.message, scrapeDurationMs: Date.now() - start }
  } finally {
    await cleanup()
  }
}

// ════════════════════════════════════════════════════════
// GENERIC
// ════════════════════════════════════════════════════════
async function scrapeGeneric(url: string, options?: BrowserOptions): Promise<ScraperResult> {
  const start = Date.now()
  const { page, cleanup } = await BrowserFactory.getPage(options)
  
  try {
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.waitForTimeout(2000)
    
    const html = await page.content()
    const blocked = detectBlock(page, html, 'generic')
    if (blocked) {
      return { jobs: [], status: 'blocked', jobsCount: 0, platform: 'generic',
               blockedReason: blocked, scrapeDurationMs: Date.now() - start }
    }
    
    const jobs = await page.evaluate(() => {
      const results: any[] = []
      const seen = new Set<string>()
      
      document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
        try {
          const data = JSON.parse(s.textContent || '')
          const postings = data['@type'] === 'JobPosting' ? [data]
            : data['@type'] === 'ItemList' ? data.itemListElement?.map((e: any) => e.item) || []
            : data['@graph']?.filter((g: any) => g['@type'] === 'JobPosting') || []
          
          postings.forEach((p: any) => {
            const id = p.url || p.identifier?.value || p.title
            if (seen.has(id)) return
            seen.add(id)
            results.push({
              atsJobId: String(p.identifier?.value || p.url?.split('/').pop() || p.title),
              title: p.title || '',
              companyName: p.hiringOrganization?.name || '',
              location: p.jobLocation?.address?.addressLocality || p.jobLocation?.name || '',
              url: p.url || window.location.href,
            })
          })
        } catch {}
      })
      
      if (results.length > 0) return results
      
      const jobLinkPatterns = ['/job/', '/jobs/', '/careers/', '/position/', '/opening/',
                                '/vacancy/', '/role/', 'job_id=', 'jobId=', 'position_id=']
      
      const links = Array.from(document.querySelectorAll('a[href]'))
        .filter(a => {
          const href = a.getAttribute('href') || ''
          return jobLinkPatterns.some(p => href.toLowerCase().includes(p))
        })
      
      links.forEach(link => {
        const href = link.getAttribute('href') || ''
        const id = href.split('/').filter(Boolean).pop()?.split('?')[0] || href
        if (seen.has(id) || !id) return
        seen.add(id)
        
        let title = link.textContent?.trim() || ''
        
        if (!title || title.length < 4) {
          const parent = link.closest('li, article, div[class*="job"], div[class*="position"], div[class*="role"]')
          if (parent) {
            const heading = parent.querySelector('h1,h2,h3,h4,strong,[class*="title"],[class*="Title"]')
            title = heading?.textContent?.trim() || parent.textContent?.slice(0, 80).trim() || ''
          }
        }
        
        let location = ''
        const parent = link.closest('li, article, [class*="job"], [class*="position"]')
        if (parent) {
          const locEl = parent.querySelector('[class*="location"],[class*="Location"],[class*="city"],[class*="City"],span')
          location = locEl?.textContent?.trim() || ''
        }
        
        if (title && title.length >= 4) {
          results.push({
            atsJobId: id,
            title: title.slice(0, 120),
            companyName: '',
            location: location.slice(0, 80),
            url: href.startsWith('http') ? href : new URL(href, window.location.href).href,
          })
        }
      })
      
      return results
    })
    
    const deduplicated = deduplicateByTitle(jobs)
    
    return {
      jobs: deduplicated,
      status: deduplicated.length === 0 ? 'empty' : 'ok',
      jobsCount: deduplicated.length,
      platform: 'generic',
      scrapeDurationMs: Date.now() - start,
      pageTitle: await page.title(),
    }
  } catch (err: any) {
    return { jobs: [], status: 'error', jobsCount: 0, platform: 'generic',
             errorMessage: err.message, scrapeDurationMs: Date.now() - start }
  } finally {
    await cleanup()
  }
}

function deduplicateByTitle(jobs: ScrapedJob[]): ScrapedJob[] {
  const seen = new Set<string>()
  return jobs.filter(job => {
    const normalized = job.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim()
    if (seen.has(normalized)) return false
    seen.add(normalized)
    return true
  })
}
