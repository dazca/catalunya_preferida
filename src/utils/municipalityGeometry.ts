/**
 * @file Municipality geometry normalization helpers.
 * Ensures polygon rings are closed and winding is consistent so
 * MapLibre fill triangulation is stable for multipart municipalities.
 */
import type { MunicipalityCollection, MunicipalityFeature } from '../types';

type Position = [number, number];

type PolygonCoords = Position[][];

function isFinitePos(p: unknown): p is Position {
  return Array.isArray(p)
    && p.length >= 2
    && Number.isFinite(p[0])
    && Number.isFinite(p[1]);
}

function samePos(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function signedArea(ring: Position[]): number {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

function normalizeRing(rawRing: unknown): Position[] | null {
  if (!Array.isArray(rawRing)) return null;

  const points: Position[] = [];
  for (const raw of rawRing) {
    if (!isFinitePos(raw)) continue;
    const p: Position = [raw[0], raw[1]];
    if (points.length === 0 || !samePos(points[points.length - 1], p)) {
      points.push(p);
    }
  }

  if (points.length < 3) return null;

  if (!samePos(points[0], points[points.length - 1])) {
    points.push([points[0][0], points[0][1]]);
  }

  if (points.length < 4) return null;

  const area = signedArea(points);
  if (!Number.isFinite(area) || Math.abs(area) < 1e-14) return null;

  return points;
}

function orientRing(ring: Position[], clockwise: boolean): Position[] {
  const out = [...ring];
  const isClockwise = signedArea(out) < 0;
  if (isClockwise !== clockwise) out.reverse();
  return out;
}

function normalizePolygon(rawPolygon: unknown): PolygonCoords[] {
  if (!Array.isArray(rawPolygon) || rawPolygon.length === 0) return [];

  const rawOuter = normalizeRing(rawPolygon[0]);
  if (!rawOuter) return [];
  const outerSign = Math.sign(signedArea(rawOuter));

  const shells: Position[][] = [orientRing(rawOuter, false)];
  const holesByShell: Position[][][] = [[]];

  for (let i = 1; i < rawPolygon.length; i++) {
    const ring = normalizeRing(rawPolygon[i]);
    if (!ring) continue;
    const sign = Math.sign(signedArea(ring));
    if (sign === outerSign) {
      shells.push(orientRing(ring, false));
      holesByShell.push([]);
      continue;
    }
    holesByShell[0].push(orientRing(ring, true));
  }

  return shells.map((shell, idx) => [shell, ...holesByShell[idx]]);
}

function normalizeFeatureGeometry(feature: MunicipalityFeature): MunicipalityFeature[] {
  const g = feature.geometry;
  if (!g) return [feature];

  if (g.type === 'Polygon') {
    const polygons = normalizePolygon(g.coordinates);
    if (polygons.length === 0) return [feature];
    return polygons.map((coords) => ({
      ...feature,
      geometry: {
        ...g,
        type: 'Polygon',
        coordinates: coords,
      },
    }));
  }

  if (g.type === 'MultiPolygon') {
    const parts: MunicipalityFeature[] = [];
    for (const rawPoly of g.coordinates) {
      const polygons = normalizePolygon(rawPoly);
      for (const poly of polygons) {
        parts.push({
          ...feature,
          geometry: {
            ...g,
            type: 'Polygon',
            coordinates: poly,
          },
        });
      }
    }
    if (parts.length > 0) return parts;
    return [feature];
  }

  return [feature];
}

export function normalizeMunicipalityGeometries(
  municipalities: MunicipalityCollection | null,
): MunicipalityCollection | null {
  if (!municipalities) return null;
  return {
    ...municipalities,
    features: municipalities.features.flatMap((f) => normalizeFeatureGeometry(f)),
  };
}
