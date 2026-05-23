import { scrapeJobsWithResult } from './scraper.js';

const TEST_URLS = [
  { platform: 'greenhouse',  url: 'https://boards.greenhouse.io/notion' },
  { platform: 'lever',       url: 'https://jobs.lever.co/vercel' },
  { platform: 'workday',     url: 'https://amazon.wd5.myworkdayjobs.com/en-US/External_Careers' },
  { platform: 'linkedin',    url: 'https://www.linkedin.com/company/cloudflare/jobs/' },
  { platform: 'amazon_jobs', url: 'https://amazon.jobs/en/search?base_query=software+engineer&loc_query=india' },
  { platform: 'naukri',      url: 'https://www.naukri.com/software-engineer-jobs' },
  { platform: 'ashby',       url: 'https://jobs.ashbyhq.com/linear' },
  { platform: 'wellfound',   url: 'https://wellfound.com/company/stripe/jobs' },
];

async function main() {
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│  NextRole Scraper Batch Test                                │');
  console.log('├──────────────┬──────────┬───────┬──────────┬────────────────┤');
  console.log('│ Platform     │ Status   │ Jobs  │ Duration │ Error/Block    │');
  console.log('├──────────────┼──────────┼───────┼──────────┼────────────────┤');

  for (const test of TEST_URLS) {
    try {
      const result = await scrapeJobsWithResult(test.url);
      const platform = result.platform.padEnd(12);
      let status = result.status as string;
      if (status === 'ok') status = '✓ ok';
      else if (status === 'empty') status = '⚠ empty';
      else if (status === 'blocked') status = '⛔ block';
      else if (status === 'error') status = '❌ error';
      else if (status === 'partial') status = '⚠ part';
      
      const jobs = String(result.jobsCount).padEnd(5);
      const duration = ((result.scrapeDurationMs) / 1000).toFixed(1) + 's';
      const durPad = duration.padEnd(8);
      
      let msg = '';
      if (result.status === 'blocked') msg = result.blockedReason || '';
      else if (result.status === 'error') msg = result.errorMessage || '';
      msg = msg.slice(0, 14).padEnd(14);
      
      console.log(`│ ${platform} │ ${status.padEnd(8)} │ ${jobs} │ ${durPad} │ ${msg} │`);
    } catch (err: any) {
      console.log(`│ ${test.platform.padEnd(12)} │ ❌ crash │ 0     │          │ ${err.message?.slice(0,14).padEnd(14)} │`);
    }
  }
  console.log('└──────────────┴──────────┴───────┴──────────┴────────────────┘');
}

main().catch(console.error);
