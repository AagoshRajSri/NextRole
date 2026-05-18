import express from 'express';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import Stripe from 'stripe';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
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

// Configure Stripe (fallback to mock if key is missing)
const stripeKey = process.env.STRIPE_SECRET_KEY || '';
const stripe = stripeKey.startsWith('sk_') ? new Stripe(stripeKey) : null;

// Initialize BullMQ Queue if Redis is configured
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
let monitorQueue: Queue | null = null;
try {
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
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

/**
 * ----------------------------------------------------
 * PREMIUM SUBSCRIPTION & STRIPE PAYWALL API
 * ----------------------------------------------------
 */

// GET /api/subscription - Check user's subscription status
app.get('/api/subscription', async (req, res) => {
  const userId = getUserId(req);
  try {
    const sub = await prisma.userSubscription.findUnique({
      where: { userId }
    });
    res.json({ isActive: sub?.isActive || false });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/checkout - Create a Stripe checkout session for $15/month paywall
app.post('/api/checkout', async (req, res) => {
  const userId = getUserId(req);
  
  try {
    if (!stripe) {
      // Mock payment mode for testing when Stripe key is not configured
      console.log(`[Stripe Mock] Creating checkout for user: ${userId}`);
      
      // Proactively activate premium subscription immediately in mock mode
      await prisma.userSubscription.upsert({
        where: { userId },
        update: { isActive: true },
        create: { userId, stripeCustomerId: `mock-cus-${userId}`, isActive: true }
      });
      
      return res.json({ url: 'https://checkout.stripe.com/mock-success-premium-activated' });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'NextRole Premium Plan',
              description: 'AI-tailored resumes and 24/7 background job board monitoring',
            },
            unit_amount: 1500, // $15.00
            recurring: { interval: 'month' },
          },
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `${req.headers.origin || 'http://localhost:3000'}/subscription-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin || 'http://localhost:3000'}/subscription-cancel`,
      client_reference_id: userId,
    });

    res.json({ url: session.url });
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
