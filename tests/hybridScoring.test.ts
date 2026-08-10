import { describe, it, expect } from 'vitest';
import { combineScores } from '../jobtracker-backend/lib/hybridScoring';

describe('hybridScoring', () => {
  it('combines heuristic and semantic scores using configured weights', () => {
    // Using default weights: 60% heuristic, 40% semantic
    const result = combineScores(80, 50, 'role:swe');
    // 80 * 0.6 + 50 * 0.4 = 48 + 20 = 68
    expect(result.hybridScore).toBe(68);
    expect(result.heuristicScore).toBe(80);
    expect(result.semanticScore).toBe(50);
    expect(result.reason).toContain('role:swe | semantic:50');
  });

  it('falls back to 100% heuristic weight if semantic score is null (e.g. due to failed embedding)', () => {
    const result = combineScores(80, null, 'role:swe');
    // Falls back to heuristic only without throwing or diluting the score
    expect(result.hybridScore).toBe(80);
    expect(result.heuristicScore).toBe(80);
    expect(result.semanticScore).toBeNull();
    expect(result.reason).toBe('role:swe');
  });

  it('clamps scores between 0 and 100', () => {
    // 150 * 0.6 + (-20) * 0.4 = 90 - 8 = 82
    const result = combineScores(150, -20, 'test');
    expect(result.hybridScore).toBeGreaterThanOrEqual(0);
    expect(result.hybridScore).toBeLessThanOrEqual(100);
    // The heuristic score itself is clamped to 100 on output
    expect(result.heuristicScore).toBe(100);
  });
});
