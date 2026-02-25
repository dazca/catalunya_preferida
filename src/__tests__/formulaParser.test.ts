import { describe, it, expect } from 'vitest';
import {
  parseFormula,
  serializeAst,
  detectSimpleStructure,
  walkAst,
  type AstNode,
} from '../utils/formulaParser';
import {
  validateCustomFormula,
  evaluateCustomFormula,
  visualToRawFormula,
} from '../utils/formulaEngine';
import { DEFAULT_LAYER_CONFIGS, defaultTf } from '../types/transferFunction';
import type { LayerMeta } from '../types';

/* ── formulaParser ─────────────────────────────────────────────────── */

describe('parseFormula — atoms', () => {
  it('parses a number literal', () => {
    const n = parseFormula('42');
    expect(n.kind).toBe('number');
    if (n.kind === 'number') expect(n.value).toBe(42);
  });

  it('parses a float', () => {
    const n = parseFormula('3.14');
    expect(n.kind).toBe('number');
    if (n.kind === 'number') expect(n.value).toBeCloseTo(3.14);
  });

  it('parses an identifier', () => {
    const n = parseFormula('slope');
    expect(n.kind).toBe('identifier');
    if (n.kind === 'identifier') expect(n.name).toBe('slope');
  });

  it('normalises score= prefix', () => {
    const n = parseFormula('Score = slope');
    expect(n.kind).toBe('identifier');
  });

  it('normalises [] brackets', () => {
    const n = parseFormula('[slope]');
    expect(n.kind).toBe('identifier');
  });
});

describe('parseFormula — arithmetic', () => {
  it('addition', () => {
    const n = parseFormula('a + b');
    expect(n.kind).toBe('binop');
    if (n.kind === 'binop') {
      expect(n.op).toBe('+');
      expect(n.left.kind).toBe('identifier');
      expect(n.right.kind).toBe('identifier');
    }
  });

  it('multiplication binds tighter than addition', () => {
    // a + b * c → a + (b * c)
    const n = parseFormula('a + b * c');
    expect(n.kind).toBe('binop');
    if (n.kind === 'binop') {
      expect(n.op).toBe('+');
      expect(n.right.kind).toBe('binop');
      if (n.right.kind === 'binop') expect(n.right.op).toBe('*');
    }
  });

  it('unary minus', () => {
    const n = parseFormula('-slope');
    expect(n.kind).toBe('unary');
    if (n.kind === 'unary') {
      expect(n.op).toBe('-');
      expect(n.expr.kind).toBe('identifier');
    }
  });
});

describe('parseFormula — function calls', () => {
  it('parses SIN call with 3 args', () => {
    const n = parseFormula('SIN(slope, 12, 20)');
    expect(n.kind).toBe('call');
    if (n.kind === 'call') {
      expect(n.name).toBe('SIN');
      expect(n.args).toHaveLength(3);
    }
  });

  it('uppercases function name', () => {
    const n = parseFormula('sqrt(slope)');
    expect(n.kind).toBe('call');
    if (n.kind === 'call') expect(n.name).toBe('SQRT');
  });

  it('nested function calls', () => {
    const n = parseFormula('ABS(slope - 10)');
    expect(n.kind).toBe('call');
    if (n.kind === 'call') {
      expect(n.args[0].kind).toBe('binop');
    }
  });
});

describe('parseFormula — comparison', () => {
  it('less-than comparison', () => {
    const n = parseFormula('slope < 20');
    expect(n.kind).toBe('binop');
    if (n.kind === 'binop') expect(n.op).toBe('<');
  });

  it('less-than-or-equal', () => {
    const n = parseFormula('slope <= 20');
    expect(n.kind).toBe('binop');
    if (n.kind === 'binop') expect(n.op).toBe('<=');
  });
});

describe('serializeAst', () => {
  it('round-trips a simple identifier', () => {
    const src = 'slope';
    expect(serializeAst(parseFormula(src))).toBe(src);
  });

  it('round-trips a function call', () => {
    const src = 'SIN(slope, 12, 20)';
    expect(serializeAst(parseFormula(src))).toBe(src);
  });

  it('round-trips an arithmetic expression', () => {
    const src = 'a + b * c';
    expect(serializeAst(parseFormula(src))).toBe(src);
  });

  it('adds parens for right-side subtraction', () => {
    // a - (b - c) must be preserved
    const src = 'a - (b - c)';
    const ast = parseFormula(src);
    const out = serializeAst(ast);
    // Re-parsing the output should give the same result
    expect(serializeAst(parseFormula(out))).toBe(out);
  });

  it('preserves integer output without decimals', () => {
    const n: AstNode = { kind: 'number', value: 2 };
    expect(serializeAst(n)).toBe('2');
  });
});

describe('parser round-trip stability', () => {
  const stableCases = [
    'weight(1) * SIN(slope, 12, 20) / weights',
    '(weight(0.79) * SIN(slope, 8.69, 13.29) + weight(1) * SIN(elevation, 982.2033, 2067.3729)) / weights',
    '(slope < 13.29) * (weight(0.79) * SIN(slope, 8.69, 13.29) + weight(1) * SIN(elevation, 982.2033, 2067.3729)) / weights',
    '(slope < 13.29) * SIN(elevation, 982.2033, 2067.3729) * (weight(0.79) * SIN(slope, 8.69, 13.29) + weight(1) * INVSIN(transit, 4, 10)) / weights',
    '2 * (weight(1) * SIN(slope, 12, 20) + weight(0.6) * INVRANGE(transit, 4, 10)) / weights',
    '(weight(1) * SIN(slope, 12, 20) + SIN(elevation, 400, 1800)) / weights',
    'IF(slope < 20, (weight(1) * SIN(slope, 5, 20) + weight(1) * SIN(elevation, 400, 1800)) / weights, 0)',
    'CLAMP((weight(1) * SIN(slope, 5, 20) + weight(2) * SIN(elevation, 400, 1800)) / weights, 0, 1)',
    'MIN((weight(1) * SIN(slope, 12, 20)) / weights, (weight(1) * INVSIN(transit, 4, 10)) / weights)',
    '(weight(1) * RANGE(slope, 5, 20, 0.9, 0.2) + weight(0.5) * INVRANGE(transit, 2, 12, 0.8, 0.1)) / weights',
  ];

  it('is idempotent across parse → serialize → parse → serialize for many formulas', () => {
    for (const src of stableCases) {
      const once = serializeAst(parseFormula(src));
      const twice = serializeAst(parseFormula(once));
      expect(twice).toBe(once);
    }
  });
});

describe('raw ↔ visual compatibility (chip preservation)', () => {
  const visualCompatibleCases = [
    'weight(1) * SIN(slope, 12, 20) / weights',
    '(weight(0.79) * SIN(slope, 8.69, 13.29) + weight(1) * SIN(elevation, 982.2033, 2067.3729)) / weights',
    '(slope < 13.29) * (weight(0.79) * SIN(slope, 8.69, 13.29) + weight(1) * SIN(elevation, 982.2033, 2067.3729)) / weights',
    '(slope < 13.29) * SIN(elevation, 982.2033, 2067.3729) * (weight(0.79) * SIN(slope, 8.69, 13.29) + weight(1) * INVSIN(transit, 4, 10)) / weights',
    // Missing weight(...) should default to weight 1 when re-entering visual mode
    '(weight(0.79) * SIN(slope, 8.69, 13.29) + SIN(elevation, 982.2033, 2067.3729)) / weights',
    // Bare numeric factor outside sum should not be interpreted as a layer weight
    '2 * (weight(1) * SIN(slope, 12, 20) + weight(1) * SIN(elevation, 400, 1800)) / weights',
  ];

  it('keeps simple structure detectable after parse/serialize (no chip loss)', () => {
    for (const src of visualCompatibleCases) {
      const canonical = serializeAst(parseFormula(src));
      const parsed = detectSimpleStructure(parseFormula(canonical));
      expect(parsed).not.toBeNull();
      expect(parsed!.terms.length).toBeGreaterThan(0);
    }
  });
});

describe('walkAst', () => {
  it('visits all nodes in a formula', () => {
    const ast = parseFormula('SIN(slope, 12, 20) + elevation');
    const kinds: string[] = [];
    walkAst(ast, (node) => { kinds.push(node.kind); });
    expect(kinds).toContain('call');
    expect(kinds).toContain('identifier');
    expect(kinds).toContain('number');
    expect(kinds).toContain('binop');
  });

  it('respects false return to prune subtree', () => {
    const ast = parseFormula('SIN(slope, 12, 20) + elevation');
    const visited: string[] = [];
    walkAst(ast, (node) => {
      visited.push(node.kind);
      if (node.kind === 'call') return false; // prune SIN subtree
    });
    // Should not contain the inner identifiers/numbers of SIN
    expect(visited.filter(k => k === 'number')).toHaveLength(0);
  });
});

describe('detectSimpleStructure', () => {
  it('detects a single-term visual formula', () => {
    const ast = parseFormula('weight(1) * SIN(slope, 12, 20) / weights');
    const s = detectSimpleStructure(ast);
    expect(s).not.toBeNull();
    expect(s!.terms).toHaveLength(1);
    expect(s!.importantTerms).toHaveLength(0);
    expect(s!.terms[0].fn).toBe('SIN');
    expect(s!.terms[0].varName).toBe('slope');
    expect(s!.terms[0].weight).toBe(1);
    expect(s!.guards).toHaveLength(0);
    expect(s!.totalWeight).toBe(1);
  });

  it('detects a two-term sum with totalWeight', () => {
    const ast = parseFormula('(weight(1) * SIN(slope, 12, 20) + weight(1) * SIN(elevation, 400, 1800)) / weights');
    const s = detectSimpleStructure(ast);
    expect(s).not.toBeNull();
    expect(s!.terms).toHaveLength(2);
    expect(s!.importantTerms).toHaveLength(0);
    expect(s!.totalWeight).toBe(2);
  });

  it('detects guard prefix', () => {
    const ast = parseFormula('(slope < 20) * weight(1) * SIN(slope, 12, 20) / weights');
    const s = detectSimpleStructure(ast);
    expect(s).not.toBeNull();
    expect(s!.guards).toHaveLength(1);
    expect(s!.guards[0].op).toBe('<');
  });

  it('detects important terms (bare TF calls as multiplicative factors)', () => {
    const ast = parseFormula('SIN(elevation, 0, 1500) * (weight(1) * SIN(slope, 5, 20) + weight(1) * INVSIN(transit, 4, 10)) / weights');
    const s = detectSimpleStructure(ast);
    expect(s).not.toBeNull();
    expect(s!.importantTerms).toHaveLength(1);
    expect(s!.importantTerms[0].fn).toBe('SIN');
    expect(s!.importantTerms[0].varName).toBe('elevation');
    expect(s!.terms).toHaveLength(2);
    expect(s!.totalWeight).toBe(2);
  });

  it('detects guards + important + sum together', () => {
    // Needs additions in the sum so detectSimpleStructure can distinguish important from sum
    const ast = parseFormula(
      '(slope < 20) * SIN(elevation, 0, 1500) * (weight(1) * INVSIN(transit, 4, 10) + weight(2) * SIN(slope, 12, 20)) / weights'
    );
    const s = detectSimpleStructure(ast);
    expect(s).not.toBeNull();
    expect(s!.guards).toHaveLength(1);
    expect(s!.importantTerms).toHaveLength(1);
    expect(s!.importantTerms[0].varName).toBe('elevation');
    expect(s!.terms).toHaveLength(2);
    expect(s!.totalWeight).toBe(3);
  });

  it('detects no-plus chain as important * term (user raw style)', () => {
    const ast = parseFormula('SIN(slope, 8.69, 13.29) * weight(1) * SIN(elevation, 982.2033, 2067.3729) / weights');
    const s = detectSimpleStructure(ast);
    expect(s).not.toBeNull();
    expect(s!.importantTerms).toHaveLength(1);
    expect(s!.importantTerms[0].varName).toBe('slope');
    expect(s!.terms).toHaveLength(1);
    expect(s!.terms[0].varName).toBe('elevation');
    expect(s!.terms[0].weight).toBe(1);
    expect(s!.totalWeight).toBe(1);
  });

  it('defaults missing weight() to 1 for a sum term', () => {
    const ast = parseFormula('(weight(0.79) * SIN(slope, 8.69, 13.29) + SIN(elevation, 982.2033, 2067.3729)) / weights');
    const s = detectSimpleStructure(ast);
    expect(s).not.toBeNull();
    expect(s!.terms).toHaveLength(2);
    expect(s!.terms[0].weight).toBeCloseTo(0.79, 6);
    expect(s!.terms[1].weight).toBe(1);
    expect(s!.totalWeight).toBeCloseTo(1.79, 6);
  });

  it('does not treat bare numeric constants as chip weight when weight() exists', () => {
    const ast = parseFormula('2 * weight(1) * SIN(slope, 12, 20) / weights');
    const s = detectSimpleStructure(ast);
    expect(s).not.toBeNull();
    expect(s!.terms).toHaveLength(1);
    expect(s!.terms[0].weight).toBe(1);
  });

  it('also supports legacy numeric divisor', () => {
    const ast = parseFormula('(1 * SIN(slope, 12, 20) + 1 * SIN(elevation, 400, 1800)) / 2');
    const s = detectSimpleStructure(ast);
    expect(s).not.toBeNull();
    expect(s!.terms).toHaveLength(2);
    expect(s!.totalWeight).toBe(2);
  });

  it('returns null for arbitrary formula', () => {
    const ast = parseFormula('SQRT(slope) + ABS(elevation)');
    const s = detectSimpleStructure(ast);
    expect(s).toBeNull();
  });
});

/* ── visualToRawFormula with important layers ───────────────────────── */

describe('visualToRawFormula — 3 sections', () => {
  const mkLayer = (id: string, weight = 1, enabled = true): LayerMeta => ({
    id: id as LayerMeta['id'],
    label: id,
    description: '',
    icon: '📐',
    enabled,
    weight,
  });

  it('places important layers as multiplicative factors outside sum', () => {
    const cfgs = structuredClone(DEFAULT_LAYER_CONFIGS);
    cfgs.terrain.elevation.tf.important = true;
    const layers = [mkLayer('terrainSlope'), mkLayer('terrainElevation')];
    const raw = visualToRawFormula(layers, cfgs);
    // Important elevation should be outside the sum, slope inside
    expect(raw).toContain('SIN(elevation');
    expect(raw).toContain('SIN(slope');
    // weight() wraps the summed term's weight
    expect(raw).toContain('weight(1)');
    // Important term multiplied with sum
    expect(raw).toMatch(/SIN\(elevation.*\*.*SIN\(slope/);
    // Always ends with / weights
    expect(raw).toContain('/ weights');
  });

  it('handles guards + important + sum together', () => {
    const cfgs = structuredClone(DEFAULT_LAYER_CONFIGS);
    cfgs.terrain.slope.tf.mandatory = true;
    cfgs.terrain.elevation.tf.important = true;
    const layers = [mkLayer('terrainSlope'), mkLayer('terrainElevation'), mkLayer('transit')];
    const raw = visualToRawFormula(layers, cfgs);
    // Guard: (slope < ...)
    expect(raw).toMatch(/\(slope\s*</);
    // Important: SIN(elevation, ...) as multiplier
    expect(raw).toContain('SIN(elevation');
    // Sum: weight() wrapped terms
    expect(raw).toContain('weight(1) * SIN(slope');
    expect(raw).toContain('weight(1) * SIN(transit');
    // Divisor is 'weights' keyword
    expect(raw).toContain('/ weights');
  });

  it('round-trips: visualToRaw → parse → detectSimpleStructure', () => {
    const cfgs = structuredClone(DEFAULT_LAYER_CONFIGS);
    cfgs.terrain.slope.tf.mandatory = true;
    cfgs.terrain.elevation.tf.important = true;
    const layers = [mkLayer('terrainSlope'), mkLayer('terrainElevation'), mkLayer('transit')];
    const raw = visualToRawFormula(layers, cfgs);
    const ast = parseFormula(raw);
    const s = detectSimpleStructure(ast);
    expect(s).not.toBeNull();
    expect(s!.guards.length).toBeGreaterThanOrEqual(1);
    expect(s!.importantTerms.length).toBe(1);
    expect(s!.importantTerms[0].varName).toBe('elevation');
    expect(s!.terms.length).toBeGreaterThanOrEqual(1);
  });
});

/* ── formulaEngine math builtins ────────────────────────────────────── */

describe('formulaEngine — math builtins', () => {
  it('validates a formula using SQRT', () => {
    const r = validateCustomFormula('SQRT(slope)');
    expect(r.ok).toBe(true);
  });

  it('validates a formula using IF', () => {
    const r = validateCustomFormula('IF(slope < 20, 1, 0)');
    expect(r.ok).toBe(true);
  });

  it('validates a formula using CLAMP', () => {
    const r = validateCustomFormula('CLAMP(slope / 45, 0, 1)');
    expect(r.ok).toBe(true);
  });

  it('validates a formula using POW', () => {
    const r = validateCustomFormula('POW(SIN(slope, 10, 30), 2)');
    expect(r.ok).toBe(true);
  });

  it('evaluates SQRT correctly', () => {
    const v = evaluateCustomFormula('SQRT(slope)', { slope: 0.25 });
    expect(v).toBeCloseTo(0.5, 5);
  });

  it('evaluates ABS correctly', () => {
    const v = evaluateCustomFormula('CLAMP(ABS(elevation - 1000) / 600, 0, 1)', { elevation: 400 });
    expect(v).toBeCloseTo(1, 3); // |400-1000|/600 = 1
  });

  it('evaluates IF correctly — true branch', () => {
    const v = evaluateCustomFormula('IF(slope < 20, 1, 0)', { slope: 10 });
    expect(v).toBe(1);
  });

  it('evaluates IF correctly — false branch', () => {
    const v = evaluateCustomFormula('IF(slope < 20, 1, 0)', { slope: 30 });
    expect(v).toBe(0);
  });

  it('evaluates CLAMP', () => {
    const v = evaluateCustomFormula('CLAMP(slope, 0, 0.5)', { slope: 0.8 });
    expect(v).toBe(0.5);
  });

  it('evaluates MIN and MAX', () => {
    const vMin = evaluateCustomFormula('MIN(slope, elevation)', { slope: 0.3, elevation: 0.7 });
    expect(vMin).toBeCloseTo(0.3, 5);
    const vMax = evaluateCustomFormula('MAX(slope, elevation)', { slope: 0.3, elevation: 0.7 });
    expect(vMax).toBeCloseTo(0.7, 5);
  });

  it('evaluates SIGN', () => {
    const pos = evaluateCustomFormula('CLAMP(SIGN(elevation - 500), 0, 1)', { elevation: 600 });
    expect(pos).toBe(1); // SIGN(100) = 1
    const neg = evaluateCustomFormula('CLAMP(SIGN(elevation - 500) * 0.5 + 0.5, 0, 1)', { elevation: 400 });
    expect(neg).toBeCloseTo(0, 5); // SIGN(-100) = -1, * 0.5 + 0.5 = 0
  });

  it('rejects an invalid formula', () => {
    const r = validateCustomFormula('SQRT(((slope)');
    expect(r.ok).toBe(false);
  });

  it('evaluates weight() as identity and weights as sum of all weight() values', () => {
    // weight(0.5) * SIN(slope,0,45) + weight(1) * SIN(elevation,0,2000)
    // weights = 0.5 + 1 = 1.5
    // With slope=0 → SIN=1, elevation=0 → SIN=1:
    // (0.5*1 + 1*1) / 1.5 = 1.5/1.5 = 1
    const v = evaluateCustomFormula(
      '(weight(0.5) * SIN(slope, 0, 45) + weight(1) * SIN(elevation, 0, 2000)) / weights',
      { slope: 0, elevation: 0 },
    );
    expect(v).toBeCloseTo(1, 5);
  });

  it('treats bare 2* as constant multiplier, not a weight', () => {
    // 2 * SIN(slope, 0, 45) / weights — no weight() calls → weights defaults to 1
    // With slope=0 → SIN=1 → 2*1/1 = 2, clamped to 1
    const v = evaluateCustomFormula(
      '2 * SIN(slope, 0, 45)',
      { slope: 0 },
    );
    expect(v).toBeCloseTo(1, 5); // clamped to [0,1]
  });
});
