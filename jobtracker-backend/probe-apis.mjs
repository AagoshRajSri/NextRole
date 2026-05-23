const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const r = await fetch('https://jobs.apple.com/en-us/search?team=Internships-STDNT-INTRN', { headers: { 'User-Agent': UA } });
const html = await r.text();
const match = html.match(/window\.__staticRouterHydrationData\s*=\s*JSON\.parse\("(.+?)"\);<\/script>/s);
const jsonStr = match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '').replace(/\\r/g,'');
const data = JSON.parse(jsonStr);
const j = data.loaderData.search.searchResults[0];
console.log('KEYS:', Object.keys(j));
console.log('location field:', JSON.stringify(j.locations || j.location || j.postingDate));
