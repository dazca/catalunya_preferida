/**
 * @file Tests for the scoring engine with TransferFunction-based configs.
 */
import { describe, it, expect } from 'vitest';
import { clamp01, computeScore, computeAllScores, normalizeIne } from '../utils/scorer';
import type { MunicipalityData } from '../utils/scorer';
import type { LayerMeta } from '../types';
import type { LayerConfigs } from '../types/transferFunction';
import { DEFAULT_LAYER_CONFIGS, defaultTf } from '../types/transferFunction';
import { DEFAULT_LAYERS } from '../store';

describe('normalizeIne', () => {
  it('extracts 5-digit INE from 6-digit GeoJSON code', () => {
    expect(normalizeIne('170010')).toBe('17001');
  });
  it('extracts 5-digit INE from 10-digit vote code', () => {
    expect(normalizeIne('1700100000')).toBe('17001');
  });
  it('passes through 5-digit code unchanged', () => {
    expect(normalizeIne('17001')).toBe('17001');
  });
});

describe('clamp01', () => {
  it('clamps negative values to 0', () => {
    expect(clamp01(-1)).toBe(0);
  });
  it('clamps values > 1 to 1', () => {
    expect(clamp01(1.5)).toBe(1);
  });
  it('passes through values in [0, 1]', () => {
    expect(clamp01(0.5)).toBe(0.5);
  });
});

function makeEmptyData(): MunicipalityData {
  return {
    terrain: {},
    votes: {},
    forest: {},
    crime: {},
    rentalPrices: {},
    employment: {},
    climate: {},
    airQuality: {},
    internet: {},
    transitDistKm: {},
    healthcareDistKm: {},
    schoolDistKm: {},
    amenityDistKm: {},
  };
}

describe('computeScore', () => {
  it('returns 0 when no data is available for any layer', () => {
    const layers: LayerMeta[] = DEFAULT_LAYERS.filter((l) => l.enabled);
    const result = computeScore('08001', layers, DEFAULT_LAYER_CONFIGS, makeEmptyData());
    expect(result.score).toBe(0);
    expect(Object.keys(result.layerScores)).toHaveLength(0);
  });

  it('scores forest layer via transfer function', () => {
    const data = makeEmptyData();
    data.forest['08001'] = { codi: '08001', forestPct: 60, agriculturalPct: 20, urbanPct: 20 };

    const layers: LayerMeta[] = [
      { id: 'forest', label: 'Forest', description: '', icon: '', enabled: true, weight: 1 },
    ];
    // Forest TF: non-inverted, plateauEnd=10, decayEnd=80 — 60% is well within decay zone
    const configs: LayerConfigs = {
      ...DEFAULT_LAYER_CONFIGS,
      forest: { enabled: true, tf: defaultTf(10, 80, false, 0) },
    };

    const result = computeScore('08001', layers, configs, data);
    expect(result.score).toBeGreaterThan(0);
    expect(result.layerScores.forest).toBeDefined();
    // At 60, t = (60-10)/(80-10) = 50/70 ≈ 0.714, score = 0.5*(1+cos(π*0.714))
    expect(result.layerScores.forest!).toBeGreaterThan(0.1);
    expect(result.layerScores.forest!).toBeLessThan(0.5);
  });

  it('scores crime layer with inverted TF (lower = better)', () => {
    const data = makeEmptyData();
    data.crime['08001'] = {
      codi: '08001', nom: 'Test', totalOffenses: 100, ratePerThousand: 10, year: 2023,
    };

    const layers: LayerMeta[] = [
      { id: 'crime', label: 'Crime', description: '', icon: '', enabled: true, weight: 1 },
    ];
    // Inverted TF: plateauEnd=5, decayEnd=50 — rate 10 is early in decay, should be high
    const configs: LayerConfigs = {
      ...DEFAULT_LAYER_CONFIGS,
      crime: { enabled: true, tf: defaultTf(5, 50, true, 0) },
    };

    const result = computeScore('08001', layers, configs, data);
    expect(result.layerScores.crime).toBeGreaterThan(0.7);
  });

  it('disqualifies when mandatory layer is at floor', () => {
    const data = makeEmptyData();
    data.transitDistKm['08001'] = 100; // Very far, will score at floor

    const layers: LayerMeta[] = [
      { id: 'transit', label: 'Transit', description: '', icon: '', enabled: true, weight: 1 },
    ];
    const configs: LayerConfigs = {
      ...DEFAULT_LAYER_CONFIGS,
      transit: {
        enabled: true,
        tf: { plateauEnd: 5, decayEnd: 25, floor: 0, mandatory: true, multiplier: 1, invert: true },
      },
    };

    const result = computeScore('08001', layers, configs, data);
    expect(result.disqualified).toBe(true);
    expect(result.score).toBe(0);
  });

  it('applies layer weights correctly', () => {
    const data = makeEmptyData();
    data.forest['08001'] = { codi: '08001', forestPct: 5, agriculturalPct: 70, urbanPct: 25 };
    data.transitDistKm['08001'] = 0.5; // Very close

    const layers: LayerMeta[] = [
      { id: 'forest', label: 'Forest', description: '', icon: '', enabled: true, weight: 1 },
      { id: 'transit', label: 'Transit', description: '', icon: '', enabled: true, weight: 3 },
    ];
    // Forest at 5%: below plateauEnd=10 → full score=1.0
    const configs: LayerConfigs = {
      ...DEFAULT_LAYER_CONFIGS,
      forest: { enabled: true, tf: defaultTf(10, 80, false, 0) },
      transit: { enabled: true, tf: defaultTf(5, 25, true, 0) },
    };

    const result = computeScore('08001', layers, configs, data);
    // forest=1.0*w1, transit=1.0*w3 → (1*1+1*3)/4 = 1.0
    expect(result.score).toBeCloseTo(1.0, 1);
  });
});

describe('computeAllScores', () => {
  it('computes scores for multiple municipalities', () => {
    const data = makeEmptyData();
    data.forest['08001'] = { codi: '08001', forestPct: 5, agriculturalPct: 10, urbanPct: 85 };
    data.forest['08002'] = { codi: '08002', forestPct: 50, agriculturalPct: 30, urbanPct: 20 };

    const layers: LayerMeta[] = [
      { id: 'forest', label: 'Forest', description: '', icon: '', enabled: true, weight: 1 },
    ];
    const configs: LayerConfigs = {
      ...DEFAULT_LAYER_CONFIGS,
      forest: { enabled: true, tf: defaultTf(10, 80, false, 0) },
    };

    const result = computeAllScores(['08001', '08002'], layers, configs, data);
    // 5% is within plateau (<=10), so score=1.0
    // 50% is in decay zone, so score < 1.0
    expect(result['08001'].score).toBeGreaterThan(result['08002'].score);
  });
});
