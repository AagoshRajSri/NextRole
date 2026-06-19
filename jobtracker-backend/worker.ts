import { Worker, Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { scrapeJobsWithResult, ScraperResult } from './scraper.js';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  extractCompanyFromUrl,
  jobMatchesPrefs,
  decryptData,
  type UserPrefs,
} from './utils.js';

chromium.use(stealth());
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
monitorQueue.on('error', (err) => {
  // Suppress Queue connection errors
});

console.log('[Worker] Connected to Redis. Initializing worker...');

// ────────────────────────────────────────────────────────
// MAIN SCRAPE WORKER
// ────────────────────────────────────────────────────────

async function scrapeWithRetry(url: string, cookies: Array<Record<string, any>> = [], maxRetries = 2): Promise<ScraperResult> {
  let lastResult: ScraperResult | null = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = 30000 * Math.pow(2, attempt - 1);
      console.log(`[worker] Retry ${attempt}/${maxRetries} for ${url} in ${delay/1000}s`);
      await new Promise(r => setTimeout(r, delay));
    }
    
    const result = await scrapeJobsWithResult(url, { cookies });
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

const worker = new Worker('monitorQueue', async (job) => {  // Default: scrape job
  const { searchId, url } = job.data;
  console.log(`\n[Worker] Processing scrape: ${searchId} → ${url}`);

  try {
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

    // Decrypt stored session cookies for auth-wall bypass (LinkedIn etc.)
    let sessionCookies: Array<Record<string, any>> = [];
    if (userProfile?.sessionCookies) {
      try {
        const decrypted = decryptData(userProfile.sessionCookies as string);
        if (decrypted) sessionCookies = JSON.parse(decrypted);
        console.log(`[Worker] Loaded ${sessionCookies.length} session cookies for auth bypass.`);
      } catch (e) {
        console.warn('[Worker] Failed to decrypt session cookies (non-fatal):', e);
      }
    }

    // Scrape the page with retries + cookie injection
    const result = await scrapeWithRetry(url, sessionCookies);

    // Update DB with scrape result regardless of outcome
    await prisma.trackedSearch.update({
      where: { id: searchId },
      data: {
        lastScrapedAt: new Date(),
        lastScrapeStatus: result.status,
        lastScrapeError: result.errorMessage || result.blockedReason || null,
      }
    });

    // Only process jobs if we got something useful
    if (result.status !== 'ok' && result.status !== 'partial') {
      console.log(`[Worker] Skipping job processing for ${url}: ${result.status}`);
      return;
    }

    const scrapedJobs = result.jobs;

    // Determine new jobs
    const existingSnapshots = await prisma.jobSnapshot.findMany({
      where: { trackedSearchId: searchId },
    });
    const existingIds = new Set(existingSnapshots.map(s => s.atsJobId));
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

          // Premium auto-tailoring (only for premium users)
          if (userProfile?.isPremium) {
            const fullDesc = await scrapeFullJobDescription(job.url);
            await handlePremiumAiTailoring(search.userId, companyName, savedJob, fullDesc);
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
// SCHEDULED CRON SCRAPER (every 15 minutes)
// ────────────────────────────────────────────────────────
setInterval(async () => {
  console.log('[Scheduler] Queuing scrape jobs for all tracked searches...');
  try {
    const searches = await prisma.trackedSearch.findMany();
    console.log(`[Scheduler] Found ${searches.length} tracked searches.`);
    for (const search of searches) {
      await monitorQueue.add('cron-scrape', { searchId: search.id, url: search.url });
    }
  } catch (err) {
    console.error('[Scheduler] Error:', err);
  }
}, 15 * 60 * 1000);

console.log('[Scheduler] Active — 15 min interval.');

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
// ────────────────────────────────────────────────────────
async function scrapeFullJobDescription(url: string): Promise<string> {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    await page.waitForTimeout(Math.floor(Math.random() * 800) + 200);
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
    await browser.close();
  }
}

// ────────────────────────────────────────────────────────
// PREMIUM AI RESUME TAILORING PIPELINE
// ────────────────────────────────────────────────────────
async function handlePremiumAiTailoring(
  userId: string,
  companyName: string,
  jobSnapshot: any,
  jobDescription: string,
): Promise<void> {
  console.log(`[AI Tailoring] Starting resume tailoring for user: ${userId}, Job: ${jobSnapshot.title} at ${companyName}`);
  
  try {
    const userProfile = await prisma.userProfile.findUnique({ where: { userId } });
    if (!userProfile) {
      console.warn(`[AI Tailoring] User profile not found for user: ${userId}`);
      return;
    }

    const hasResumeData = userProfile.experience || userProfile.skills || userProfile.education || userProfile.projects;
    if (!hasResumeData) {
      console.log(`[AI Tailoring] User has no resume details in profile. Skipping tailoring.`);
      return;
    }

    const promptText = `
You are an expert resume writer and career coach.
Your task is to tailor the user's resume sections (Experience, Skills, Education, Projects) to align with the following job description.

Job Title: ${jobSnapshot.title}
Company: ${companyName}
Location: ${jobSnapshot.location || 'Not Specified'}
Job Description:
${jobDescription}

User's Current Resume Details:
Experience:
${userProfile.experience || 'None'}

Skills:
${userProfile.skills || 'None'}

Education:
${userProfile.education || 'None'}

Projects:
${userProfile.projects || 'None'}

Please tailor these sections to highlight relevant skills and achievements that match the requirements of the job.
Keep the output professional, formatted in clean markdown, containing sections for Tailored Experience, Tailored Skills, Tailored Projects, and Education.
Do not invent facts, only rephrase and emphasize existing experiences.
`;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    let resumeText = '';

    if (!apiKey || apiKey === 'sk-ant-123456') {
      console.log('[AI Tailoring] Dev/Mock mode enabled. Generating mock tailored resume.');
      resumeText = `
# Tailored Resume for ${userProfile.name || 'User'}
Target: ${jobSnapshot.title} at ${companyName}

## Professional Summary
Accomplished professional tailored for the ${jobSnapshot.title} position at ${companyName}.

## Tailored Experience
${userProfile.experience || 'No experience details specified.'}

## Tailored Skills
${userProfile.skills || 'No skills details specified.'}

## Tailored Projects
${userProfile.projects || 'No project details specified.'}

## Education
${userProfile.education || 'No education details specified.'}
      `.trim();
    } else {
      console.log('[AI Tailoring] Sending request to Anthropic Claude...');
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-3-5-sonnet-20240620',
          max_tokens: 3000,
          messages: [{ role: 'user', content: promptText }],
        }),
      });

      if (!response.ok) {
        throw new Error(`Anthropic API returned status ${response.status}: ${await response.text()}`);
      }

      const data = await response.json() as any;
      resumeText = data.content?.[0]?.text || '';
    }

    if (resumeText) {
      await prisma.tailoredResume.create({
        data: {
          jobSnapshotId: jobSnapshot.id,
          resumeText,
          pdfUrl: null,
        },
      });
      console.log(`[AI Tailoring] ✅ Successfully saved tailored resume for job snapshot: ${jobSnapshot.id}`);
    } else {
      console.warn('[AI Tailoring] Tailored resume generation resulted in empty text.');
    }
  } catch (err: any) {
    console.error(`[AI Tailoring] Error in resume tailoring pipeline:`, err);
  }
}

// ────────────────────────────────────────────────────────

