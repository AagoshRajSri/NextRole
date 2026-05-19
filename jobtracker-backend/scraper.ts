import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';

chromium.use(stealth());

export interface ScrapedJob {
  id: string;       // The unique ID from the ATS
  title: string;    // Title of the job
  location: string; // Job location
  url: string;      // Direct application/listing URL
}

export async function scrapeJobs(targetUrl: string): Promise<ScrapedJob[]> {
  console.log(`[Scraper] Launching Playwright to scrape: ${targetUrl}`);
  
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    
    // Implement jagged delay behavior emulation
    await page.waitForTimeout(Math.floor(Math.random() * 500) + 200);
    
    // Navigate to page securely
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(Math.floor(Math.random() * 1000) + 500);
    
    const url = targetUrl.toLowerCase();
    let jobs: ScrapedJob[] = [];

    if (url.includes('boards.greenhouse.io') || url.includes('greenhouse.io')) {
      jobs = await parseGreenhouse(page);
    } else if (url.includes('jobs.lever.co') || url.includes('lever.co')) {
      jobs = await parseLever(page);
    } else if (url.includes('myworkdayjobs.com')) {
      jobs = await parseWorkday(page);
    } else {
      // Fallback: auto-detect based on class elements present in DOM
      console.log('[Scraper] Unknown platform, attempting auto-detection...');
      const greenhouseCount = await page.locator('.opening').count();
      const leverCount = await page.locator('.posting').count();
      
      if (greenhouseCount > 0) {
        console.log('[Scraper] Detected Greenhouse structure on generic domain');
        jobs = await parseGreenhouse(page);
      } else if (leverCount > 0) {
        console.log('[Scraper] Detected Lever structure on generic domain');
        jobs = await parseLever(page);
      } else {
        console.log('[Scraper] Running generic job listing parser...');
        jobs = await parseGeneric(page);
      }
    }

    console.log(`[Scraper] Successfully scraped ${jobs.length} jobs from ${targetUrl}`);
    return jobs;
  } catch (err) {
    console.error(`[Scraper] Error scraping ${targetUrl}:`, err);
    throw err;
  } finally {
    await browser.close();
  }
}

/**
 * Greenhouse Parser
 * Listings structure:
 * <div class="opening" department_id="123">
 *   <a href="/stripe/jobs/456789">Software Engineer</a>
 *   <span class="location">San Francisco, CA</span>
 * </div>
 */
async function parseGreenhouse(page: any): Promise<ScrapedJob[]> {
  // Wait for the openings container
  try {
    await page.waitForSelector('.opening', { timeout: 10000 });
  } catch (e) {
    console.log('[Scraper] Timeout waiting for .opening, page might be empty.');
    return [];
  }

  const jobs = await page.evaluate(() => {
    const elements = document.querySelectorAll('.opening');
    const results: any[] = [];
    
    elements.forEach((el: any) => {
      const linkEl = el.querySelector('a') as any;
      const locationEl = el.querySelector('.location') as any;
      
      if (linkEl) {
        const href = linkEl.getAttribute('href') || '';
        const title = linkEl.innerText.trim();
        const location = locationEl ? locationEl.innerText.trim() : 'Remote / Unspecified';
        
        // Extract ATS Job ID from Greenhouse path, e.g. /stripe/jobs/4829302 -> 4829302
        const absoluteUrl = href.startsWith('http') ? href : new URL(href, window.location.href).href;
        const match = absoluteUrl.match(/\/jobs\/(\d+)/);
        const id = match ? match[1] : absoluteUrl.split('/').pop() || Math.random().toString();

        results.push({
          id,
          title,
          location,
          url: absoluteUrl
        });
      }
    });
    
    return results;
  });

  return jobs;
}

/**
 * Lever Parser
 * Listings structure:
 * <div class="posting">
 *   <a class="posting-title" href="https://jobs.lever.co/company/abc-123">
 *     <h5>Software Engineer</h5>
 *     <div class="posting-categories">
 *       <span class="sort-by-location posting-category">San Francisco</span>
 *     </div>
 *   </a>
 * </div>
 */
async function parseLever(page: any): Promise<ScrapedJob[]> {
  try {
    await page.waitForSelector('.posting', { timeout: 10000 });
  } catch (e) {
    console.log('[Scraper] Timeout waiting for .posting, page might be empty.');
    return [];
  }

  const jobs = await page.evaluate(() => {
    const elements = document.querySelectorAll('.posting');
    const results: any[] = [];
    
    elements.forEach((el: any) => {
      const linkEl = (el.querySelector('a.posting-title') || el.querySelector('a')) as any;
      const titleEl = (el.querySelector('h5') || el.querySelector('.posting-title')) as any;
      const locationEl = (el.querySelector('.sort-by-location') || el.querySelector('.posting-category')) as any;
      
      if (linkEl) {
        const url = linkEl.getAttribute('href') || '';
        const title = titleEl ? titleEl.innerText.trim() : linkEl.innerText.trim();
        const location = locationEl ? locationEl.innerText.trim() : 'Remote / Unspecified';
        
        // Extract ATS Job ID from Lever URL, e.g. https://jobs.lever.co/company/abc-123 -> abc-123
        const parts = url.split('/');
        const id = parts.pop() || parts.pop() || Math.random().toString();

        results.push({
          id,
          title,
          location,
          url
        });
      }
    });
    
    return results;
  });

  return jobs;
}

/**
 * Workday Parser
 * Listings structure:
 * Workday relies heavily on dynamically rendered lists.
 * Jobs are in elements with data-automation-id="jobPostingTitle" inside lists.
 */
async function parseWorkday(page: any): Promise<ScrapedJob[]> {
  try {
    // Wait for the standard list items of workday to render
    await page.waitForSelector('[data-automation-id="jobPostingTitle"]', { timeout: 15000 });
  } catch (e) {
    console.log('[Scraper] Timeout waiting for Workday job titles.');
    return [];
  }

  const jobs = await page.evaluate(() => {
    const results: any[] = [];
    const titleElements = document.querySelectorAll('[data-automation-id="jobPostingTitle"]');
    
    titleElements.forEach((el: any) => {
      const linkEl = (el.closest('a') || el.querySelector('a') || el) as any;
      // Navigate up to find the list card item to extract location
      const cardEl = (el.closest('li') || el.closest('[role="listitem"]') || el.parentElement?.parentElement) as any;
      
      const title = el.innerText.trim();
      const href = linkEl.getAttribute('href') || '';
      const absoluteUrl = href.startsWith('http') ? href : new URL(href, window.location.href).href;
      
      // Look for locations inside the card item
      let location = 'Remote / Unspecified';
      if (cardEl) {
        const subTitleEl = cardEl.querySelector('[data-automation-id="subtitle"]');
        const locationsEl = cardEl.querySelector('[data-automation-id="locations"]');
        if (locationsEl) {
          location = locationsEl.innerText.trim();
        } else if (subTitleEl) {
          location = subTitleEl.innerText.trim();
        }
      }
      
      // Extract unique ID from Workday URL
      // E.g. /company/job/jobName_R12345 -> R12345 or jobName_R12345
      const parts = absoluteUrl.split('/');
      const lastPart = parts.pop() || '';
      const id = lastPart.includes('_') ? lastPart.split('_').pop() || lastPart : lastPart || Math.random().toString();

      results.push({
        id,
        title,
        location,
        url: absoluteUrl
      });
    });

    return results;
  });

  return jobs;
}

/**
 * Generic Scraper Fallback
 * Looks for common patterns (e.g. elements that contain "job", "career", cards, headings, and links)
 */
async function parseGeneric(page: any): Promise<ScrapedJob[]> {
  const jobs = await page.evaluate(() => {
    const results: any[] = [];
    
    // Look for all <a> tags that look like job postings
    const anchors = Array.from(document.querySelectorAll('a')) as any[];
    
    anchors.forEach((a: any, idx: number) => {
      const href = a.getAttribute('href') || '';
      const text = a.innerText.trim();
      
      // Must be a substantial link with job keywords or inside a list
      const isJobLink = href.includes('/job/') || href.includes('/jobs/') || href.includes('/careers/') || href.includes('/opening/');
      const hasLength = text.length > 5 && text.length < 80;
      
      if (isJobLink && hasLength) {
        const absoluteUrl = href.startsWith('http') ? href : new URL(href, window.location.href).href;
        
        // Find nearby location
        let location = 'Remote / Unspecified';
        const parent = a.parentElement as any;
        if (parent) {
          const siblingText = parent.innerText.replace(text, '').trim();
          // Extract short text like cities/countries
          const cleanText = siblingText.split('\n')[0]?.trim();
          if (cleanText && cleanText.length < 40) {
            location = cleanText;
          }
        }
        
        results.push({
          id: `gen-${idx}-${absoluteUrl.split('/').pop() || 'job'}`,
          title: text,
          location,
          url: absoluteUrl
        });
      }
    });

    return results;
  });

  return jobs;
}
