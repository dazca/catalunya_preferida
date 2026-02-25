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
import { scoreAspect, scoreAspectAngle } from './transferFunction';
import {
  nearestDistanceKm,
  pointInPolygon,
  idwInterpolatePoint,
} from './spatial';
import { getSlopeAt, getElevationAt, getAspectAt, getAspectAngleAt } from './demSlope';
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
  // ── Helpers for point-level terrain lookups ──────────────────────
  const getTerrainVals = () => {
    const realSlope   = (pointLon != null && pointLat != null) ? getSlopeAt(pointLon, pointLat)    : null;
    const realElev    = (pointLon != null && pointLat != null) ? getElevationAt(pointLon, pointLat) : null;
    const realAspect  = (pointLon != null && pointLat != null) ? getAspectAt(pointLon, pointLat)   : null;
    const realAngle   = (pointLon != null && pointLat != null) ? getAspectAngleAt(pointLon, pointLat) : null;
    const t = codi ? data.terrain[normalizeIne(codi)] : undefined;
    return {
      slopeDeg:    realSlope   ?? t?.avgSlopeDeg,
      elevationM:  realElev    ?? t?.avgElevationM,
      aspect:      realAspect  ?? t?.dominantAspect ?? 'N',
      aspectAngle: realAngle,  // numeric degrees or -1 (flat) or null
    };
  };

  switch (layerId) {
    case 'terrainSlope': {
      const { slopeDeg } = getTerrainVals();
      if (slopeDeg == null) return undefined;
      rawValues.slopeDeg = slopeDeg;
      return combineSubScores([scoreSingleTf(slopeDeg, configs.terrain.slope)]);
    }
    case 'terrainElevation': {
      const { elevationM } = getTerrainVals();
      if (elevationM == null) return undefined;
      rawValues.elevationM = elevationM;
      return combineSubScores([scoreSingleTf(elevationM, configs.terrain.elevation)]);
    }
    case 'terrainAspect': {
      const { aspect, aspectAngle } = getTerrainVals();
      const aw = configs.terrain.aspectWeight ?? 1;
      // Prefer numeric angle for smooth interpolation (matches heatmap)
      const rawScore = aspectAngle != null
        ? scoreAspectAngle(aspectAngle, configs.terrain.aspect)
        : scoreAspect(aspect, configs.terrain.aspect);
      return { score: 0.5 + (rawScore - 0.5) * aw, disqualified: false };
    }

    case 'votesLeft': {
      const v = codi ? data.votes[codi] : undefined;
      if (!v) return undefined;
      const term = configs.votes.terms.find((t) => t.metric === 'leftPct');
      if (!term) return undefined;
      rawValues.vote_leftPct = v.leftPct;
      return combineSubScores([scoreSingleTf(v.leftPct, term.value)]);
    }
    case 'votesRight': {
      const v = codi ? data.votes[codi] : undefined;
      if (!v) return undefined;
      const term = configs.votes.terms.find((t) => t.metric === 'rightPct');
      if (!term) return undefined;
      rawValues.vote_rightPct = v.rightPct;
      return combineSubScores([scoreSingleTf(v.rightPct, term.value)]);
    }
    case 'votesIndep': {
      const v = codi ? data.votes[codi] : undefined;
      if (!v) return undefined;
      const term = configs.votes.terms.find((t) => t.metric === 'independencePct');
      if (!term) return undefined;
      rawValues.vote_independencePct = v.independencePct;
      return combineSubScores([scoreSingleTf(v.independencePct, term.value)]);
    }
    case 'votesUnionist': {
      const v = codi ? data.votes[codi] : undefined;
      if (!v) return undefined;
      const term = configs.votes.terms.find((t) => t.metric === 'unionistPct');
      if (!term) return undefined;
      rawValues.vote_unionistPct = v.unionistPct;
      return combineSubScores([scoreSingleTf(v.unionistPct, term.value)]);
    }
    case 'votesTurnout': {
      const v = codi ? data.votes[codi] : undefined;
      if (!v) return undefined;
      const term = configs.votes.terms.find((t) => t.metric === 'turnoutPct');
      if (!term) return undefined;
      rawValues.vote_turnoutPct = v.turnoutPct;
      return combineSubScores([scoreSingleTf(v.turnoutPct, term.value)]);
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

    case 'airQualityPm10': {
      const a = codi ? data.airQuality[codi] : undefined;
      if (!a) return undefined;
      if (a.pm10 !== undefined) rawValues.pm10 = a.pm10;
      return combineSubScores([scoreSingleTf(a.pm10, configs.airQuality.pm10)]);
    }
    case 'airQualityNo2': {
      const a = codi ? data.airQuality[codi] : undefined;
      if (!a) return undefined;
      if (a.no2 !== undefined) rawValues.no2 = a.no2;
      return combineSubScores([scoreSingleTf(a.no2, configs.airQuality.no2)]);
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

    case 'climateTemp': {
      const temp = climateVals.avgTempC;
      if (temp !== undefined) rawValues.avgTempC = temp;
      return combineSubScores([scoreSingleTf(temp, configs.climate.temperature)]);
    }
    case 'climateRainfall': {
      const rain = climateVals.avgRainfallMm;
      if (rain !== undefined) rawValues.avgRainfallMm = rain;
      return combineSubScores([scoreSingleTf(rain, configs.climate.rainfall)]);
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
