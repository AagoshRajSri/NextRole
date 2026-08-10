import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('Database Schema Integration Test', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('inserts and reads back UserProfile with passwordHash, embeddingStatus, and embeddingRetries', async () => {
    const testUserId = `test-user-${Date.now()}`;

    // Insert user profile specifying the newly verified fields
    const createdProfile = await prisma.userProfile.create({
      data: {
        userId: testUserId,
        name: 'Integration Test User',
        email: 'test@example.com',
        passwordHash: '$2b$10$e898492839482938492348',
        embeddingStatus: 'ok',
        embeddingRetries: 1,
      },
    });

    expect(createdProfile.userId).toBe(testUserId);
    expect(createdProfile.passwordHash).toBe('$2b$10$e898492839482938492348');
    expect(createdProfile.embeddingStatus).toBe('ok');
    expect(createdProfile.embeddingRetries).toBe(1);

    // Read back directly from database
    const fetchedProfile = await prisma.userProfile.findUnique({
      where: { userId: testUserId },
    });

    expect(fetchedProfile).not.toBeNull();
    expect(fetchedProfile?.passwordHash).toBe('$2b$10$e898492839482938492348');
    expect(fetchedProfile?.embeddingStatus).toBe('ok');
    expect(fetchedProfile?.embeddingRetries).toBe(1);

    // Clean up
    await prisma.userProfile.delete({
      where: { userId: testUserId },
    });
  });

  it('inserts and reads back JobSnapshot with embeddingStatus and embeddingRetries', async () => {
    const testSearchId = `test-search-${Date.now()}`;
    const testUserId = `test-owner-${Date.now()}`;

    // Create prerequisite TrackedSearch
    const search = await prisma.trackedSearch.create({
      data: {
        id: testSearchId,
        userId: testUserId,
        url: 'https://example.com/careers',
        platform: 'generic',
      },
    });

    // Insert JobSnapshot specifying embeddingStatus and embeddingRetries
    const createdSnapshot = await prisma.jobSnapshot.create({
      data: {
        trackedSearchId: search.id,
        atsJobId: 'job-123',
        title: 'Backend Engineer',
        location: 'Remote',
        url: 'https://example.com/careers/job-123',
        embeddingStatus: 'failed',
        embeddingRetries: 3,
      },
    });

    expect(createdSnapshot.embeddingStatus).toBe('failed');
    expect(createdSnapshot.embeddingRetries).toBe(3);

    // Read back directly from database
    const fetchedSnapshot = await prisma.jobSnapshot.findUnique({
      where: { id: createdSnapshot.id },
    });

    expect(fetchedSnapshot).not.toBeNull();
    expect(fetchedSnapshot?.embeddingStatus).toBe('failed');
    expect(fetchedSnapshot?.embeddingRetries).toBe(3);

    // Clean up
    await prisma.trackedSearch.delete({
      where: { id: search.id },
    });
  });
});
