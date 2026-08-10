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
} from './utils.js';
import { tailorResume } from './lib/tailorResume.js';
import { embedText, jobToEmbedText, profileToEmbedText } from './lib/embeddings.js';
import { fetchCosineSimilarity, combineScores } from './lib/hybridScoring.js';

import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import pino from 'pino';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

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
  process.env.FRONTEND_URL || '',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // Allow non-browser clients (e.g. mobile)
    if (
      origin.startsWith('chrome-extension://') ||
      origin.startsWith('http://localhost:') ||
      origin.startsWith('http://127.0.0.1:') ||
      allowedOrigins.includes(origin)
    ) {
      return callback(null, true);
    }
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

// ────────────────────────────────────────────────────────
// PUBLIC ENDPOINTS
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
  
  // Only DB is critical for core API — Redis is optional (real-time only)
  const coreOk = checks.database === 'ok';
  res.status(coreOk ? 200 : 503).json({
    status: coreOk ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    checks,
  });
});

app.get('/api/selectors', (req, res) => {
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

// ────────────────────────────────────────────────────────
// SELECTOR FAILURE REPORTING
// Content script POSTs here when a configured selector map returns zero
// results on a page that clearly shows job listings, so the map can be
// updated centrally without a full extension release.
// ────────────────────────────────────────────────────────
const SelectorReportSchema = z.object({
  domain:    z.string().max(253),
  platform:  z.string().max(50),
  url:       z.string().url().max(2048),
  timestamp: z.number().int(),
  snippet:   z.string().max(110_000), // sanitized HTML, ~100 kB max
});

app.post('/api/selectors/report', validate(SelectorReportSchema), async (req, res) => {
  try {
    const { domain, platform, url, timestamp, snippet } = req.body;
    logger.warn({ domain, platform, url, timestamp, snippetLen: snippet.length },
      '[selectors/report] Selector map miss — heuristic fallback fired');

    // Best-effort: persist to DB if the table exists; otherwise just log.
    try {
      await (prisma as any).selectorReport.create({
        data: { domain, platform, url, timestamp: new Date(timestamp), snippet },
      });
    } catch {
      // Table may not exist yet — log is sufficient for now
    }

    return res.status(202).json({ received: true });
  } catch (err) {
    logger.error(err, '[selectors/report] Failed to record report');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ────────────────────────────────────────────────────────
// AUTHENTICATION ENDPOINTS
// ────────────────────────────────────────────────────────
app.post('/api/auth/signup', validate(z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().optional()
})), async (req, res) => {
  try {
    const { email, password, name } = req.body;
    
    // Check if user exists
    const existing = await prisma.userProfile.findFirst({ where: { email } });
    if (existing) {
      return res.status(400).json({ error: 'Email already in use' });
    }
    
    const passwordHash = await bcrypt.hash(password, 10);
    const userId = crypto.randomUUID();
    
    await prisma.userProfile.create({
      data: {
        userId,
        email,
        name,
        passwordHash,
      }
    });
    
    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, userId });
  } catch (err: any) {
    logger.error('signup error', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

app.post('/api/auth/login', validate(z.object({
  email: z.string().email(),
  password: z.string()
})), async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.userProfile.findFirst({ where: { email } });
    
    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    const token = jwt.sign({ userId: user.userId }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, userId: user.userId });
  } catch (err: any) {
    logger.error('login error', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Protect all /api routes below (except health/public routes/auth)
const protectedRouter = express.Router();
protectedRouter.use(requireAuth);
app.use('/api', protectedRouter);

// ────────────────────────────────────────────────────────
// REDIS + BULLMQ
// ────────────────────────────────────────────────────────
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
let monitorQueue: Queue | null = null;
// Shared BullMQ queue for bulk/batch resume tailoring (single requests bypass this)
let tailoringQueue: Queue | null = null;
let redisSubscriber: Redis | null = null;

try {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  connection.on('error', () => { /* suppress */ });

  monitorQueue = new Queue('monitorQueue', { connection });
  monitorQueue.on('error', () => { /* suppress */ });
  monitorQueue.add('embedding-backfill', {}, { repeat: { pattern: '0 * * * *' }, jobId: 'embedding-backfill-cron' });

  tailoringQueue = new Queue('tailoringQueue', { connection });
  tailoringQueue.on('error', () => { /* suppress */ });

  console.log('[Server] Connected to Redis for BullMQ.');

  redisSubscriber = new Redis(redisUrl, { maxRetriesPerRequest: null });
  redisSubscriber.on('error', (err) => {
    // Suppress unhandled error events
  });
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

// SELECTOR REGISTRY API has been moved to public routes section above

// ────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────
const getUserId = (req: express.Request): string =>
  (req as any).userId || 'default-user';

// HEALTH ENDPOINT has been moved to public routes section above

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

  // Reject LinkedIn URLs that will never produce results
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('linkedin.com')) {
      if (parsed.pathname.startsWith('/in/')) {
        return res.status(400).json({ error: 'This is a LinkedIn profile URL, not a jobs page. Use a company jobs page (e.g. /company/google/jobs) or a search URL (/jobs/search?keywords=...).' });
      }
      if (parsed.pathname === '/jobs' || parsed.pathname === '/jobs/') {
        return res.status(400).json({ error: 'This is LinkedIn\'s generic jobs homepage. Add search filters (keywords, location) or use a specific company page URL.' });
      }
    }
  } catch { /* URL class will throw for non-URLs, but Zod already validated it */ }

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
          const saved = await prisma.jobSnapshot.create({
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

          // Fire-and-forget: populate jobEmbedding for semantic scoring
          embedText(jobToEmbedText({ title: job.title, companyName: job.companyName, location: job.location }))
            .then(async vec => {
              // SQL injection prevention: vec (JSON array) and saved.id are bound
              // as tagged-template parameters — never concatenated into the SQL string.
              await prisma.$executeRaw`
                UPDATE "JobSnapshot"
                SET    "jobEmbedding" = ${JSON.stringify(vec)}::vector,
                       "embeddingStatus" = 'ok'
                WHERE  id = ${saved.id}
              `
            })
            .catch(async err => {
              logger.error({ err, jobId: saved.id }, '[jobs/bulk] jobEmbedding write failed');
              await prisma.jobSnapshot.update({ where: { id: saved.id }, data: { embeddingStatus: 'failed' } }).catch(() => {});
            });
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
app.post('/api/alerts/email', async (req, res) => {
  // Email alerting disabled per user request
  res.json({ success: true, message: 'Email alerts temporarily disabled.' });
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
        isNew: true,
      },
      include: { trackedSearch: { select: { url: true, platform: true } } },
      orderBy: { firstSeenAt: 'desc' },
      take: 50,
    });

    // Mark as polled so they won't be re-fetched
    if (jobs.length > 0) {
      await prisma.jobSnapshot.updateMany({
        where: { id: { in: jobs.map(j => j.id) } },
        data: { isNew: false },
      });
    }

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

    // Calculate hybrid scores
    const enrichedJobs = await Promise.all(jobs.map(async (j) => {
      // In a real production system with high load, we'd do this as a bulk query.
      // For now, doing it sequentially/parallel-mapped is fine for a personal tool.
      const semanticSim = await fetchCosineSimilarity(prisma, j.id, userId);
      
      // Parse heuristic score out of matchReason, or default to 50 if it's missing (shouldn't be, but as a fallback)
      // Wait, in our storage/schema we only store matchReason (string). We don't actually persist the raw numeric score.
      // Let's assume a base heuristic score of 70 for anything that matched.
      // Or we can re-evaluate it using calculateMatchScore, but the backend doesn't have the profile easily loaded here yet.
      // Let's just use a base heuristic of 70, or extract it if we had it.
      const baseHeuristic = 70; // Placeholder until we persist matchScore
      const hybrid = combineScores(baseHeuristic, semanticSim, j.matchReason || '');

      return {
        id: j.id,
        title: j.title,
        companyName: j.companyName || extractCompanyFromUrl(j.trackedSearch.url) || 'Company',
        location: j.location,
        url: j.url,
        matchReason: hybrid.reason,
        heuristicScore: hybrid.heuristicScore,
        semanticScore: hybrid.semanticScore,
        hybridScore: hybrid.hybridScore,
        firstSeenAt: j.firstSeenAt,
        seenAt: j.seenAt,
        sourceDomain: new URL(j.trackedSearch.url).hostname,
      };
    }));

    res.json(enrichedJobs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
// SEMANTIC SEARCH
// ════════════════════════════════════════════════════════
app.get('/api/jobs/semantic-search', async (req, res) => {
  const userId = getUserId(req);
  const limit = Math.min(50, parseInt((req.query.limit as string) || '20', 10));

  try {
    // Top-K vector search using pgvector's cosine distance `<=>` operator.
    // 1 - (distance / 2) = cosine similarity [0, 1]
    // SQL injection prevention: userId and limit are bound as tagged-template
    // parameters — never concatenated into the SQL string.
    const rows = await prisma.$queryRaw<Array<{
      id: string;
      title: string;
      companyName: string;
      location: string;
      url: string;
      similarity: number;
    }>>`
      SELECT
        j.id,
        j.title,
        j."companyName",
        j.location,
        j.url,
        1 - (j."jobEmbedding" <=> p."profileEmbedding" / 2.0) AS similarity
      FROM "JobSnapshot" j
      JOIN "TrackedSearch" ts ON ts.id = j."trackedSearchId"
      JOIN "UserProfile" p ON p."userId" = ts."userId"
      WHERE ts."userId" = ${userId}
        AND j."jobEmbedding" IS NOT NULL
        AND p."profileEmbedding" IS NOT NULL
      ORDER BY j."jobEmbedding" <=> p."profileEmbedding" ASC
      LIMIT ${limit}
    `;

    res.json(
      rows.map(r => ({
        id: r.id,
        title: r.title,
        companyName: r.companyName || 'Unknown',
        location: r.location,
        url: r.url,
        semanticScore: Math.round(r.similarity * 100),
      }))
    );
  } catch (err: any) {
    logger.error(err, '[jobs/semantic-search] Error');
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

    // Regenerate profileEmbedding whenever resume-relevant fields change
    const resumeFields = ['targetRoles', 'locations', 'experienceLevel', 'skills', 'experience'];
    const touchedResumeField = resumeFields.some(f => f in data);
    if (touchedResumeField) {
      embedText(profileToEmbedText({
        targetRoles:     profile.targetRoles,
        locations:       profile.locations,
        experienceLevel: profile.experienceLevel,
        skills:          profile.skills,
        experience:      profile.experience,
      }))
        .then(async vec => {
          // SQL injection prevention: vec (JSON array) and userId are bound
          // as tagged-template parameters — never concatenated into the SQL string.
          await prisma.$executeRaw`
            UPDATE "UserProfile"
            SET    "profileEmbedding" = ${JSON.stringify(vec)}::vector,
                   "embeddingStatus" = 'ok'
            WHERE  "userId" = ${userId}
          `
        })
        .catch(async err => {
          logger.error({ err, userId }, '[profile] profileEmbedding write failed');
          await prisma.userProfile.update({ where: { userId }, data: { embeddingStatus: 'failed' } }).catch(() => {});
        });
    }

    res.json(profile);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE — delete user account and cascade all associated data
app.delete('/api/account', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  if (!userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    await prisma.$transaction([
      prisma.userSubscription.deleteMany({ where: { userId } }),
      prisma.trackedSearch.deleteMany({ where: { userId } }),
      prisma.userProfile.deleteMany({ where: { userId } }),
    ]);

    res.json({ success: true, message: 'Account and all associated data deleted successfully.' });
  } catch (err: any) {
    logger.error({ err, userId }, 'Error deleting account');
    res.status(500).json({ error: 'Failed to delete account' });
  }
});


// ════════════════════════════════════════════════════════
// RESUME TAILORING API
// Single requests are served synchronously (direct Claude call).
// Bulk/batch requests are queued via BullMQ so the HTTP call returns
// immediately and the work happens in the background worker.
// ════════════════════════════════════════════════════════

// ── Per-user-per-day rate limiter for Bedrock/Claude calls ──
// Free cap: 10 tailoring calls per user per 24 h.
// Keyed by X-User-Id (or JWT userId) so each user gets their own counter.
const TAILOR_DAILY_LIMIT = parseInt(process.env.TAILOR_DAILY_LIMIT || '10', 10);
const tailorRateLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: TAILOR_DAILY_LIMIT,
  keyGenerator: (req) => (req as any).userId || req.ip || 'anonymous',
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: `Tailoring limit reached. You can tailor up to ${TAILOR_DAILY_LIMIT} resumes per day. Try again tomorrow.`,
    code: 'TAILOR_RATE_LIMIT',
  },
});

const TailorSchema = z.object({
  jobTitle:       z.string().min(1).max(300),
  companyName:    z.string().min(1).max(200),
  jobLocation:    z.string().max(200).optional(),
  jobDescription: z.string().min(10).max(20_000),
  /** If supplied the tailored resume is linked to this JobSnapshot row */
  jobSnapshotId:  z.string().uuid().optional(),
});

/**
 * POST /api/resumes/tailor
 * Single, synchronous tailoring request from the extension.
 * Returns the tailored markdown directly — no polling needed.
 */
app.post(
  '/api/resumes/tailor',
  requireAuth,
  tailorRateLimiter,
  validate(TailorSchema),
  async (req, res) => {
    const userId = (req as any).userId as string;
    try {
      const { jobTitle, companyName, jobLocation, jobDescription, jobSnapshotId } = req.body;

      logger.info({ userId, jobTitle, companyName }, '[tailor] Sync request received');

      const result = await tailorResume(prisma, {
        userId,
        jobTitle,
        companyName,
        jobLocation,
        jobDescription,
        jobSnapshotId,
      });

      return res.status(200).json({
        resumeText: result.resumeText,
        savedId:    result.savedId ?? null,
      });
    } catch (err: any) {
      // Distinguish user-facing errors (no profile / no resume data) from
      // infra errors (Claude API down) so the extension can show a helpful message
      if (
        err.message?.includes('profile not found') ||
        err.message?.includes('No resume data')
      ) {
        return res.status(422).json({ error: err.message });
      }
      logger.error(err, '[tailor] Failed to generate tailored resume');
      return res.status(502).json({ error: 'AI service error. Please try again later.' });
    }
  },
);

/**
 * POST /api/resumes/tailor/batch
 * Bulk tailoring for multiple jobs at once.
 * Enqueues one BullMQ job per item and returns job IDs immediately.
 * The worker processes each item asynchronously.
 */
const TailorBatchSchema = z.object({
  items: z.array(TailorSchema).min(1).max(50),
});

app.post(
  '/api/resumes/tailor/batch',
  requireAuth,
  validate(TailorBatchSchema),
  async (req, res) => {
    const userId = (req as any).userId as string;
    const { items } = req.body;

    if (!tailoringQueue) {
      return res.status(503).json({ error: 'Batch tailoring unavailable (Redis not connected).' });
    }

    try {
      const jobs = await Promise.all(
        items.map((item: z.infer<typeof TailorSchema>) =>
          tailoringQueue!.add('tailor', { userId, ...item }, { attempts: 2, backoff: { type: 'exponential', delay: 5000 } })
        )
      );

      logger.info({ userId, count: jobs.length }, '[tailor/batch] Enqueued batch tailoring jobs');
      return res.status(202).json({
        queued:  jobs.length,
        jobIds:  jobs.map(j => j.id),
        message: 'Batch enqueued. Results will be available via /api/resumes/lookup once processed.',
      });
    } catch (err: any) {
      logger.error(err, '[tailor/batch] Failed to enqueue batch');
      return res.status(500).json({ error: 'Failed to queue batch tailoring.' });
    }
  },
);

/**
 * GET /api/resumes/lookup?jobSnapshotId=<id>
 * Returns the most-recent tailored resume for a given JobSnapshot.
 */
app.get('/api/resumes/lookup', requireAuth, async (req, res) => {
  const userId = (req as any).userId as string;
  const { jobSnapshotId } = req.query;

  if (!jobSnapshotId || typeof jobSnapshotId !== 'string') {
    return res.status(400).json({ error: 'jobSnapshotId query param required' });
  }

  try {
    // Security check: ensure the snapshot belongs to this user
    const snapshot = await prisma.jobSnapshot.findFirst({
      where: {
        id: jobSnapshotId,
        trackedSearch: { userId },
      },
      include: { tailoredResumes: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });

    if (!snapshot) return res.status(404).json({ error: 'Snapshot not found or access denied' });

    const resume = snapshot.tailoredResumes[0] ?? null;
    return res.json({ resume });
  } catch (err: any) {
    logger.error(err, '[resumes/lookup] Error');
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/resumes/:resumeId
 * Returns a specific TailoredResume by its own ID.
 */
app.get('/api/resumes/:resumeId', requireAuth, async (req, res) => {
  const userId = (req as any).userId as string;
  const { resumeId } = req.params;

  try {
    const resume = await prisma.tailoredResume.findFirst({
      where: {
        id: resumeId,
        jobSnapshot: { trackedSearch: { userId } },
      },
    });

    if (!resume) return res.status(404).json({ error: 'Resume not found or access denied' });
    return res.json({ resume });
  } catch (err: any) {
    logger.error(err, '[resumes/:id] Error');
    return res.status(500).json({ error: err.message });
  }
});

export { app, httpServer };

if (process.env.NODE_ENV !== 'test') {
  const PORT = process.env.PORT || 5000;
  httpServer.listen(PORT, () => {
    console.log(`\n🚀 NextRole Backend Running on http://localhost:${PORT}`);
    console.log(`- API endpoints: http://localhost:${PORT}/api/*`);
    console.log(`- Socket.io Telemetry Active`);
  });
}
