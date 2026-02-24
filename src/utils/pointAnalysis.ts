/**
 * @file Point-based analysis: compute the score at an arbitrary lat/lon
 *       coordinate on the map. Distance layers use actual distances from the
 *       point; municipality-level data comes from the containing municipality;
 *       climate is IDW-interpolated directly from stations.
 */
import type { LayerId, LayerMeta, MunicipalityCollection } from '../types';
import type { LayerConfigs } from '../types/transferFunction';
import type { MunicipalityData } from './scorer';
import { scoreSingleTf, combineSubScores, normalizeIne } from './scorer';
import { scoreAspect } from './transferFunction';
import {
  nearestDistanceKm,
  pointInPolygon,
  idwInterpolatePoint,
} from './spatial';
import { getSlopeAt, getElevationAt, getAspectAt } from './demSlope';
import type { PointLocation, StationValue } from './spatial';

/** Facility point arrays grouped by category. */
export interface FacilityPoints {
  transit: PointLocation[];
  health: PointLocation[];
  schools: PointLocation[];
  amenities: PointLocation[];
}

/** Result of scoring an arbitrary point on the map. */
export interface PointScoreResult {
  lat: number;
  lon: number;
  /** Municipality containing the point, or null if outside Catalonia. */
  municipality: { codi: string; nom: string } | null;
  /** Composite score 0-1. */
  score: number;
  /** Per-layer scores. */
  layerScores: Partial<Record<LayerId, number>>;
  /** Whether the point is disqualified by mandatory layers. */
  disqualified: boolean;
  /** Raw values used for each metric (for display). */
  rawValues: Record<string, number>;
}

/**
 * Find which municipality contains a given point.
 *
 * @param lon - Longitude
 * @param lat - Latitude
 * @param municipalities - GeoJSON FeatureCollection of municipalities
 * @returns Municipality codi + name, or null if not found
 */
function findMunicipality(
  lon: number,
  lat: number,
  municipalities: MunicipalityCollection,
): { codi: string; nom: string } | null {
  for (const f of municipalities.features) {
    if (pointInPolygon(lon, lat, f.geometry)) {
      return {
        codi: normalizeIne(f.properties.codi),
        nom: f.properties.nom,
      };
    }
  }
  return null;
}

/**
 * Score a single layer for a point-based analysis.
 * Distance layers use the actual point; municipality-level data uses
 * the containing municipality's codi.
 */
function scorePointLayer(
  layerId: LayerId,
  codi: string,
  configs: LayerConfigs,
  data: MunicipalityData,
  rawValues: Record<string, number>,
  distances: { transit: number; health: number; school: number; amenity: number },
  climateVals: Record<string, number>,
  pointLon?: number,
  pointLat?: number,
): { score: number; disqualified: boolean } | undefined {
  switch (layerId) {
    case 'terrain': {
      // Prefer real DEM values at the exact point; fall back to municipal average
      const realSlope   = (pointLon != null && pointLat != null) ? getSlopeAt(pointLon, pointLat)    : null;
      const realElev    = (pointLon != null && pointLat != null) ? getElevationAt(pointLon, pointLat) : null;
      const realAspect  = (pointLon != null && pointLat != null) ? getAspectAt(pointLon, pointLat)   : null;

      const t = codi ? data.terrain[normalizeIne(codi)] : undefined;
      const slopeDeg   = realSlope   ?? t?.avgSlopeDeg;
      const elevationM = realElev    ?? t?.avgElevationM;
      const aspect     = realAspect  ?? t?.dominantAspect ?? 'N';

      if (slopeDeg == null || elevationM == null) return undefined;

      rawValues.slopeDeg   = slopeDeg;
      rawValues.elevationM = elevationM;
      const slope = scoreSingleTf(slopeDeg, configs.terrain.slope);
      const elev  = scoreSingleTf(elevationM, configs.terrain.elevation);
      const aspectRes = {
        score: scoreAspect(aspect, configs.terrain.aspect),
        weight: 1,
        disqualified: false,
      };
      return combineSubScores([slope, elev, aspectRes]);
    }

    case 'votes': {
      const v = codi ? data.votes[codi] : undefined;
      if (!v) return undefined;
      const terms = configs.votes.terms;
      if (!terms || terms.length === 0) return undefined;
      const subs = terms.map((term) => {
        const raw = v[term.metric] as number | undefined;
        if (raw !== undefined) rawValues[`vote_${term.metric}`] = raw;
        return scoreSingleTf(raw, term.value);
      });
      return combineSubScores(subs);
    }

    case 'transit':
      rawValues.transitDistKm = distances.transit;
      return combineSubScores([scoreSingleTf(distances.transit, configs.transit)]);

    case 'forest': {
      const f = codi ? data.forest[codi] : undefined;
      if (f) rawValues.forestPct = f.forestPct;
      return combineSubScores([scoreSingleTf(f?.forestPct, configs.forest)]);
    }

    case 'soil':
      return { score: 0.5, disqualified: false };

    case 'airQuality': {
      const a = codi ? data.airQuality[codi] : undefined;
      if (!a) return undefined;
      if (a.pm10 !== undefined) rawValues.pm10 = a.pm10;
      if (a.no2 !== undefined) rawValues.no2 = a.no2;
      return combineSubScores([
        scoreSingleTf(a.pm10, configs.airQuality.pm10),
        scoreSingleTf(a.no2, configs.airQuality.no2),
      ]);
    }

    case 'crime': {
      const c = codi ? data.crime[codi] : undefined;
      if (c) rawValues.crimeRate = c.ratePerThousand;
      return combineSubScores([
        scoreSingleTf(c?.ratePerThousand, configs.crime),
      ]);
    }

    case 'healthcare':
      rawValues.healthcareDistKm = distances.health;
      return combineSubScores([scoreSingleTf(distances.health, configs.healthcare)]);

    case 'schools':
      rawValues.schoolDistKm = distances.school;
      return combineSubScores([scoreSingleTf(distances.school, configs.schools)]);

    case 'internet': {
      const i = codi ? data.internet[codi] : undefined;
      if (i) rawValues.fiberPct = i.fiberPct;
      return combineSubScores([scoreSingleTf(i?.fiberPct, configs.internet)]);
    }

    case 'noise':
      return { score: 0.5, disqualified: false };

    case 'climate': {
      const temp = climateVals.avgTempC;
      const rain = climateVals.avgRainfallMm;
      if (temp !== undefined) rawValues.avgTempC = temp;
      if (rain !== undefined) rawValues.avgRainfallMm = rain;
      return combineSubScores([
        scoreSingleTf(temp, configs.climate.temperature),
        scoreSingleTf(rain, configs.climate.rainfall),
      ]);
    }

    case 'rentalPrices': {
      const r = codi ? data.rentalPrices[codi] : undefined;
      if (r) rawValues.avgRent = r.avgEurMonth;
      return combineSubScores([
        scoreSingleTf(r?.avgEurMonth, configs.rentalPrices),
      ]);
    }

    case 'employment': {
      const e = codi ? data.employment[codi] : undefined;
      if (e) rawValues.unemploymentPct = e.unemploymentPct;
      return combineSubScores([
        scoreSingleTf(e?.unemploymentPct, configs.employment),
      ]);
    }

    case 'amenities':
      rawValues.amenityDistKm = distances.amenity;
      return combineSubScores([scoreSingleTf(distances.amenity, configs.amenities)]);

    default:
      return undefined;
  }
}

/**
 * Compute the score at an arbitrary geographic point.
 * Distance layers are computed from the actual point to the nearest facility.
 * Municipality-level data is looked up from the containing municipality.
 * Climate is IDW-interpolated from station data.
 *
 * @param lat - Latitude of the query point
 * @param lon - Longitude of the query point
 * @param enabledLayers - Array of enabled layer metadata (with weights)
 * @param configs - Transfer function configs
 * @param municipalities - Municipality GeoJSON for point-in-polygon lookup
 * @param data - All loaded municipality data
 * @param facilityPoints - Facility point arrays for distance computation
 * @param climateStations - Climate station values for IDW interpolation
 * @returns Point score result with per-layer breakdown
 */
export function computePointScore(
  lat: number,
  lon: number,
  enabledLayers: LayerMeta[],
  configs: LayerConfigs,
  municipalities: MunicipalityCollection,
  data: MunicipalityData,
  facilityPoints: FacilityPoints,
  climateStations: StationValue[],
): PointScoreResult {
  // 1. Find which municipality this point falls in
  const muni = findMunicipality(lon, lat, municipalities);
  const codi = muni?.codi ?? '';

  // 2. Compute actual distances from the point to facilities
  const distances = {
    transit: nearestDistanceKm(lat, lon, facilityPoints.transit),
    health: nearestDistanceKm(lat, lon, facilityPoints.health),
    school: nearestDistanceKm(lat, lon, facilityPoints.schools),
    amenity: nearestDistanceKm(lat, lon, facilityPoints.amenities),
  };

  // 3. Interpolate climate directly to this point
  const climateVals = idwInterpolatePoint(lat, lon, climateStations);

  // 4. Score each enabled layer
  const rawValues: Record<string, number> = {
    transitDistKm: distances.transit,
    healthcareDistKm: distances.health,
    schoolDistKm: distances.school,
    amenityDistKm: distances.amenity,
  };

  const layerScores: Partial<Record<LayerId, number>> = {};
  let weightedSum = 0;
  let totalWeight = 0;
  let disqualified = false;

  for (const layer of enabledLayers) {
    const result = scorePointLayer(
      layer.id,
      codi,
      configs,
      data,
      rawValues,
      distances,
      climateVals,
      lon,
      lat,
    );
    if (!result) continue;
    if (result.disqualified) disqualified = true;
    layerScores[layer.id] = result.score;
    weightedSum += result.score * layer.weight;
    totalWeight += layer.weight;
  }

  const score = disqualified
    ? 0
    : totalWeight > 0
      ? weightedSum / totalWeight
      : 0;

  return { lat, lon, municipality: muni, score, layerScores, disqualified, rawValues };
}
