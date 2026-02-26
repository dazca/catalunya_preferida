import type { FacilityCollection, MunicipalityCollection, TransitStopCollection } from '../types';
import type { MunicipalityData } from './scorer';
import { normalizeIne } from './scorer';

export type IntegritySeverity = 'info' | 'warning' | 'error';

export type IntegrityLayer =
  | 'global'
  | 'votes'
  | 'terrain'
  | 'forest'
  | 'airQuality'
  | 'crime'
  | 'rentalPrices'
  | 'employment'
  | 'internet'
  | 'transit'
  | 'healthcare'
  | 'schools'
  | 'amenities'
  | 'climate';

export interface IntegrityIssue {
  id: string;
  layer: IntegrityLayer;
  severity: IntegritySeverity;
  code: string;
  message: string;
  affectedCount: number;
  sampleCodes: string[];
  /** Full list of affected municipality codes (for map integration). */
  affectedCodis?: string[];
}

export interface IntegrityLayerReport {
  layer: IntegrityLayer;
  issues: IntegrityIssue[];
}

export interface IntegrityLayerStats {
  layer: IntegrityLayer;
  totalRecords: number;
  municipalityCoverage: number;
  blankFieldPct: number;
  outlierCount: number;
  dataYear: number | null;
}

export interface IntegrityReport {
  generatedAt: string;
  totalIssues: number;
  bySeverity: Record<IntegritySeverity, number>;
  layers: IntegrityLayerReport[];
  /** Per-layer quick stats for the matrix/freshness views. */
  layerStats: IntegrityLayerStats[];
  /** Municipality codes present in each layer (for map). */
  coverageByLayer: Record<string, string[]>;
}

export interface IntegrityRules {
  requiredCoveragePct: number;
  maxBlankPctPerLayer: number;
  maxOutlierZScore: number;
  maxDuplicateCoordDecimals: number;
  staleYearThreshold: number;
  leftParties: string[];
  independenceParties: string[];
  /** Enable cross-layer correlation check. */
  crossLayerCheck: boolean;
  /** Enable coordinate bounds validation (Catalonia bbox). */
  coordBoundsCheck: boolean;
  /** Enable broken codi reference check. */
  brokenRefCheck: boolean;
  /** Enable duplicate codi detection per layer. */
  duplicateCodiCheck: boolean;
}

export const DEFAULT_INTEGRITY_RULES: IntegrityRules = {
  requiredCoveragePct: 90,
  maxBlankPctPerLayer: 15,
  maxOutlierZScore: 4,
  maxDuplicateCoordDecimals: 5,
  staleYearThreshold: 6,
  crossLayerCheck: true,
  coordBoundsCheck: true,
  brokenRefCheck: true,
  duplicateCodiCheck: true,
  leftParties: [
    'psc', 'erc', 'cup', 'podem', 'icv', 'euia', 'comuns', 'bcomú', 'en comú',
    'iniciativa', 'esquerra', 'socialistes', 'podemos', 'sumar',
    'barcelona en comú', 'catalan european democratic party',
  ],
  independenceParties: [
    'erc', 'jxcat', 'cup', 'cdc', 'ciu', 'pdecat', 'junts',
    'convergència', 'esquerra republicana', 'junts per catalunya',
    "candidatura d'unitat popular",
  ],
};

export interface DataIntegrityInput {
  municipalities: MunicipalityCollection | null;
  municipalityData: MunicipalityData;
  transitStops: TransitStopCollection | null;
  healthFacilities: FacilityCollection | null;
  schools: FacilityCollection | null;
  amenities: FacilityCollection | null;
  /** Optional raw arrays (before indexing) for duplicate codi detection. */
  rawArrays?: Partial<Record<IntegrityLayer, Array<{ codi: string }> | null>>;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((acc, n) => acc + n, 0) / values.length;
}

function stdev(values: number[]): number {
  if (values.length <= 1) return 0;
  const m = mean(values);
  const variance = values.reduce((acc, n) => acc + (n - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function uniqueMunicipalityCodes(municipalities: MunicipalityCollection | null): Set<string> {
  if (!municipalities) return new Set<string>();
  const set = new Set<string>();
  for (const f of municipalities.features) {
    const code = f.properties?.codi;
    if (typeof code === 'string' && code.length >= 5) set.add(normalizeIne(code));
  }
  return set;
}

function addIssue(
  out: IntegrityIssue[],
  layer: IntegrityLayer,
  severity: IntegritySeverity,
  code: string,
  message: string,
  affectedCodes: string[],
): void {
  out.push({
    id: `${layer}:${code}:${out.length + 1}`,
    layer,
    severity,
    code,
    message,
    affectedCount: affectedCodes.length,
    sampleCodes: affectedCodes.slice(0, 8),
    affectedCodis: affectedCodes,
  });
}

function checkCoverage(
  layer: IntegrityLayer,
  municipalityCodes: Set<string>,
  datasetCodes: Set<string>,
  rules: IntegrityRules,
  out: IntegrityIssue[],
): void {
  const total = municipalityCodes.size;
  if (total === 0) return;
  const missing: string[] = [];
  for (const c of municipalityCodes) {
    if (!datasetCodes.has(c)) missing.push(c);
  }
  const coveragePct = ((total - missing.length) / total) * 100;
  if (coveragePct < rules.requiredCoveragePct) {
    addIssue(
      out,
      layer,
      'error',
      'coverage.low',
      `Coverage ${coveragePct.toFixed(1)}% is below threshold ${rules.requiredCoveragePct}%`,
      missing,
    );
  } else if (missing.length > 0) {
    addIssue(
      out,
      layer,
      'warning',
      'coverage.partial',
      `Partial coverage ${coveragePct.toFixed(1)}% (${missing.length} municipalities missing)`,
      missing,
    );
  }
}

function checkNumericOutliers(
  layer: IntegrityLayer,
  metricName: string,
  byCode: Record<string, number>,
  rules: IntegrityRules,
  out: IntegrityIssue[],
): void {
  const entries = Object.entries(byCode).filter(([, value]) => Number.isFinite(value));
  const values = entries.map(([, value]) => value);
  if (values.length < 5) return;
  const m = mean(values);
  const s = stdev(values);
  if (!Number.isFinite(s) || s === 0) {
    addIssue(
      out,
      layer,
      'warning',
      'distribution.constant',
      `${metricName} has near-constant values; check upstream feed`,
      entries.map(([code]) => code),
    );
    return;
  }
  const outlierCodes = entries
    .filter(([, value]) => Math.abs((value - m) / s) > rules.maxOutlierZScore)
    .map(([code]) => code);
  if (outlierCodes.length > 0) {
    addIssue(
      out,
      layer,
      'warning',
      'distribution.outliers',
      `${metricName} has ${outlierCodes.length} outliers (|z| > ${rules.maxOutlierZScore})`,
      outlierCodes,
    );
  }
}

function checkVotes(
  municipalityCodes: Set<string>,
  data: MunicipalityData,
  rules: IntegrityRules,
  out: IntegrityIssue[],
): void {
  const voteCodes = new Set(Object.keys(data.votes));
  checkCoverage('votes', municipalityCodes, voteCodes, rules, out);

  const blankLeft: string[] = [];
  const inconsistent: string[] = [];
  const stale: string[] = [];
  const turnoutAlwaysZero: string[] = [];
  const currentYear = new Date().getFullYear();

  for (const [codi, v] of Object.entries(data.votes)) {
    if (!Number.isFinite(v.leftPct)) blankLeft.push(codi);
    const lr = (v.leftPct ?? 0) + (v.rightPct ?? 0);
    const iu = (v.independencePct ?? 0) + (v.unionistPct ?? 0);
    if (Math.abs(lr - 100) > 8 || Math.abs(iu - 100) > 8) inconsistent.push(codi);
    if ((v.turnoutPct ?? 0) === 0) turnoutAlwaysZero.push(codi);
    if (Number.isFinite(v.year) && currentYear - v.year > rules.staleYearThreshold) stale.push(codi);
  }

  const blankPct = voteCodes.size > 0 ? (blankLeft.length / voteCodes.size) * 100 : 0;
  if (blankPct > rules.maxBlankPctPerLayer) {
    addIssue(
      out,
      'votes',
      'error',
      'leftsentiment.blank',
      `leftPct blanks are ${blankPct.toFixed(1)}% (> ${rules.maxBlankPctPerLayer}%)`,
      blankLeft,
    );
  } else if (blankLeft.length > 0) {
    addIssue(out, 'votes', 'warning', 'leftsentiment.blank', 'Some municipalities have blank leftPct', blankLeft);
  }

  if (inconsistent.length > 0) {
    addIssue(
      out,
      'votes',
      'warning',
      'votes.inconsistentTotals',
      'Vote totals look inconsistent (left+right or indep+unionist far from 100)',
      inconsistent,
    );
  }

  if (turnoutAlwaysZero.length > 0) {
    addIssue(
      out,
      'votes',
      'warning',
      'turnout.zero',
      'turnoutPct is zero for municipalities (likely missing turnout feed)',
      turnoutAlwaysZero,
    );
  }

  if (stale.length > 0) {
    addIssue(
      out,
      'votes',
      'warning',
      'votes.stale',
      `Vote records older than ${rules.staleYearThreshold} years`,
      stale,
    );
  }
}

function checkObjectLayer<T extends { codi: string }>(
  layer: IntegrityLayer,
  municipalities: Set<string>,
  table: Record<string, T>,
  fieldChecks: Array<{ name: string; read: (row: T) => number | undefined; min?: number; max?: number }>,
  rules: IntegrityRules,
  out: IntegrityIssue[],
): void {
  const codes = new Set(Object.keys(table));
  checkCoverage(layer, municipalities, codes, rules, out);

  for (const f of fieldChecks) {
    const blanks: string[] = [];
    const rangeViolations: string[] = [];
    const numericMap: Record<string, number> = {};

    for (const [code, row] of Object.entries(table)) {
      const value = f.read(row);
      if (!Number.isFinite(value)) {
        blanks.push(code);
        continue;
      }
      numericMap[code] = value as number;
      if ((f.min !== undefined && (value as number) < f.min) || (f.max !== undefined && (value as number) > f.max)) {
        rangeViolations.push(code);
      }
    }

    const blankPct = codes.size > 0 ? (blanks.length / codes.size) * 100 : 0;
    if (blankPct > rules.maxBlankPctPerLayer) {
      addIssue(
        out,
        layer,
        'error',
        `${f.name}.blank`,
        `${f.name} blanks are ${blankPct.toFixed(1)}% (> ${rules.maxBlankPctPerLayer}%)`,
        blanks,
      );
    } else if (blanks.length > 0) {
      addIssue(out, layer, 'warning', `${f.name}.blank`, `${f.name} has blank values`, blanks);
    }

    if (rangeViolations.length > 0) {
      addIssue(out, layer, 'error', `${f.name}.range`, `${f.name} contains impossible values`, rangeViolations);
    }

    checkNumericOutliers(layer, f.name, numericMap, rules, out);
  }
}

function checkDistanceLayer(
  layer: IntegrityLayer,
  municipalities: Set<string>,
  table: Record<string, number>,
  rules: IntegrityRules,
  out: IntegrityIssue[],
): void {
  const codes = new Set(Object.keys(table));
  checkCoverage(layer, municipalities, codes, rules, out);

  const negative: string[] = [];
  const huge: string[] = [];
  const values: Record<string, number> = {};
  for (const [codi, dist] of Object.entries(table)) {
    if (!Number.isFinite(dist)) continue;
    values[codi] = dist;
    if (dist < 0) negative.push(codi);
    if (dist > 200) huge.push(codi);
  }
  if (negative.length > 0) addIssue(out, layer, 'error', 'distance.negative', 'Negative distances found', negative);
  if (huge.length > 0) addIssue(out, layer, 'warning', 'distance.huge', 'Very large distances found (>200km)', huge);
  checkNumericOutliers(layer, 'distanceKm', values, rules, out);
}

function checkPointCollection(
  layer: IntegrityLayer,
  fc: TransitStopCollection | FacilityCollection | null,
  rules: IntegrityRules,
  out: IntegrityIssue[],
): void {
  if (!fc) {
    addIssue(out, layer, 'error', 'feed.missing', 'FeatureCollection is missing', []);
    return;
  }
  const invalidCoords: string[] = [];
  const seen = new Map<string, number>();
  const duplicateCoords: string[] = [];
  const p = rules.maxDuplicateCoordDecimals;

  fc.features.forEach((feature, idx) => {
    if (feature.geometry?.type !== 'Point') {
      invalidCoords.push(`idx:${idx}`);
      return;
    }
    const [lon, lat] = feature.geometry.coordinates;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      invalidCoords.push(`idx:${idx}`);
      return;
    }
    const key = `${lat.toFixed(p)}:${lon.toFixed(p)}`;
    const prev = seen.get(key);
    if (prev !== undefined) duplicateCoords.push(`idx:${prev}->${idx}`);
    seen.set(key, idx);
  });

  if (invalidCoords.length > 0) {
    addIssue(out, layer, 'error', 'geo.invalidPoint', 'Invalid point coordinates detected', invalidCoords);
  }
  if (duplicateCoords.length > 0) {
    addIssue(out, layer, 'warning', 'geo.duplicatePoint', 'Duplicate point coordinates detected', duplicateCoords);
  }
}

/** Catalonia bounding box [minLon, minLat, maxLon, maxLat]. */
const CAT_BBOX = { minLon: 0.15, minLat: 40.52, maxLon: 3.33, maxLat: 42.86 };

/**
 * Check that point features fall within the Catalonia bounding box.
 */
function checkCoordinateBounds(
  layer: IntegrityLayer,
  fc: TransitStopCollection | FacilityCollection | null,
  out: IntegrityIssue[],
): void {
  if (!fc) return;
  const oob: string[] = [];
  fc.features.forEach((f, idx) => {
    if (f.geometry?.type !== 'Point') return;
    const [lon, lat] = f.geometry.coordinates;
    if (lat < CAT_BBOX.minLat || lat > CAT_BBOX.maxLat || lon < CAT_BBOX.minLon || lon > CAT_BBOX.maxLon) {
      oob.push(`idx:${idx}`);
    }
  });
  if (oob.length > 0) {
    addIssue(out, layer, 'warning', 'geo.outsideCatalonia', `${oob.length} points outside Catalonia bounding box`, oob);
  }
}

/**
 * Cross-layer correlation: flag municipalities that exist in layer A but not in layer B.
 */
function checkCrossLayerCorrelation(
  municipalityCodes: Set<string>,
  data: MunicipalityData,
  out: IntegrityIssue[],
): void {
  const layerPairs: Array<[IntegrityLayer, IntegrityLayer, string, string]> = [
    ['votes', 'employment', 'votes', 'employment'],
    ['votes', 'rentalPrices', 'votes', 'rentalPrices'],
    ['employment', 'rentalPrices', 'employment', 'rentalPrices'],
    ['terrain', 'forest', 'terrain', 'forest'],
  ];

  for (const [layerA, layerB, keyA, keyB] of layerPairs) {
    const tables = data as unknown as Record<string, Record<string, unknown>>;
    const codesA = new Set(Object.keys(tables[keyA] ?? {}));
    const codesB = new Set(Object.keys(tables[keyB] ?? {}));
    const inANotB: string[] = [];
    const inBNotA: string[] = [];
    for (const c of codesA) if (!codesB.has(c) && municipalityCodes.has(c)) inANotB.push(c);
    for (const c of codesB) if (!codesA.has(c) && municipalityCodes.has(c)) inBNotA.push(c);
    if (inANotB.length > 20) {
      addIssue(out, 'global', 'warning', `crosslayer.${layerA}_${layerB}`,
        `${inANotB.length} municipalities in ${layerA} but not in ${layerB}`, inANotB);
    }
    if (inBNotA.length > 20) {
      addIssue(out, 'global', 'warning', `crosslayer.${layerB}_${layerA}`,
        `${inBNotA.length} municipalities in ${layerB} but not in ${layerA}`, inBNotA);
    }
  }
}

/**
 * Broken reference: validate that codi values in data layers actually exist in the municipalities GeoJSON.
 */
function checkBrokenReferences(
  municipalityCodes: Set<string>,
  data: MunicipalityData,
  out: IntegrityIssue[],
): void {
  const layerKeys: Array<[IntegrityLayer, string]> = [
    ['votes', 'votes'], ['terrain', 'terrain'], ['forest', 'forest'],
    ['crime', 'crime'], ['rentalPrices', 'rentalPrices'], ['employment', 'employment'],
    ['internet', 'internet'], ['airQuality', 'airQuality'],
  ];

  for (const [layer, key] of layerKeys) {
    const table = (data as unknown as Record<string, Record<string, unknown>>)[key] ?? {};
    const orphans: string[] = [];
    for (const codi of Object.keys(table)) {
      if (!municipalityCodes.has(codi)) orphans.push(codi);
    }
    if (orphans.length > 0) {
      addIssue(out, layer, 'warning', 'ref.broken',
        `${orphans.length} codi values not found in municipalities GeoJSON`, orphans);
    }
  }
}

/**
 * Duplicate codi detection within a single dataset.
 */
function checkDuplicateCodis(
  layer: IntegrityLayer,
  rawArray: Array<{ codi: string }> | null,
  out: IntegrityIssue[],
): void {
  if (!rawArray || rawArray.length === 0) return;
  const seen = new Map<string, number>();
  const dupes: string[] = [];
  for (const item of rawArray) {
    const c = normalizeIne(item.codi);
    const prev = seen.get(c) ?? 0;
    if (prev === 1) dupes.push(c);
    seen.set(c, prev + 1);
  }
  if (dupes.length > 0) {
    addIssue(out, layer, 'warning', 'codi.duplicate',
      `${dupes.length} duplicate codi values in raw dataset`, dupes);
  }
}

export function runDataIntegrityChecks(
  input: DataIntegrityInput,
  rules: IntegrityRules,
): IntegrityReport {
  const issues: IntegrityIssue[] = [];
  const municipalityData = {
    terrain: input.municipalityData?.terrain ?? {},
    votes: input.municipalityData?.votes ?? {},
    forest: input.municipalityData?.forest ?? {},
    crime: input.municipalityData?.crime ?? {},
    rentalPrices: input.municipalityData?.rentalPrices ?? {},
    employment: input.municipalityData?.employment ?? {},
    climate: input.municipalityData?.climate ?? {},
    airQuality: input.municipalityData?.airQuality ?? {},
    internet: input.municipalityData?.internet ?? {},
    transitDistKm: input.municipalityData?.transitDistKm ?? {},
    healthcareDistKm: input.municipalityData?.healthcareDistKm ?? {},
    schoolDistKm: input.municipalityData?.schoolDistKm ?? {},
    amenityDistKm: input.municipalityData?.amenityDistKm ?? {},
  };
  const municipalityCodes = uniqueMunicipalityCodes(input.municipalities);

  if (municipalityCodes.size === 0) {
    addIssue(issues, 'global', 'error', 'municipalities.missing', 'Municipality geometry dataset is missing', []);
  }

  checkVotes(municipalityCodes, municipalityData, rules, issues);

  checkObjectLayer('terrain', municipalityCodes, municipalityData.terrain, [
    { name: 'avgSlopeDeg', read: (r) => r.avgSlopeDeg, min: 0, max: 90 },
    { name: 'avgElevationM', read: (r) => r.avgElevationM, min: -100, max: 4000 },
  ], rules, issues);

  checkObjectLayer('forest', municipalityCodes, municipalityData.forest, [
    { name: 'forestPct', read: (r) => r.forestPct, min: 0, max: 100 },
  ], rules, issues);

  checkObjectLayer('airQuality', municipalityCodes, municipalityData.airQuality, [
    { name: 'pm10', read: (r) => r.pm10, min: 0, max: 200 },
    { name: 'no2', read: (r) => r.no2, min: 0, max: 200 },
  ], rules, issues);

  checkObjectLayer('crime', municipalityCodes, municipalityData.crime, [
    { name: 'ratePerThousand', read: (r) => r.ratePerThousand, min: 0, max: 300 },
  ], rules, issues);

  checkObjectLayer('rentalPrices', municipalityCodes, municipalityData.rentalPrices, [
    { name: 'avgEurMonth', read: (r) => r.avgEurMonth, min: 0, max: 10000 },
  ], rules, issues);

  checkObjectLayer('employment', municipalityCodes, municipalityData.employment, [
    { name: 'unemploymentPct', read: (r) => r.unemploymentPct, min: 0, max: 100 },
  ], rules, issues);

  checkObjectLayer('internet', municipalityCodes, municipalityData.internet, [
    { name: 'fiberPct', read: (r) => r.fiberPct, min: 0, max: 100 },
  ], rules, issues);

  checkObjectLayer('climate', municipalityCodes, municipalityData.climate, [
    { name: 'avgTempC', read: (r) => r.avgTempC, min: -40, max: 55 },
    { name: 'avgRainfallMm', read: (r) => r.avgRainfallMm, min: 0, max: 4000 },
  ], rules, issues);

  checkDistanceLayer('transit', municipalityCodes, municipalityData.transitDistKm, rules, issues);
  checkDistanceLayer('healthcare', municipalityCodes, municipalityData.healthcareDistKm, rules, issues);
  checkDistanceLayer('schools', municipalityCodes, municipalityData.schoolDistKm, rules, issues);
  checkDistanceLayer('amenities', municipalityCodes, municipalityData.amenityDistKm, rules, issues);

  checkPointCollection('transit', input.transitStops, rules, issues);
  checkPointCollection('healthcare', input.healthFacilities, rules, issues);
  checkPointCollection('schools', input.schools, rules, issues);
  checkPointCollection('amenities', input.amenities, rules, issues);

  // ── New checks ─────────────────────────────────────────────────
  if (rules.coordBoundsCheck) {
    checkCoordinateBounds('transit', input.transitStops, issues);
    checkCoordinateBounds('healthcare', input.healthFacilities, issues);
    checkCoordinateBounds('schools', input.schools, issues);
    checkCoordinateBounds('amenities', input.amenities, issues);
  }

  if (rules.crossLayerCheck) {
    checkCrossLayerCorrelation(municipalityCodes, municipalityData, issues);
  }

  if (rules.brokenRefCheck) {
    checkBrokenReferences(municipalityCodes, municipalityData, issues);
  }

  // Duplicate codi checks (requires raw arrays — stored on input if provided)
  if (rules.duplicateCodiCheck && input.rawArrays) {
    for (const [layer, arr] of Object.entries(input.rawArrays) as Array<[IntegrityLayer, Array<{ codi: string }> | null]>) {
      checkDuplicateCodis(layer, arr, issues);
    }
  }

  // ── Build report ───────────────────────────────────────────────
  const grouped = new Map<IntegrityLayer, IntegrityIssue[]>();
  for (const issue of issues) {
    const prev = grouped.get(issue.layer);
    if (prev) prev.push(issue);
    else grouped.set(issue.layer, [issue]);
  }

  const layers: IntegrityLayerReport[] = Array.from(grouped.entries()).map(([layer, layerIssues]) => ({
    layer,
    issues: layerIssues,
  }));

  const bySeverity: Record<IntegritySeverity, number> = { info: 0, warning: 0, error: 0 };
  for (const issue of issues) bySeverity[issue.severity] += 1;

  // ── Per-layer stats + coverage map ─────────────────────────────
  const muniDataKeys: Array<[IntegrityLayer, string]> = [
    ['votes', 'votes'], ['terrain', 'terrain'], ['forest', 'forest'],
    ['crime', 'crime'], ['rentalPrices', 'rentalPrices'], ['employment', 'employment'],
    ['internet', 'internet'], ['airQuality', 'airQuality'], ['climate', 'climate'],
  ];

  const coverageByLayer: Record<string, string[]> = {};
  const layerStats: IntegrityLayerStats[] = [];
  const totalMunis = municipalityCodes.size || 1;

  for (const [layer, key] of muniDataKeys) {
    const table = (municipalityData as Record<string, Record<string, unknown>>)[key] ?? {};
    const codes = Object.keys(table);
    coverageByLayer[layer] = codes;
    const coverage = (codes.length / totalMunis) * 100;

    // Extract year from first record if available
    let dataYear: number | null = null;
    const first = Object.values(table)[0] as Record<string, unknown> | undefined;
    if (first && typeof first.year === 'number') dataYear = first.year;

    // Count outliers for this layer from issues
    const layerIssues = grouped.get(layer) ?? [];
    const outlierCount = layerIssues
      .filter((i) => i.code.includes('outlier'))
      .reduce((acc, i) => acc + i.affectedCount, 0);
    const blankCount = layerIssues
      .filter((i) => i.code.includes('blank'))
      .reduce((acc, i) => acc + i.affectedCount, 0);

    layerStats.push({
      layer,
      totalRecords: codes.length,
      municipalityCoverage: Math.round(coverage * 10) / 10,
      blankFieldPct: codes.length > 0 ? Math.round((blankCount / codes.length) * 1000) / 10 : 0,
      outlierCount,
      dataYear,
    });
  }

  // Point layers coverage
  const pointLayerData: Array<[IntegrityLayer, TransitStopCollection | FacilityCollection | null]> = [
    ['transit', input.transitStops],
    ['healthcare', input.healthFacilities],
    ['schools', input.schools],
    ['amenities', input.amenities],
  ];
  for (const [layer, fc] of pointLayerData) {
    const count = fc?.features.length ?? 0;
    coverageByLayer[layer] = [`${count} points`];
    layerStats.push({
      layer,
      totalRecords: count,
      municipalityCoverage: count > 0 ? -1 : 0, // -1 = not municipality-based
      blankFieldPct: 0,
      outlierCount: 0,
      dataYear: null,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    totalIssues: issues.length,
    bySeverity,
    layers,
    layerStats,
    coverageByLayer,
  };
}
