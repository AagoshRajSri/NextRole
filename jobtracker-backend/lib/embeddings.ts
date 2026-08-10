// ────────────────────────────────────────────────────────
// AWS TITAN TEXT EMBEDDINGS v2
// Shared module used by:
//   - Job ingest (worker.ts / server.ts) → populates jobEmbedding
//   - Profile save (server.ts)           → populates profileEmbedding
//
// Dimensions: 1024  (matches the vector(1024) Prisma columns)
// Model:      amazon.titan-embed-text-v2:0
//
// Falls back to a deterministic mock vector in dev/test when
// AWS_REGION is not set — so the server starts without credentials.
// ────────────────────────────────────────────────────────

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';

export const EMBEDDING_DIM = 1024;

// Lazy singleton — created only when a real embedding is needed
let _client: BedrockRuntimeClient | null = null;

function getClient(): BedrockRuntimeClient {
  if (!_client) {
    _client = new BedrockRuntimeClient({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: process.env.AWS_ACCESS_KEY_ID
        ? {
            accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
            sessionToken:    process.env.AWS_SESSION_TOKEN,
          }
        : undefined, // falls back to IAM role / EC2 instance profile
    });
  }
  return _client;
}

/**
 * Generate a 1024-dimensional embedding for `text` using AWS Titan v2.
 *
 * In dev mode (no AWS_ACCESS_KEY_ID + no IAM role) returns a
 * deterministic pseudo-vector derived from hashing the text so the rest
 * of the pipeline can be exercised without real AWS credentials.
 *
 * Throws on Bedrock API errors so callers can decide whether to
 * log-and-skip or surface the error.
 */
export async function embedText(text: string): Promise<number[]> {
  const cleaned = text.replace(/\s+/g, ' ').trim().slice(0, 8192); // Titan token limit

  // Dev mock path — no real API call, no AWS credentials required
  if (!process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) {
    return mockEmbedding(cleaned);
  }

  const client = getClient();
  const body = JSON.stringify({
    inputText: cleaned,
    dimensions: EMBEDDING_DIM,
    normalize: true,
  });

  const cmd = new InvokeModelCommand({
    modelId: 'amazon.titan-embed-text-v2:0',
    contentType: 'application/json',
    accept: 'application/json',
    body: Buffer.from(body),
  });

  const response = await client.send(cmd);
  const payload = JSON.parse(Buffer.from(response.body).toString('utf-8'));
  const embedding: number[] = payload.embedding;

  if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIM) {
    throw new Error(`Unexpected embedding shape: expected ${EMBEDDING_DIM} dims, got ${embedding?.length}`);
  }

  return embedding;
}

/**
 * Convenience: build a single text blob from a job for embedding.
 * Keeps the input stable so the vector is consistent across updates.
 */
export function jobToEmbedText(job: {
  title: string;
  companyName?: string | null;
  location?: string | null;
}): string {
  return [job.title, job.companyName, job.location]
    .filter(Boolean)
    .join(' | ');
}

/**
 * Convenience: build a profile blob for embedding.
 */
export function profileToEmbedText(profile: {
  targetRoles?: string[];
  locations?: string[];
  experienceLevel?: string | null;
  skills?: string | null;
  experience?: string | null;
}): string {
  const parts: string[] = [];
  if (profile.targetRoles?.length)   parts.push('Roles: ' + profile.targetRoles.join(', '));
  if (profile.locations?.length)     parts.push('Locations: ' + profile.locations.join(', '));
  if (profile.experienceLevel)       parts.push('Level: ' + profile.experienceLevel);
  if (profile.skills)                parts.push('Skills: ' + profile.skills);
  if (profile.experience)            parts.push('Experience: ' + profile.experience.slice(0, 2000));
  return parts.join(' | ');
}

// ── deterministic mock (dev only) ──────────────────────────────────────────
function mockEmbedding(text: string): number[] {
  // Simple hash-seeded sinusoidal vector — not meaningful but stable
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  }
  return Array.from({ length: EMBEDDING_DIM }, (_, i) =>
    Math.sin(h * (i + 1) * 0.0001) * 0.5 + 0.5
  );
}
