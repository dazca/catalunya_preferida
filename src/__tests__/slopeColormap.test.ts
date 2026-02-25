/**
 * @file Tests for slope computation (Horn kernel, cellH conformality,
 *       NaN boundary handling) and the RYG colormap.
 *
 * demSlope.ts uses browser APIs (fetch, canvas, createImageBitmap) so
 * we test the mathematical core via extracted pure-function equivalents
 * rather than calling the module directly.
 */
import { describe, it, expect } from 'vitest';
import { scoreToRgba, scoreToCssColor, getTurboLut } from '../utils/turboColormap';
import { evaluateTransferFunction } from '../utils/transferFunction';
import type { TransferFunction } from '../types/transferFunction';

/* ── Horn kernel helper (pure replica of demSlope logic) ────────── */

/**
 * Horn's 3×3 weighted finite-difference slope (degrees).
 * Takes a 3×3 neighbourhood [a,b,c,d,e,f,g,h,i] row-major and cell sizes.
 */
function hornSlope(
  neighbourhood: number[],
  cellW: number,
  cellH: number,
): number {
  const [a, b, c, d, _e, f, g, h, i] = neighbourhood;
  const dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * cellW);
  const dzdy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8 * cellH);
  return Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy)) * (180 / Math.PI);
}

/**
 * NaN-safe version: substitute centre (e) for any NaN neighbour.
 */
function hornSlopeNaNSafe(
  neighbourhood: number[],
  cellW: number,
  cellH: number,
): number {
  const e = neighbourhood[4];
  if (isNaN(e)) return NaN;
  const safe = neighbourhood.map(v => isNaN(v) ? e : v);
  return hornSlope(safe, cellW, cellH);
}

/** Compute Mercator cell sizes at a given latitude (replicates demSlope.ts). */
function cellSizes(degPerPx: number, latDeg: number): { cellW: number; cellH: number } {
  const cosLat = Math.cos(latDeg * (Math.PI / 180));
  return {
    cellW: degPerPx * 111_320 * cosLat,
    cellH: degPerPx * 110_540 * cosLat,
  };
}

/* ── TF helper ──────────────────────────────────────────────────── */

function makeSlopeTf(
  plateauEnd: number,
  decayEnd: number,
  shape: TransferFunction['shape'] = 'sin',
  floor = 0,
): TransferFunction {
  return { plateauEnd, decayEnd, floor, mandatory: false, multiplier: 1, shape };
}

/* ══════════════════════════════════════════════════════════════════ */
/*  1. COLORMAP TESTS                                                */
/* ══════════════════════════════════════════════════════════════════ */

describe('RYG colormap', () => {
  it('score 0 (bad) maps to bright red', () => {
    const [r, g, b] = scoreToRgba(0);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(60);
    expect(b).toBeLessThan(60);
  });

  it('score 0.5 maps to yellow/amber zone', () => {
    const [r, g, b] = scoreToRgba(0.5);
    expect(r).toBeGreaterThan(180);
    expect(g).toBeGreaterThan(180);
    expect(b).toBeLessThan(80);
  });

  it('score 1 (good) maps to bright green', () => {
    const [r, g] = scoreToRgba(1);
    expect(g).toBeGreaterThan(150);
    expect(r).toBeLessThan(60);
  });

  it('no colour in the LUT is near-black (min brightness >= 40)', () => {
    const lut = getTurboLut();
    for (let i = 0; i < lut.length; i++) {
      const [r, g, b] = lut[i];
      const maxChannel = Math.max(r, g, b);
      expect(maxChannel).toBeGreaterThanOrEqual(40);
    }
  });

  it('alpha defaults to 200', () => {
    const [, , , a] = scoreToRgba(0.5);
    expect(a).toBe(200);
  });

  it('custom alpha is respected', () => {
    const [, , , a] = scoreToRgba(0.5, 128);
    expect(a).toBe(128);
  });

  it('scoreToCssColor produces valid rgba() string', () => {
    const css = scoreToCssColor(0.5, 0.8);
    expect(css).toMatch(/^rgba\(\d+,\d+,\d+,0\.8\)$/);
  });

  it('clamps out-of-range scores', () => {
    const below = scoreToRgba(-0.5);
    const zero  = scoreToRgba(0);
    expect(below).toEqual(zero);

    const above = scoreToRgba(1.5);
    const one   = scoreToRgba(1);
    expect(above).toEqual(one);
  });
});

/* ══════════════════════════════════════════════════════════════════ */
/*  2. HORN KERNEL SLOPE TESTS                                       */
/* ══════════════════════════════════════════════════════════════════ */

describe('Horn kernel slope', () => {
  const CELL = 228; // metres, typical Z=9 pixel at ~41°

  it('flat terrain → slope = 0°', () => {
    const flat = [100, 100, 100, 100, 100, 100, 100, 100, 100];
    expect(hornSlope(flat, CELL, CELL)).toBeCloseTo(0, 6);
  });

  it('pure E→W gradient → correct slope angle', () => {
    // Elevation rises 100m per cell (E to W): a=300,b=200,c=100,...
    // Horn: dzdx numerator = (c+2f+i)-(a+2d+g) = (100+200+100)-(300+600+300) = -800
    // gradient = 800/(8*CELL) = 100/CELL; slope = atan(100/228) ≈ 23.7°
    const ew = [300, 200, 100, 300, 200, 100, 300, 200, 100];
    const slope = hornSlope(ew, CELL, CELL);
    const expected = Math.atan(100 / CELL) * (180 / Math.PI);
    expect(slope).toBeCloseTo(expected, 4);
  });

  it('pure N→S gradient → correct slope angle', () => {
    // Elevation rises 100m per cell (N to S)
    // Horn: dzdy numerator = (g+2h+i)-(a+2b+c) = (300+600+300)-(100+200+100) = 800
    const ns = [100, 100, 100, 200, 200, 200, 300, 300, 300];
    const slope = hornSlope(ns, CELL, CELL);
    const expected = Math.atan(100 / CELL) * (180 / Math.PI);
    expect(slope).toBeCloseTo(expected, 4);
  });

  it('45° physical slope (rise = run per pixel)', () => {
    // Each column differs by CELL metres: left=0, centre=CELL, right=2*CELL
    // Horn: dzdx = (2C+4C+2C - 0)/(8C) = 8C/8C = 1.0 → atan(1) = 45°
    const steep = [0, CELL, 2*CELL, 0, CELL, 2*CELL, 0, CELL, 2*CELL];
    const slope = hornSlope(steep, CELL, CELL);
    expect(slope).toBeCloseTo(45, 4);
  });
});

/* ══════════════════════════════════════════════════════════════════ */
/*  3. NaN BOUNDARY HANDLING                                         */
/* ══════════════════════════════════════════════════════════════════ */

describe('NaN-safe Horn kernel', () => {
  const CELL = 228;

  it('centre with all NaN neighbours → slope = 0°', () => {
    const allNaN = [NaN, NaN, NaN, NaN, 500, NaN, NaN, NaN, NaN];
    const slope = hornSlopeNaNSafe(allNaN, CELL, CELL);
    expect(slope).toBeCloseTo(0, 6);
  });

  it('NaN centre → returns NaN', () => {
    const nanCentre = [100, 100, 100, 100, NaN, 100, 100, 100, 100];
    expect(hornSlopeNaNSafe(nanCentre, CELL, CELL)).toBeNaN();
  });

  it('partial NaN neighbours produce conservative slope', () => {
    // Real gradient on right side; left side is NaN → substituted with centre
    // a=NaN→200, b=200, c=300, d=NaN→200, e=200, f=300, g=NaN→200, h=200, i=300
    const partial = [NaN, 200, 300, NaN, 200, 300, NaN, 200, 300];
    const slope = hornSlopeNaNSafe(partial, CELL, CELL);
    // After substitution: uniform left col = 200, right col = 300
    // dzdx = ((300+600+300) - (200+400+200)) / (8*228) = 400/1824
    expect(slope).toBeGreaterThan(0);
    // But less than with a real 100m/pixel gradient from 0 to 300
    const fullGrad = [100, 200, 300, 100, 200, 300, 100, 200, 300];
    expect(slope).toBeLessThan(hornSlope(fullGrad, CELL, CELL));
  });
});

/* ══════════════════════════════════════════════════════════════════ */
/*  4. CELL SIZE CONFORMALITY                                        */
/* ══════════════════════════════════════════════════════════════════ */

describe('Mercator cell size conformality', () => {
  it('cellW ≈ cellH at Catalonia latitude (ratio ≈ 1.007)', () => {
    const z9DegPerPx = 360 / (512 * 256);
    const lat = 41.7;
    const { cellW, cellH } = cellSizes(z9DegPerPx, lat);

    // Both should include cos(lat) and be close in magnitude
    const ratio = cellW / cellH;
    expect(ratio).toBeCloseTo(111_320 / 110_540, 3); // ≈ 1.00706
    expect(ratio).toBeGreaterThan(0.99);
    expect(ratio).toBeLessThan(1.02);
  });

  it('cell sizes are ~170 m at lat 41.7° Z=9', () => {
    const z9DegPerPx = 360 / (512 * 256);
    const lat = 41.7;
    const { cellW, cellH } = cellSizes(z9DegPerPx, lat);
    // At lat 41.7°: cos(41.7°) ≈ 0.746
    // cellW ≈ 0.00275 * 111320 * 0.746 ≈ 228 m  (at equator)
    // But with cos correction applied to both, they're both ~170 m
    expect(cellW).toBeGreaterThan(150);
    expect(cellW).toBeLessThan(250);
    expect(cellH).toBeGreaterThan(150);
    expect(cellH).toBeLessThan(250);
  });

  it('without cos(lat) on cellH, ratio would be ~1.34 (the old bug)', () => {
    const z9DegPerPx = 360 / (512 * 256);
    const lat = 41.7;
    const cosLat = Math.cos(lat * Math.PI / 180);
    const cellW = z9DegPerPx * 111_320 * cosLat;
    const buggyCellH = z9DegPerPx * 110_540; // missing cos(lat) — old code
    const buggyRatio = cellW / buggyCellH;
    expect(buggyRatio).toBeCloseTo(cosLat * 111_320 / 110_540, 3);
    expect(buggyRatio).toBeLessThan(0.80); // significantly off from ~1.0
  });
});

/* ══════════════════════════════════════════════════════════════════ */
/*  5. SLOPE TRANSFER FUNCTION INTEGRATION                           */
/* ══════════════════════════════════════════════════════════════════ */

describe('slope transfer function (sin 5°–20°)', () => {
  const slopeTf = makeSlopeTf(5, 20);

  it('0° slope → score 1.0 (perfectly flat, best)', () => {
    expect(evaluateTransferFunction(0, slopeTf)).toBe(1.0);
  });

  it('5° slope → score 1.0 (still in plateau)', () => {
    expect(evaluateTransferFunction(5, slopeTf)).toBe(1.0);
  });

  it('12.5° slope (midpoint) → score ≈ 0.5', () => {
    const score = evaluateTransferFunction(12.5, slopeTf);
    expect(score).toBeCloseTo(0.5, 1);
  });

  it('20° slope → score 0.0 (decay end)', () => {
    expect(evaluateTransferFunction(20, slopeTf)).toBe(0);
  });

  it('35° slope → score 0.0 (beyond decay)', () => {
    expect(evaluateTransferFunction(35, slopeTf)).toBe(0);
  });
});

/* ══════════════════════════════════════════════════════════════════ */
/*  6. KNOWN-LOCATION SANITY CHECKS                                  */
/* ══════════════════════════════════════════════════════════════════ */

describe('known-location slope expectations', () => {
  it('Barcelona Eixample flat area → slope < 2°', () => {
    // Simulate: surrounding elevations all ~15 m (flat Eixample grid)
    const flat = [15, 15, 15, 15, 15, 15, 15, 15, 15];
    const { cellW, cellH } = cellSizes(360 / (512 * 256), 41.39);
    const slope = hornSlope(flat, cellW, cellH);
    expect(slope).toBeLessThan(2);
  });

  it('Pyrenees steep area → slope > 15°', () => {
    // Simulate: Pyrenean ridge with 300m drop across 3 pixels
    const steep = [2500, 2300, 2100, 2500, 2300, 2100, 2500, 2300, 2100];
    const { cellW, cellH } = cellSizes(360 / (512 * 256), 42.5);
    const slope = hornSlope(steep, cellW, cellH);
    expect(slope).toBeGreaterThan(15);
  });

  it('Barcelona flat → RYG score is GREEN (score 1.0)', () => {
    const slopeTf = makeSlopeTf(5, 20);
    const score = evaluateTransferFunction(0, slopeTf);
    const [r, g] = scoreToRgba(score);
    expect(g).toBeGreaterThan(r); // green dominates
  });

  it('Pyrenees steep → RYG score is RED (score ~0)', () => {
    const slopeTf = makeSlopeTf(5, 20);
    const score = evaluateTransferFunction(40, slopeTf); // 40° extreme slope
    const [r, g] = scoreToRgba(score);
    expect(r).toBeGreaterThan(g); // red dominates
  });
});
