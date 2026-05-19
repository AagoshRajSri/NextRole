import express from 'express';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prisma = new PrismaClient();
const app = express();
app.use(express.json());

// Serve generated PDFs statically
app.use('/resumes', express.static(path.join(__dirname, 'public/resumes')));

// Enable CORS for Chrome Extension requests
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-User-Id');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});


// Initialize BullMQ Queue if Redis is configured
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
let monitorQueue: Queue | null = null;
try {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  monitorQueue = new Queue('monitorQueue', { connection });
  console.log('[Server] Successfully connected to Redis for BullMQ.');
} catch (e) {
  console.warn('[Server] Redis not connected. BullMQ monitoring queue will be disabled locally.');
}

// Helper to get User ID from headers
const getUserId = (req: express.Request): string => {
  return (req.header('X-User-Id') || 'default-user').trim();
};

/**
 * ----------------------------------------------------
 * TRACKED SEARCHES API
 * ----------------------------------------------------
 */

// GET /api/tracked-searches - List all saved searches for user
app.get('/api/tracked-searches', async (req, res) => {
  const userId = getUserId(req);
  try {
    const searches = await prisma.trackedSearch.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });
    res.json(searches);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tracked-searches - Add a new saved search
app.post('/api/tracked-searches', async (req, res) => {
  const userId = getUserId(req);
  const { url, platform } = req.body;

  if (!url || !platform) {
    return res.status(400).json({ error: 'URL and platform are required.' });
  }

  try {
    // Avoid exact duplicate URL searches for the same user
    const existing = await prisma.trackedSearch.findFirst({
      where: { userId, url }
    });

    if (existing) {
      return res.status(200).json(existing);
    }

    const newSearch = await prisma.trackedSearch.create({
      data: {
        userId,
        url,
        platform
      }
    });

    // Proactively queue an immediate scraping job for this newly tracked search
    if (monitorQueue) {
      await monitorQueue.add('scrape-single', { searchId: newSearch.id, url: newSearch.url });
      console.log(`[Server] Queued immediate scrape for new search: ${newSearch.id}`);
    }

    res.status(201).json(newSearch);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/tracked-searches/:id - Delete a saved search
app.delete('/api/tracked-searches/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.trackedSearch.delete({
      where: { id }
    });
    res.json({ success: true, message: 'Saved search deleted successfully.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ----------------------------------------------------
 * JOB SNAPSHOTS & BACKGROUND POLLING API
 * ----------------------------------------------------
 */

// GET /api/new-jobs - Poll for newly detected jobs (extension background worker calls this)
app.get('/api/new-jobs', async (req, res) => {
  const userId = getUserId(req);
  try {
    // Fetch all job snapshots marked as 'isNew' for the user's searches
    const newJobs = await prisma.jobSnapshot.findMany({
      where: {
        isNew: true,
        trackedSearch: { userId }
      },
      include: {
        trackedSearch: true
      },
      orderBy: { firstSeenAt: 'desc' }
    });

    // Mark these jobs as processed (isNew = false) so we don't notify twice
    if (newJobs.length > 0) {
      await prisma.jobSnapshot.updateMany({
        where: {
          id: { in: newJobs.map(job => job.id) }
        },
        data: { isNew: false }
      });
    }

    res.json(newJobs.map(job => ({
      id: job.id,
      companyName: job.trackedSearch.url.includes('workday') 
        ? 'Workday' 
        : job.trackedSearch.url.includes('greenhouse') 
          ? 'Greenhouse Board' 
          : 'Lever Board',
      title: job.title,
      location: job.location,
      url: job.url,
      atsJobId: job.atsJobId,
      firstSeenAt: job.firstSeenAt
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ----------------------------------------------------
 * PROFILE (MASTER RESUME) API
 * ----------------------------------------------------
 */

// GET /api/profile - Fetch master resume profile
app.get('/api/profile', async (req, res) => {
  const userId = getUserId(req);
  try {
    const profile = await prisma.userProfile.findUnique({
      where: { userId }
    });
    if (!profile) {
      return res.json({ experience: '', skills: '', education: '', projects: '' });
    }
    res.json(profile);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/profile - Create or update master resume profile
app.post('/api/profile', async (req, res) => {
  const userId = getUserId(req);
  const { experience, skills, education, projects } = req.body;

  try {
    const profile = await prisma.userProfile.upsert({
      where: { userId },
      update: {
        experience: experience || '',
        skills: skills || '',
        education: education || '',
        projects: projects || ''
      },
      create: {
        userId,
        experience: experience || '',
        skills: skills || '',
        education: education || '',
        projects: projects || ''
      }
    });
    res.json(profile);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ----------------------------------------------------
 * TAILORED RESUMES API
 * ----------------------------------------------------
 */

// GET /api/resumes/lookup - Query tailored resume by active URL
app.get('/api/resumes/lookup', async (req, res) => {
  const url = req.query.url as string;
  const userId = getUserId(req);

  if (!url) {
    return res.status(400).json({ error: 'URL is required.' });
  }

  try {
    const snapshot = await prisma.jobSnapshot.findFirst({
      where: {
        url: {
          contains: url
        },
        trackedSearch: { userId }
      },
      include: {
        tailoredResumes: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      }
    });

    if (!snapshot || snapshot.tailoredResumes.length === 0) {
      return res.status(404).json({ error: 'No tailored resume found for this job.' });
    }

    res.json({
      snapshot,
      resume: snapshot.tailoredResumes[0]
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/resumes/:jobId - Get tailored resume for a specific job snapshot
app.get('/api/resumes/:jobId', async (req, res) => {
  const { jobId } = req.params;
  try {
    const resume = await prisma.tailoredResume.findFirst({
      where: { jobSnapshotId: jobId },
      orderBy: { createdAt: 'desc' }
    });
    if (!resume) {
      return res.status(404).json({ error: 'Tailored resume not found for this job.' });
    }
    res.json(resume);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});



const FREE_TIER_MAX_RUNS = 5;

export async function verifyTokenBudget(req: express.Request, res: express.Response, next: express.NextFunction) {
  const userId = getUserId(req);

  try {
    const user = await prisma.userProfile.findUnique({
      where: { userId }
    });

    if (!user) {
      return res.status(404).json({ error: "User profile console not found." });
    }

    // Check if user is a premium tier subscriber
    if (!user.isPremium) {
      // If free tier, enforce hard cap ceiling
      if (user.monthlyRunsUsed >= FREE_TIER_MAX_RUNS) {
        return res.status(402).json({
          error: "TOKEN_LIMIT_EXCEEDED",
          message: "You have reached your 5 free AI customizations for this month. Upgrade to Premium for infinite bandwidth or supply a custom API key under settings."
        });
      }
    }

    // If validations pass, increment count and handoff request to compiler queue
    await prisma.userProfile.update({
      where: { userId },
      data: { monthlyRunsUsed: { increment: 1 } }
    });

    next();
  } catch (error) {
    return res.status(500).json({ error: "Internal Gateway Error verifying pipeline limits." });
  }
}

// POST /api/resumes/tailor - Trigger an AI resume tailoring job
app.post('/api/resumes/tailor', verifyTokenBudget, async (req, res) => {
  const userId = getUserId(req);
  const { jobSnapshotId, companyName } = req.body;

  if (!jobSnapshotId || !companyName) {
    return res.status(400).json({ error: "jobSnapshotId and companyName are required." });
  }

  try {
    const jobSnapshot = await prisma.jobSnapshot.findUnique({
      where: { id: jobSnapshotId }
    });

    if (!jobSnapshot) {
      return res.status(404).json({ error: "Job snapshot not found." });
    }

    if (monitorQueue) {
      await monitorQueue.add('resume-tailoring', {
        userId,
        company: companyName,
        jobSnapshot
      });
      return res.status(202).json({ message: "Resume tailoring job queued successfully." });
    } else {
      return res.status(503).json({ error: "Job queue is not active." });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// START EXPRESS SERVER
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n🚀 NextRole Backend Running on http://localhost:${PORT}`);
  console.log(`- API endpoints: http://localhost:${PORT}/api/*`);
});
