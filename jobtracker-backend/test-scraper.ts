import { scrapeJobs } from './scraper.js';

async function runTest() {
  const testUrl = 'https://jobs.lever.co/palantir';
  console.log(`[Test] Starting manual scrape test for: ${testUrl}`);
  
  try {
    const jobs = await scrapeJobs(testUrl);
    
    console.log('\n=========================================');
    console.log(`[Test] SUCCESS! Scraped ${jobs.length} jobs.`);
    console.log('=========================================');
    
    // Print the first 5 jobs as a sample
    const sample = jobs.slice(0, 5);
    console.log('[Test] Sample of 5 jobs scraped:');
    console.log(JSON.stringify(sample, null, 2));
    
    if (jobs.length > 0) {
      console.log(`\nFirst job parsed:`);
      console.log(`- ID: ${jobs[0].id}`);
      console.log(`- Title: ${jobs[0].title}`);
      console.log(`- Location: ${jobs[0].location}`);
      console.log(`- URL: ${jobs[0].url}`);
    } else {
      console.log('[Test] Warning: No jobs found! Check selectors or page structure.');
    }
  } catch (err) {
    console.error('[Test] FAILED to scrape:', err);
  }
}

runTest();
