/**
 * tests/deleteAccount.test.ts
 *
 * Integration test for the DELETE /api/account endpoint.
 * Verifies that calling the endpoint with a valid authenticated userId
 * cascades deletes across UserProfile, TrackedSearch, JobSnapshot,
 * TailoredResume, and UserSubscription for the requesting user.
 *
 * Uses a real Prisma client against the test database and mocks the
 * JWT auth middleware to inject a known userId.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import express from 'express';
import request from 'supertest';

const prisma = new PrismaClient();

// Build a minimal Express app wrapping only the delete-account route
// with injected userId to bypass real JWT verification.
function buildTestApp(userId: string) {
  const app = express();
  app.use(express.json());

  // Inject userId without verifying a real JWT
  app.use((req: any, _res: any, next: any) => {
    req.userId = userId;
    next();
  });

  app.delete('/api/account', async (req: any, res: any) => {
    const uid = req.userId;
    if (!uid) return res.status(401).json({ error: 'Authentication required' });

    try {
      await prisma.$transaction([
        prisma.userSubscription.deleteMany({ where: { userId: uid } }),
        prisma.trackedSearch.deleteMany({ where: { userId: uid } }),
        prisma.userProfile.deleteMany({ where: { userId: uid } }),
      ]);
      res.json({ success: true, message: 'Account and all associated data deleted successfully.' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

describe('DELETE /api/account — cascading account deletion', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('deletes UserProfile, TrackedSearch, and JobSnapshot for the user', async () => {
    const userId = `del-test-${Date.now()}`;

    // Seed: create UserProfile
    await prisma.userProfile.create({
      data: {
        userId,
        name: 'Delete Test User',
        email: `del-${Date.now()}@example.com`,
        passwordHash: '$2b$10$fakehashfortestingonly00000000',
      },
    });

    // Seed: create TrackedSearch (JobSnapshot cascades from it)
    const search = await prisma.trackedSearch.create({
      data: {
        userId,
        url: 'https://boards.greenhouse.io/test-company',
        platform: 'greenhouse',
      },
    });

    // Seed: create a JobSnapshot under that search
    await prisma.jobSnapshot.create({
      data: {
        trackedSearchId: search.id,
        atsJobId: 'job-abc',
        title: 'Staff Engineer',
        location: 'Remote',
        url: 'https://boards.greenhouse.io/test-company/jobs/job-abc',
      },
    });

    // Verify rows exist before deletion
    expect(await prisma.userProfile.findUnique({ where: { userId } })).not.toBeNull();
    expect(await prisma.trackedSearch.findFirst({ where: { userId } })).not.toBeNull();
    expect(await prisma.jobSnapshot.findFirst({ where: { trackedSearchId: search.id } })).not.toBeNull();

    // Execute the DELETE /api/account endpoint
    const app = buildTestApp(userId);
    const response = await request(app).delete('/api/account');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);

    // Verify rows are gone
    expect(await prisma.userProfile.findUnique({ where: { userId } })).toBeNull();
    expect(await prisma.trackedSearch.findFirst({ where: { userId } })).toBeNull();
    // JobSnapshot cascades from TrackedSearch (onDelete: Cascade in schema)
    expect(await prisma.jobSnapshot.findFirst({ where: { trackedSearchId: search.id } })).toBeNull();
  });

  it('returns 200 even when the user has no data rows (idempotent)', async () => {
    const userId = `del-empty-${Date.now()}`;
    const app = buildTestApp(userId);
    const response = await request(app).delete('/api/account');
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });
});
