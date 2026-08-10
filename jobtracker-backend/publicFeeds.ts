export interface PublicJob {
  id: string;
  title: string;
  location: string;
  url: string;
  companyName?: string;
}

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

async function fetchWithBackoff(url: string, options: any = {}, maxRetries = 2): Promise<Response> {
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429) {
        if (attempt < maxRetries) {
          const waitTime = Math.pow(2, attempt) * 1000;
          await delay(waitTime);
          attempt++;
          continue;
        }
      }
      return res;
    } catch (e) {
      if (attempt < maxRetries) {
        const waitTime = Math.pow(2, attempt) * 1000;
        await delay(waitTime);
        attempt++;
        continue;
      }
      throw e;
    }
  }
  throw new Error('Max retries reached');
}

export async function fetchGreenhouseJobs(boardSlug: string): Promise<PublicJob[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${boardSlug}/jobs`;
  const res = await fetchWithBackoff(url);
  if (!res.ok) throw new Error(`Greenhouse API error: ${res.status}`);
  const data = await res.json();
  if (!data.jobs) return [];
  return data.jobs.map((j: any) => ({
    id: String(j.id),
    title: j.title || '',
    location: j.location?.name || '',
    url: j.absolute_url || '',
  }));
}

export async function fetchLeverJobs(boardSlug: string): Promise<PublicJob[]> {
  const url = `https://api.lever.co/v0/postings/${boardSlug}?mode=json`;
  const res = await fetchWithBackoff(url);
  if (!res.ok) throw new Error(`Lever API error: ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.map((j: any) => ({
    id: String(j.id),
    title: j.text || '',
    location: j.categories?.location || j.categories?.commitment || '',
    url: j.hostedUrl || '',
  }));
}

export async function fetchAshbyJobs(boardSlug: string): Promise<PublicJob[]> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${boardSlug}`;
  const res = await fetchWithBackoff(url);
  if (!res.ok) throw new Error(`Ashby API error: ${res.status}`);
  const data = await res.json();
  if (!data.jobs) return [];
  return data.jobs.map((j: any) => ({
    id: String(j.id),
    title: j.title || '',
    location: j.location || '',
    url: j.jobUrl || '',
  }));
}

export async function fetchWorkdayJobs(tenantAndSite: string): Promise<PublicJob[]> {
  // TenantAndSite expected format: "tenant/site"
  const parts = tenantAndSite.split('/');
  if (parts.length !== 2) throw new Error(`Invalid workday boardSlug format: ${tenantAndSite}`);
  const tenant = parts[0];
  const site = parts[1];
  
  const wdn = 'myworkdayjobs.com'; // Some use wd1, wd3, wd5. If the user didn't specify wdN, just use standard or wd3.
  // We'll assume the boardSlug provides the tenant.
  // In prompt: {tenant}.wd{n}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
  // If we only have boardSlug="amazon/amazon_jobs", we don't know {n}. We might have to guess or assume the tenant name includes .wd3 if it's there.
  // For simplicity, let's just query {tenant}.myworkdayjobs.com or let the boardSlug dictate the host.
  // Actually, Workday often redirects or allows myworkdayjobs.com without wdN.
  
  // To handle the `wd{n}` we can extract it if the boardSlug is `tenant.wd3/site`.
  let hostPrefix = tenant;
  let tenantName = tenant;
  if (tenant.includes('.')) {
    tenantName = tenant.split('.')[0];
  }

  const url = `https://${hostPrefix}.myworkdayjobs.com/wday/cxs/${tenantName}/${site}/jobs`;
  const res = await fetchWithBackoff(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ limit: 50, offset: 0 })
  });
  
  if (res.status === 401 || res.status === 403) {
    console.warn(`[PublicFeeds] Workday returned ${res.status} for ${url}. Skipping.`);
    return [];
  }
  
  if (!res.ok) throw new Error(`Workday API error: ${res.status}`);
  const data = await res.json();
  if (!data.jobPostings) return [];
  
  return data.jobPostings.map((j: any) => {
    // externalPath is usually /job/Location/Title_ID
    const jobUrl = `https://${hostPrefix}.myworkdayjobs.com/en-US/${site}${j.externalPath}`;
    return {
      id: j.bulletFields?.[0] || j.externalPath || String(Math.random()),
      title: j.title || '',
      location: j.locationsText || '',
      url: jobUrl,
    };
  });
}

export async function fetchPublicJobs(atsType: string, boardSlug: string): Promise<PublicJob[]> {
  switch (atsType) {
    case 'greenhouse': return fetchGreenhouseJobs(boardSlug);
    case 'lever': return fetchLeverJobs(boardSlug);
    case 'ashby': return fetchAshbyJobs(boardSlug);
    case 'workday': return fetchWorkdayJobs(boardSlug);
    default:
      throw new Error(`Unsupported ATS type for public feeds: ${atsType}`);
  }
}
