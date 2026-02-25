/**
 * @file Tests for the grid-based heatmap pipeline:
 *   - municipalityRaster.ts
 *   - variableGrids.ts
 *   - gridFormulaEngine.ts
 *
 * Verifies vectorised grid operations produce identical results to the
 * scalar per-pixel equivalents in transferFunction.ts and scorer.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  sinGrid,
  invsinGrid,
  rangeGrid,
  invrangeGrid,
  applyTfGrid,
  scaleGrid,
  addGridInPlace,
  divideGridScalar,
  mulGrid,
  clampGrid01,
  buildDisqualificationMask,
  scoreAspectGrid,
  computeVisualScoreGrid,
  scoreGridToRGBA,
  DISQUALIFIED,
} from '../utils/gridFormulaEngine';
import type { GridScoreResult } from '../utils/gridFormulaEngine';
import {
  buildVariableGrid,
  buildAllVariableGrids,
  acquireFloat32,
  releaseFloat32,
  MUNICIPALITY_VARS,
} from '../utils/variableGrids';
import type { MunicipalityLUT } from '../utils/variableGrids';
import { evaluateTransferFunction } from '../utils/transferFunction';
import type { TransferFunction, AspectPreferences } from '../types/transferFunction';

/* ── Helpers ────────────────────────────────────────────────────────── */

function makeTf(
  plateauEnd: number,
  decayEnd: number,
  shape: TransferFunction['shape'] = 'sin',
  floor = 0,
  mandatory = false,
): TransferFunction {
  return { plateauEnd, decayEnd, floor, mandatory, multiplier: 1, shape };
}

/** Generate a Float32Array of linearly spaced values. */
function linspace(start: number, end: number, n: number): Float32Array {
  const arr = new Float32Array(n);
  const step = (end - start) / (n - 1);
  for (let i = 0; i < n; i++) arr[i] = start + i * step;
  return arr;
}

/* ══════════════════════════════════════════════════════════════════ */
/*  § 1. Vectorised TF functions vs scalar evaluateTransferFunction  */
/* ══════════════════════════════════════════════════════════════════ */

describe('Vectorised TF grid functions', () => {
  const input = linspace(0, 50, 200);
  const n = input.length;

  describe.each([
    { shape: 'sin' as const, fn: sinGrid },
    { shape: 'invsin' as const, fn: invsinGrid },
    { shape: 'range' as const, fn: rangeGrid },
    { shape: 'invrange' as const, fn: invrangeGrid },
  ])('$shape', ({ shape, fn }) => {
    it('matches scalar evaluateTransferFunction within 1e-6', () => {
      const tf = makeTf(10, 30, shape, 0.1);
      const out = new Float32Array(n);
      fn(input, out, tf.plateauEnd, tf.decayEnd, 1, tf.floor);

      for (let i = 0; i < n; i++) {
        const expected = evaluateTransferFunction(input[i], tf);
        expect(out[i]).toBeCloseTo(expected, 5);
      }
    });

    it('preserves NaN for missing data', () => {
      const tf = makeTf(5, 20, shape, 0);
      const withNaN = new Float32Array([1, NaN, 15, NaN, 25]);
      const out = new Float32Array(5);
      fn(withNaN, out, tf.plateauEnd, tf.decayEnd, 1, tf.floor);

      expect(out[0]).not.toBeNaN();
      expect(out[1]).toBeNaN();
      expect(out[2]).not.toBeNaN();
      expect(out[3]).toBeNaN();
      expect(out[4]).not.toBeNaN();
    });
  });

  it('applyTfGrid dispatches to correct TF shape', () => {
    const tf = makeTf(10, 30, 'invrange', 0.2);
    const out1 = new Float32Array(n);
    const out2 = new Float32Array(n);

    applyTfGrid(input, out1, tf);
    invrangeGrid(input, out2, 10, 30, 1, 0.2);

    for (let i = 0; i < n; i++) {
      expect(out1[i]).toBe(out2[i]);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════ */
/*  § 2. Grid arithmetic operations                                  */
/* ══════════════════════════════════════════════════════════════════ */

describe('Grid arithmetic', () => {
  const a = new Float32Array([1, 2, 3, 4, 0.5]);
  const b = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);

  it('scaleGrid multiplies by scalar', () => {
    const out = new Float32Array(5);
    scaleGrid(a, out, 2);
    expect(Array.from(out)).toEqual([2, 4, 6, 8, 1]);
  });

  it('addGridInPlace accumulates', () => {
    const out = new Float32Array([10, 20, 30, 40, 50]);
    addGridInPlace(out, a);
    expect(out[0]).toBe(11);
    expect(out[4]).toBe(50.5);
  });

  it('divideGridScalar divides', () => {
    const out = new Float32Array(5);
    divideGridScalar(a, out, 2);
    expect(out[0]).toBeCloseTo(0.5);
    expect(out[3]).toBeCloseTo(2);
  });

  it('mulGrid element-wise multiply', () => {
    const out = new Float32Array(5);
    mulGrid(a, b, out);
    expect(out[0]).toBeCloseTo(0.1);
    expect(out[4]).toBeCloseTo(0.25);
  });

  it('clampGrid01 clamps and handles NaN', () => {
    const grid = new Float32Array([-0.5, 0, 0.5, 1, 1.5, NaN]);
    clampGrid01(grid);
    expect(grid[0]).toBe(0);
    expect(grid[1]).toBe(0);
    expect(grid[2]).toBe(0.5);
    expect(grid[3]).toBe(1);
    expect(grid[4]).toBe(1);
    expect(grid[5]).toBe(0); // NaN → 0
  });
});

/* ══════════════════════════════════════════════════════════════════ */
/*  § 3. Buffer pool                                                 */
/* ══════════════════════════════════════════════════════════════════ */

describe('Buffer pool (acquireFloat32 / releaseFloat32)', () => {
  it('allocates and returns a Float32Array of requested length', () => {
    const buf = acquireFloat32(100);
    expect(buf).toBeInstanceOf(Float32Array);
    expect(buf.length).toBe(100);
    releaseFloat32(buf);
  });

  it('reuses released buffers of matching length', () => {
    const buf1 = acquireFloat32(64);
    buf1[0] = 42;
    releaseFloat32(buf1);

    const buf2 = acquireFloat32(64);
    // Reused and zeroed
    expect(buf2.length).toBe(64);
    expect(buf2[0]).toBe(0);
  });

  it('allocates fresh buffer when pool has no match', () => {
    const buf1 = acquireFloat32(32);
    releaseFloat32(buf1);
    const buf2 = acquireFloat32(64);
    expect(buf2.length).toBe(64); // different length
    releaseFloat32(buf2);
    releaseFloat32(buf1);
  });
});

/* ══════════════════════════════════════════════════════════════════ */
/*  § 4. Variable grid building                                      */
/* ══════════════════════════════════════════════════════════════════ */

describe('buildVariableGrid', () => {
  it('maps membership raster indices to LUT values', () => {
    // 2×2 grid: pixel 0 → feature 0, pixel 1 → feature 1, pixel 2 → -1, pixel 3 → feature 0
    const raster = new Int16Array([0, 1, -1, 0]);
    const lut = new Float32Array([10.5, 20.3]);
    const grid = buildVariableGrid(raster, lut, 2, 2);

    expect(grid[0]).toBeCloseTo(10.5, 5);
    expect(grid[1]).toBeCloseTo(20.3, 5);
    expect(grid[2]).toBeNaN(); // outside any municipality
    expect(grid[3]).toBeCloseTo(10.5, 5);
  });

  it('propagates NaN from LUT for features with missing data', () => {
    const raster = new Int16Array([0, 1]);
    const lut = new Float32Array([5, NaN]);
    const grid = buildVariableGrid(raster, lut, 2, 1);

    expect(grid[0]).toBe(5);
    expect(grid[1]).toBeNaN();
  });
});

describe('buildAllVariableGrids', () => {
  it('produces a grid for every MUNICIPALITY_VARS entry', () => {
    const raster = new Int16Array([0, 0]);
    const mockLut = {} as MunicipalityLUT;
    for (const v of MUNICIPALITY_VARS) {
      mockLut[v] = new Float32Array([42]);
    }

    const grids = buildAllVariableGrids(raster, mockLut, 2, 1);
    for (const v of MUNICIPALITY_VARS) {
      expect(grids[v]).toBeInstanceOf(Float32Array);
      expect(grids[v].length).toBe(2);
      expect(grids[v][0]).toBe(42);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════ */
/*  § 5. Aspect scoring grid                                         */
/* ══════════════════════════════════════════════════════════════════ */

describe('scoreAspectGrid', () => {
  it('maps 256-step aspect codes through wind-rose preferences (exact directions)', () => {
    // Exact direction codes: 0=N(0°), 32=NE(45°), 64=E(90°), 96=SE(135°),
    //                        128=S(180°), 160=SW(225°), 192=W(270°), 224=NW(315°)
    const aspects = new Uint8Array([0, 32, 64, 96, 128, 160, 192, 224]);
    const prefs: AspectPreferences = {
      N: 1.0, NE: 0.8, E: 0.6, SE: 0.4, S: 0.2, SW: 0.3, W: 0.5, NW: 0.7,
    };
    const out = new Float32Array(8);
    scoreAspectGrid(aspects, prefs, out);

    expect(out[0]).toBeCloseTo(1.0, 2);   // N
    expect(out[1]).toBeCloseTo(0.8, 2);   // NE
    expect(out[2]).toBeCloseTo(0.6, 2);   // E
    expect(out[3]).toBeCloseTo(0.4, 2);   // SE
    expect(out[4]).toBeCloseTo(0.2, 2);   // S
    expect(out[5]).toBeCloseTo(0.3, 2);   // SW
    expect(out[6]).toBeCloseTo(0.5, 2);   // W
    expect(out[7]).toBeCloseTo(0.7, 2);   // NW
  });

  it('intermediate codes produce smoothly interpolated scores', () => {
    // Code 16 = midway between N(0°) and NE(45°) → should blend the two
    const aspects = new Uint8Array([16]);
    const prefs: AspectPreferences = {
      N: 1.0, NE: 0.0, E: 0.5, SE: 0.5, S: 0.5, SW: 0.5, W: 0.5, NW: 0.5,
    };
    const out = new Float32Array(1);
    scoreAspectGrid(aspects, prefs, out);

    // Cosine interpolation midpoint: 0.5 * (1 + 0) = 0.5
    expect(out[0]).toBeCloseTo(0.5, 1);
    // Definitely not 1.0 (hard N bucket) or 0.0 (hard NE bucket)
    expect(out[0]).toBeGreaterThan(0.1);
    expect(out[0]).toBeLessThan(0.9);
  });
});

/* ══════════════════════════════════════════════════════════════════ */
/*  § 6. Disqualification mask                                       */
/* ══════════════════════════════════════════════════════════════════ */

describe('buildDisqualificationMask', () => {
  it('marks pixels where mandatory layer hits floor', () => {
    const n = 4;
    const variableGrids: Record<string, Float32Array> = {
      // Values: 5, 15, 25, 35
      transit: new Float32Array([5, 15, 25, 35]),
    };
    const layers = [
      { id: 'transit' as const, label: 'Transit', enabled: true, weight: 1 },
    ] as any[];
    const configs = {
      transit: { tf: makeTf(10, 20, 'sin', 0, true) },  // mandatory
    } as any;

    const mask = buildDisqualificationMask(variableGrids, null, layers, configs, n);

    // v=5 → score=1 (plateau, ok), v=15 → 0.5 (ok), v=25 → 0 (at floor = disq), v=35 → 0 (at floor = disq)
    expect(mask[0]).toBe(0);
    expect(mask[1]).toBe(0);
    expect(mask[2]).toBe(1);
    expect(mask[3]).toBe(1);
  });

  it('does not disqualify for non-mandatory layers', () => {
    const variableGrids: Record<string, Float32Array> = {
      transit: new Float32Array([100]),
    };
    const layers = [
      { id: 'transit', label: 'Transit', enabled: true, weight: 1 },
    ] as any[];
    const configs = {
      transit: { tf: makeTf(10, 20, 'sin', 0, false) },
    } as any;

    const mask = buildDisqualificationMask(variableGrids, null, layers, configs, 1);
    expect(mask[0]).toBe(0); // non-mandatory → never disqualified
  });
});

/* ══════════════════════════════════════════════════════════════════ */
/*  § 7. computeVisualScoreGrid (end-to-end scoring)                 */
/* ══════════════════════════════════════════════════════════════════ */

describe('computeVisualScoreGrid', () => {
  const n = 4;
  const membership = new Int16Array([0, 0, 1, -1]); // px3 = outside

  const variableGrids: Record<string, Float32Array> = {
    transit: new Float32Array([5, 15, 25, 0]),
  };

  const layers = [
    { id: 'transit', label: 'Transit', enabled: true, weight: 2 },
  ] as any[];

  const configs = {
    transit: { tf: makeTf(10, 30, 'sin', 0, false) },
    terrain: { slope: { tf: makeTf(10, 30) }, elevation: { tf: makeTf(500, 2000) }, aspect: {} },
    votes: { terms: [] },
    forest: { tf: makeTf(30, 80) },
    airQuality: { pm10: { tf: makeTf(10, 30) }, no2: { tf: makeTf(10, 30) } },
    crime: { tf: makeTf(5, 20) },
    healthcare: { tf: makeTf(5, 20) },
    schools: { tf: makeTf(5, 20) },
    internet: { tf: makeTf(50, 100) },
    climate: { temperature: { tf: makeTf(15, 30) }, rainfall: { tf: makeTf(400, 800) } },
    rentalPrices: { tf: makeTf(300, 1000) },
    employment: { tf: makeTf(5, 20) },
    amenities: { tf: makeTf(5, 20) },
  } as any;

  it('computes weighted average scores matching scalar TF', () => {
    const result = computeVisualScoreGrid(variableGrids, null, membership, layers, configs, n);

    // px0: transit=5 (plateau) → TF=1.0
    expect(result.scores[0]).toBeCloseTo(1.0, 4);
    // px1: transit=15, midpoint of [10,30] → TF≈0.5 for sin
    const midTf = evaluateTransferFunction(15, configs.transit.tf);
    expect(result.scores[1]).toBeCloseTo(midTf, 4);
    // px3: outside municipality → NaN
    expect(result.scores[3]).toBeNaN();
  });

  it('returns valid minScore/maxScore', () => {
    const result = computeVisualScoreGrid(variableGrids, null, membership, layers, configs, n);
    expect(result.minScore).toBeLessThanOrEqual(result.maxScore);
    expect(result.minScore).toBeGreaterThanOrEqual(0);
    expect(result.maxScore).toBeLessThanOrEqual(1);
  });

  it('applies DISQUALIFIED sentinel for mandatory layer violations', () => {
    const mandatoryConfigs = {
      ...configs,
      transit: { tf: makeTf(10, 20, 'sin', 0, true) },
    };
    const result = computeVisualScoreGrid(variableGrids, null, membership, layers, mandatoryConfigs, n);

    // px2: transit=25 → beyond decayEnd=20, score=0=floor → disqualified
    expect(result.scores[2]).toBe(DISQUALIFIED);
    // px0: transit=5 → plateau → ok
    expect(result.scores[0]).not.toBe(DISQUALIFIED);
  });
});

/* ══════════════════════════════════════════════════════════════════ */
/*  § 8. scoreGridToRGBA (pixel output)                              */
/* ══════════════════════════════════════════════════════════════════ */

describe('scoreGridToRGBA', () => {
  it('produces correct pixel count', () => {
    const result: GridScoreResult = {
      scores: new Float32Array([0.5, 0.8, NaN, DISQUALIFIED]),
      minScore: 0.5,
      maxScore: 0.8,
    };
    const pixels = scoreGridToRGBA(result, 'transparent');
    expect(pixels.length).toBe(4 * 4); // 4 pixels × 4 channels
  });

  it('makes NaN pixels transparent', () => {
    const result: GridScoreResult = {
      scores: new Float32Array([NaN]),
      minScore: 0,
      maxScore: 1,
    };
    const pixels = scoreGridToRGBA(result, 'transparent');
    expect(pixels[3]).toBe(0); // alpha = transparent
  });

  it('makes disqualified pixels dark grey when mask=black', () => {
    const result: GridScoreResult = {
      scores: new Float32Array([DISQUALIFIED]),
      minScore: 0,
      maxScore: 1,
    };
    const pixels = scoreGridToRGBA(result, 'black');
    expect(pixels[0]).toBe(40);
    expect(pixels[1]).toBe(40);
    expect(pixels[2]).toBe(40);
    expect(pixels[3]).toBe(180);
  });

  it('makes disqualified pixels transparent when mask=transparent', () => {
    const result: GridScoreResult = {
      scores: new Float32Array([DISQUALIFIED]),
      minScore: 0,
      maxScore: 1,
    };
    const pixels = scoreGridToRGBA(result, 'transparent');
    expect(pixels[3]).toBe(0);
  });

  it('assigns non-zero alpha to valid scored pixels', () => {
    const result: GridScoreResult = {
      scores: new Float32Array([0.5]),
      minScore: 0,
      maxScore: 1,
    };
    const pixels = scoreGridToRGBA(result, 'transparent');
    expect(pixels[3]).toBeGreaterThan(0);
  });
});

/* ══════════════════════════════════════════════════════════════════ */
/*  § 9. DISQUALIFIED sentinel                                       */
/* ══════════════════════════════════════════════════════════════════ */

describe('DISQUALIFIED sentinel', () => {
  it('is a finite negative number distinguishable from NaN', () => {
    expect(isFinite(DISQUALIFIED)).toBe(true);
    expect(DISQUALIFIED).toBeLessThan(0);
    expect(DISQUALIFIED).not.toBeNaN();
  });
});
