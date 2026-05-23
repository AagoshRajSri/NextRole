const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Apple — find the correct state key
console.log('=== APPLE STATE KEYS ===');
const appleRes = await fetch('https://jobs.apple.com/en-us/search?team=Internships-STDNT-INTRN', {
  headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US' }
});
const html = await appleRes.text();
// Find all window.__ assignments
const stateKeys = [...html.matchAll(/window\.__([A-Z_]+)__\s*=/g)].map(m=>m[1]);
console.log('State keys:', stateKeys);

// Try postingTitle pattern (we saw it earlier)
const postIdx = html.indexOf('postingTitle');
if (postIdx > -1) console.log('postingTitle context:', html.substring(postIdx-50, postIdx+300));

// Find all script tags with large JSON
const scripts = [...html.matchAll(/<script[^>]*>([^<]{1000,})<\/script>/g)];
console.log('Large scripts:', scripts.length);
for (const s of scripts.slice(0, 3)) {
  const content = s[1].trim();
  if (content.includes('postingTitle') || content.includes('searchResult')) {
    console.log('Found job data in script:', content.substring(0, 800));
    break;
  }
}

// Google — try the correct careers API
console.log('\n=== GOOGLE CORRECT ENDPOINT ===');
for (const endpoint of [
  'https://careers.google.com/jobs/search/?q=software+engineer&location=&company=Google&jid=&num=10&start=0&dst=true&sort=relevance',
  'https://www.google.com/about/careers/applications/api/jobs',
  'https://careers.google.com/jobs/',
]) {
  const r = await fetch(endpoint, {headers: {'User-Agent': UA, 'Accept': 'application/json,text/html', 'Referer': 'https://careers.google.com/'}});
  console.log(endpoint, '->', r.status, r.headers.get('content-type')?.substring(0,40));
  if (r.ok) {
    const t = await r.text();
    console.log('  first 200:', t.substring(0,200));
  }
}

// LinkedIn full parsing
console.log('\n=== LINKEDIN FULL PARSE ===');
const liRes = await fetch('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=software+engineer&start=0&count=5', {
  headers: { 'User-Agent': UA }
});
const liHtml = await liRes.text();
// Parse job IDs and titles
const urns = [...liHtml.matchAll(/data-entity-urn="urn:li:jobPosting:(\d+)"/g)].map(m=>m[1]);
const titles = [...liHtml.matchAll(/class="sr-only"[^>]*>([^<]+)</g)].map(m=>m[1].trim());
const hrefs = [...liHtml.matchAll(/href="(https:\/\/[^"]*\/jobs\/view\/[^"]+)"/g)].map(m=>m[1]);
console.log('LinkedIn job IDs:', urns.slice(0,5));
console.log('LinkedIn hrefs:', hrefs.slice(0,3));

// LinkedIn company-specific 
console.log('\n=== LINKEDIN COMPANY JOBS ===');
const compRes = await fetch('https://www.linkedin.com/jobs/search?keywords=&location=&f_C=1441', {  // Google company ID
  headers: { 'User-Agent': UA }
});
console.log('Company search status:', compRes.status);
const compHtml = await compRes.text();
const compUrns = [...compHtml.matchAll(/data-entity-urn="urn:li:jobPosting:(\d+)"/g)].map(m=>m[1]);
console.log('Company job IDs:', compUrns.slice(0,5));
