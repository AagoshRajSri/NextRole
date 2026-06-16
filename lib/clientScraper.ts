// ────────────────────────────────────────────────────────
// CLIENT-SIDE DOM JOB SCRAPER
// Extracts jobs directly from the page DOM in the content script.
// ────────────────────────────────────────────────────────

export interface ScrapedJob {
  atsJobId: string;
  title: string;
  companyName?: string;
  location?: string;
  url: string;
  postDate?: string;
}

export interface ClientScrapeResult {
  jobs: ScrapedJob[];
  platform: string;
  strategy: string;
  jobCount: number;
  durationMs: number;
}

export function detectPlatform(url: string): string {
  try {
    const { hostname: host, pathname: path } = new URL(url)
    const h = host.toLowerCase()
    const p = path.toLowerCase()
    
    if (h.includes('greenhouse.io') || h.includes('boards.greenhouse.io')) return 'greenhouse'
    if (h.includes('lever.co')) return 'lever'
    if (h.includes('myworkdayjobs.com') || (h.includes('workday.com') && p.includes('jobs'))) return 'workday'
    if (h.includes('ashbyhq.com')) return 'ashby'
    if (h.includes('wellfound.com') || h.includes('angel.co')) return 'wellfound'
    if (h.includes('workable.com') || h.includes('apply.workable.com')) return 'workable'
    if (h.includes('smartrecruiters.com')) return 'smartrecruiters'
    if (h === 'amazon.jobs') return 'amazon_jobs'
    if (h.includes('naukri.com')) return 'naukri'
    if (h.includes('instahyre.com')) return 'instahyre'
    if (h.includes('linkedin.com')) return 'linkedin'
    
    if (h.includes('eightfold.ai')) return 'eightfold'
    if (h.includes('taleo.net')) return 'taleo'
    if (h.includes('icims.com')) return 'icims'
    if (h.includes('successfactors.com') || h.includes('successfactors.eu')) return 'successfactors'
    if (h.includes('jobvite.com')) return 'jobvite'
    if (h.includes('brassring.com') || h.includes('kenexa.com')) return 'brassring'
    if (h.includes('myworkday.com')) return 'workday'
    if (h.includes('ultipro.com') || h.includes('ukg.com')) return 'ultipro'
    
    if (h === 'careers.google.com' || (h.includes('google.com') && p.includes('/careers'))) return 'google'
    if (h.includes('microsoft.com') && (h.includes('eightfold') || p.includes('careers'))) return 'eightfold'
    if (h.includes('apple.com') && p.includes('job')) return 'generic'
    if (h.includes('meta.com') && p.includes('careers')) return 'generic'
    
    if (h.startsWith('careers.') || h.startsWith('jobs.')) return 'generic'
    if (p.includes('/careers') || p.includes('/jobs')) return 'generic'
    
    return 'generic'
  } catch { return 'generic' }
}
export function scrapeCurrentPage(doc: Document, url: string, remoteSelectors: Record<string, any> = {}): ClientScrapeResult {
  const start = performance.now();
  const platform = detectPlatform(url);

  let result: { jobs: ScrapedJob[], strategy: string };

  switch (platform) {
    case 'linkedin':        result = scrapeLinkedInDOM(doc, url, remoteSelectors.linkedin); break;
    case 'greenhouse':      result = scrapeGreenhouseDOM(doc, url); break;
    case 'lever':           result = scrapeLeverDOM(doc, url); break;
    case 'workday':         result = scrapeWorkdayDOM(doc, url); break;
    case 'ashby':           result = scrapeAshbyDOM(doc, url); break;
    case 'wellfound':       result = scrapeWellfoundDOM(doc, url); break;
    case 'workable':        result = scrapeWorkableDOM(doc, url); break;
    case 'eightfold':       result = scrapeEightfoldDOM(doc, url); break;
    case 'google':          result = scrapeGoogleCareersDOM(doc, url); break;
    case 'taleo':           result = scrapeTaleoDOM(doc, url); break;
    case 'icims':           result = scrapeICIMSDOM(doc, url); break;
    case 'successfactors':  result = scrapeSuccessFactorsDOM(doc, url); break;
    case 'jobvite':         result = scrapeJobviteDOM(doc, url); break;
    case 'amazon_jobs':     result = scrapeAmazonJobsDOM(doc, url); break;
    default:                result = scrapeGenericCompanyCareerDOM(doc, url);
  }

  // If platform-specific scraper found nothing, fall back to generic
  if (result.jobs.length === 0 && platform !== 'generic') {
    const fallback = scrapeGenericCompanyCareerDOM(doc, url);
    if (fallback.jobs.length > 0) {
      result = { jobs: fallback.jobs, strategy: `fallback:${fallback.strategy}` };
    }
  }

  return {
    jobs: deduplicateByTitle(result.jobs),
    platform,
    strategy: result.strategy,
    jobCount: result.jobs.length,
    durationMs: Math.round(performance.now() - start),
  };
}

// ════════════════════════════════════════════════════════
// LINKEDIN
// ════════════════════════════════════════════════════════
function scrapeLinkedInDOM(doc: Document, url: string, selectors?: any): { jobs: ScrapedJob[], strategy: string } {
  // Strategy 1: data-occludable-job-id (logged-in feed layout)
  const occludable = doc.querySelectorAll('[data-occludable-job-id]');
  if (occludable.length > 0) {
    const jobs = Array.from(occludable).map(el => {
      const jobId = el.getAttribute('data-occludable-job-id') || '';
      const titleEl = el.querySelector('[aria-label], .job-card-list__title, .job-card-container__link');
      const companyEl = el.querySelector('.job-card-container__company-name, .artdeco-entity-lockup__subtitle');
      const locationEl = el.querySelector('.job-card-container__metadata-item, .artdeco-entity-lockup__caption');
      const timeEl = el.querySelector('time');
      return {
        atsJobId: jobId,
        title: titleEl?.textContent?.trim() || titleEl?.getAttribute('aria-label') || '',
        companyName: companyEl?.textContent?.trim() || '',
        location: locationEl?.textContent?.trim() || '',
        url: `https://www.linkedin.com/jobs/view/${jobId}/`,
        postDate: timeEl?.getAttribute('datetime') || timeEl?.textContent?.trim(),
      };
    }).filter(j => j.title && j.atsJobId);
    if (jobs.length > 0) return { jobs, strategy: 'data-occludable-job-id' };
  }

  // Strategy 2: .job-search-card (public guest view)
  const cardSelector = selectors?.strategyA || '.job-search-card, .base-search-card';
  const titleSelector = selectors?.title || '.job-search-card__title, .base-search-card__title';
  const companySelector = selectors?.company || '.job-search-card__company-name, .base-search-card__subtitle h4';
  const locSelector = selectors?.location || '.job-search-card__location';
  
  const cards = doc.querySelectorAll(cardSelector);
  if (cards.length > 0) {
    const jobs = Array.from(cards).map(card => {
      const titleEl = card.querySelector(titleSelector);
      const companyEl = card.querySelector(companySelector);
      const locationEl = card.querySelector(locSelector);
      const linkEl = card.querySelector('a[href*="/jobs/view/"]');
      const href = linkEl?.getAttribute('href') || '';
      const idMatch = href.match(/\/jobs\/view\/(\d+)/);
      const timeEl = card.querySelector('time');
      return {
        atsJobId: idMatch ? idMatch[1] : (card.getAttribute('data-entity-urn') || '').replace(/[^0-9]/g, ''),
        title: titleEl?.textContent?.trim() || '',
        companyName: companyEl?.textContent?.trim() || '',
        location: locationEl?.textContent?.trim() || '',
        url: href ? (href.startsWith('http') ? href.split('?')[0] : `https://www.linkedin.com${href.split('?')[0]}`) : `https://www.linkedin.com/jobs/view/${card.getAttribute('data-entity-urn')?.replace(/[^0-9]/g, '')}/`,
        postDate: timeEl?.getAttribute('datetime') || timeEl?.textContent?.trim(),
      };
    }).filter(j => j.title && j.atsJobId);
    if (jobs.length > 0) return { jobs, strategy: 'job-search-card' };
  }

  // Strategy 3: company jobs page layout (.jobs-search__results-list li)
  const listSelector = selectors?.strategyB || '.jobs-search-results__list-item, .jobs-search__results-list li, .scaffold-layout__list-container li';
  const listTitleSel = selectors?.title || 'h3, .base-search-card__title, strong';
  const listCompSel = selectors?.company || 'h4, .base-search-card__subtitle';
  const listLocSel = selectors?.location || '[class*="location"], [class*="Location"]';

  const listItems = doc.querySelectorAll(listSelector);
  if (listItems.length > 0) {
    const jobs = Array.from(listItems).map(li => {
      const link = li.querySelector('a[href*="/jobs/view/"]');
      const href = link?.getAttribute('href') || '';
      const idMatch = href.match(/\/jobs\/view\/(\d+)/);
      const titleEl = li.querySelector(listTitleSel);
      const companyEl = li.querySelector(listCompSel);
      const locationEl = li.querySelector(listLocSel);
      return {
        atsJobId: idMatch?.[1] || '',
        title: titleEl?.textContent?.trim() || link?.textContent?.trim() || '',
        companyName: companyEl?.textContent?.trim() || '',
        location: locationEl?.textContent?.trim() || '',
        url: href.startsWith('http') ? href.split('?')[0] : `https://www.linkedin.com${href.split('?')[0]}`,
      };
    }).filter(j => j.title && j.atsJobId);
    if (jobs.length > 0) return { jobs, strategy: 'results-list' };
  }

  // Strategy 4: JSON-LD structured data
  const jsonLdJobs = extractJsonLdJobs(doc);
  if (jsonLdJobs.length > 0) return { jobs: jsonLdJobs, strategy: 'json-ld' };

  // Strategy 5: any link to /jobs/view/ on the page
  const jobLinks = Array.from(doc.querySelectorAll('a[href*="/jobs/view/"]'));
  if (jobLinks.length > 0) {
    const seen = new Set<string>();
    const jobs = jobLinks.map(link => {
      const href = link.getAttribute('href') || '';
      const idMatch = href.match(/\/jobs\/view\/(\d+)/);
      const id = idMatch?.[1] || '';
      if (!id || seen.has(id)) return null;
      seen.add(id);
      return {
        atsJobId: id,
        title: link.getAttribute('aria-label') || link.textContent?.trim() || '',
        companyName: '',
        location: '',
        url: `https://www.linkedin.com/jobs/view/${id}/`,
      };
    }).filter(Boolean) as ScrapedJob[];
    if (jobs.length > 0) return { jobs, strategy: 'link-scan' };
  }

  return { jobs: [], strategy: 'none' };
}

// ════════════════════════════════════════════════════════
// GREENHOUSE
// ════════════════════════════════════════════════════════
function scrapeGreenhouseDOM(doc: Document, url: string): { jobs: ScrapedJob[], strategy: string } {
  // Strategy 1: .opening elements (classic Greenhouse layout)
  const openings = doc.querySelectorAll('.opening');
  if (openings.length > 0) {
    const jobs = Array.from(openings).map(el => {
      const link = el.querySelector('a');
      const href = link?.getAttribute('href') || '';
      const idMatch = href.match(/\/jobs\/(\d+)/);
      const locationEl = el.querySelector('.location');
      return {
        atsJobId: idMatch?.[1] || href,
        title: link?.textContent?.trim() || '',
        companyName: extractCompanyFromUrl(url),
        location: locationEl?.textContent?.trim() || '',
        url: href.startsWith('http') ? href : new URL(href, url).href,
      };
    }).filter(j => j.title && j.atsJobId);
    if (jobs.length > 0) return { jobs, strategy: 'opening-class' };
  }

  // Strategy 2: tr.job-post rows
  const rows = doc.querySelectorAll('tr.job-post');
  if (rows.length > 0) {
    const jobs = Array.from(rows).map(row => {
      const link = row.querySelector('a[href*="/jobs/"]');
      const href = link?.getAttribute('href') || '';
      const idMatch = href.match(/\/jobs\/(\d+)/);
      const locationEl = row.querySelector('.job-post-location, td:last-child');
      return {
        atsJobId: idMatch?.[1] || href,
        title: link?.textContent?.trim() || row.querySelector('td')?.textContent?.trim() || '',
        companyName: extractCompanyFromUrl(url),
        location: locationEl?.textContent?.trim() || '',
        url: href.startsWith('http') ? href : new URL(href, url).href,
      };
    }).filter(j => j.title && j.atsJobId);
    if (jobs.length > 0) return { jobs, strategy: 'tr-job-post' };
  }

  // Strategy 3: JSON-LD
  const jsonLdJobs = extractJsonLdJobs(doc);
  if (jsonLdJobs.length > 0) return { jobs: jsonLdJobs, strategy: 'json-ld' };

  // Strategy 4: any /jobs/ link
  return scrapeByJobLinks(doc, url, '/jobs/');
}

// ════════════════════════════════════════════════════════
// LEVER
// ════════════════════════════════════════════════════════
function scrapeLeverDOM(doc: Document, url: string): { jobs: ScrapedJob[], strategy: string } {
  // Strategy 1: .posting elements
  const postings = doc.querySelectorAll('.posting');
  if (postings.length > 0) {
    const jobs = Array.from(postings).map(el => {
      const titleLink = el.querySelector('.posting-title a, a.posting-title, [data-qa="posting-name"] a');
      const href = titleLink?.getAttribute('href') || '';
      // Lever job ID is the last path segment: jobs.lever.co/company/ID
      const idMatch = href.match(/([a-f0-9-]{36})\/?$/);
      const locationEl = el.querySelector('.posting-categories .location, .sort-by-location');
      return {
        atsJobId: idMatch?.[1] || href.split('/').pop() || '',
        title: titleLink?.textContent?.trim() || el.querySelector('h5')?.textContent?.trim() || '',
        companyName: extractCompanyFromUrl(url),
        location: locationEl?.textContent?.trim() || '',
        url: href.startsWith('http') ? href : new URL(href, url).href,
      };
    }).filter(j => j.title && j.atsJobId);
    if (jobs.length > 0) return { jobs, strategy: 'posting-class' };
  }

  // Strategy 2: [data-qa] attributes (newer Lever layout)
  const qaItems = doc.querySelectorAll('[data-qa="posting-name"]');
  if (qaItems.length > 0) {
    const jobs = Array.from(qaItems).map(el => {
      const link = el.querySelector('a') || el.closest('a');
      const href = link?.getAttribute('href') || '';
      const idMatch = href.match(/([a-f0-9-]{36})\/?$/);
      return {
        atsJobId: idMatch?.[1] || href.split('/').pop() || '',
        title: el.textContent?.trim() || '',
        companyName: extractCompanyFromUrl(url),
        location: el.closest('[class*="posting"]')?.querySelector('[data-qa="posting-location"]')?.textContent?.trim() || '',
        url: href.startsWith('http') ? href : new URL(href, url).href,
      };
    }).filter(j => j.title && j.atsJobId);
    if (jobs.length > 0) return { jobs, strategy: 'data-qa' };
  }

  return scrapeByJobLinks(doc, url, '/jobs/');
}

// ════════════════════════════════════════════════════════
// WORKDAY
// ════════════════════════════════════════════════════════
function scrapeWorkdayDOM(doc: Document, url: string): { jobs: ScrapedJob[], strategy: string } {
  // Workday is a heavy SPA — the DOM may not be ready immediately
  // Strategy 1: data-automation-id="jobItem" (standard Workday layout)
  const jobItems = doc.querySelectorAll('[data-automation-id="jobItem"]');
  if (jobItems.length > 0) {
    const jobs = Array.from(jobItems).map(el => {
      const titleEl = el.querySelector('[data-automation-id="jobTitle"], a[data-automation-id="jobTitle"]');
      const href = titleEl?.getAttribute('href') || '';
      const locationEl = el.querySelector('[data-automation-id="jobPrimaryLocation"], [data-automation-id="locations"]');
      // Workday job ID is in the URL after the last /
      const idMatch = href.match(/\/([^/]+)\/?$/);
      return {
        atsJobId: idMatch?.[1] || href,
        title: titleEl?.textContent?.trim() || '',
        companyName: extractCompanyFromUrl(url),
        location: locationEl?.textContent?.trim() || '',
        url: href.startsWith('http') ? href : new URL(href, url).href,
      };
    }).filter(j => j.title && j.atsJobId);
    if (jobs.length > 0) return { jobs, strategy: 'automation-id' };
  }

  // Strategy 2: gwt-uid elements (older Workday layout)
  const altItems = doc.querySelectorAll('[class*="jobItem"], [class*="job-item"], li[class*="css-"]');
  if (altItems.length > 0) {
    const jobs = Array.from(altItems).map(el => {
      const link = el.querySelector('a[href*="myworkdayjobs.com"], a[href*="/job/"]');
      if (!link) return null;
      const href = link.getAttribute('href') || '';
      const idMatch = href.match(/\/([^/]+)\/?$/);
      return {
        atsJobId: idMatch?.[1] || href,
        title: link.textContent?.trim() || el.querySelector('h3,h4')?.textContent?.trim() || '',
        companyName: extractCompanyFromUrl(url),
        location: el.querySelector('[class*="location"], [class*="Location"]')?.textContent?.trim() || '',
        url: href.startsWith('http') ? href : new URL(href, url).href,
      };
    }).filter(Boolean) as ScrapedJob[];
    if (jobs.length > 0) return { jobs, strategy: 'class-scan' };
  }

  return { jobs: [], strategy: 'none' };  // SPA may not have rendered yet — caller should retry
}

// ════════════════════════════════════════════════════════
// ASHBY
// ════════════════════════════════════════════════════════
function scrapeAshbyDOM(doc: Document, url: string): { jobs: ScrapedJob[], strategy: string } {
  // Ashby layouts vary: try multiple selectors
  const selectors = [
    '[class*="PostingCard"]',
    '[class*="posting-card"]',
    '.ashby-job-posting-list-item',
    '[class*="JobCard"]',
    '[class*="job-card"]',
  ];

  for (const selector of selectors) {
    const cards = doc.querySelectorAll(selector);
    if (cards.length === 0) continue;

    const jobs = Array.from(cards).map(card => {
      const link = card.querySelector('a[href]');
      const href = link?.getAttribute('href') || '';
      const titleEl = card.querySelector('[class*="title"], [class*="Title"], h3, h2, strong');
      const locationEl = card.querySelector('[class*="location"], [class*="Location"]');
      const idMatch = href.match(/\/([a-f0-9-]{36})\/?$/) || href.match(/\/jobs\/([^/]+)\/?$/);
      return {
        atsJobId: idMatch?.[1] || href.split('/').pop() || '',
        title: titleEl?.textContent?.trim() || link?.textContent?.trim() || '',
        companyName: extractCompanyFromUrl(url),
        location: locationEl?.textContent?.trim() || '',
        url: href.startsWith('http') ? href : new URL(href, url).href,
      };
    }).filter(j => j.title && j.atsJobId);

    if (jobs.length > 0) return { jobs, strategy: selector };
  }

  // Fallback: any link to /jobs/
  return scrapeByJobLinks(doc, url, '/jobs/');
}

// ════════════════════════════════════════════════════════
// GENERIC
// ════════════════════════════════════════════════════════
function scrapeGenericCompanyCareerDOM(
    doc: Document, url: string
  ): { jobs: ScrapedJob[], strategy: string } {
    
    const jsonLd = extractJsonLdJobs(doc)
    if (jsonLd.length > 0) {
      const company = jsonLd[0].companyName || extractCompanyFromUrl(url)
      return {
        jobs: jsonLd.map(j => ({ ...j, companyName: j.companyName || company })),
        strategy: 'generic-json-ld'
      }
    }
    
    const nextData = extractNextJsData(doc)
    if (nextData) {
      const jobs = extractJobsFromAnyJsonTree(nextData, extractCompanyFromUrl(url))
      if (jobs.length > 0) return { jobs, strategy: 'generic-next-data' }
    }
    
    const nuxtData = extractEmbeddedWindowData(doc, '__NUXT__')
    if (nuxtData) {
      const jobs = extractJobsFromAnyJsonTree(nuxtData, extractCompanyFromUrl(url))
      if (jobs.length > 0) return { jobs, strategy: 'generic-nuxt-data' }
    }
    
    const structuredJobs = scrapeStructuredJobListings(doc, url)
    if (structuredJobs.length > 0) return { jobs: structuredJobs, strategy: 'generic-structured' }
    
    const heuristicJobs = scrapeByJobLinkHeuristics(doc, url)
    return { jobs: heuristicJobs, strategy: heuristicJobs.length > 0 ? 'generic-heuristic' : 'none' }
  }

  function scrapeStructuredJobListings(doc: Document, url: string): ScrapedJob[] {
    const company = extractCompanyFromUrl(url)
    
    const candidates = [
      ...Array.from(doc.querySelectorAll('ul li, ol li')),
      ...Array.from(doc.querySelectorAll('[role="list"] [role="listitem"]')),
      ...Array.from(doc.querySelectorAll('article')),
      ...Array.from(doc.querySelectorAll('[class*="job"][class*="item"], [class*="job"][class*="card"], [class*="job"][class*="row"]')),
      ...Array.from(doc.querySelectorAll('[class*="position"][class*="item"], [class*="opening"][class*="item"]')),
      ...Array.from(doc.querySelectorAll('[class*="role"][class*="item"], [class*="vacancy"]')),
    ]
    
    const withLinks = candidates.filter(el => el.querySelector('a[href]'))
    
    const parentGroups = new Map<Element, Element[]>()
    for (const el of withLinks) {
      const parent = el.parentElement
      if (!parent) continue
      const group = parentGroups.get(parent) || []
      group.push(el)
      parentGroups.set(parent, group)
    }
    
    let bestGroup: Element[] = []
    for (const [, group] of parentGroups) {
      if (group.length > bestGroup.length) bestGroup = group
    }
    
    if (bestGroup.length < 2) return []
    
    const seen = new Set<string>()
    const jobs = bestGroup.map(el => {
      const link = el.querySelector('a[href]')
      if (!link) return null
      
      const href = link.getAttribute('href') || ''
      const fullUrl = href.startsWith('http') ? href : new URL(href, url).href
      
      if (href.startsWith('#')) return null
      if (fullUrl === url) return null
      
      const titleEl = el.querySelector('h1,h2,h3,h4,h5,[class*="title"],[class*="Title"],strong')
      let title = titleEl?.textContent?.trim() || link.textContent?.trim() || ''
      title = title.replace(/\s+/g, ' ').trim()
      if (!title || title.length < 4 || title.length > 200) return null
      
      const navWords = ['home', 'about', 'contact', 'blog', 'news', 'team', 'faq',
                         'privacy', 'terms', 'sitemap', 'login', 'sign in', 'sign up']
      if (navWords.some(w => title.toLowerCase() === w)) return null
      
      const id = fullUrl.split('/').filter(Boolean).pop()?.split('?')[0] || ''
      if (!id || seen.has(id)) return null
      seen.add(id)
      
      const allText = el.textContent || ''
      const remainingText = allText.replace(title, '').trim()
      
      let location = ''
      const locationMatch = remainingText.match(
        /\b(remote|hybrid|on.?site|[A-Z][a-z]+(?:,\s*[A-Z][a-z]+)*(?:,\s*[A-Z]{2,})?)\b/
      )
      if (locationMatch) location = locationMatch[0]
      
      return {
        atsJobId: id,
        title,
        companyName: company,
        location,
        url: fullUrl,
        postDate: extractPostDate(el),
      }
    }).filter(Boolean) as ScrapedJob[]
    
    return jobs
  }

  function scrapeByJobLinkHeuristics(doc: Document, url: string): ScrapedJob[] {
    const company = extractCompanyFromUrl(url)
    const jobPathWords = ['/job/', '/jobs/', '/careers/', '/position/', '/opening/',
                          '/role/', '/vacancy/', '/opportunity/', '/requisition/']
    
    const allLinks = Array.from(doc.querySelectorAll('a[href]'))
    const jobLinks = allLinks.filter(a => {
      const href = (a.getAttribute('href') || '').toLowerCase()
      if (href.startsWith('#') || href.startsWith('mailto:')) return false
      return jobPathWords.some(w => href.includes(w))
    })
    
    if (jobLinks.length === 0) return []
    
    const seen = new Set<string>()
    return jobLinks.map(link => {
      const href = link.getAttribute('href') || ''
      const fullUrl = href.startsWith('http') ? href : new URL(href, url).href
      const id = fullUrl.split('/').filter(Boolean).pop()?.split('?')[0] || ''
      if (!id || seen.has(id)) return null
      seen.add(id)
      
      const title = link.textContent?.trim() || link.getAttribute('title') || link.getAttribute('aria-label') || ''
      if (!title || title.length < 4) return null
      
      return {
        atsJobId: id,
        title: title.replace(/\s+/g, ' ').trim(),
        companyName: company,
        location: '',
        url: fullUrl,
      }
    }).filter(Boolean) as ScrapedJob[]
  }

// ════════════════════════════════════════════════════════
// SHARED UTILITIES
// ════════════════════════════════════════════════════════
function extractJsonLdJobs(doc: Document): ScrapedJob[] {
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  const jobs: ScrapedJob[] = [];

  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent || '');
      const items = Array.isArray(data)
        ? data
        : data['@type'] === 'ItemList'
          ? (data.itemListElement || []).map((e: any) => e.item || e)
          : data['@graph']
            ? data['@graph'].filter((g: any) => g['@type'] === 'JobPosting')
            : data['@type'] === 'JobPosting' ? [data] : [];

      for (const item of items) {
        if (item?.['@type'] !== 'JobPosting') continue;
        const id = item.identifier?.value || item.url?.split('/').pop() || item.title;
        jobs.push({
          atsJobId: String(id),
          title: item.title || '',
          companyName: item.hiringOrganization?.name || '',
          location: item.jobLocation?.address?.addressLocality
                 || item.jobLocation?.address?.addressRegion
                 || item.jobLocation?.name || '',
          url: item.url || '',
        });
      }
    } catch {}
  }
  return jobs;
}

function scrapeByJobLinks(
  doc: Document, baseUrl: string, pathFragment: string
): { jobs: ScrapedJob[], strategy: string } {
  const links = Array.from(doc.querySelectorAll(`a[href*="${pathFragment}"]`));
  const seen = new Set<string>();
  const jobs = links.map(link => {
    const href = link.getAttribute('href') || '';
    const fullUrl = href.startsWith('http') ? href : new URL(href, baseUrl).href;
    const id = href.split('/').filter(Boolean).pop()?.split('?')[0] || '';
    if (!id || seen.has(id)) return null;
    seen.add(id);
    const title = link.textContent?.trim() || link.getAttribute('aria-label') || '';
    if (!title || title.length < 4) return null;
    return {
      atsJobId: id,
      title,
      companyName: extractCompanyFromUrl(baseUrl),
      location: '',
      url: fullUrl,
    };
  }).filter(Boolean) as ScrapedJob[];
  return { jobs, strategy: 'link-scan' };
}

function deduplicateByTitle(jobs: ScrapedJob[]): ScrapedJob[] {
  const seen = new Set<string>();
  return jobs.filter(job => {
    const key = job.title.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function extractCompanyFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace('www.', '');
    const path = new URL(url).pathname;
    if (host.includes('linkedin.com')) {
      const match = path.match(/\/company\/([^/]+)/);
      return match?.[1]?.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || '';
    }
    if (host.includes('greenhouse.io')) return path.split('/')[1]?.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || '';
    if (host.includes('lever.co')) return path.split('/')[1]?.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || '';
    if (host.includes('ashbyhq.com')) return path.split('/')[1]?.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || '';
    if (host.startsWith('careers.') || host.startsWith('jobs.')) {
      return host.split('.')[1]?.replace(/\b\w/g, l => l.toUpperCase()) || '';
    }
    return host.split('.')[0]?.replace(/\b\w/g, l => l.toUpperCase()) || '';
  } catch { return ''; }
}

function scrapeWellfoundDOM(doc: Document, url: string) { return scrapeGenericCompanyCareerDOM(doc, url); }
function scrapeWorkableDOM(doc: Document, url: string) { return scrapeGenericCompanyCareerDOM(doc, url); }
function scrapeAmazonJobsDOM(doc: Document, url: string) { return scrapeGenericCompanyCareerDOM(doc, url); }

  function extractNextJsData(doc: Document): any {
    const script = doc.getElementById('__NEXT_DATA__')
    if (!script) return null
    try { return JSON.parse(script.textContent || '') } catch { return null }
  }

  function extractEmbeddedWindowData(doc: Document, varName: string): any {
    const scripts = Array.from(doc.querySelectorAll('script:not([src])'))
    for (const script of scripts) {
      const text = script.textContent || ''
      const idx = text.indexOf(varName)
      if (idx === -1) continue
      try {
        const eqIdx = text.indexOf('=', idx)
        if (eqIdx === -1) continue
        const jsonStart = text.indexOf('{', eqIdx)
        if (jsonStart === -1) continue
        const jsonStr = extractBalancedJson(text, jsonStart)
        if (jsonStr) return JSON.parse(jsonStr)
      } catch {}
    }
    return null
  }

  function extractBalancedJson(text: string, start: number): string | null {
    if (start === -1 || text[start] !== '{') return null
    let depth = 0
    let i = start
    while (i < text.length && i < start + 500000) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') {
        depth--
        if (depth === 0) return text.slice(start, i + 1)
      }
      i++
    }
    return null
  }

  function extractJobsFromAnyJsonTree(data: any, company: string, depth = 0): ScrapedJob[] {
    if (depth > 6) return []
    if (!data || typeof data !== 'object') return []
    
    if (isJobLikeObject(data)) {
      const job = normalizeJobObject(data, company)
      if (job) return [job]
    }
    
    if (Array.isArray(data)) {
      const jobItems = data.filter(isJobLikeObject)
      if (jobItems.length > 0) {
        return jobItems.map(j => normalizeJobObject(j, company)).filter(Boolean) as ScrapedJob[]
      }
      return data.flatMap(item => extractJobsFromAnyJsonTree(item, company, depth + 1))
    }
    
    const priorityKeys = ['jobs', 'positions', 'openings', 'listings', 'postings',
                           'results', 'items', 'data', 'careers', 'opportunities',
                           'jobPostings', 'jobList', 'vacancies']
    
    for (const key of priorityKeys) {
      if (data[key]) {
        const result = extractJobsFromAnyJsonTree(data[key], company, depth + 1)
        if (result.length > 0) return result
      }
    }
    
    for (const key of Object.keys(data)) {
      if (priorityKeys.includes(key)) continue
      const result = extractJobsFromAnyJsonTree(data[key], company, depth + 1)
      if (result.length > 0) return result
    }
    
    return []
  }

  function isJobLikeObject(obj: any): boolean {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false
    const keys = Object.keys(obj).map(k => k.toLowerCase())
    const hasTitle = keys.some(k => ['title', 'name', 'jobtitle', 'job_title',
                                      'position', 'role', 'positionname'].includes(k))
    const hasId = keys.some(k => ['id', 'jobid', 'job_id', 'requisitionid',
                                    'reqid', 'url', 'link', 'href'].includes(k))
    return hasTitle && hasId
  }

  function normalizeJobObject(obj: any, company: string): ScrapedJob | null {
    const title = obj.title || obj.name || obj.jobTitle || obj.job_title ||
                  obj.position || obj.positionName || ''
    if (!title || typeof title !== 'string') return null
    
    const id = String(obj.id || obj.jobId || obj.job_id || obj.requisitionId ||
                      obj.reqId || obj.externalId || title)
    
    const rawUrl = obj.url || obj.link || obj.href || obj.applyUrl || obj.jobUrl || ''
    
    const location = obj.location || obj.city ||
                     (Array.isArray(obj.locations) ? obj.locations[0] : '') ||
                     obj.jobLocation || obj.officeLocation || ''
    
    const locationStr = typeof location === 'string'
      ? location
      : location?.name || location?.city || location?.addressLocality || ''
    
    return {
      atsJobId: id,
      title: String(title).trim(),
      companyName: obj.company || obj.companyName || company,
      location: String(locationStr).trim(),
      url: rawUrl || '',
      postDate: obj.datePosted || obj.postedDate || obj.posted_date || obj.createdAt || '',
    }
  }

  function extractPostDate(el: Element | null): string {
    if (!el) return ''
    const timeEl = el.querySelector('time[datetime]')
    if (timeEl) return timeEl.getAttribute('datetime') || timeEl.textContent?.trim() || ''
    const text = el.textContent || ''
    const dateMatch = text.match(/\d{4}-\d{2}-\d{2}/)
    return dateMatch?.[0] || ''
  }

  function scrapeEightfoldDOM(doc: Document, url: string): { jobs: ScrapedJob[], strategy: string } {
    const cards = doc.querySelectorAll(
      '[class*="job-card"], [class*="JobCard"], [class*="position-card"], ' +
      '[data-ph-at-id="job-item"], [class*="card--job"]'
    )
    if (cards.length > 0) {
      const jobs = Array.from(cards).map(card => {
        const titleEl = card.querySelector(
          '[class*="job-title"], [class*="JobTitle"], [data-ph-at-id="job-title"], h2, h3'
        )
        const locationEl = card.querySelector(
          '[class*="job-location"], [class*="location"], [data-ph-at-id="job-location"]'
        )
        const link = card.querySelector('a[href]') || (card.tagName === 'A' ? card : null)
        const href = link?.getAttribute('href') || ''
        const fullUrl = href.startsWith('http') ? href : new URL(href, url).href
        
        const idMatch = fullUrl.match(/\/job\/(\d+)/) ||
                        fullUrl.match(/job_id=(\d+)/) ||
                        fullUrl.match(/requisitionId=([^&]+)/)
        const jobId = idMatch?.[1] || titleEl?.textContent?.trim() || ''
        
        return {
          atsJobId: jobId,
          title: titleEl?.textContent?.trim() || '',
          companyName: extractCompanyFromUrl(url),
          location: locationEl?.textContent?.trim() || '',
          url: fullUrl || url,
          postDate: extractPostDate(card),
        }
      }).filter(j => j.title && j.atsJobId)
      if (jobs.length > 0) return { jobs, strategy: 'eightfold-job-card' }
    }
    
    const nextData = extractNextJsData(doc)
    if (nextData) {
      const positions = nextData?.props?.pageProps?.positions ||
                        nextData?.props?.pageProps?.jobs ||
                        nextData?.query?.positions || []
      if (positions.length > 0) {
        const jobs = positions.map((p: any) => ({
          atsJobId: String(p.id || p.job_id || p.requisitionId || ''),
          title: p.name || p.title || p.job_title || '',
          companyName: extractCompanyFromUrl(url),
          location: p.location || p.city || (Array.isArray(p.locations) ? p.locations[0] : '') || '',
          url: p.url || `${new URL(url).origin}/careers/job/${p.id}`,
          postDate: p.posted_date || p.datePosted || '',
        })).filter((j: any) => j.title && j.atsJobId)
        if (jobs.length > 0) return { jobs, strategy: 'eightfold-next-data' }
      }
    }
    
    const jsonLd = extractJsonLdJobs(doc)
    if (jsonLd.length > 0) return { jobs: jsonLd, strategy: 'eightfold-json-ld' }
    
    return { jobs: [], strategy: 'none' }
  }

  function scrapeGoogleCareersDOM(doc: Document, url: string): { jobs: ScrapedJob[], strategy: string } {
    const jobLinks = Array.from(doc.querySelectorAll('a[href*="/jobs/results/"]'))
      .filter(a => {
        const href = a.getAttribute('href') || ''
        return /\/jobs\/results\/\d+/.test(href)
      })
    
    if (jobLinks.length > 0) {
      const seen = new Set<string>()
      const jobs = jobLinks.map(link => {
        const href = link.getAttribute('href') || ''
        const idMatch = href.match(/\/jobs\/results\/(\d+)/)
        const id = idMatch?.[1] || ''
        if (!id || seen.has(id)) return null
        seen.add(id)
        
        const card = link.closest('li, [role="listitem"], [class*="card"], [class*="Card"]')
        const titleEl = card?.querySelector('h3, h2, [class*="title"], [class*="Title"]')
        const title = titleEl?.textContent?.trim() || link.textContent?.trim() || ''
        
        const spans = card?.querySelectorAll('span, div')
        let location = ''
        if (spans) {
          for (const span of spans) {
            const text = span.textContent?.trim() || ''
            if (text.includes(',') && text.length < 80 && !text.includes('·')) {
              location = text
              break
            }
          }
        }
        
        return {
          atsJobId: id,
          title,
          companyName: 'Google',
          location,
          url: href.startsWith('http') ? href : `https://www.google.com${href}`,
          postDate: extractPostDate(card || link),
        }
      }).filter(Boolean) as ScrapedJob[]
      
      if (jobs.length > 0) return { jobs, strategy: 'google-job-links' }
    }
    
    const nextData = extractNextJsData(doc)
    if (nextData) {
      const jobs = extractJobsFromAnyJsonTree(nextData, 'google.com')
      if (jobs.length > 0) return { jobs, strategy: 'google-next-data' }
    }
    
    const jsonLd = extractJsonLdJobs(doc)
    if (jsonLd.length > 0) return { jobs: jsonLd.map(j => ({ ...j, companyName: 'Google' })), strategy: 'google-json-ld' }
    
    return { jobs: [], strategy: 'none' }
  }

  function scrapeTaleoDOM(doc: Document, url: string): { jobs: ScrapedJob[], strategy: string } {
    const rows = doc.querySelectorAll(
      'table.ogResultsTable tr[class*="even"], table.ogResultsTable tr[class*="odd"], ' +
      'tr.listSectionContents'
    )
    
    if (rows.length > 0) {
      const jobs = Array.from(rows).map(row => {
        const titleLink = row.querySelector('a[href*="jobdetail"]')
        if (!titleLink) return null
        const href = titleLink.getAttribute('href') || ''
        const idMatch = href.match(/job=([A-Z0-9]+)/) || href.match(/jobId=([^&]+)/)
        const cells = row.querySelectorAll('td')
        const location = cells[1]?.textContent?.trim() || cells[2]?.textContent?.trim() || ''
        return {
          atsJobId: idMatch?.[1] || href,
          title: titleLink.textContent?.trim() || '',
          companyName: extractCompanyFromUrl(url),
          location,
          url: href.startsWith('http') ? href : new URL(href, url).href,
        }
      }).filter(Boolean) as ScrapedJob[]
      if (jobs.length > 0) return { jobs, strategy: 'taleo-table' }
    }
    
    const fluidCards = doc.querySelectorAll('[class*="job-tile"], .job-tile-container')
    if (fluidCards.length > 0) {
      const jobs = Array.from(fluidCards).map(card => {
        const titleEl = card.querySelector('.job-title, [class*="title"]')
        const link = card.querySelector('a')
        const href = link?.getAttribute('href') || ''
        const idMatch = href.match(/job=([^&]+)/) || href.match(/jobId=([^&]+)/)
        return {
          atsJobId: idMatch?.[1] || '',
          title: titleEl?.textContent?.trim() || '',
          companyName: extractCompanyFromUrl(url),
          location: card.querySelector('[class*="location"]')?.textContent?.trim() || '',
          url: href.startsWith('http') ? href : new URL(href, url).href,
        }
      }).filter(j => j.title && j.atsJobId)
      if (jobs.length > 0) return { jobs, strategy: 'taleo-fluid' }
    }
    
    return { jobs: [], strategy: 'none' }
  }

  function scrapeICIMSDOM(doc: Document, url: string): { jobs: ScrapedJob[], strategy: string } {
    const jobItems = doc.querySelectorAll(
      '.iCIMS_JobsTable .iCIMS_Expandable_Container, ' +
      '.iCIMS_JobsTable tr.iCIMS_TableRow, ' +
      '[class*="job-listing"], [id*="jobLink"]'
    )
    
    if (jobItems.length > 0) {
      const jobs = Array.from(jobItems).map(item => {
        const link = item.querySelector('a[href*="/jobs/"]')
        const href = link?.getAttribute('href') || ''
        const idMatch = href.match(/\/jobs\/(\d+)/)
        const titleEl = item.querySelector('.iCIMS_JobTitle, h3, [class*="title"], a')
        const locationEl = item.querySelector('.iCIMS_JobLocation, [class*="location"]')
        return {
          atsJobId: idMatch?.[1] || href,
          title: titleEl?.textContent?.trim() || link?.textContent?.trim() || '',
          companyName: extractCompanyFromUrl(url),
          location: locationEl?.textContent?.trim() || '',
          url: href.startsWith('http') ? href : new URL(href, url).href,
        }
      }).filter(j => j.title && j.atsJobId)
      if (jobs.length > 0) return { jobs, strategy: 'icims-table' }
    }
    
    return scrapeByJobLinks(doc, url, '/jobs/')
  }

  function scrapeSuccessFactorsDOM(doc: Document, url: string): { jobs: ScrapedJob[], strategy: string } {
    const containers = doc.querySelectorAll(
      '[class*="jobReqTile"], [id*="careerSiteJobList"] li, ' +
      '.jd-search-result, [class*="job-result-item"]'
    )
    
    if (containers.length > 0) {
      const jobs = Array.from(containers).map(el => {
        const titleEl = el.querySelector('[class*="JobTitle"], [id*="JDTitle"], a[title], h3')
        const link = el.querySelector('a')
        const href = link?.getAttribute('href') || titleEl?.getAttribute('href') || ''
        const idMatch = href.match(/jobId=([^&]+)/) ||
                        href.match(/\/careers\/jobdetails\?jobId=([^&]+)/) ||
                        href.match(/reqId=([^&]+)/)
        const locationEl = el.querySelector('[class*="location"], [id*="location"], [class*="Location"]')
        return {
          atsJobId: idMatch?.[1] || '',
          title: titleEl?.textContent?.trim() || titleEl?.getAttribute('title') || '',
          companyName: extractCompanyFromUrl(url),
          location: locationEl?.textContent?.trim() || '',
          url: href.startsWith('http') ? href : new URL(href, url).href,
        }
      }).filter(j => j.title && j.atsJobId)
      if (jobs.length > 0) return { jobs, strategy: 'successfactors-tiles' }
    }
    
    return { jobs: [], strategy: 'none' }
  }

  function scrapeJobviteDOM(doc: Document, url: string): { jobs: ScrapedJob[], strategy: string } {
    const listings = doc.querySelectorAll('.jv-job-list-item, [class*="jv-job"], li.jv-job-list-name')
    
    if (listings.length > 0) {
      const jobs = Array.from(listings).map(el => {
        const link = el.querySelector('a[href*="jv-job-detail"]') || el.querySelector('a')
        const href = link?.getAttribute('href') || ''
        const idMatch = href.match(/jv-job-detail-([^/]+)/) || href.match(/jobId=([^&]+)/)
        const locationEl = el.querySelector('.jv-job-location, [class*="location"]')
        return {
          atsJobId: idMatch?.[1] || href.split('/').pop() || '',
          title: link?.textContent?.trim() || el.querySelector('h3,h4')?.textContent?.trim() || '',
          companyName: extractCompanyFromUrl(url),
          location: locationEl?.textContent?.trim() || '',
          url: href.startsWith('http') ? href : new URL(href, url).href,
        }
      }).filter(j => j.title && j.atsJobId)
      if (jobs.length > 0) return { jobs, strategy: 'jobvite-list' }
    }
    
    return scrapeByJobLinks(doc, url, '/jobs/')
  }

  function scrapePhenom(doc: Document, url: string): { jobs: ScrapedJob[], strategy: string } {
    const scripts = Array.from(doc.querySelectorAll('script:not([src])'))
    for (const script of scripts) {
      const text = script.textContent || ''
      for (const pattern of ['__REDUX_STATE__', '__PHENOM__', 'window.phenom', '__INITIAL_DATA__']) {
        const idx = text.indexOf(pattern)
        if (idx === -1) continue
        try {
          const jsonStart = text.indexOf('{', idx)
          const jsonStr = extractBalancedJson(text, jsonStart)
          if (!jsonStr) continue
          const data = JSON.parse(jsonStr)
          const jobs = extractJobsFromAnyJsonTree(data, extractCompanyFromUrl(url))
          if (jobs.length > 0) return { jobs, strategy: `phenom-${pattern}` }
        } catch {}
      }
    }
    
    return scrapeEightfoldDOM(doc, url)
  }
