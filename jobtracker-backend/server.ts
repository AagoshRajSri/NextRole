import express from 'express';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  normalizeCareerUrl,
  extractCompanyFromUrl,
  detectPlatform,
  encryptData,
} from './utils.js';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import pino from 'pino';
import jwt from 'jsonwebtoken';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prisma = new PrismaClient();
const app = express();
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});
app.use(express.json());

// ────────────────────────────────────────────────────────
// STATIC FILE SERVING
// ────────────────────────────────────────────────────────
app.use('/resumes', express.static(path.join(__dirname, 'public/resumes')));

// ────────────────────────────────────────────────────────
// CORS & RATE LIMITING & VALIDATION
// ────────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.ALLOWED_ORIGINS || '',
  ...(process.env.NODE_ENV === 'development' ? ['chrome-extension://fakeextensionidfordev'] : []),
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (origin.startsWith('chrome-extension://')) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: false,
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'X-User-Id'],
}));

app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  message: { error: 'Too many requests, please slow down.' },
  skip: (req) => process.env.NODE_ENV === 'development',
}));

app.use('/api/alerts/email', rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Email alert rate limit exceeded.' },
}));

app.use('/api/jobs/bulk', rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Sync rate limit exceeded. Try again in a moment.' },
}));

const cookieSyncLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 1, // max 1 sync per minute per user
  message: { error: 'Cookie sync rate limit exceeded.' },
});

const TrackedSearchSchema = z.object({
  url: z.string().url().max(2048),
  platform: z.string().max(50).optional(),
});

const JobBulkSchema = z.object({
  pageUrl: z.string().url().max(2048),
  jobs: z.array(z.object({
    atsJobId: z.string().max(200),
    title: z.string().max(300),
    location: z.string().max(200).optional().default(''),
    url: z.string().url().max(2048),
    companyName: z.string().max(200).optional().default(''),
    matchReason: z.string().max(200).optional().default(''),
  })).max(100),
});

const ProfileSchema = z.object({
  name: z.string().max(200).optional(),
  phone: z.string().max(50).optional(),
  email: z.string().email().max(200).optional(),
  targetRoles: z.array(z.string().max(100)).max(20).optional(),
  locations: z.array(z.string().max(100)).max(20).optional(),
  watchlistCompanies: z.array(z.string().max(100)).max(50).optional(),
  experienceLevel: z.enum(['fresher', '1-3', '3-7', '7+']).optional(),
  alertMode: z.enum(['instant', 'daily', 'weekly']).optional(),
  emailAlerts: z.boolean().optional(),
  timezone: z.string().max(100).optional(),
  isOnboarded: z.boolean().optional(),
  monitorActive: z.boolean().optional(),
  experience: z.string().max(10000).optional(),
  skills: z.string().max(10000).optional(),
  education: z.string().max(10000).optional(),
  projects: z.string().max(10000).optional(),
});

function validate<T>(schema: z.ZodSchema<T>) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message }))
      });
    }
    req.body = result.data;
    next();
  };
}

// ────────────────────────────────────────────────────────
// AUTHENTICATION MIDDLEWARE
// ────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_jwt_secret_for_dev';

export const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
      (req as any).userId = decoded.userId;
      return next();
    } catch (err) {
      logger.warn(`[Auth] Invalid JWT provided: ${(err as any).message}`);
      return res.status(401).json({ error: 'Invalid token' });
    }
  }

  // Fallback to X-User-Id for legacy extension compatibility during transition
  const fallbackId = req.header('X-User-Id');
  if (fallbackId) {
    (req as any).userId = fallbackId.trim();
    return next();
  }

  return res.status(401).json({ error: 'Authentication required' });
};

// Protect all /api routes below (except health/public routes)
const protectedRouter = express.Router();
app.use('/api', protectedRouter);

// ────────────────────────────────────────────────────────
// REDIS + BULLMQ
// ────────────────────────────────────────────────────────
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
let monitorQueue: Queue | null = null;
let redisSubscriber: Redis | null = null;

try {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  monitorQueue = new Queue('monitorQueue', { connection });
  console.log('[Server] Connected to Redis for BullMQ.');

  redisSubscriber = new Redis(redisUrl, { maxRetriesPerRequest: null });
  redisSubscriber.subscribe('jobAlerts', (err) => {
    if (err) console.error('[Server] Failed to subscribe to jobAlerts', err);
    else console.log('[Server] Subscribed to Redis jobAlerts channel.');
  });
} catch (e) {
  console.warn('[Server] Redis not connected. BullMQ disabled.');
}

// ────────────────────────────────────────────────────────
// SOCKET.IO TELEMETRY
// ────────────────────────────────────────────────────────
const activeSockets = new Map<string, any>();

io.use((socket, next) => {
  const userId = socket.handshake.auth?.userId || socket.handshake.headers['x-user-id'];
  if (!userId) return next(new Error('Unauthorized: User ID required'));
  socket.data.userId = userId;
  next();
});

io.on('connection', (socket) => {
  const userId = socket.data.userId;
  activeSockets.set(userId, socket);
  console.log(`[Socket.io] 🟢 Connected: ${userId}`);
  socket.on('disconnect', () => {
    activeSockets.delete(userId);
    console.log(`[Socket.io] 🔴 Disconnected: ${userId}`);
  });
});

if (redisSubscriber) {
  redisSubscriber.on('message', (channel, message) => {
    if (channel === 'jobAlerts') {
      try {
        const { userId, job } = JSON.parse(message);
        const userSocket = activeSockets.get(userId);
        if (userSocket) userSocket.emit('JOB_ALERT_DISCOVERED', job);
      } catch (err) {
        console.error('[Server] Error parsing jobAlerts:', err);
      }
    }
  });
}

// ────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────
const getUserId = (req: express.Request): string =>
  (req as any).userId || 'default-user';

// ────────────────────────────────────────────────────────
// HEALTH
// ────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  const checks: Record<string, 'ok' | 'error'> = {};
  
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = 'ok';
  } catch {
    checks.database = 'error';
  }
  
  try {
    if (redisSubscriber) {
      await redisSubscriber.ping();
      checks.redis = 'ok';
    } else {
      checks.redis = 'error';
    }
  } catch {
    checks.redis = 'error';
  }
  
  const allOk = Object.values(checks).every(v => v === 'ok');
  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    checks,
  });
});

app.get('/api/scraper-health', async (req, res) => {
  const userId = getUserId(req);
  try {
    const pages = await prisma.trackedSearch.findMany({
      where: { userId },
      orderBy: { lastScrapedAt: 'desc' },
    });
    
    const summary = {
      total: pages.length,
      healthy: pages.filter(p => p.lastScrapeStatus === 'ok').length,
      empty: pages.filter(p => p.lastScrapeStatus === 'empty').length,
      blocked: pages.filter(p => p.lastScrapeStatus === 'blocked').length,
      erroring: pages.filter(p => p.lastScrapeStatus === 'error').length,
    };
    
    const mappedPages = pages.map(p => {
      let nextScrapeIn = 'paused';
      if (p.lastScrapedAt) {
        // Assume cron runs every 15 mins (900000 ms)
        const nextTime = new Date(p.lastScrapedAt).getTime() + 15 * 60 * 1000;
        const diff = Math.max(0, nextTime - Date.now());
        nextScrapeIn = Math.round(diff / 60000) + ' min';
      }
      return {
        id: p.id,
        url: p.url,
        platform: p.platform,
        lastScrapedAt: p.lastScrapedAt,
        lastScrapeStatus: p.lastScrapeStatus,
        lastScrapeError: p.lastScrapeError,
        newJobCount: p.newJobCount,
        nextScrapeIn
      };
    });
    
    res.json({ summary, pages: mappedPages });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
// TRACKED SEARCHES API
// ════════════════════════════════════════════════════════

// GET — list all tracked searches + scrape status + new job count
app.get('/api/tracked-searches', async (req, res) => {
  const userId = getUserId(req);
  try {
    const searches = await prisma.trackedSearch.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    res.json(searches);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST — add a new tracked URL (normalised, deduped, auto-detect platform)
app.post('/api/tracked-searches', validate(TrackedSearchSchema), async (req, res) => {
  const userId = getUserId(req);
  const { url } = req.body;

  if (!url) return res.status(400).json({ error: 'URL is required.' });

  const normalised = normalizeCareerUrl(url);
  const platform = req.body.platform || detectPlatform(normalised);

  try {
    const existing = await prisma.trackedSearch.findUnique({
      where: { userId_url: { userId, url: normalised } },
    });

    if (existing) {
      return res.status(409).json({ ...existing, message: 'Already tracked.' });
    }

    const newSearch = await prisma.trackedSearch.create({
      data: { userId, url: normalised, platform },
    });

    // Queue immediate scrape
    if (monitorQueue) {
      await monitorQueue.add('scrape-single', { searchId: newSearch.id, url: normalised });
      console.log(`[Server] Queued immediate scrape for: ${newSearch.id}`);
    }

    res.status(201).json(newSearch);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE — remove a tracked search
app.delete('/api/tracked-searches/:id', async (req, res) => {
  try {
    await prisma.trackedSearch.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
// NEW JOBS POLLING API
// ════════════════════════════════════════════════════════

app.get('/api/new-jobs', async (req, res) => {
  const userId = getUserId(req);
  try {
    const newJobs = await prisma.jobSnapshot.findMany({
      where: {
        isNew: true,
        trackedSearch: { userId },
      },
      include: { trackedSearch: true },
      orderBy: { firstSeenAt: 'desc' },
    });

    // Mark as polled (isNew = false)
    if (newJobs.length > 0) {
      await prisma.jobSnapshot.updateMany({
        where: { id: { in: newJobs.map(j => j.id) } },
        data: { isNew: false },
      });
    }

    res.json(
      newJobs.map(job => ({
        id: job.id,
        companyName: job.companyName || extractCompanyFromUrl(job.trackedSearch.url) || 'Company',
        title: job.title,
        location: job.location,
        url: job.url,
        atsJobId: job.atsJobId,
        matchReason: job.matchReason,
        firstSeenAt: job.firstSeenAt,
        trackedSearchId: job.trackedSearchId,
      })),
    );
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
// BULK SYNC (Client-Side Scraper)
// ════════════════════════════════════════════════════════
app.post('/api/jobs/bulk', validate(JobBulkSchema), async (req, res) => {
  const userId = getUserId(req);
  const { pageUrl, jobs } = req.body;
  if (!pageUrl || !jobs || !Array.isArray(jobs)) return res.status(400).json({ error: 'Invalid payload' });

  try {
    const trackedSearch = await prisma.trackedSearch.findFirst({
      where: { userId, url: normalizeCareerUrl(pageUrl) },
    });
    
    if (!trackedSearch) return res.status(404).json({ error: 'Tracked search not found' });

    let addedCount = 0;
    for (const job of jobs) {
      const existing = await prisma.jobSnapshot.findFirst({
        where: { trackedSearchId: trackedSearch.id, atsJobId: job.atsJobId },
      });
      if (!existing) {
        await prisma.jobSnapshot.create({
          data: {
            trackedSearchId: trackedSearch.id,
            atsJobId: job.atsJobId,
            title: job.title,
            location: job.location || '',
            url: job.url,
            companyName: job.companyName || '',
            matchReason: job.matchReason || '',
            isNew: false, // Already notified in extension
          },
        });
        addedCount++;
      }
    }
    res.json({ success: true, addedCount });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
// EMAIL ALERTS (Client-Side Trigger)
// ════════════════════════════════════════════════════════
import { Resend } from 'resend';
const resend = new Resend(process.env.RESEND_API_KEY || 're_dummy');

app.post('/api/alerts/email', async (req, res) => {
  const userId = getUserId(req);
  const { jobId, jobTitle, companyName, jobUrl, matchReason } = req.body;
  
  if (!jobId || !jobTitle || !jobUrl) return res.status(400).json({ error: 'Missing job details' });

  try {
    if (redisSubscriber) {
      const key = `email_sent:${userId}:${jobId}`;
      const alreadySent = await redisSubscriber.get(key);
      if (alreadySent) return res.status(429).json({ error: 'Email already sent for this job' });
      await redisSubscriber.set(key, '1', 'EX', 86400 * 30);
    }

    if (process.env.RESEND_API_KEY) {
      await resend.emails.send({
        from: 'NextRole Alerts <alerts@nextrole.com>',
        to: 'user@example.com', // Normally fetched from User profile
        subject: `New Match: ${jobTitle} at ${companyName || 'Unknown'}`,
        html: `<h2>NextRole Found a Match</h2><p><strong>${jobTitle}</strong> at ${companyName || 'Unknown'}</p><p>Match Reason: ${matchReason || 'Profile Match'}</p><a href="${jobUrl}">View Job</a>`
      });
    } else {
      console.log('[Server] Mock Email Alert:', { jobId, jobTitle, companyName });
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
// ALL JOBS (FEED) API
// ════════════════════════════════════════════════════════

// GET /api/jobs/new?since=<unix_ms> — lightweight endpoint for background polling
// Returns only new, unseen jobs since the given timestamp. Used by the extension
// alarm handler to fire system notifications even when no career tabs are open.
app.get('/api/jobs/new', async (req, res) => {
  const userId = getUserId(req);
  const sinceMs = parseInt((req.query.since as string) || '0', 10);
  const since = new Date(sinceMs > 0 ? sinceMs : Date.now() - 20 * 60 * 1000); // default: last 20 min

  try {
    const jobs = await prisma.jobSnapshot.findMany({
      where: {
        trackedSearch: { userId },
        matchReason: { not: null },
        firstSeenAt: { gte: since },
        seenAt: null,
        isNew: true,
      },
      include: { trackedSearch: { select: { url: true, platform: true } } },
      orderBy: { firstSeenAt: 'desc' },
      take: 50,
    });

    res.json(
      jobs.map(j => ({
        id: j.id,
        title: j.title,
        companyName: j.companyName || extractCompanyFromUrl(j.trackedSearch.url) || 'Company',
        location: j.location,
        url: j.url,
        matchReason: j.matchReason,
        firstSeenAt: (j.firstSeenAt as Date).getTime(),
        sourceDomain: (() => { try { return new URL(j.trackedSearch.url).hostname; } catch { return ''; } })(),
      })),
    );
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/jobs', async (req, res) => {
  const userId = getUserId(req);
  const range = (req.query.range as string) || 'all';

  let dateFilter: any = {};
  if (range === 'today') {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    dateFilter = { firstSeenAt: { gte: startOfDay } };
  } else if (range === '7days') {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    dateFilter = { firstSeenAt: { gte: weekAgo } };
  }

  try {
    const jobs = await prisma.jobSnapshot.findMany({
      where: {
        trackedSearch: { userId },
        matchReason: { not: null },
        ...dateFilter,
      },
      include: { trackedSearch: { select: { url: true, platform: true } } },
      orderBy: { firstSeenAt: 'desc' },
      take: 200,
    });

    res.json(
      jobs.map(j => ({
        id: j.id,
        title: j.title,
        companyName: j.companyName || extractCompanyFromUrl(j.trackedSearch.url) || 'Company',
        location: j.location,
        url: j.url,
        matchReason: j.matchReason,
        firstSeenAt: j.firstSeenAt,
        seenAt: j.seenAt,
        sourceDomain: new URL(j.trackedSearch.url).hostname,
      })),
    );
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
// JOB SEEN ENDPOINTS
// ════════════════════════════════════════════════════════

// PATCH — mark single job as seen
app.patch('/api/jobs/:id/seen', async (req, res) => {
  try {
    await prisma.jobSnapshot.update({
      where: { id: req.params.id },
      data: { seenAt: new Date(), isNew: false },
    });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST — mark all jobs as seen for user
app.post('/api/jobs/seen-all', async (req, res) => {
  const userId = getUserId(req);
  try {
    const trackedSearches = await prisma.trackedSearch.findMany({
      where: { userId },
      select: { id: true },
    });
    const searchIds = trackedSearches.map(s => s.id);

    await prisma.jobSnapshot.updateMany({
      where: {
        trackedSearchId: { in: searchIds },
        seenAt: null,
      },
      data: { seenAt: new Date(), isNew: false },
    });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
// USER PROFILE API
// ════════════════════════════════════════════════════════

app.get('/api/profile', async (req, res) => {
  const userId = getUserId(req);
  try {
    const profile = await prisma.userProfile.findUnique({ where: { userId } });
    if (!profile) {
      return res.json({
        name: '', phone: '', email: '', linkedinUrl: '',
        targetRoles: [], locations: [], watchlistCompanies: [],
        experienceLevel: '', alertMode: 'instant', emailAlerts: false,
        isOnboarded: false, monitorActive: false,
        experience: '', skills: '', education: '', projects: '',
      });
    }
    res.json(profile);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/profile', validate(ProfileSchema), async (req, res) => {
  const userId = getUserId(req);
  const {
    name, phone, email, linkedinUrl,
    targetRoles, locations, watchlistCompanies,
    experienceLevel, alertMode, emailAlerts,
    isOnboarded, monitorActive,
    experience, skills, education, projects,
  } = req.body;

  try {
    const data: any = {};
    if (name !== undefined) data.name = name;
    if (phone !== undefined) data.phone = phone;
    if (email !== undefined) data.email = email;
    if (linkedinUrl !== undefined) data.linkedinUrl = linkedinUrl;
    if (targetRoles !== undefined) data.targetRoles = targetRoles;
    if (locations !== undefined) data.locations = locations;
    if (watchlistCompanies !== undefined) data.watchlistCompanies = watchlistCompanies;
    if (experienceLevel !== undefined) data.experienceLevel = experienceLevel;
    if (alertMode !== undefined) data.alertMode = alertMode;
    if (emailAlerts !== undefined) data.emailAlerts = emailAlerts;
    if (isOnboarded !== undefined) data.isOnboarded = isOnboarded;
    if (monitorActive !== undefined) data.monitorActive = monitorActive;
    if (experience !== undefined) data.experience = experience;
    if (skills !== undefined) data.skills = skills;
    if (education !== undefined) data.education = education;
    if (projects !== undefined) data.projects = projects;

    const profile = await prisma.userProfile.upsert({
      where: { userId },
      update: data,
      create: { userId, ...data },
    });

    res.json(profile);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

protectedRouter.post('/cookies', cookieSyncLimiter, async (req, res) => {
  const userId = getUserId(req);
  const { cookies } = req.body;
  if (!cookies || typeof cookies !== 'object') {
    return res.status(400).json({ error: 'Invalid cookies payload' });
  }
  
  try {
    const encryptedCookies = encryptData(JSON.stringify(cookies));
    await prisma.userProfile.upsert({
      where: { userId },
      update: { sessionCookies: encryptedCookies, cookiesSyncedAt: new Date() },
      create: { userId, sessionCookies: encryptedCookies, cookiesSyncedAt: new Date() },
    });
    logger.info(`[Cookies] Synced encrypted session cookies for user: ${userId}`);
    res.json({ success: true, message: 'Cookies encrypted and synced securely' });
  } catch (err: any) {
    logger.error(`[Cookies] Error syncing cookies: ${err.message}`);
    res.status(500).json({ error: 'Failed to securely store cookies' });
  }
});

// ════════════════════════════════════════════════════════
// SELECTOR REGISTRY API
// ════════════════════════════════════════════════════════

app.get('/api/selectors', (req, res) => {
  // Hardcoded for now; can be moved to a DB table or remote JSON later
  res.json({
    linkedin: {
      strategyA: '.job-search-card, .base-search-card',
      strategyB: '.jobs-search__results-list li, .scaffold-layout__list-container li',
      title: '.job-search-card__title, .base-search-card__title, h3',
      company: '.job-search-card__company-name, .base-search-card__subtitle h4, h4',
      location: '.job-search-card__location, [class*="location"]'
    },
    workday: {
      item: '[data-automation-id="jobItem"]',
      title: 'a[data-automation-id="jobTitle"]',
      location: 'dd.css-129m7dg'
    }
  });
});

// ════════════════════════════════════════════════════════
// RESUME TAILORING API (kept for premium — no changes)
// ════════════════════════════════════════════════════════

const FREE_TIER_MAX_RUNS = 5;

async function verifyTokenBudget(req: express.Request, res: express.Response, next: express.NextFunction) {
  const userId = getUserId(req);
  try {
    const user = await prisma.userProfile.findUnique({ where: { userId } });
    if (!user) return res.status(404).json({ error: 'User profile not found.' });
    if (!user.isPremium && user.monthlyRunsUsed >= FREE_TIER_MAX_RUNS) {
      return res.status(402).json({
        error: 'TOKEN_LIMIT_EXCEEDED',
        message: 'You have reached your 5 free AI runs. Upgrade to Premium for unlimited.',
      });
    }
    await prisma.userProfile.update({
      where: { userId },
      data: { monthlyRunsUsed: { increment: 1 } },
    });
    next();
  } catch {
    res.status(500).json({ error: 'Internal error verifying limits.' });
  }
}

app.post('/api/resumes/tailor', verifyTokenBudget, async (req, res) => {
  const userId = getUserId(req);
  const { jobSnapshotId, companyName } = req.body;
  if (!jobSnapshotId || !companyName) {
    return res.status(400).json({ error: 'jobSnapshotId and companyName are required.' });
  }
  try {
    const jobSnapshot = await prisma.jobSnapshot.findUnique({ where: { id: jobSnapshotId } });
    if (!jobSnapshot) return res.status(404).json({ error: 'Job snapshot not found.' });
    if (monitorQueue) {
      await monitorQueue.add('resume-tailoring', { userId, company: companyName, jobSnapshot });
      return res.status(202).json({ message: 'Resume tailoring queued.' });
    }
    res.status(503).json({ error: 'Queue not active.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/resumes/lookup', async (req, res) => {
  const url = req.query.url as string;
  const userId = getUserId(req);
  if (!url) return res.status(400).json({ error: 'URL required.' });
  try {
    const snapshot = await prisma.jobSnapshot.findFirst({
      where: { url: { contains: url }, trackedSearch: { userId } },
      include: { tailoredResumes: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    if (!snapshot || snapshot.tailoredResumes.length === 0) {
      return res.status(404).json({ error: 'No tailored resume found.' });
    }
    res.json({ snapshot, resume: snapshot.tailoredResumes[0] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/resumes/:jobId', async (req, res) => {
  try {
    const resume = await prisma.tailoredResume.findFirst({
      where: { jobSnapshotId: req.params.jobId },
      orderBy: { createdAt: 'desc' },
    });
    if (!resume) return res.status(404).json({ error: 'Resume not found.' });
    res.json(resume);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
// START SERVER
// ════════════════════════════════════════════════════════
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`\n🚀 NextRole Backend Running on http://localhost:${PORT}`);
  console.log(`- API endpoints: http://localhost:${PORT}/api/*`);
  console.log(`- Socket.io Telemetry Active`);
});
