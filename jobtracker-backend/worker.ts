import { Worker, Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { BrowserFactory } from './lib/browserFactory.js';
import { scrapeJobsWithResult, ScraperResult } from './scraper.js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  extractCompanyFromUrl,
  jobMatchesPrefs,
  type UserPrefs,
} from './utils.js';
import { fetchPublicJobs } from './publicFeeds.js';
import { tailorResume } from './lib/tailorResume.js';
import { embedText, jobToEmbedText, profileToEmbedText } from './lib/embeddings.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prisma = new PrismaClient();

// Public resume directory
const publicResumeDir = path.join(__dirname, 'public', 'resumes');
if (!fs.existsSync(publicResumeDir)) {
  fs.mkdirSync(publicResumeDir, { recursive: true });
}

// ────────────────────────────────────────────────────────
// REDIS + BULLMQ SETUP
// ────────────────────────────────────────────────────────
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
connection.on('error', (err) => {
  // Suppress unhandled error events
});
const redisPublisher = new Redis(redisUrl, { maxRetriesPerRequest: null });
redisPublisher.on('error', (err) => {
  // Suppress unhandled error events
});
const monitorQueue = new Queue('monitorQueue', { connection });
monitorQueue.on('error', (err: unknown) => {
  // Suppress Queue connection errors
});

console.log('[Worker] Connected to Redis. Initializing worker...');

// ────────────────────────────────────────────────────────
// MAIN SCRAPE WORKER
// ────────────────────────────────────────────────────────

async function scrapeWithRetry(url: string, maxRetries = 2): Promise<ScraperResult> {
  let lastResult: ScraperResult | null = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = 30000 * Math.pow(2, attempt - 1);
      console.log(`[worker] Retry ${attempt}/${maxRetries} for ${url} in ${delay/1000}s`);
      await new Promise(r => setTimeout(r, delay));
    }
    
    const result = await scrapeJobsWithResult(url);
    lastResult = result;
    
    if (result.status === 'ok' || result.status === 'empty') break;
    
    if (result.status === 'blocked') {
      console.warn(`[worker] ${url} is blocked (${result.blockedReason}). Backing off.`);
      break;
    }
    
    // Don't retry validation errors (bad URLs) — they won't recover
    if (result.status === 'error' && result.errorMessage?.startsWith('Skipped:')) {
      console.warn(`[worker] ${result.errorMessage}`);
      break;
    }
    
    console.warn(`[worker] Attempt ${attempt} failed for ${url}: ${result.errorMessage}`);
  }
  
  return lastResult!;
}


const worker = new Worker('monitorQueue', async (job: any) => {
  const { searchId, url } = job.data;
  console.log(`\n[Worker] Processing ${job.name || 'scrape'}: ${searchId}`);

  try {
    // ────────────────────────────────────────────────────────
    // BACKFILL JOB: Retries failed/pending embeddings
    // ────────────────────────────────────────────────────────
    if (job.name === 'embedding-backfill') {
      try {
        console.log('[Worker] Starting embedding backfill...');
        // 1. Process JobSnapshots
        const pendingJobs = await prisma.jobSnapshot.findMany({
          where: {
            embeddingStatus: { in: ['pending', 'failed'] },
            embeddingRetries: { lt: 5 }
          },
          take: 50
        });

        for (const snap of pendingJobs) {
          try {
            const vec = await embedText(jobToEmbedText({ title: snap.title, companyName: snap.companyName || '', location: snap.location }));
            // SQL injection prevention: vec (JSON array) and snap.id are bound as
            // tagged-template parameters — never concatenated into the SQL string.
            await prisma.$executeRaw`
              UPDATE "JobSnapshot"
              SET    "jobEmbedding" = ${JSON.stringify(vec)}::vector,
                     "embeddingStatus" = 'ok'
              WHERE  id = ${snap.id}
            `;
            console.log(`[Worker] Backfilled embedding for job ${snap.id}`);
          } catch (err: any) {
            console.error(`[Worker] Backfill failed for job ${snap.id}:`, err.message);
            await prisma.jobSnapshot.update({
              where: { id: snap.id },
              data: {
                embeddingStatus: 'failed',
                embeddingRetries: { increment: 1 }
              }
            });
          }
        }

        // 2. Process UserProfiles
        const pendingProfiles = await prisma.userProfile.findMany({
          where: {
            embeddingStatus: { in: ['pending', 'failed'] },
            embeddingRetries: { lt: 5 }
          },
          take: 50
        });

        for (const prof of pendingProfiles) {
          try {
            const vec = await embedText(profileToEmbedText({
              targetRoles: prof.targetRoles,
              locations: prof.locations,
              experienceLevel: prof.experienceLevel,
              skills: prof.skills,
              experience: prof.experience
            }));
            // SQL injection prevention: vec (JSON array) and prof.userId are bound
            // as tagged-template parameters — never concatenated into the SQL string.
            await prisma.$executeRaw`
              UPDATE "UserProfile"
              SET    "profileEmbedding" = ${JSON.stringify(vec)}::vector,
                     "embeddingStatus" = 'ok'
              WHERE  "userId" = ${prof.userId}
            `;
            console.log(`[Worker] Backfilled embedding for profile ${prof.userId}`);
          } catch (err: any) {
            console.error(`[Worker] Backfill failed for profile ${prof.userId}:`, err.message);
            await prisma.userProfile.update({
              where: { userId: prof.userId },
              data: {
                embeddingStatus: 'failed',
                embeddingRetries: { increment: 1 }
              }
            });
          }
        }
      } catch (err: any) {
        console.error('[Worker] Backfill job failed:', err.message);
      }
      return;
    }

    // ────────────────────────────────────────────────────────
    // STANDARD SCRAPING JOB
    // ────────────────────────────────────────────────────────
    const search = await prisma.trackedSearch.findUnique({ where: { id: searchId } });
    if (!search) {
      console.error(`[Worker] TrackedSearch ${searchId} not found.`);
      return;
    }

    // Fetch user preferences for keyword matching
    const userProfile = await prisma.userProfile.findUnique({ where: { userId: search.userId } });
    const prefs: UserPrefs = {
      targetRoles: userProfile?.targetRoles ?? [],
      watchlistCompanies: userProfile?.watchlistCompanies ?? [],
      locations: userProfile?.locations ?? [],
      experienceLevel: userProfile?.experienceLevel ?? undefined,
    };

    let resultStatus = 'ok';
    let resultError: string | null = null;
    let scrapedJobs: Array<{ atsJobId: string, title: string, location: string, url: string, companyName?: string }> = [];

    if (job.name === 'public-feed-sync' && search.atsType && search.boardSlug) {
      try {
        const publicJobs = await fetchPublicJobs(search.atsType, search.boardSlug);
        scrapedJobs = publicJobs.map(j => ({
          atsJobId: j.id,
          title: j.title,
          location: j.location,
          url: j.url,
          companyName: j.companyName,
        }));
      } catch (err: any) {
        resultStatus = 'error';
        resultError = err.message;
      }
    } else {
      // Restricted platforms (LinkedIn, Google Careers, Amazon Jobs) are NEVER scraped
      // unattended via background cron. They are restricted to user-initiated extension scans.
      const urlPlatform = search.platform || (await import('./utils.js')).detectPlatform(url);
      if (['linkedin', 'google', 'amazon_jobs'].includes(urlPlatform)) {
        console.log(`[Worker] Skipping background cron sweep for restricted platform "${urlPlatform}" (${url}). Use extension live-tab scan.`);
        await prisma.trackedSearch.update({
          where: { id: searchId },
          data: {
            lastScrapedAt: new Date(),
            lastScrapeStatus: 'skipped',
            lastScrapeError: `Background scraping disabled for ${urlPlatform} — use extension live-tab scan`,
          }
        });
        return;
      }

      // Scrape the page with retries
      const result = await scrapeWithRetry(url);
      resultStatus = result.blockedReason === 'robots-disallowed' ? 'robots-disallowed' : result.status;
      resultError = result.errorMessage || result.blockedReason || null;
      if (result.status === 'ok' || result.status === 'partial') {
        scrapedJobs = result.jobs;
      }
    }

    // Update DB with scrape result regardless of outcome
    await prisma.trackedSearch.update({
      where: { id: searchId },
      data: {
        lastScrapedAt: new Date(),
        lastScrapeStatus: resultStatus,
        lastScrapeError: resultError,
      }
    });

    // Only process jobs if we got something useful
    if (resultStatus !== 'ok' && resultStatus !== 'partial') {
      console.log(`[Worker] Skipping job processing for ${searchId}: ${resultStatus}`);
      return;
    }


    // Determine new jobs
    const existingSnapshots = await prisma.jobSnapshot.findMany({
      where: { trackedSearchId: searchId },
    });
    const existingIds = new Set(existingSnapshots.map((s: any) => s.atsJobId));
    const newJobs = scrapedJobs.filter(j => !existingIds.has(j.atsJobId));

    console.log(`[Worker] Scraped ${scrapedJobs.length}, existing ${existingIds.size}, new ${newJobs.length}`);


    const companyFromUrl = extractCompanyFromUrl(url);
    let matchedCount = 0;

    for (const job of newJobs) {
      try {
        const companyName = job.companyName || companyFromUrl || 'Unknown';

        // Run keyword matching
        const match = jobMatchesPrefs(
          { title: job.title, companyName, location: job.location },
          prefs,
        );

        const savedJob = await prisma.jobSnapshot.create({
          data: {
            trackedSearchId: searchId,
            atsJobId: job.atsJobId,
            title: job.title,
            location: job.location,
            url: job.url,
            companyName,
            isNew: match.matched,
            matchReason: match.matched ? match.reason : null,
          },
        });

        // Populate jobEmbedding asynchronously (fire-and-forget so ingest is never blocked)
        embedText(jobToEmbedText({ title: job.title, companyName, location: job.location }))
          .then(async vec => {
            // SQL injection prevention: vec (JSON array) and savedJob.id are bound
            // as tagged-template parameters — never concatenated into the SQL string.
            await prisma.$executeRaw`
              UPDATE "JobSnapshot"
              SET    "jobEmbedding" = ${JSON.stringify(vec)}::vector,
                     "embeddingStatus" = 'ok'
              WHERE  id = ${savedJob.id}
            `
          })
          .catch(async err => {
            console.error(`[Worker] jobEmbedding write failed for JobSnapshot ${savedJob.id}:`, err.message);
            await prisma.jobSnapshot.update({ where: { id: savedJob.id }, data: { embeddingStatus: 'failed' } }).catch(() => {});
          });

        if (match.matched) {
          matchedCount++;
          console.log(`[Worker] ✅ MATCHED: "${job.title}" — ${match.reason}`);

          // Publish real-time alert via Redis
          redisPublisher.publish('jobAlerts', JSON.stringify({
            userId: search.userId,
            job: {
              id: savedJob.id,
              title: job.title,
              companyName,
              location: job.location,
              url: job.url,
              matchReason: match.reason,
            },
          }));

          // Send email if user has emailAlerts enabled AND alertMode is instant
          if (userProfile?.emailAlerts && userProfile?.alertMode === 'instant') {
            await sendJobEmailAlert(search.userId, companyName, job, match.reason, userProfile.email);
          }
        } else {
          console.log(`[Worker] ⏭️  No match: "${job.title}"`);
        }
      } catch (innerErr: any) {
        console.error(`[Worker] Error processing job ${job.atsJobId}:`, innerErr.message);
      }
    }

    // Update tracked search status
    const newJobCount = await prisma.jobSnapshot.count({
      where: { trackedSearchId: searchId, isNew: true },
    });

    await prisma.trackedSearch.update({
      where: { id: searchId },
      data: {
        lastScrapedAt: new Date(),
        lastScrapeStatus: 'ok',
        lastScrapeError: null,
        newJobCount,
      },
    });

    console.log(`[Worker] Done. ${matchedCount} matched, ${newJobCount} total unseen.`);

  } catch (error: any) {
    console.error(`[Worker] Fatal error for job ${job.name}:`, error);
    throw error;
  }
}, { connection });



// ────────────────────────────────────────────────────────
// PUBLIC FEED CRON (every 15 minutes)
// ────────────────────────────────────────────────────────
setInterval(async () => {
  console.log('[Scheduler] Queuing public feed syncs...');
  try {
    const searches = await prisma.trackedSearch.findMany({
      where: {
        atsType: { not: null },
        boardSlug: { not: null }
      }
    });
    console.log(`[Scheduler] Found ${searches.length} public feeds to sync.`);
    for (const search of searches) {
      if (search.atsType && search.boardSlug) {
        await monitorQueue.add('public-feed-sync', { searchId: search.id, url: search.url });
      }
    }
  } catch (err) {
    console.error('[Scheduler] Error querying public feeds:', err);
  }
}, 15 * 60 * 1000);

// ────────────────────────────────────────────────────────
// EMAIL ALERTS
// ────────────────────────────────────────────────────────
async function sendJobEmailAlert(
  userId: string,
  company: string,
  job: { title: string; location: string; url: string },
  matchReason: string,
  userEmail?: string | null,
) {
  const to = userEmail || `user-${userId}@gmail.com`;
  console.log(`[Email Mock] To: ${to} | Subject: ${job.title} at ${company} | Match: ${matchReason}`);
}

// ────────────────────────────────────────────────────────
// FULL JOB DESCRIPTION SCRAPER
// Fetches the rendered HTML of an individual job posting page and extracts
// the description text.  Uses BrowserFactory so configuration is centralised.
// ────────────────────────────────────────────────────────
async function scrapeFullJobDescription(url: string): Promise<string> {
  const { page, cleanup } = await BrowserFactory.getPage({ disableResourceBlocking: true });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const selectors = [
      '#content', '.description', '.posting-description',
      '[data-automation-id="jobDescription"]', '#job-description',
      '.job-description', 'article', 'body',
    ];

    let desc = '';
    for (const sel of selectors) {
      const el = page.locator(sel);
      if (await el.count() > 0) {
        desc = await el.first().innerText();
        if (desc.trim().length > 200) break;
      }
    }
    return desc.trim() || 'No description scraped.';
  } finally {
    await cleanup();
  }
}

// ────────────────────────────────────────────────────────
// PREMIUM AI RESUME TAILORING PIPELINE
// Delegates to the shared lib/tailorResume.ts so the REST endpoint
// and this BullMQ path always use identical Claude/mock logic.
// ────────────────────────────────────────────────────────
async function handlePremiumAiTailoring(
  userId: string,
  companyName: string,
  jobSnapshot: any,
  jobDescription: string,
): Promise<void> {
  console.log(`[AI Tailoring] Starting for user: ${userId}, job: ${jobSnapshot.title} @ ${companyName}`);
  try {
    await tailorResume(prisma, {
      userId,
      jobTitle: jobSnapshot.title,
      companyName,
      jobLocation: jobSnapshot.location,
      jobDescription,
      jobSnapshotId: jobSnapshot.id,
    });
    console.log(`[AI Tailoring] ✅ Done for snapshot ${jobSnapshot.id}`);
  } catch (err: any) {
    console.error('[AI Tailoring] Error:', err.message);
  }
}

// ────────────────────────────────────────────────────────

