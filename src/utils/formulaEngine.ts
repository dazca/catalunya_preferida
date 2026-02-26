/**
 * @file Formula engine — deterministic Visual→Raw formula generation and
 *       Raw formula compilation/evaluation.
 *
 * ## Design
 *
 * The scoring formula is always a function of known variables.  Units are
 * implicit (degrees, %, km, etc.) and never appear in the formula text.
 *
 * ### Syntax elements
 *
 * - **Variables**: bare identifiers like `slope`, `elevation`, `transit`.
 * - **SIN(var, M, N [, high, low])**: sinusoidal decay, ≤M→high, ≥N→low
 * - **INVSIN(var, M, N [, high, low])**: sinusoidal rise, ≤M→low, ≥N→high
 * - **RANGE(var, M, N [, high, low])**: linear decay, ≤M→high, ≥N→low
 * - **INVRANGE(var, M, N [, high, low])**: linear rise, ≤M→low, ≥N→high
 * - **Operators**: `+  -  *  /  >  <  >=  <=  ==`
 * - **Parentheses**: `(  )` for grouping.  `[  ]` are auto-converted to `( )`.
 *
 * high defaults to 1, low defaults to 0.
 *
 * ### Bijective Visual↔Raw
 *
 * - **Visual → Raw** (`visualToRawFormula`): reads enabled layers, weights,
 *   transfer-function configs and mandatory constraints to produce a canonical
 *   formula string.  This is deterministic and lossless.
 *
 * - **Raw → Visual**: switching to Visual mode simply discards the raw text
 *   and rebuilds from the live layers+configs (which remain the source of
 *   truth).  The user can *always* go back to Visual — no parsing needed.
 */
import type { LayerMeta, LayerId } from '../types';
import type {
  LayerConfigs,
  TransferFunction,
  TfShape,
  AspectPreferences,
  VoteMetric,
} from '../types/transferFunction';
import { scoreAspectAngle } from './transferFunction';
import { POLITICAL_AXES, axisLayerId, axisIdFromLayerId } from './politicalAxes';

/* ── Orientation (aspect wind-rose) helpers ──────────────────────────── */

/** Canonical direction order used in ORIENTATION() formula function. */
export const ORIENTATION_DIR_ORDER: readonly (keyof AspectPreferences)[] =
  ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE'] as const;

/**
 * Build an ORIENTATION(...) call string from aspect preferences and
 * dampening weight.
 *
 * Syntax: `ORIENTATION(aspect, S, SW, W, NW, N, NE, E, SE [, dampWeight])`
 */
export function buildOrientationCall(
  varName: string,
  prefs: AspectPreferences,
  aspectWeight = 1,
): string {
  const args = [varName, ...ORIENTATION_DIR_ORDER.map(d => fmtNum(prefs[d]))];
  if (Math.abs(aspectWeight - 1) > 1e-9) args.push(fmtNum(aspectWeight));
  return `ORIENTATION(${args.join(', ')})`;
}

/**
 * Parse ORIENTATION(...) args back into AspectPreferences + weight.
 */
export function parseOrientationArgs(
  dirValues: number[],
): { prefs: AspectPreferences; aspectWeight: number } {
  const prefs: AspectPreferences = { N: 0.5, NE: 0.5, E: 0.5, SE: 0.5, S: 0.5, SW: 0.5, W: 0.5, NW: 0.5 };
  for (let i = 0; i < 8 && i < dirValues.length; i++) {
    prefs[ORIENTATION_DIR_ORDER[i]] = dirValues[i];
  }
  const aspectWeight = dirValues.length > 8 ? dirValues[8] : 1;
  return { prefs, aspectWeight };
}

/**
 * Runtime ORIENTATION function for per-municipality formula evaluation.
 * `angleDeg` is the numeric aspect angle (0-360, -1=flat).
 * The 8 direction weights are S,SW,W,NW,N,NE,E,SE.
 * Optional 9th arg = dampening weight (default 1).
 */
function orientationFn(
  angleDeg: number | string,
  S: number, SW: number, W: number, NW: number,
  N: number, NE: number, E: number, SE: number,
  dampWeight?: number,
): number {
  const a = typeof angleDeg === 'string' ? 0 : angleDeg;
  const prefs: AspectPreferences = { N, NE, E, SE, S, SW, W, NW };
  const raw = scoreAspectAngle(a, prefs);
  const dw = dampWeight ?? 1;
  return 0.5 + (raw - 0.5) * dw;
}

/* ── Variable name mapping ──────────────────────────────────────────── */

/** Canonical variable name for each sub-layer ID. */
export const LAYER_VAR: Record<string, string> = {
  terrainSlope:    'slope',
  terrainElevation:'elevation',
  terrainAspect:   'aspect',
  votesLeft:       'votesLeft',
  votesRight:      'votesRight',
  votesIndep:      'votesIndep',
  votesUnionist:   'votesUnionist',
  votesTurnout:    'votesTurnout',
  // Party layers
  votesERC:          'votesERC',
  votesCUP:          'votesCUP',
  votesPODEM:        'votesPODEM',
  votesJUNTS:        'votesJUNTS',
  votesCOMUNS:       'votesCOMUNS',
  votesPP:           'votesPP',
  votesVOX:          'votesVOX',
  votesPSC:          'votesPSC',
  votesCs:           'votesCs',
  votesPDeCAT:       'votesPDeCAT',
  votesCiU:          'votesCiU',
  votesOtherParties: 'votesOtherParties',
  transit:         'transit',
  forest:          'forest',
  soil:            'soil',
  airQualityPm10:  'airPm10',
  airQualityNo2:   'airNo2',
  crime:           'crime',
  healthcare:      'healthcare',
  schools:         'schools',
  internet:        'internet',
  noise:           'noise',
  climateTemp:     'climateTemp',
  climateRainfall: 'climateRain',
  rentalPrices:    'rentalPrices',
  employment:      'employment',
  amenities:       'amenities',
  // Political axis variables (derived from POLITICAL_AXES)
  ...Object.fromEntries(
    POLITICAL_AXES.map(a => [axisLayerId(a.id), axisLayerId(a.id)]),
  ),
};

/* ── Vote metric map ────────────────────────────────────────────────── */

const VOTE_ID_TO_METRIC: Record<string, VoteMetric> = {
  votesLeft:     'leftPct',
  votesRight:    'rightPct',
  votesIndep:    'independencePct',
  votesUnionist: 'unionistPct',
  votesTurnout:  'turnoutPct',
  // Party layers
  votesERC:          'ercPct',
  votesCUP:          'cupPct',
  votesPODEM:        'podemPct',
  votesJUNTS:        'juntsPct',
  votesCOMUNS:       'comunsPct',
  votesPP:           'ppPct',
  votesVOX:          'voxPct',
  votesPSC:          'pscPct',
  votesCs:           'csPct',
  votesPDeCAT:       'pdecatPct',
  votesCiU:          'ciuPct',
  votesOtherParties: 'otherPartiesPct',
};

/* ── Helpers ────────────────────────────────────────────────────────── */

/** Number formatting: strip trailing zeros but keep up to 4 decimal places. */
function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : parseFloat(n.toFixed(4)).toString();
}

/**
 * Get the "primary" TransferFunction for a layer.
 * Returns null for layers without a single TF (e.g. aspect).
 */
export function layerTf(id: LayerId, configs: LayerConfigs): TransferFunction | null {
  switch (id) {
    case 'terrainSlope':     return configs.terrain.slope.tf;
    case 'terrainElevation': return configs.terrain.elevation.tf;
    case 'terrainAspect':    return null;
    case 'votesLeft':
    case 'votesRight':
    case 'votesIndep':
    case 'votesUnionist':
    case 'votesTurnout': {
      const metric = VOTE_ID_TO_METRIC[id];
      return configs.votes.terms.find((t) => t.metric === metric)?.value.tf ?? null;
    }
    // Party vote layers
    case 'votesERC':
    case 'votesCUP':
    case 'votesPODEM':
    case 'votesJUNTS':
    case 'votesCOMUNS':
    case 'votesPP':
    case 'votesVOX':
    case 'votesPSC':
    case 'votesCs':
    case 'votesPDeCAT':
    case 'votesCiU':
    case 'votesOtherParties': {
      const metric = VOTE_ID_TO_METRIC[id];
      return configs.partyVotes.terms.find((t) => t.metric === metric)?.value.tf ?? null;
    }
    case 'transit':         return configs.transit.tf;
    case 'forest':          return configs.forest.tf;
    case 'airQualityPm10':  return configs.airQuality.pm10.tf;
    case 'airQualityNo2':   return configs.airQuality.no2.tf;
    case 'crime':           return configs.crime.tf;
    case 'healthcare':      return configs.healthcare.tf;
    case 'schools':         return configs.schools.tf;
    case 'internet':        return configs.internet.tf;
    case 'climateTemp':     return configs.climate.temperature.tf;
    case 'climateRainfall': return configs.climate.rainfall.tf;
    case 'rentalPrices':    return configs.rentalPrices.tf;
    case 'employment':      return configs.employment.tf;
    case 'amenities':       return configs.amenities.tf;
    default: {
      // Political axis layers
      const axisId = axisIdFromLayerId(id);
      if (axisId) return configs.axisConfigs?.[axisId]?.tf ?? null;
      return null;
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════
   Visual → Raw formula generation
   ══════════════════════════════════════════════════════════════════════ */

/** Map TfShape to its formula function name. */
const SHAPE_FN: Record<TfShape, string> = {
  sin: 'SIN',
  invsin: 'INVSIN',
  range: 'RANGE',
  invrange: 'INVRANGE',
};

/**
 * Build the canonical raw formula string from the current visual state.
 *
 * Structure:
 *   guard1 * guard2 * ... *
 *   (w1 * FN(var1, M, N, 1, floor) + w2 * FN(var2, M, N, 1, floor) + ...) / totalWeight
 *
 * This exactly mirrors the visual scoring pipeline:
 *   Σ(evaluateTransferFunction(value_i, tf_i) * weight_i) / Σ(weight_i)
 */
export function visualToRawFormula(
  enabledLayers: LayerMeta[],
  configs: LayerConfigs,
  layerOrder?: LayerId[],
): string {
  // Respect explicit ordering if provided
  let orderedLayers = enabledLayers;
  if (layerOrder && layerOrder.length > 0) {
    const layerById = new Map(enabledLayers.map(l => [l.id, l]));
    const ordered: LayerMeta[] = [];
    for (const id of layerOrder) {
      const l = layerById.get(id);
      if (l) { ordered.push(l); layerById.delete(id); }
    }
    // Append any enabled layers not in the order array
    for (const l of layerById.values()) ordered.push(l);
    orderedLayers = ordered;
  }
  const constraints: string[] = [];
  const importantParts: string[] = [];
  const terms: string[] = [];
  let totalWeight = 0;

  for (const layer of orderedLayers) {
    const varName = LAYER_VAR[layer.id];
    if (!varName) continue;

    // Aspect → ORIENTATION(...) special call (no TF)
    if (layer.id === 'terrainAspect') {
      const varName = LAYER_VAR[layer.id];
      if (!varName) continue;
      const call = buildOrientationCall(varName, configs.terrain.aspect, configs.terrain.aspectWeight ?? 1);
      const w = fmtNum(layer.weight);
      terms.push(`weight(${w}) * ${call}`);
      totalWeight += layer.weight;
      continue;
    }

    const tf = layerTf(layer.id, configs);
    if (!tf) continue;

    const shape = tf.shape ?? 'sin';
    const fn = SHAPE_FN[shape];
    const isInv = shape === 'invsin' || shape === 'invrange';

    // Build function call: FN(var, M, N [, high, low])
    const args = [varName, fmtNum(tf.plateauEnd), fmtNum(tf.decayEnd)];
    const high = tf.ceiling ?? 1;
    if (high !== 1 || tf.floor !== 0) {
      args.push(fmtNum(high), fmtNum(tf.floor));
    }
    const call = `${fn}(${args.join(', ')})`;

    // Mandatory constraint guard (binary 0/1)
    if (tf.mandatory) {
      if (isInv) {
        constraints.push(`(${varName} > ${fmtNum(tf.plateauEnd)})`);
      } else {
        constraints.push(`(${varName} < ${fmtNum(tf.decayEnd)})`);
      }
    }

    // Important layers: TF call placed as multiplicative factor outside the sum
    if (tf.important && !tf.mandatory) {
      importantParts.push(call);
      continue; // skip adding to weighted sum
    }

    const w = fmtNum(layer.weight);
    terms.push(`weight(${w}) * ${call}`);
    totalWeight += layer.weight;
  }

  if (terms.length === 0 && importantParts.length === 0 && constraints.length === 0) return '0';

  // Build the sum section (without /totalWeight — appended at end for
  // clean AST stripping in detectSimpleStructure).
  let result: string;
  if (terms.length === 0) {
    // Only important/guard layers, no sum → use 1 as base
    result = '1';
  } else {
    const sumPart = terms.length === 1 ? terms[0] : terms.join(' + ');
    // Wrap in parens when there are multiple additive terms
    result = terms.length > 1 ? `(${sumPart})` : sumPart;
  }

  // Prepend important factors
  if (importantParts.length > 0) {
    const impStr = importantParts.join(' * ');
    result = terms.length === 0 ? impStr : `${impStr} * ${result}`;
  }

  // Prepend guard constraints
  if (constraints.length > 0) {
    result = constraints.join(' * ') + ' * ' + result;
  }

  // Append / weights at the very end so it's at the AST root
  if (terms.length > 0) {
    result += ' / weights';
  }

  return result;
}

/* ══════════════════════════════════════════════════════════════════════
   DEFAULT formula
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Empty default — Visual mode always re-generates from live layers+configs.
 * A non-empty string is only stored when the user switches to Raw mode.
 */
export const DEFAULT_CUSTOM_FORMULA = '';

/* ══════════════════════════════════════════════════════════════════════
   Raw formula compilation & evaluation
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Runtime transfer-function implementations for formula evaluation.
 * Each accepts (value, M, N, high?, low?) → score.
 * Also tolerates (stringName, M, N, ...) for legacy compatibility.
 */
type TfFn = (valueOrName: number | string, M: number, N: number, high?: number, low?: number) => number;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function sinFn(v: number, M: number, N: number, high = 1, low = 0): number {
  if (!Number.isFinite(v)) return low;
  if (v <= M) return high;
  if (v >= N) return low;
  const t = (v - M) / (N - M);
  return low + (high - low) * 0.5 * (1 + Math.cos(Math.PI * t));
}

function invsinFn(v: number, M: number, N: number, high = 1, low = 0): number {
  if (!Number.isFinite(v)) return low;
  if (v <= M) return low;
  if (v >= N) return high;
  const t = (v - M) / (N - M);
  return low + (high - low) * 0.5 * (1 - Math.cos(Math.PI * t));
}

function rangeFn(v: number, M: number, N: number, high = 1, low = 0): number {
  if (!Number.isFinite(v)) return low;
  if (v <= M) return high;
  if (v >= N) return low;
  const t = (v - M) / (N - M);
  return high - (high - low) * t;
}

function invrangeFn(v: number, M: number, N: number, high = 1, low = 0): number {
  if (!Number.isFinite(v)) return low;
  if (v <= M) return low;
  if (v >= N) return high;
  const t = (v - M) / (N - M);
  return low + (high - low) * t;
}

type MathBuiltins = {
  SQRT: (v: number) => number;
  ABS:  (v: number) => number;
  POW:  (base: number, exp: number) => number;
  MIN:  (...args: number[]) => number;
  MAX:  (...args: number[]) => number;
  LOG:  (v: number) => number;
  LOG2: (v: number) => number;
  LOG10:(v: number) => number;
  EXP:  (v: number) => number;
  SIGN: (v: number) => number;
  CLAMP:(v: number, lo: number, hi: number) => number;
  IF:   (cond: unknown, t: number, f: number) => number;
  FLOOR:(v: number) => number;
  CEIL: (v: number) => number;
  ROUND:(v: number) => number;
  ATAN2:(y: number, x: number) => number;
  ACOS: (v: number) => number;
  ASIN: (v: number) => number;
  ATAN: (v: number) => number;
  COS:  (v: number) => number;
  TAN:  (v: number) => number;
  PI:   number;
};

const BUILTIN_MATH: MathBuiltins = {
  SQRT: Math.sqrt,
  ABS:  Math.abs,
  POW:  Math.pow,
  MIN:  Math.min,
  MAX:  Math.max,
  LOG:  Math.log,
  LOG2: Math.log2,
  LOG10:Math.log10,
  EXP:  Math.exp,
  SIGN: (v) => v > 0 ? 1 : v < 0 ? -1 : 0,
  CLAMP:(v, lo, hi) => v < lo ? lo : v > hi ? hi : v,
  IF:   (cond, t, f) => cond ? t : f,
  FLOOR:Math.floor,
  CEIL: Math.ceil,
  ROUND:Math.round,
  ATAN2:Math.atan2,
  ACOS: Math.acos,
  ASIN: Math.asin,
  ATAN: Math.atan,
  COS:  Math.cos,
  TAN:  Math.tan,
  PI:   Math.PI,
};

type OrientationFn = (
  angleDeg: number | string,
  S: number, SW: number, W: number, NW: number,
  N: number, NE: number, E: number, SE: number,
  dampWeight?: number,
) => number;

type CompiledFormulaFn = (
  VAR: (name: string) => number,
  SIN: TfFn,
  INVSIN: TfFn,
  RANGE: TfFn,
  INVRANGE: TfFn,
  _M: MathBuiltins,
  ORIENTATION: OrientationFn,
) => unknown;

const COMPILED_CACHE = new Map<string, CompiledFormulaFn>();

/** Strip leading "Score=" or "score =" prefix the user may type. */
export function normalizeUserFormulaInput(formula: string): string {
  return formula.trim().replace(/^\s*score\s*=\s*/i, '');
}

const _nameCache = new Map<string, string>();
function normalizeName(name: string): string {
  let cached = _nameCache.get(name);
  if (cached !== undefined) return cached;
  cached = name.replace(/[^a-z0-9]/gi, '').toLowerCase();
  _nameCache.set(name, cached);
  return cached;
}

function tokenToNumber(token: string): number {
  const cleaned = token.replace(/[^0-9+\-\.eE]/g, '');
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return clamp(value, 0, 1);
}

/**
 * Normalise raw formula source into evaluable JS.
 *
 * Steps:
 *   1. Strip "Score =" prefix
 *   2. Convert `[` / `]` → `(` / `)`
 *   3. Convert GT / LT / Eq text operators
 *   4. Strip unit suffixes (º, %, km, etc.) — legacy tolerance
 *   5. Convert legacy `Var(min X, max Y)` → `RANGE(VAR("var"), X, Y)`
 *   6. Wrap bare identifiers with `VAR("name")`
 */
function normalizeFormulaSource(formula: string): string {
  let source = formula.trim();
  source = source.replace(/^\s*score\s*=\s*/i, '');
  source = source.replace(/\[/g, '(').replace(/\]/g, ')');
  source = source.replace(/\bGT\b/gi, '>').replace(/\bLT\b/gi, '<').replace(/\bEq\b/gi, '==');

  // Strip unit suffixes (legacy tolerance)
  source = source.replace(
    /(\d+(?:\.\d+)?)(?:\s*(?:º|°|%|km|mm|cm|m|ug\/m3|ug\/m³|eur|€|c|°c|\/1k))/gi,
    '$1',
  );

  // Legacy: Var(minX, maxY) → RANGE(VAR("var"), X, Y)
  source = source.replace(
    /([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*min\s*([^,\)]+)\s*,\s*max\s*([^\)]+)\s*\)/gi,
    (_match, variable: string, minToken: string, maxToken: string) => {
      const minValue = tokenToNumber(minToken);
      const maxValue = tokenToNumber(maxToken);
      return `RANGE(VAR("${variable}"),${minValue},${maxValue})`;
    },
  );

  // Wrap bare identifiers with VAR("name") — skip reserved function names
  const reserved = new Set([
    'SIN', 'INVSIN', 'RANGE', 'INVRANGE', 'VAR', 'Math',
    'ORIENTATION',
    'WEIGHT', 'weight', 'weights',
    'true', 'false', 'null', 'undefined',
    // Math builtins injected via _M destructuring
    'SQRT', 'ABS', 'POW', 'MIN', 'MAX', 'LOG', 'LOG2', 'LOG10',
    'EXP', 'SIGN', 'CLAMP', 'IF', 'FLOOR', 'CEIL', 'ROUND',
    'ATAN2', 'ACOS', 'ASIN', 'ATAN', 'COS', 'TAN', 'PI',
    '_M',
  ]);
  source = source.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*\()/g, (match, name: string) => {
    if (reserved.has(name)) return match;
    return `VAR("${name}")`;
  });

  return source;
}

/** Compute the `weights` sum by extracting all WEIGHT(n) calls from the source. */
function computeWeightsFromSource(normalizedInput: string): number {
  let total = 0;
  const re = /\bweight\s*\(\s*([0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?)\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(normalizedInput)) !== null) {
    total += parseFloat(match[1]);
  }
  return total || 1; // fallback to 1 to avoid division by zero
}

function getCompiledFormula(normalizedInput: string): CompiledFormulaFn {
  const key = normalizedInput;
  const cached = COMPILED_CACHE.get(key);
  if (cached) return cached;
  const normalizedSource = normalizeFormulaSource(normalizedInput);
  const weightsValue = computeWeightsFromSource(normalizedInput);
  const mathDestructure = `const {${Object.keys(BUILTIN_MATH).join(',')}} = _M;`;
  const preamble = [
    mathDestructure,
    `function WEIGHT(n) { return n; }`,
    `var weight = WEIGHT;`,
    `var weights = ${weightsValue};`,
  ].join('\n');
  const compiled = new Function(
    'VAR', 'SIN', 'INVSIN', 'RANGE', 'INVRANGE', '_M', 'ORIENTATION',
    `${preamble}\nreturn (${normalizedSource});`,
  ) as CompiledFormulaFn;
  COMPILED_CACHE.set(key, compiled);
  return compiled;
}

/* ── Validation ─────────────────────────────────────────────────────── */

export interface FormulaValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Validate a raw formula string.  Empty formulas are considered valid
 * (they simply mean "use visual mode scoring").
 */
export function validateCustomFormula(formula: string): FormulaValidationResult {
  const normalizedInput = normalizeUserFormulaInput(formula);
  if (!normalizedInput.trim()) return { ok: true }; // empty = visual mode
  try {
    const noop: TfFn = () => 0;
    const fn = getCompiledFormula(normalizedInput);
    fn(() => 0, noop, noop, noop, noop, BUILTIN_MATH, orientationFn);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Invalid formula' };
  }
}

/* ── Evaluation ─────────────────────────────────────────────────────── */

export type FormulaValueMap = Record<string, number | undefined>;

/** Pre-normalise value keys for batch evaluation. */
export function normalizeFormulaValueKeys(raw: FormulaValueMap): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value == null || !Number.isFinite(value)) continue;
    result[normalizeName(key)] = value;
  }
  return result;
}

/** Build the runtime TF functions that resolve variable names from a values map. */
function buildRuntimeFns(values: Record<string, number>) {
  const resolve = (vOrName: number | string): number =>
    typeof vOrName === 'string' ? (values[normalizeName(vOrName)] ?? 0) : vOrName;

  const SIN: TfFn = (v, M, N, h, l) => sinFn(resolve(v), M, N, h, l);
  const INVSIN: TfFn = (v, M, N, h, l) => invsinFn(resolve(v), M, N, h, l);
  const RANGE: TfFn = (v, M, N, h, l) => rangeFn(resolve(v), M, N, h, l);
  const INVRANGE: TfFn = (v, M, N, h, l) => invrangeFn(resolve(v), M, N, h, l);

  return { SIN, INVSIN, RANGE, INVRANGE };
}

/**
 * Pre-compile a formula for fast repeated evaluation in a pixel loop.
 */
export function compileFormulaForBatch(
  formula: string,
): ((values: Record<string, number>) => number) | null {
  const normalizedInput = normalizeUserFormulaInput(formula);
  if (!normalizedInput.trim()) return null;
  try {
    const noop: TfFn = () => 0;
    const fn = getCompiledFormula(normalizedInput);
    fn(() => 0, noop, noop, noop, noop, BUILTIN_MATH, orientationFn); // validation dry-run
    return (values: Record<string, number>): number => {
      try {
        const VAR = (name: string): number => values[normalizeName(name)] ?? 0;
        const { SIN, INVSIN, RANGE, INVRANGE } = buildRuntimeFns(values);
        const output = fn(VAR, SIN, INVSIN, RANGE, INVRANGE, BUILTIN_MATH, orientationFn);
        const numeric = typeof output === 'boolean' ? (output ? 1 : 0) : Number(output);
        return clamp01(numeric);
      } catch { return 0; }
    };
  } catch { return null; }
}

export function evaluateCustomFormula(formula: string, rawValues: FormulaValueMap): number {
  const normalizedInput = normalizeUserFormulaInput(formula);
  if (!normalizedInput.trim()) return 0;

  const normalizedValues: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawValues)) {
    if (value == null || !Number.isFinite(value)) continue;
    normalizedValues[normalizeName(key)] = value;
  }

  const VAR = (name: string): number => normalizedValues[normalizeName(name)] ?? 0;
  const { SIN, INVSIN, RANGE, INVRANGE } = buildRuntimeFns(normalizedValues);

  try {
    const fn = getCompiledFormula(normalizedInput);
    const output = fn(VAR, SIN, INVSIN, RANGE, INVRANGE, BUILTIN_MATH, orientationFn);
    const numeric = typeof output === 'boolean' ? (output ? 1 : 0) : Number(output);
    return clamp01(numeric);
  } catch {
    return 0;
  }
}
