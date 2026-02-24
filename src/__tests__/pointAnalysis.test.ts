/**
 * @file Tests for point-in-polygon, IDW point interpolation,
 *       and the full computePointScore pipeline.
 */
import { describe, it, expect } from 'vitest';
import {
  pointInPolygon,
  idwInterpolatePoint,
} from '../utils/spatial';
import { computePointScore } from '../utils/pointAnalysis';
import type { FacilityPoints } from '../utils/pointAnalysis';
import type { MunicipalityData } from '../utils/scorer';
import type { MunicipalityCollection } from '../types';
import { DEFAULT_LAYER_CONFIGS } from '../types/transferFunction';

// ── pointInPolygon ─────────────────────────────────────────────────────

describe('pointInPolygon', () => {
  const square: GeoJSON.Polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
    ],
  };

  it('returns true for point inside polygon', () => {
    expect(pointInPolygon(5, 5, square)).toBe(true);
  });

  it('returns false for point outside polygon', () => {
    expect(pointInPolygon(15, 5, square)).toBe(false);
  });

  it('returns false for point clearly outside', () => {
    expect(pointInPolygon(-5, -5, square)).toBe(false);
  });

  it('handles polygon with hole', () => {
    const withHole: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [
        // Outer ring
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
        // Inner hole
        [
          [3, 3],
          [7, 3],
          [7, 7],
          [3, 7],
          [3, 3],
        ],
      ],
    };

    // Inside outer, outside hole
    expect(pointInPolygon(1, 1, withHole)).toBe(true);
    // Inside hole
    expect(pointInPolygon(5, 5, withHole)).toBe(false);
  });

  it('handles MultiPolygon', () => {
    const multi: GeoJSON.MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [
        // First polygon: 0-5, 0-5
        [
          [
            [0, 0],
            [5, 0],
            [5, 5],
            [0, 5],
            [0, 0],
          ],
        ],
        // Second polygon: 10-15, 10-15
        [
          [
            [10, 10],
            [15, 10],
            [15, 15],
            [10, 15],
            [10, 10],
          ],
        ],
      ],
    };

    expect(pointInPolygon(2.5, 2.5, multi)).toBe(true);
    expect(pointInPolygon(12, 12, multi)).toBe(true);
    expect(pointInPolygon(7.5, 7.5, multi)).toBe(false);
  });
});

// ── idwInterpolatePoint ────────────────────────────────────────────────

describe('idwInterpolatePoint', () => {
  const stations = [
    { lat: 0, lon: 0, values: { temp: 10 } },
    { lat: 0, lon: 1, values: { temp: 20 } },
    { lat: 1, lon: 0, values: { temp: 30 } },
  ];

  it('returns empty for no stations', () => {
    expect(idwInterpolatePoint(0, 0, [])).toEqual({});
  });

  it('returns exact station value when at station location', () => {
    const result = idwInterpolatePoint(0, 0, stations);
    expect(result.temp).toBe(10);
  });

  it('interpolates between stations', () => {
    const result = idwInterpolatePoint(0.5, 0.5, stations);
    expect(result.temp).toBeGreaterThan(10);
    expect(result.temp).toBeLessThan(30);
  });
});

// ── computePointScore ──────────────────────────────────────────────────

describe('computePointScore', () => {
  // Minimal municipality collection with one square municipality
  const municipalities: MunicipalityCollection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [1, 41],
              [2, 41],
              [2, 42],
              [1, 42],
              [1, 41],
            ],
          ],
        },
        properties: {
          codi: '08001',
          nom: 'TestMuni',
          comarca: 'TestComarca',
        },
      },
    ],
  };

  const data: MunicipalityData = {
    terrain: {
      '08001': { codi: '08001', avgSlopeDeg: 10, dominantAspect: 'S', avgElevationM: 200 },
    },
    votes: {
      '08001': {
        codi: '08001', nom: 'TestMuni', leftPct: 60, rightPct: 40,
        independencePct: 50, unionistPct: 50, turnoutPct: 80, year: 2021,
      },
    },
    forest: { '08001': { codi: '08001', forestPct: 45, agriculturalPct: 30, urbanPct: 25 } },
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

  const facilityPoints: FacilityPoints = {
    transit: [{ lat: 41.5, lon: 1.5 }],
    health: [{ lat: 41.5, lon: 1.5 }],
    schools: [{ lat: 41.5, lon: 1.5 }],
    amenities: [{ lat: 41.5, lon: 1.5 }],
  };

  const climateStations = [
    { lat: 41.5, lon: 1.5, values: { avgTempC: 15, avgRainfallMm: 500 } },
  ];

  it('finds municipality and returns a score', () => {
    const enabled = [
      { id: 'transit' as const, label: 'Transit', description: '', icon: '', enabled: true, weight: 1 },
    ];

    const result = computePointScore(
      41.5, 1.5, enabled, DEFAULT_LAYER_CONFIGS,
      municipalities, data, facilityPoints, climateStations,
    );

    expect(result.municipality).not.toBeNull();
    expect(result.municipality!.codi).toBe('08001');
    expect(result.municipality!.nom).toBe('TestMuni');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.layerScores.transit).toBeDefined();
  });

  it('returns null municipality for point outside all polygons', () => {
    const enabled = [
      { id: 'transit' as const, label: 'Transit', description: '', icon: '', enabled: true, weight: 1 },
    ];

    const result = computePointScore(
      45, 5, enabled, DEFAULT_LAYER_CONFIGS,
      municipalities, data, facilityPoints, climateStations,
    );

    expect(result.municipality).toBeNull();
  });

  it('includes raw distance values', () => {
    const enabled = [
      { id: 'transit' as const, label: 'Transit', description: '', icon: '', enabled: true, weight: 1 },
      { id: 'healthcare' as const, label: 'Healthcare', description: '', icon: '', enabled: true, weight: 1 },
    ];

    const result = computePointScore(
      41.5, 1.5, enabled, DEFAULT_LAYER_CONFIGS,
      municipalities, data, facilityPoints, climateStations,
    );

    expect(result.rawValues.transitDistKm).toBeDefined();
    expect(result.rawValues.healthcareDistKm).toBeDefined();
    // Point is at the facility, so distance ~ 0
    expect(result.rawValues.transitDistKm).toBeLessThan(1);
  });

  it('scores terrain layer from municipality data', () => {
    const enabled = [
      { id: 'terrain' as const, label: 'Terrain', description: '', icon: '', enabled: true, weight: 1 },
    ];

    const result = computePointScore(
      41.5, 1.5, enabled, DEFAULT_LAYER_CONFIGS,
      municipalities, data, facilityPoints, climateStations,
    );

    expect(result.layerScores.terrain).toBeDefined();
    expect(result.rawValues.slopeDeg).toBe(10);
    expect(result.rawValues.elevationM).toBe(200);
  });

  it('scores climate from IDW interpolation', () => {
    const enabled = [
      { id: 'climate' as const, label: 'Climate', description: '', icon: '', enabled: true, weight: 1 },
    ];

    const configs = { ...DEFAULT_LAYER_CONFIGS };
    configs.climate = {
      temperature: { enabled: true, tf: { plateauEnd: 10, decayEnd: 25, floor: 0, mandatory: false, multiplier: 1, invert: false } },
      rainfall: { enabled: true, tf: { plateauEnd: 200, decayEnd: 800, floor: 0, mandatory: false, multiplier: 1, invert: true } },
    };

    const result = computePointScore(
      41.5, 1.5, enabled, configs,
      municipalities, data, facilityPoints, climateStations,
    );

    expect(result.layerScores.climate).toBeDefined();
    expect(result.rawValues.avgTempC).toBeCloseTo(15, 0);
    expect(result.rawValues.avgRainfallMm).toBeCloseTo(500, 0);
  });

  it('handles multiple enabled layers weighted correctly', () => {
    const enabled = [
      { id: 'transit' as const, label: 'Transit', description: '', icon: '', enabled: true, weight: 2 },
      { id: 'forest' as const, label: 'Forest', description: '', icon: '', enabled: true, weight: 1 },
    ];

    const result = computePointScore(
      41.5, 1.5, enabled, DEFAULT_LAYER_CONFIGS,
      municipalities, data, facilityPoints, climateStations,
    );

    expect(result.layerScores.transit).toBeDefined();
    expect(result.layerScores.forest).toBeDefined();
    // Composite should be weighted average
    const expected =
      (result.layerScores.transit! * 2 + result.layerScores.forest! * 1) / 3;
    expect(result.score).toBeCloseTo(expected, 5);
  });
});
