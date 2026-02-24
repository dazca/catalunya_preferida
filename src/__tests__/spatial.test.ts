/**
 * @file Tests for spatial utility functions: haversine, centroid, distance maps, IDW.
 */
import { describe, it, expect } from 'vitest';
import {
  haversineKm,
  computeCentroid,
  nearestDistanceKm,
  computeDistanceMap,
  idwInterpolate,
} from '../utils/spatial';

describe('haversineKm', () => {
  it('returns 0 for identical points', () => {
    expect(haversineKm(41.39, 2.17, 41.39, 2.17)).toBe(0);
  });

  it('computes Barcelona-to-Girona distance (~100km)', () => {
    const d = haversineKm(41.3874, 2.1686, 41.9794, 2.8214);
    expect(d).toBeGreaterThan(85);
    expect(d).toBeLessThan(105);
  });

  it('computes Barcelona-to-Lleida distance (~150km)', () => {
    const d = haversineKm(41.3874, 2.1686, 41.6176, 0.6200);
    expect(d).toBeGreaterThan(125);
    expect(d).toBeLessThan(160);
  });
});

describe('computeCentroid', () => {
  it('computes centroid of a simple square Polygon', () => {
    const poly: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]],
    };
    const [lon, lat] = computeCentroid(poly);
    expect(lon).toBeCloseTo(0.8, 0); // Average of 0,2,2,0,0 = 4/5 = 0.8
    expect(lat).toBeCloseTo(0.8, 0);
  });

  it('computes centroid of a MultiPolygon', () => {
    const multi: GeoJSON.MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [
        [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
        [[[2, 2], [3, 2], [3, 3], [2, 3], [2, 2]]],
      ],
    };
    const [lon, lat] = computeCentroid(multi);
    // Average of all 10 coords (5 per polygon)
    expect(lon).toBeCloseTo(1.5, 0);
    expect(lat).toBeCloseTo(1.5, 0);
  });

  it('returns [0,0] for empty geometry', () => {
    const poly: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[]] };
    const [lon, lat] = computeCentroid(poly);
    expect(lon).toBe(0);
    expect(lat).toBe(0);
  });
});

describe('nearestDistanceKm', () => {
  it('returns Infinity for empty point set', () => {
    expect(nearestDistanceKm(41.39, 2.17, [])).toBe(Infinity);
  });

  it('finds nearest point from a set', () => {
    const points = [
      { lat: 42.0, lon: 2.8 },  // ~80km away (Girona area)
      { lat: 41.4, lon: 2.2 },  // ~4km away (near Barcelona)
      { lat: 41.6, lon: 0.6 },  // ~130km away (Lleida area)
    ];
    const d = nearestDistanceKm(41.39, 2.17, points);
    expect(d).toBeLessThan(5);
  });
});

describe('computeDistanceMap', () => {
  it('returns empty map for empty points', () => {
    const centroids = { '08019': [2.17, 41.39] as [number, number] };
    expect(computeDistanceMap(centroids, [])).toEqual({});
  });

  it('computes distances for all centroids', () => {
    const centroids: Record<string, [number, number]> = {
      '08019': [2.17, 41.39],    // Barcelona-ish
      '17079': [2.82, 41.98],    // Girona-ish
    };
    const points = [{ lat: 41.4, lon: 2.2 }]; // Near Barcelona
    const result = computeDistanceMap(centroids, points);

    expect(Object.keys(result)).toHaveLength(2);
    expect(result['08019']).toBeLessThan(5);     // Very close
    expect(result['17079']).toBeGreaterThan(60);  // Far from Girona
  });
});

describe('idwInterpolate', () => {
  it('returns empty for no stations', () => {
    const centroids = { '08019': [2.17, 41.39] as [number, number] };
    expect(idwInterpolate(centroids, [])).toEqual({});
  });

  it('returns exact station value when centroid is at station', () => {
    const centroids = { '08019': [2.17, 41.39] as [number, number] };
    const stations = [
      { lat: 41.39, lon: 2.17, values: { temp: 15, rain: 50 } },
      { lat: 42.0, lon: 2.8, values: { temp: 10, rain: 80 } },
    ];
    const result = idwInterpolate(centroids, stations, 2, 2);
    expect(result['08019'].temp).toBe(15);
    expect(result['08019'].rain).toBe(50);
  });

  it('interpolates between stations by inverse distance', () => {
    const centroids = { mid: [1.5, 41.5] as [number, number] };
    const stations = [
      { lat: 41.0, lon: 1.0, values: { temp: 10 } },
      { lat: 42.0, lon: 2.0, values: { temp: 20 } },
    ];
    const result = idwInterpolate(centroids, stations, 2, 2);
    // Midpoint should be close to 15 (equal weight from both)
    expect(result['mid'].temp).toBeGreaterThan(13);
    expect(result['mid'].temp).toBeLessThan(17);
  });
});
