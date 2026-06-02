import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { Worker, Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { scrapeJobsWithResult, ScraperResult } from './scraper.js';
import { Resend } from 'resend';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';
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
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });

// Resend email client
const resendKey = process.env.RESEND_API_KEY || '';
const resend = resendKey.startsWith('re_') ? new Resend(resendKey) : null;
const SENDER_EMAIL = process.env.SENDER_EMAIL || 'NextRole Alerts <alerts@nextrole.com>';

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
const redisPublisher = new Redis(redisUrl, { maxRetriesPerRequest: null });
const monitorQueue = new Queue('monitorQueue', { connection });

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

const worker = new Worker('monitorQueue', async (job) => {
  // Route to the right handler
  if (job.name === 'resume-tailoring') {
    return handleResumeTailoring(job.data);
  }

  // Default: scrape job
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
  const emailHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f8fafc; padding: 24px; color: #1e293b; margin: 0; }
          .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 16px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
          .header { background: linear-gradient(135deg, #050D17, #0A1525); padding: 32px 24px; text-align: center; color: #fff; }
          .header h1 { font-size: 24px; font-weight: 700; margin: 0; color: #00E5FF; }
          .body { padding: 32px 24px; }
          .badge { display: inline-block; background: #ecfdf5; color: #059669; font-weight: 600; font-size: 12px; padding: 4px 12px; border-radius: 9999px; margin-bottom: 16px; }
          .match-badge { display: inline-block; background: #f0f9ff; color: #0284c7; font-weight: 600; font-size: 12px; padding: 4px 12px; border-radius: 9999px; margin-bottom: 16px; margin-left: 8px; }
          .job-title { font-size: 22px; font-weight: 700; color: #0f172a; margin: 0 0 8px; }
          .meta { font-size: 14px; color: #64748b; margin-bottom: 24px; }
          .btn { display: inline-block; background: #050D17; color: #00E5FF; font-weight: 600; font-size: 14px; text-decoration: none; padding: 12px 24px; border-radius: 8px; border: 1px solid #00E5FF; }
          .footer { text-align: center; font-size: 12px; color: #94a3b8; padding: 24px; border-top: 1px solid #f1f5f9; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header"><h1>NextRole</h1></div>
          <div class="body">
            <span class="badge">New Job Alert</span>
            <span class="match-badge">Matched: ${matchReason}</span>
            <h2 class="job-title">${job.title}</h2>
            <div class="meta">
              <span>🏢 <strong>${company}</strong></span> · <span>📍 ${job.location}</span>
            </div>
            <p style="font-size: 15px; line-height: 1.6; color: #475569; margin-bottom: 32px;">
              This role matched your keyword: <strong>${matchReason}</strong>
            </p>
            <a href="${job.url}" class="btn" target="_blank">Apply Now →</a>
          </div>
          <div class="footer">
            <p>You received this because you're tracking ${company} on NextRole.</p>
            <p>© 2026 NextRole. All rights reserved.</p>
          </div>
        </div>
      </body>
    </html>
  `;

  const to = userEmail || `user-${userId}@gmail.com`;

  if (!resend) {
    console.log(`[Email Mock] To: ${to} | Subject: ${job.title} at ${company} | Match: ${matchReason}`);
    return;
  }

  try {
    await resend.emails.send({
      from: SENDER_EMAIL,
      to,
      subject: `🚨 New Match: ${job.title} at ${company}`,
      html: emailHtml,
    });
    console.log('[Email] Alert sent via Resend.');
  } catch (err) {
    console.error('[Email] Send failed:', err);
  }
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
// BEDROCK EMBEDDINGS (kept — premium only)
// ────────────────────────────────────────────────────────
async function generateBedrockEmbedding(text: string): Promise<number[]> {
  try {
    const cmd = new InvokeModelCommand({
      modelId: 'amazon.titan-embed-text-v2:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({ inputText: text.substring(0, 8000) }),
    });
    const res = await bedrock.send(cmd);
    const parsed = JSON.parse(new TextDecoder().decode(res.body));
    return parsed.embedding || [];
  } catch (err) {
    console.error('[Bedrock] Embedding failed:', err);
    return [];
  }
}

// ────────────────────────────────────────────────────────
// AI RESUME TAILORING (premium only)
// ────────────────────────────────────────────────────────
async function handleResumeTailoring(data: any) {
  const { userId, company, jobSnapshot } = data;
  console.log(`[AI Engine] Resume tailoring for "${jobSnapshot.title}" at "${company}"`);

  const sub = await prisma.userSubscription.findUnique({ where: { userId } });
  if (!sub || !sub.isActive) {
    console.log(`[AI Engine] User "${userId}" not premium. Skipping.`);
    return;
  }

  const profile = await prisma.userProfile.findUnique({ where: { userId } });
  if (!profile) {
    console.log(`[AI Engine] No profile for user "${userId}". Skipping.`);
    return;
  }

  try {
    const fullDesc = await scrapeFullJobDescription(jobSnapshot.url);
    const tailoredText = await callBedrockToTailorResume(profile, jobSnapshot, fullDesc);

    const filename = `tailored-${jobSnapshot.id}.pdf`;
    const localPath = path.join(publicResumeDir, filename);
    const htmlContent = await marked.parse(tailoredText);
    await generatePdfFile(htmlContent, localPath);
    const pdfUrl = `/resumes/${filename}`;

    await prisma.tailoredResume.create({
      data: {
        jobSnapshotId: jobSnapshot.id,
        resumeText: tailoredText,
        pdfUrl,
      },
    });

    console.log(`[AI Engine] Resume saved: ${pdfUrl}`);
  } catch (err) {
    console.error('[AI Engine] Tailoring error:', err);
  }
}

async function handlePremiumAiTailoring(
  userId: string, company: string,
  jobSnapshot: { id: string; title: string; location: string; url: string },
  fullDesc: string,
) {
  const sub = await prisma.userSubscription.findUnique({ where: { userId } });
  if (!sub || !sub.isActive) return;

  const profile = await prisma.userProfile.findUnique({ where: { userId } });
  if (!profile) return;

  try {
    const tailoredText = await callBedrockToTailorResume(profile, jobSnapshot, fullDesc);
    const filename = `tailored-${jobSnapshot.id}.pdf`;
    const localPath = path.join(publicResumeDir, filename);
    const htmlContent = await marked.parse(tailoredText);
    await generatePdfFile(htmlContent, localPath);

    await prisma.tailoredResume.create({
      data: {
        jobSnapshotId: jobSnapshot.id,
        resumeText: tailoredText,
        pdfUrl: `/resumes/${filename}`,
      },
    });
  } catch (err) {
    console.error('[AI Engine] Auto-tailoring error:', err);
  }
}

async function callBedrockToTailorResume(
  profile: { experience: string; skills: string; education: string; projects: string },
  job: { title: string },
  jobDesc: string,
): Promise<string> {
  const prompt = `You are an elite AI resume engineer. Analyse the candidate profile and job description, then generate a hyper-tailored ATS-optimized resume in Markdown.

<MASTER_PROFILE>
Experience: ${profile.experience}
Skills: ${profile.skills}
Education: ${profile.education}
Projects: ${profile.projects}
</MASTER_PROFILE>

<TARGET_JOB>
Role: ${job.title}
${jobDesc}
</TARGET_JOB>

Rules:
- Output ONLY valid Markdown. No commentary.
- Never invent certifications, employers, or metrics.
- Use X-Y-Z bullet format: "Accomplished X, measured by Y, by doing Z."
- Include sections: Name/Contact, Summary, Skills, Experience, Education, Projects.`;

  try {
    const cmd = new InvokeModelCommand({
      modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const res = await bedrock.send(cmd);
    const parsed = JSON.parse(new TextDecoder().decode(res.body));
    return parsed.content[0].text;
  } catch (err) {
    console.error('[AI Engine] Bedrock call failed:', err);
    return `# ${job.title}\n\n*Resume tailoring temporarily unavailable.*`;
  }
}

async function generatePdfFile(htmlContent: string, outputPath: string) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <!DOCTYPE html>
      <html><head><style>
        @page { size: A4; margin: 0.65in; }
        body { font-family: Arial, Helvetica, sans-serif; color: #111; line-height: 1.4; font-size: 10.5pt; margin: 0; padding: 0; }
        h1 { font-size: 22pt; text-transform: uppercase; text-align: center; margin: 0 0 4px; }
        h2 { font-size: 13pt; color: #0f172a; border-bottom: 1px solid #94a3b8; text-transform: uppercase; margin: 16px 0 8px; padding-bottom: 2px; }
        h3 { font-size: 11pt; margin: 8px 0 2px; }
        p { margin: 0 0 8px; text-align: justify; }
        ul { margin: 0 0 8px; padding-left: 20px; }
        li { margin-bottom: 3px; text-align: justify; }
        h2, h3 { page-break-after: avoid; break-after: avoid; }
      </style></head><body>${htmlContent}</body></html>
    `);
    await page.pdf({
      path: outputPath,
      format: 'A4',
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
    });
  } finally {
    await browser.close();
  }
}
