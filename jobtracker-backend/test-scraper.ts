import { scrapeJobsWithResult } from './scraper.js';

async function main() {
  const args = process.argv.slice(2);
  const url = args.find(a => !a.startsWith('--'));
  const headed = args.includes('--headed');
  const screenshot = args.includes('--screenshot');
  const retriesMatch = args.find(a => a.startsWith('--retries='));
  const retries = retriesMatch ? parseInt(retriesMatch.split('=')[1], 10) : 0;

  if (!url) {
    console.error('Usage: tsx test-scraper.ts <url> [--screenshot] [--headed] [--retries=N]');
    process.exit(1);
  }

  console.log(`\n┌─────────────────────────────────────────────────────────────┐`);
  console.log(`│  NextRole Scraper Test                                       │`);
  console.log(`│  URL: ${url.padEnd(54)}│`);
  
  let result;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      console.log(`│  [Retry ${attempt}/${retries}]...                                           │`);
    }
    
    result = await scrapeJobsWithResult(url, { headed });
    
    if (result.status === 'ok' || result.status === 'empty') break;
    if (result.status === 'blocked') break;
  }

  if (!result) return;

  console.log(`│  Scraper: ${result.platform.padEnd(50)}│`);
  console.log(`│  Duration: ${(result.scrapeDurationMs / 1000).toFixed(1)}s${' '.padEnd(46)}│`);
  console.log(`├─────────────────────────────────────────────────────────────┤`);

  if (result.status === 'ok') {
    console.log(`│  Status: ✓ ok (${result.jobsCount} jobs found)${' '.padEnd(35)}│`);
  } else if (result.status === 'empty') {
    console.log(`│  Status: ⚠ empty (0 jobs found)${' '.padEnd(34)}│`);
  } else if (result.status === 'blocked') {
    console.log(`│  Status: ⛔ blocked (${result.blockedReason})${' '.padEnd(max(0, 42 - (result.blockedReason?.length || 0)))}│`);
  } else {
    console.log(`│  Status: ❌ ${result.status} (${result.errorMessage})${' '.padEnd(max(0, 44 - (result.errorMessage?.length || 0)))}│`);
  }

  if (result.jobsCount > 0) {
    console.log(`├───┬──────────────────────────────────┬────────────┬─────────┤`);
    console.log(`│ # │ Title                            │ Location   │ ID      │`);
    console.log(`├───┼──────────────────────────────────┼────────────┼─────────┤`);
    result.jobs.forEach((job: any, idx: number) => {
      const i = String(idx + 1).padEnd(2);
      const title = (job.title.length > 32 ? job.title.slice(0, 29) + '...' : job.title).padEnd(32);
      const loc = (job.location.length > 10 ? job.location.slice(0, 7) + '...' : job.location).padEnd(10);
      const id = (job.atsJobId.length > 7 ? job.atsJobId.slice(0, 4) + '...' : job.atsJobId).padEnd(7);
      console.log(`│ ${i}│ ${title} │ ${loc} │ ${id} │`);
    });
    console.log(`└───┴──────────────────────────────────┴────────────┴─────────┘`);
  } else {
    console.log(`└─────────────────────────────────────────────────────────────┘`);
  }
}

function max(a: number, b: number) { return a > b ? a : b; }

main().catch(console.error);
