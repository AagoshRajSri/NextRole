import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
// We must mock the heavy dependencies before importing the app
vi.mock('@prisma/client', () => {
  class MockPrismaClient {
    $queryRaw = vi.fn().mockResolvedValue([{}]);
    userProfile = {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    };
    trackedSearch = {
      findMany: vi.fn().mockResolvedValue([]),
    };
  }
  return {
    PrismaClient: MockPrismaClient,
  };
});

vi.mock('ioredis', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      ping: vi.fn().mockResolvedValue('PONG'),
      on: vi.fn(),
      subscribe: vi.fn((channel, cb) => cb && cb(null)),
    })),
    Redis: vi.fn().mockImplementation(() => ({
      ping: vi.fn().mockResolvedValue('PONG'),
      on: vi.fn(),
      subscribe: vi.fn((channel, cb) => cb && cb(null)),
    })),
  };
});

vi.mock('bullmq', () => {
  return {
    Queue: vi.fn().mockImplementation(() => ({
      on: vi.fn(),
    })),
  };
});

import { app } from '../jobtracker-backend/server';

describe('server.ts API endpoints', () => {
  it('GET /api/health should return 200 OK and healthy status', async () => {
    const response = await request(app).get('/api/health');
    
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('status', 'ok');
    expect(response.body.checks).toHaveProperty('database', 'ok');
  });

  it('Protected API routes should return 401 when no auth is provided', async () => {
    const response = await request(app).get('/api/profile');
    
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Authentication required' });
  });

  it('Protected API routes should return 401 for an invalid token format', async () => {
    const response = await request(app)
      .get('/api/profile')
      .set('Authorization', 'Bearer invalid-jwt-token');
    
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Invalid token' });
  });

  it('CORS validation blocks requests from unauthorized origins', async () => {
    // Assuming 'http://malicious-site.com' is not in ALLOWED_ORIGINS
    const response = await request(app)
      .get('/api/health')
      .set('Origin', 'http://malicious-site.com');
      
    // The health endpoint itself is public, but CORS middleware applies globally.
    // Wait, the CORS setup allows non-browser clients (Origin is undefined) but blocks unauthorized Origins.
    expect(response.status).toBe(500); // Express default error handler status for uncaught errors
    expect(response.text).toContain('CORS: origin');
  });
});
