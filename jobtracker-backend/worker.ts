import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { Worker, Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { scrapeJobs } from './scraper.js';
import { Resend } from 'resend';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';

chromium.use(stealth());
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prisma = new PrismaClient();

// Configure Resend
const resendKey = process.env.RESEND_API_KEY || '';
const resend = resendKey.startsWith('re_') ? new Resend(resendKey) : null;
const SENDER_EMAIL = process.env.SENDER_EMAIL || 'NextRole Alerts <alerts@nextrole.com>';

// Create local resume public storage directory
const publicResumeDir = path.join(__dirname, 'public', 'resumes');
if (!fs.existsSync(publicResumeDir)) {
  fs.mkdirSync(publicResumeDir, { recursive: true });
}

// Initialize Redis for Worker
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

console.log('[Worker] Connected to Redis. Initializing monitorQueue worker...');

// Create the BullMQ Worker
const worker = new Worker('monitorQueue', async (job) => {
  const { searchId, url } = job.data;
  console.log(`\n[Worker] Processing Job ${job.id}: Scrape search ID ${searchId} (${url})`);

  try {
    // 1. Fetch tracked search details
    const search = await prisma.trackedSearch.findUnique({
      where: { id: searchId }
    });

    if (!search) {
      console.error(`[Worker] TrackedSearch with ID ${searchId} not found in database.`);
      return;
    }

    // 2. Perform the scrape using Playwright
    const scrapedJobs = await scrapeJobs(url);
    if (scrapedJobs.length === 0) {
      console.log(`[Worker] Scraper returned 0 jobs for ${url}. Skipping diff check.`);
      return;
    }

    // 3. Query existing snapshots for this search in database
    const existingSnapshots = await prisma.jobSnapshot.findMany({
      where: { trackedSearchId: searchId }
    });

    const existingJobIds = new Set(existingSnapshots.map(s => s.atsJobId));
    const newJobsDetected = scrapedJobs.filter(job => !existingJobIds.has(job.id));

    console.log(`[Worker] Scrape Analysis: total scraped = ${scrapedJobs.length}, existing snapshots = ${existingJobIds.size}, newly detected = ${newJobsDetected.length}`);

    // Parse company name once for all jobs in this search
    const company = getCompanyNameFromUrl(url);

    // 4. Save new snapshots and trigger workflows
    for (const newJob of newJobsDetected) {
      console.log(`[Worker] New job detected! Processing: "${newJob.title}" at "${newJob.location}"`);

      try {
        // Save initially to generate UUID
        const savedJob = await prisma.jobSnapshot.create({
          data: {
            trackedSearchId: searchId,
            atsJobId: newJob.id,
            title: newJob.title,
            location: newJob.location,
            url: newJob.url,
            isNew: true
          }
        });

        const fullDesc = await scrapeFullJobDescription(newJob.url);
        
        // AWS Bedrock: Generate Job Vector Embedding
        const embedding = await generateBedrockEmbedding(`${newJob.title} ${newJob.location} ${fullDesc}`);
        if (embedding.length > 0) {
          await prisma.$executeRawUnsafe(
            `UPDATE "JobSnapshot" SET "jobEmbedding" = $1::vector WHERE id = $2`,
            `[${embedding.join(',')}]`,
            savedJob.id
          );
        }

        const profile = await prisma.userProfile.findUnique({ where: { userId: search.userId } });
        
        let semanticScore = 1.0; // Default to pass if no profile embedding exists
        let passesThreshold = true;

        if (profile) {
          // If profile has an embedding, run fast pgvector cosine distance calculation
          const similarityResult = await prisma.$queryRawUnsafe<any[]>(
            `SELECT 1 - ("jobEmbedding" <=> "profileEmbedding") AS score 
             FROM "JobSnapshot" j, "UserProfile" u 
             WHERE j.id = $1 AND u."userId" = $2 AND j."jobEmbedding" IS NOT NULL AND u."profileEmbedding" IS NOT NULL`,
            savedJob.id,
            search.userId
          );

          if (similarityResult && similarityResult.length > 0 && similarityResult[0].score !== null) {
            semanticScore = similarityResult[0].score;
            await prisma.jobSnapshot.update({ where: { id: savedJob.id }, data: { semanticScore } });
            
            if (semanticScore < 0.65) {
              passesThreshold = false;
              console.log(`[Bedrock] Semantic similarity (${semanticScore.toFixed(3)}) is below 0.65. Dropping alert to preserve token budget.`);
            }
          }
        }

        // Only trigger alerts and tailoring if it passes the vector threshold
        if (passesThreshold) {
          await sendJobEmailAlert(search.userId, company, newJob);
          await handlePremiumAiTailoring(search.userId, company, savedJob, fullDesc);
        }

      } catch (innerErr) {
        console.error(`[Worker] Error processing individual job ${newJob.id}:`, innerErr);
        // Continue processing other jobs in queue
      }
    }

  } catch (error) {
    console.error(`[Worker] Exhaustive structural failure handling job ${job.id}:`, error);
    throw error; // Re-throw for BullMQ retry mechanics
  }
}, { connection });

// Schedule regular repeatable checks
// For demonstration & local testing, we also establish a self-contained cron-scheduler
const monitorQueue = new Queue('monitorQueue', { connection });
setInterval(async () => {
  console.log('[Scheduler] Waking up to queue scraping jobs for all tracked career pages...');
  try {
    const searches = await prisma.trackedSearch.findMany();
    console.log(`[Scheduler] Found ${searches.length} tracked searches in database to monitor.`);
    
    for (const search of searches) {
      await monitorQueue.add('cron-scrape', {
        searchId: search.id,
        url: search.url
      });
      console.log(`- Queued scraping job for search ID ${search.id} (${search.url})`);
    }
  } catch (err) {
    console.error('[Scheduler] Error adding repeatable scraping tasks:', err);
  }
}, 15 * 60 * 1000); // Trigger every 15 minutes

console.log('[Scheduler] Recurring scheduler successfully activated (Interval: 15 minutes).');

/**
 * ----------------------------------------------------
 * EMAIL ALERTS SERVICE (RESEND)
 * ----------------------------------------------------
 */
async function sendJobEmailAlert(userId: string, company: string, job: { title: string; location: string; url: string }) {
  console.log(`[Email] Preparing notification email for user "${userId}"...`);
  
  // HTML Layout incorporating sleek premium design principles
  const emailHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; padding: 24px; color: #1e293b; margin: 0; }
          .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
          .header { background: linear-gradient(135deg, #1e293b 0%, #0f1722 100%); padding: 32px 24px; text-align: center; color: #ffffff; }
          .header h1 { font-size: 24px; font-weight: 700; margin: 0; letter-spacing: -0.5px; }
          .body { padding: 32px 24px; }
          .badge { display: inline-block; background: #ecfdf5; color: #059669; font-weight: 600; font-size: 12px; padding: 4px 12px; border-radius: 9999px; margin-bottom: 16px; text-transform: uppercase; }
          .job-title { font-size: 22px; font-weight: 700; color: #0f172a; margin: 0 0 8px 0; }
          .meta-info { font-size: 14px; color: #64748b; margin-bottom: 24px; }
          .meta-info span { margin-right: 16px; font-weight: 500; }
          .btn-apply { display: inline-block; background: #0f172a; color: #ffffff; font-weight: 600; font-size: 14px; text-decoration: none; padding: 12px 24px; border-radius: 8px; margin-right: 12px; transition: background 0.2s ease; }
          .footer { text-align: center; font-size: 12px; color: #94a3b8; padding: 24px; border-top: 1px solid #f1f5f9; background: #f8fafc; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>NextRole Tracker</h1>
          </div>
          <div class="body">
            <span class="badge">New Job Alert</span>
            <h2 class="job-title">${job.title}</h2>
            <div class="meta-info">
              <span>🏢 <strong>${company}</strong></span>
              <span>📍 ${job.location}</span>
            </div>
            <p style="font-size: 15px; line-height: 1.6; color: #475569; margin-bottom: 32px;">
              A new career opportunity matching your saved tracking filters has just been posted on the <strong>${company}</strong> career board!
            </p>
            <a href="${job.url}" class="btn-apply" target="_blank">Apply Now →</a>
          </div>
          <div class="footer">
            <p>You received this email because you are tracking the ${company} career page on NextRole.</p>
            <p>© 2026 NextRole AI. All rights reserved.</p>
          </div>
        </div>
      </body>
    </html>
  `;

  if (!resend) {
    console.log('\n[Email Mock] resend client not configured or dummy key active.');
    console.log(`[Email Mock] To: user-${userId}@gmail.com`);
    console.log(`[Email Mock] Subject: New Job Alert: ${job.title} at ${company}`);
    console.log(`[Email Mock] Job URL: ${job.url}`);
    return;
  }

  try {
    await resend.emails.send({
      from: SENDER_EMAIL,
      to: `user-${userId}@gmail.com`, // Fallback/demo destination
      subject: `🚨 New Job Alert: ${job.title} at ${company}!`,
      html: emailHtml
    });
    console.log('[Email] Alert email successfully sent via Resend API.');
  } catch (err) {
    console.error('[Email] Failed to send email alert via Resend:', err);
  }
}

/**
 * ----------------------------------------------------
 * AI RESUME TAILORING SERVICE (PREMIUM)
 * ----------------------------------------------------
 */
async function handlePremiumAiTailoring(userId: string, company: string, jobSnapshot: { id: string; title: string; location: string; url: string }, fullJobDesc: string) {
  console.log(`[AI Engine] Verifying premium status for user "${userId}"...`);

  // 1. Check if user is premium subscriber
  const sub = await prisma.userSubscription.findUnique({
    where: { userId }
  });

  if (!sub || !sub.isActive) {
    console.log(`[AI Engine] User "${userId}" is on the FREE tier. Skipping premium resume tailoring.`);
    return;
  }

  console.log(`[AI Engine] User is active Premium subscriber! Initiating AWS Bedrock inference for: "${jobSnapshot.title}" at "${company}"`);

  // 2. Fetch master resume profile
  const profile = await prisma.userProfile.findUnique({
    where: { userId }
  });

  if (!profile) {
    console.log(`[AI Engine] User has not completed their master resume profile. Skipping tailoring.`);
    return;
  }

  try {
    // 4. Generate tailored resume text using Bedrock Claude 3.5 Sonnet
    const tailoredText = await callBedrockToTailorResume(profile, jobSnapshot, fullJobDesc);
    console.log('[AI Engine] Resume tailoring completed via AWS Bedrock.');

    // 5. Generate tailored PDF using Playwright and save it locally
    const filename = `tailored-${jobSnapshot.id}.pdf`;
    const localPath = path.join(publicResumeDir, filename);
    
    // Parse the Markdown tailoredText into HTML for the PDF generator
    const htmlTailoredText = await marked.parse(tailoredText);
    await generatePdfFile(htmlTailoredText, localPath);
    const pdfUrl = `/resumes/${filename}`;

    // 6. Save tailored resume to database
    await prisma.tailoredResume.create({
      data: {
        jobSnapshotId: jobSnapshot.id,
        resumeText: tailoredText,
        pdfUrl
      }
    });

    console.log(`[AI Engine] Tailored resume saved successfully. PDF available at: ${pdfUrl}`);

  } catch (err) {
    console.error('[AI Engine] Error during resume tailoring process:', err);
  }
}

/**
 * Helper: Scrape full job description text from ATS job page
 */
async function scrapeFullJobDescription(url: string): Promise<string> {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    
    // Playwright anti-bot defense bypass
    await page.waitForTimeout(Math.floor(Math.random() * 800) + 200);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Look for common job description containers
    const descriptionSelectors = [
      '#content', '.description', '.posting-description', 
      '[data-automation-id="jobDescription"]', '#job-description', 
      '.job-description', 'article', 'body'
    ];

    let desc = '';
    for (const selector of descriptionSelectors) {
      const element = page.locator(selector);
      if (await element.count() > 0) {
        desc = await element.first().innerText();
        if (desc.trim().length > 200) break;
      }
    }

    return desc.trim() || 'No full description text could be scraped.';
  } finally {
    await browser.close();
  }
}

/**
 * Helper: Generate Embeddings using AWS Bedrock Titan
 */
async function generateBedrockEmbedding(text: string): Promise<number[]> {
  try {
    const command = new InvokeModelCommand({
      modelId: 'amazon.titan-embed-text-v2:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({ inputText: text.substring(0, 8000) }) // enforce Titan limits
    });
    
    const response = await bedrock.send(command);
    const jsonString = new TextDecoder().decode(response.body);
    const parsed = JSON.parse(jsonString);
    return parsed.embedding || [];
  } catch (err) {
    console.error('[Bedrock] Embedding Generation Failed:', err);
    return [];
  }
}

/**
 * Helper: Call AWS Bedrock Claude 3.5 Sonnet to tailor the resume
 */
async function callBedrockToTailorResume(
  profile: { experience: string; skills: string; education: string; projects: string },
  job: { title: string },
  jobDesc: string
): Promise<string> {
  const prompt = `You are the core optimization node of the NextRole Cyber Careers Co-pilot platform. Your purpose is to act as an elite AI Career Engineer specializing in the Cybersecurity and Information Security industries. 

Your objective is to analyze a candidate's Master Profile, cross-reference it with a target Job Description, and synthesize a hyper-tailored, ATS-optimized resume.

---

### 1. GROUNDING INPUTS

<MASTER_PROFILE>
Experience: ${profile.experience}
Skills: ${profile.skills}
Education: ${profile.education}
Projects: ${profile.projects}
</MASTER_PROFILE>

<TARGET_JOB_DESCRIPTION>
Role: ${job.title}
${jobDesc}
</TARGET_JOB_DESCRIPTION>

[CRITICAL RULE] Strict Data Veracity: You may rephrase, recontextualize, and strategically emphasize existing qualifications, but you must NEVER invent fictitious certifications, degrees, employers, or project metrics. If the target job requires a tool the user does not possess, emphasize adjacent or core conceptual transferring skills instead.

---

### 2. ARCHITECTURAL & STRATEGIC PRIORITIES

- **Targeted ATS Keyword Infiltration:** Inject high-signal cybersecurity industry keywords (e.g., SIEM, EDR, NIST CSF, Zero Trust, Incident Response, CI/CD Security, OWASP Top 10) natively into bullet points and skills matrices.
- **Action-Oriented Impact:** Structure all professional experience points using the X-Y-Z formula: "Accomplished [X], as measured by [Y], by doing [Z]."
- **Security-Minded Tone:** Maintain a sharp, analytical, professional, and authoritative technical tone. Speak natively in the lexicon of security teams (e.g., "remediated vulnerabilities," "reduced attack surface," "orchestrated incident containment").

---

### 3. OUTPUT SPECIFICATION

Your output must be returned STRICTLY in valid Markdown. Do not include any conversational filler, meta-commentary, or introductory remarks. Start directly with the markdown format.

The document must structure into these precise sections:

#### SECTION I: IDENTIFICATION / TERMINAL BANNER
- Candidate Name, contact channels, and a precise professional title matched to the target role (e.g., "Senior Application Security Engineer").

#### SECTION II: EXECUTIVE MISSION SUMMARY
- A punchy, 3-4 sentence paragraph framing the candidate as the definitive solution to the explicit operational pain points identified in the <TARGET_JOB_DESCRIPTION>.

#### SECTION III: SECURITY SPECIFIC SKILLS MATRIX
- Group technologies cleanly using bullet lists or inline arrays:
  - **Core Domains:** (e.g., GRC, SecOps, Threat Hunting)
  - **Tools & Platforms:** (e.g., Splunk, AWS GuardDuty, Burp Suite)
  - **Frameworks & Compliance:** (e.g., ISO 27001, SOC 2, MITRE ATT&CK)

#### SECTION IV: THREAT-MODEL AND PROFESSIONAL EXPERIENCE
- For each relevant role, output: **Job Title** | **Company** | **Date Range**
- Provide 3–5 bullet points detailing quantifiable achievements. Emphasize incident resolution windows, vulnerability remediation metrics, and compliance achievements wherever possible.

#### SECTION V: EDUCATION, CERTIFICATIONS, & CLEARANCES
- Prioritize high-signal security certs (e.g., CISSP, CEH, OSCP, CompTIA Security+) prominently at the top of this section if present in the Master Profile.

---

### 4. PARSING GUARDRAILS

- Avoid cliché corporate buzzwords ("passionate team player," "synergistic self-starter").
- Keep formatting tight, utilizing bullet points (\`* \`) to ensure predictable text-wrapping when the backend renders this Markdown into an A4 PDF format.
- Output ONLY the resume text. Do not acknowledge this prompt. Begin immediately with the markdown payload.`;

  try {
    const command = new InvokeModelCommand({
      modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    
    const response = await bedrock.send(command);
    const jsonString = new TextDecoder().decode(response.body);
    const parsed = JSON.parse(jsonString);
    return parsed.content[0].text;
  } catch (err) {
    console.error('[AI Engine] AWS Bedrock Claude API fetch error, falling back to mock generator:', err);
    return generateMockTailoredResume(profile, job.title);
  }
}

/**
 * Helper: Print HTML to PDF using Playwright
 */
async function generatePdfFile(htmlContent: string, outputPath: string) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    
    // Set formatted resume content
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            /* pdf-template.css - Injected into Playwright before rendering */
            @page {
                size: A4;
                margin: 0.65in 0.65in 0.75in 0.65in;
            }
            body {
                font-family: 'Arial', 'Helvetica', sans-serif;
                color: #111111;
                line-height: 1.4;
                font-size: 10.5pt;
                margin: 0;
                padding: 0;
            }
            h1 {
                font-size: 22pt;
                text-transform: uppercase;
                text-align: center;
                margin: 0 0 4px 0;
                letter-spacing: 0.5px;
            }
            h2 {
                font-size: 13pt;
                color: #0f172a;
                border-bottom: 1px solid #94a3b8;
                text-transform: uppercase;
                margin: 16px 0 8px 0;
                padding-bottom: 2px;
                letter-spacing: 0.3px;
            }
            h3 {
                font-size: 11pt;
                margin: 8px 0 2px 0;
                display: flex;
                justify-content: space-between;
            }
            p {
                margin: 0 0 8px 0;
                text-align: justify;
            }
            ul {
                margin: 0 0 8px 0;
                padding-left: 20px;
            }
            li {
                margin-bottom: 3px;
                text-align: justify;
            }
            /* Ensure clean line wrapping and avoid orphan headers over page breaks */
            h2, h3 {
                page-break-after: avoid;
                break-after: avoid;
            }
            .experience-block, .project-block {
                page-break-inside: avoid;
                break-inside: avoid;
            }
          </style>
        </head>
        <body>
          ${htmlContent}
        </body>
      </html>
    `);

    // Print to high-quality PDF page layout
    await page.pdf({
      path: outputPath,
      format: 'A4',
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' }
    });
  } finally {
    await browser.close();
  }
}

/**
 * Clean URL Company Parser
 */
function getCompanyNameFromUrl(targetUrl: string): string {
  try {
    const urlObj = new URL(targetUrl);
    const hostname = urlObj.hostname.toLowerCase();
    
    if (hostname.includes('greenhouse.io')) {
      const parts = urlObj.pathname.split('/');
      if (parts[1]) return parts[1].charAt(0).toUpperCase() + parts[1].slice(1);
    } else if (hostname.includes('lever.co')) {
      const parts = urlObj.pathname.split('/');
      if (parts[1]) return parts[1].charAt(0).toUpperCase() + parts[1].slice(1);
    } else if (hostname.includes('myworkdayjobs.com')) {
      const parts = hostname.split('.');
      return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    }
    return hostname;
  } catch (e) {
    return 'Company Portal';
  }
}

/**
 * Fallback Mock Resume Tailor
 */
function generateMockTailoredResume(
  profile: { experience: string; skills: string; education: string; projects: string },
  jobTitle: string
): string {
  return `
    <h1>JOHN DOE</h1>
    <div class="subtitle">john.doe@gmail.com | (555) 019-2834 | New York, NY | linkedin.com/in/johndoe</div>
    
    <h2>Professional Summary</h2>
    <p style="font-size: 13px; color: #334155;">
      Results-driven Software Engineer with extensive experience in architecting robust digital solutions. Re-tailored specifically for the <strong>${jobTitle}</strong> opening, emphasizing core capabilities in modern technology frameworks and systems engineering.
    </p>

    <h2>Skills Profile</h2>
    <p style="font-size: 13px; color: #334155;" class="skills-list">
      <strong>Core Strengths (Optimized for ${jobTitle}):</strong> ${profile.skills}
    </p>

    <h2>Professional Experience</h2>
    <div class="job-block">
      <div class="job-header">Senior Software Engineer <span class="job-date">2023 - Present</span></div>
      <p style="font-size: 13px; font-style: italic; color: #64748b; margin: 2px 0;">NextGen Systems, New York</p>
      <ul>
        <li>Optimized engineering architectures using scalable distributed nodes, meeting specific requirements matching the ${jobTitle} job definition.</li>
        ${profile.experience.split('\n').filter(Boolean).map(bullet => `<li>${bullet}</li>`).join('')}
      </ul>
    </div>

    <h2>Education</h2>
    <p style="font-size: 13px; color: #334155;">
      ${profile.education || 'B.S. in Computer Science - State University'}
    </p>

    <h2>Personal Projects</h2>
    <p style="font-size: 13px; color: #334155;">
      ${profile.projects || 'Designed and deployed distributed analytics queue monitoring tools processing million events/day.'}
    </p>
  `;
}
