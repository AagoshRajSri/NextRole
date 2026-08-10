// ────────────────────────────────────────────────────────
// BACKEND MATCH SCORING — HYBRID HEURISTIC + SEMANTIC
//
// Combines:
//   • deterministic heuristic score (keywords, company, location) — 60 %
//   • cosine similarity via pgvector                              — 40 %
//
// The weights are intentionally exposed as named constants so they can
// be tuned (or moved to an env var) without touching call-sites.
// ────────────────────────────────────────────────────────

import { PrismaClient } from '@prisma/client';

/** 0-1 weights — must sum to 1.0 */
export const HEURISTIC_WEIGHT = 0.6;
export const SEMANTIC_WEIGHT  = 0.4;

export interface HybridScoreResult {
  /** 0-100 combined score */
  hybridScore:    number;
  /** 0-100 deterministic keyword/location/company score */
  heuristicScore: number;
  /** 0-100 vector cosine similarity score (null if embeddings unavailable) */
  semanticScore:  number | null;
  reason:         string;
}

/**
 * Fetch the cosine similarity between a job embedding and a profile embedding
 * from Postgres using pgvector's `<=>` operator (cosine distance).
 *
 * Returns null when either embedding is missing (not yet populated).
 *
 * @param prisma     — shared Prisma instance
 * @param snapshotId — `JobSnapshot.id`
 * @param userId     — `UserProfile.userId`
 */
export async function fetchCosineSimilarity(
  prisma: PrismaClient,
  snapshotId: string,
  userId: string,
): Promise<number | null> {
  try {
    // SQL injection prevention: snapshotId and userId are passed as tagged-template
    // parameters — Prisma serialises them as $1/$2 bound parameters, never via
    // string interpolation.  Do NOT convert this to a plain string template.
    //
    // pgvector `<=>` = cosine *distance* (0 = identical, 2 = opposite)
    // We convert to similarity: 1 - distance/2 → [0, 1]
    const rows = await prisma.$queryRaw<Array<{ dist: number }>>`
      SELECT
        (j."jobEmbedding" <=> p."profileEmbedding") AS dist
      FROM "JobSnapshot"  j
      JOIN "TrackedSearch" ts ON ts.id = j."trackedSearchId"
      JOIN "UserProfile"   p  ON p."userId" = ts."userId"
      WHERE j.id     = ${snapshotId}
        AND p."userId" = ${userId}
        AND j."embeddingStatus" = 'ok'
        AND p."embeddingStatus" = 'ok'
        AND j."jobEmbedding"     IS NOT NULL
        AND p."profileEmbedding" IS NOT NULL
      LIMIT 1
    `;

    if (!rows.length || rows[0].dist == null) return null;
    // cosine distance [0,2] → similarity [0,1] → percentage [0,100]
    return Math.round((1 - rows[0].dist / 2) * 100);
  } catch {
    // pgvector extension not enabled, or columns not yet populated
    return null;
  }
}

/**
 * Combine a pre-computed heuristic score with a semantic similarity score.
 * Both inputs are on a 0-100 scale.
 *
 * @param heuristicScore  keyword/rule score (0-100)
 * @param semanticScore   vector similarity  (0-100 | null)
 * @param heuristicReason reason string from the heuristic engine
 */
export function combineScores(
  heuristicScore: number,
  semanticScore:  number | null,
  heuristicReason: string,
): HybridScoreResult {
  let hybridScore: number;
  let reason = heuristicReason;

  if (semanticScore !== null) {
    hybridScore = Math.round(
      heuristicScore * HEURISTIC_WEIGHT + semanticScore * SEMANTIC_WEIGHT,
    );
    reason += ` | semantic:${semanticScore}`;
  } else {
    // Fall back to pure heuristic when no embedding is available
    hybridScore = heuristicScore;
  }

  return {
    hybridScore:    Math.min(100, Math.max(0, hybridScore)),
    heuristicScore: Math.min(100, Math.max(0, heuristicScore)),
    semanticScore,
    reason,
  };
}
