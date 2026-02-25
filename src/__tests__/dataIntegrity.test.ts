import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INTEGRITY_RULES,
  runDataIntegrityChecks,
  type DataIntegrityInput,
} from '../utils/dataIntegrity';
import type { MunicipalityCollection } from '../types';
import type { MunicipalityData } from '../utils/scorer';

const municipalities: MunicipalityCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { codi: '08001', nom: 'A', comarca: 'X' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[1, 1], [1.1, 1], [1.1, 1.1], [1, 1.1], [1, 1]]],
      },
    },
    {
      type: 'Feature',
      properties: { codi: '08002', nom: 'B', comarca: 'X' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[2, 2], [2.1, 2], [2.1, 2.1], [2, 2.1], [2, 2]]],
      },
    },
  ],
};

function baseData(): MunicipalityData {
  return {
    terrain: {
      '08001': { codi: '08001', avgSlopeDeg: 10, dominantAspect: 'N', avgElevationM: 200 },
      '08002': { codi: '08002', avgSlopeDeg: 12, dominantAspect: 'S', avgElevationM: 220 },
    },
    votes: {
      '08001': { codi: '08001', nom: 'A', leftPct: 55, rightPct: 45, independencePct: 60, unionistPct: 40, turnoutPct: 65, year: 2023 },
      '08002': { codi: '08002', nom: 'B', leftPct: 45, rightPct: 55, independencePct: 35, unionistPct: 65, turnoutPct: 60, year: 2023 },
    },
    forest: {
      '08001': { codi: '08001', forestPct: 30, agriculturalPct: 50, urbanPct: 20 },
      '08002': { codi: '08002', forestPct: 32, agriculturalPct: 48, urbanPct: 20 },
    },
    crime: {
      '08001': { codi: '08001', nom: 'A', totalOffenses: 200, ratePerThousand: 20, year: 2023 },
      '08002': { codi: '08002', nom: 'B', totalOffenses: 170, ratePerThousand: 17, year: 2023 },
    },
    rentalPrices: {
      '08001': { codi: '08001', nom: 'A', avgEurMonth: 950, eurPerSqm: 12, year: 2024, quarter: 4 },
      '08002': { codi: '08002', nom: 'B', avgEurMonth: 870, eurPerSqm: 10, year: 2024, quarter: 4 },
    },
    employment: {
      '08001': { codi: '08001', nom: 'A', population: 10000, unemploymentPct: 9, avgIncome: 26000 },
      '08002': { codi: '08002', nom: 'B', population: 8000, unemploymentPct: 8, avgIncome: 24000 },
    },
    climate: {
      '08001': { codi: '08001', avgTempC: 15, avgRainfallMm: 600, avgWindKmh: 0 },
      '08002': { codi: '08002', avgTempC: 16, avgRainfallMm: 580, avgWindKmh: 0 },
    },
    airQuality: {
      '08001': { codi: '08001', stationId: 's1', stationName: 'A', lat: 41, lon: 2, pm10: 19, no2: 15 },
      '08002': { codi: '08002', stationId: 's2', stationName: 'B', lat: 42, lon: 2.2, pm10: 22, no2: 16 },
    },
    internet: {
      '08001': { codi: '08001', fiberPct: 81, adslPct: 15, coverageScore: 0.8 },
      '08002': { codi: '08002', fiberPct: 75, adslPct: 20, coverageScore: 0.74 },
    },
    transitDistKm: { '08001': 2, '08002': 3 },
    healthcareDistKm: { '08001': 1.5, '08002': 2.1 },
    schoolDistKm: { '08001': 1.2, '08002': 2.4 },
    amenityDistKm: { '08001': 0.6, '08002': 0.9 },
  };
}

function inputWithData(data: MunicipalityData): DataIntegrityInput {
  return {
    municipalities,
    municipalityData: data,
    transitStops: { type: 'FeatureCollection', features: [] },
    healthFacilities: { type: 'FeatureCollection', features: [] },
    schools: { type: 'FeatureCollection', features: [] },
    amenities: { type: 'FeatureCollection', features: [] },
  };
}

describe('runDataIntegrityChecks', () => {
  it('returns structured report with severity counts', () => {
    const report = runDataIntegrityChecks(inputWithData(baseData()), DEFAULT_INTEGRITY_RULES);
    expect(report.generatedAt).toBeTruthy();
    expect(report.totalIssues).toBeGreaterThanOrEqual(0);
    expect(report.bySeverity.error + report.bySeverity.warning + report.bySeverity.info).toBe(report.totalIssues);
  });

  it('flags blank leftsentiment values in votes', () => {
    const data = baseData();
    data.votes['08002'] = {
      ...data.votes['08002'],
      leftPct: Number.NaN,
    };

    const report = runDataIntegrityChecks(inputWithData(data), {
      ...DEFAULT_INTEGRITY_RULES,
      maxBlankPctPerLayer: 0,
    });

    const votesReport = report.layers.find((l) => l.layer === 'votes');
    expect(votesReport).toBeDefined();
    const issue = votesReport?.issues.find((i) => i.code === 'leftsentiment.blank');
    expect(issue).toBeDefined();
    expect(issue?.affectedCount).toBeGreaterThan(0);
  });

  it('flags impossible range values', () => {
    const data = baseData();
    data.airQuality['08002'] = {
      ...data.airQuality['08002'],
      pm10: -5,
    };

    const report = runDataIntegrityChecks(inputWithData(data), DEFAULT_INTEGRITY_RULES);
    const aq = report.layers.find((l) => l.layer === 'airQuality');
    const rangeIssue = aq?.issues.find((i) => i.code === 'pm10.range');
    expect(rangeIssue).toBeDefined();
    expect(rangeIssue?.severity).toBe('error');
  });
});
