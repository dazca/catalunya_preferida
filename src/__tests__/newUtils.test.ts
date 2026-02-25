/**
 * @file Tests for turbo colormap, defaults utility, and hypsometric helpers.
 */
import { describe, it, expect } from 'vitest';
import { scoreToRgba, scoreToCssColor } from '../utils/turboColormap';
import {
  median,
  fillGapsWithComarcaMedian,
  buildCodiToComarca,
} from '../utils/defaults';
import { elevationToRgb, decodeElevation } from '../utils/hypsometric';

/* ================================================================== */
/*  Turbo colormap                                                    */
/* ================================================================== */

describe('scoreToRgba', () => {
  it('returns 4-element RGBA tuple', () => {
    const c = scoreToRgba(0.5);
    expect(c).toHaveLength(4);
    c.forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    });
  });

  it('score=0 produces a bright red colour (RYG bad end)', () => {
    const [r, g, b] = scoreToRgba(0);
    // RYG at 0 is bright red — R high, G+B low
    expect(r).toBeGreaterThan(200);
    expect(g + b).toBeLessThan(100);
  });

  it('score=1 maps to the green end of the palette', () => {
    const [r, g] = scoreToRgba(1);
    expect(g).toBeGreaterThan(r);
  });

  it('clamps out-of-range scores', () => {
    const underflow = scoreToRgba(-0.5);
    const atZero = scoreToRgba(0);
    expect(underflow).toEqual(atZero);

    const overflow = scoreToRgba(1.5);
    const atOne = scoreToRgba(1);
    expect(overflow).toEqual(atOne);
  });

  it('custom alpha is applied', () => {
    const [, , , a] = scoreToRgba(0.5, 128);
    expect(a).toBe(128);
  });
});

describe('scoreToCssColor', () => {
  it('returns a valid rgba() string', () => {
    const css = scoreToCssColor(0.5, 0.8);
    expect(css).toMatch(/^rgba\(\d+,\d+,\d+,0\.8\)$/);
  });
});

/* ================================================================== */
/*  Defaults utility                                                  */
/* ================================================================== */

describe('median', () => {
  it('returns 0 for empty array', () => {
    expect(median([])).toBe(0);
  });

  it('returns middle for odd-length', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('returns average of two middles for even-length', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('fillGapsWithComarcaMedian', () => {
  const codiToComarca: Record<string, string> = {
    '08001': 'Anoia',
    '08002': 'Anoia',
    '08003': 'Anoia',
    '25001': 'Segria',
    '25002': 'Segria',
  };

  it('fills missing codis with comarca median', () => {
    const data = { '08001': 100, '08002': 200 }; // 08003 missing
    const allCodis = ['08001', '08002', '08003', '25001', '25002'];
    const filled = fillGapsWithComarcaMedian(data, allCodis, codiToComarca);
    // Anoia median = median([100, 200]) = 150
    expect(filled['08003']).toBe(150);
    // Segria has no data → global median = median([100, 200]) = 150
    expect(filled['25001']).toBe(150);
  });

  it('preserves existing values', () => {
    const data = { '08001': 100 };
    const filled = fillGapsWithComarcaMedian(data, ['08001'], codiToComarca);
    expect(filled['08001']).toBe(100);
  });
});

describe('buildCodiToComarca', () => {
  it('maps codi to comarca from GeoJSON features', () => {
    const features = [
      { properties: { codi: '08001', comarca: 'Anoia' } },
      { properties: { codi: '25001', comarca: 'Segria' } },
    ] as any;
    const map = buildCodiToComarca(features);
    expect(map['08001']).toBe('Anoia');
    expect(map['25001']).toBe('Segria');
  });
});

/* ================================================================== */
/*  Hypsometric helpers                                               */
/* ================================================================== */

describe('decodeElevation', () => {
  it('decodes mapbox encoding: sea level', () => {
    // Sea level in mapbox encoding: 10000 / 0.1 = 100000
    // 100000 = 1 * 65536 + 134 * 256 + 160
    const elev = decodeElevation(1, 134, 160, 'mapbox');
    expect(Math.abs(elev)).toBeLessThan(1);
  });

  it('decodes terrarium encoding: sea level', () => {
    // elevation = (R * 256 + G + B/256) - 32768
    // 0 = (128 * 256 + 0 + 0) - 32768 = 32768 - 32768
    const elev = decodeElevation(128, 0, 0, 'terrarium');
    expect(elev).toBe(0);
  });

  it('decodes positive elevation (mapbox)', () => {
    // 500m: encoded = (500 + 10000) / 0.1 = 105000
    // 105000 = 1*65536 + 154*256 + 104  (off by a few due to rounding)
    const elev = decodeElevation(1, 154, 104, 'mapbox');
    expect(Math.abs(elev - 500)).toBeLessThan(10);
  });
});

describe('elevationToRgb', () => {
  it('returns blue for below sea level', () => {
    const [r, g, b] = elevationToRgb(-100);
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
  });

  it('returns green-ish for low elevation', () => {
    const [r, g] = elevationToRgb(50);
    expect(g).toBeGreaterThan(r);
  });

  it('returns light gray / white for high elevation', () => {
    const [r, g, b] = elevationToRgb(3300);
    expect(r).toBeGreaterThan(230);
    expect(g).toBeGreaterThan(230);
    expect(b).toBeGreaterThan(230);
  });

  it('interpolates between stops', () => {
    const [r] = elevationToRgb(1750);
    // Between 1500 (brown) and 2000 (dark brown) -- midpoint
    expect(r).toBeGreaterThan(100);
    expect(r).toBeLessThan(200);
  });
});
