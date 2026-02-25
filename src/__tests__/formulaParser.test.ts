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
} from '../utils/formulaEngine';

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
    const ast = parseFormula('1 * SIN(slope, 12, 20)');
    const s = detectSimpleStructure(ast);
    expect(s).not.toBeNull();
    expect(s!.terms).toHaveLength(1);
    expect(s!.terms[0].fn).toBe('SIN');
    expect(s!.terms[0].varName).toBe('slope');
    expect(s!.terms[0].weight).toBe(1);
    expect(s!.guards).toHaveLength(0);
    expect(s!.totalWeight).toBe(1);
  });

  it('detects a two-term sum with totalWeight', () => {
    const ast = parseFormula('(1 * SIN(slope, 12, 20) + 1 * SIN(elevation, 400, 1800)) / 2');
    const s = detectSimpleStructure(ast);
    expect(s).not.toBeNull();
    expect(s!.terms).toHaveLength(2);
    expect(s!.totalWeight).toBe(2);
  });

  it('detects guard prefix', () => {
    const ast = parseFormula('(slope < 20) * 1 * SIN(slope, 12, 20)');
    const s = detectSimpleStructure(ast);
    expect(s).not.toBeNull();
    expect(s!.guards).toHaveLength(1);
    expect(s!.guards[0].op).toBe('<');
  });

  it('returns null for arbitrary formula', () => {
    const ast = parseFormula('SQRT(slope) + ABS(elevation)');
    const s = detectSimpleStructure(ast);
    expect(s).toBeNull();
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
});
