/**
 * @file Tests for TransferFunction evaluator and DataStats computation.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateTransferFunction,
  computeDataStats,
  scoreAspect,
} from '../utils/transferFunction';
import type { TransferFunction, AspectPreferences } from '../types/transferFunction';

/** Helper to create a simple TF. */
function makeTf(
  plateauEnd: number,
  decayEnd: number,
  shape: TransferFunction['shape'] = 'sin',
  floor = 0,
): TransferFunction {
  return { plateauEnd, decayEnd, floor, mandatory: false, multiplier: 1, shape };
}

describe('evaluateTransferFunction', () => {
  describe('non-inverted (higher input = worse)', () => {
    const tf = makeTf(10, 30, 'sin', 0);

    it('returns 1.0 at plateau (input <= plateauEnd)', () => {
      expect(evaluateTransferFunction(0, tf)).toBe(1.0);
      expect(evaluateTransferFunction(5, tf)).toBe(1.0);
      expect(evaluateTransferFunction(10, tf)).toBe(1.0);
    });

    it('returns floor at and beyond decayEnd', () => {
      expect(evaluateTransferFunction(30, tf)).toBe(0);
      expect(evaluateTransferFunction(50, tf)).toBe(0);
    });

    it('returns 0.5 at midpoint of decay (cosine midpoint)', () => {
      // At t=0.5, cos(π·0.5) = 0, so output = 0 + 1 * 0.5 * (1 + 0) = 0.5
      const mid = evaluateTransferFunction(20, tf);
      expect(mid).toBeCloseTo(0.5, 5);
    });

    it('decays smoothly through the decay zone', () => {
      const at12 = evaluateTransferFunction(12, tf);
      const at20 = evaluateTransferFunction(20, tf);
      const at28 = evaluateTransferFunction(28, tf);
      expect(at12).toBeGreaterThan(at20);
      expect(at20).toBeGreaterThan(at28);
    });
  });

  describe('non-inverted with floor > 0', () => {
    const tf = makeTf(5, 25, 'sin', 0.2);

    it('returns 1.0 at plateau', () => {
      expect(evaluateTransferFunction(3, tf)).toBe(1.0);
    });

    it('returns floor (0.2) beyond decay', () => {
      expect(evaluateTransferFunction(25, tf)).toBeCloseTo(0.2, 5);
      expect(evaluateTransferFunction(100, tf)).toBeCloseTo(0.2, 5);
    });

    it('midpoint is between 1.0 and floor', () => {
      // t=0.5 → 0.2 + 0.8 * 0.5 * (1+0) = 0.2 + 0.4 = 0.6
      const mid = evaluateTransferFunction(15, tf);
      expect(mid).toBeCloseTo(0.6, 5);
    });
  });

  describe('inverted (lower input = better)', () => {
    const tf = makeTf(5, 25, 'sin', 0);

    it('returns 1.0 when input <= plateauEnd', () => {
      expect(evaluateTransferFunction(0, tf)).toBe(1.0);
      expect(evaluateTransferFunction(5, tf)).toBe(1.0);
    });

    it('returns floor when input >= decayEnd', () => {
      expect(evaluateTransferFunction(25, tf)).toBe(0);
      expect(evaluateTransferFunction(50, tf)).toBe(0);
    });

    it('decays from plateauEnd to decayEnd', () => {
      const at10 = evaluateTransferFunction(10, tf);
      const at15 = evaluateTransferFunction(15, tf);
      const at20 = evaluateTransferFunction(20, tf);
      expect(at10).toBeGreaterThan(at15);
      expect(at15).toBeGreaterThan(at20);
    });

    it('returns 0.5 at midpoint of decay', () => {
      const mid = evaluateTransferFunction(15, tf);
      expect(mid).toBeCloseTo(0.5, 5);
    });
  });
});

describe('computeDataStats', () => {
  it('handles empty array', () => {
    const s = computeDataStats([], 'km');
    expect(s.count).toBe(0);
    expect(s.min).toBe(0);
    expect(s.max).toBe(0);
    expect(s.unit).toBe('km');
  });

  it('handles single value', () => {
    const s = computeDataStats([42], 'units');
    expect(s.count).toBe(1);
    expect(s.min).toBe(42);
    expect(s.max).toBe(42);
    expect(s.median).toBe(42);
  });

  it('computes correct stats for known data', () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const s = computeDataStats(data, 'x');
    expect(s.min).toBe(1);
    expect(s.max).toBe(10);
    expect(s.median).toBeCloseTo(5.5, 1);
    expect(s.p25).toBeCloseTo(3.25, 1);
    expect(s.p75).toBeCloseTo(7.75, 1);
    expect(s.count).toBe(10);
  });

  it('handles unsorted input', () => {
    const s = computeDataStats([5, 1, 3], 'v');
    expect(s.min).toBe(1);
    expect(s.max).toBe(5);
    expect(s.median).toBe(3);
  });
});

describe('scoreAspect', () => {
  const prefs: AspectPreferences = {
    N: 0.2, NE: 0.4, E: 0.6, SE: 0.8, S: 1.0, SW: 0.8, W: 0.6, NW: 0.4,
  };

  it('returns correct weight for each direction', () => {
    expect(scoreAspect('S', prefs)).toBe(1.0);
    expect(scoreAspect('N', prefs)).toBe(0.2);
    expect(scoreAspect('SE', prefs)).toBe(0.8);
  });

  it('is case-insensitive', () => {
    expect(scoreAspect('s', prefs)).toBe(1.0);
    expect(scoreAspect('ne', prefs)).toBe(0.4);
  });

  it('returns 0.5 for unknown direction', () => {
    expect(scoreAspect('XYZ', prefs)).toBe(0.5);
  });
});
