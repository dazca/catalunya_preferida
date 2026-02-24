/**
 * @file Utility functions for fetching data from the Socrata SODA API
 *       (analisi.transparenciacatalunya.cat) and ICGC/IDESCAT services.
 */

const SOCRATA_BASE = 'https://analisi.transparenciacatalunya.cat/resource';

/**
 * Fetch paginated data from a Socrata dataset.
 * @param datasetId - The 4-4 dataset identifier (e.g., "vq27-2ky2")
 * @param params - SoQL query parameters ($where, $select, $limit, etc.)
 * @param maxRecords - Maximum total records to fetch (default 50000)
 */
export async function fetchSocrataDataset<T = Record<string, unknown>>(
  datasetId: string,
  params: Record<string, string> = {},
  maxRecords = 50000,
): Promise<T[]> {
  const pageSize = 10000;
  const allRecords: T[] = [];
  let offset = 0;

  while (offset < maxRecords) {
    const queryParams = new URLSearchParams({
      ...params,
      $limit: String(pageSize),
      $offset: String(offset),
    });

    const url = `${SOCRATA_BASE}/${datasetId}.json?${queryParams}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Socrata API error ${response.status}: ${response.statusText} for ${datasetId}`);
    }

    const page = (await response.json()) as T[];
    allRecords.push(...page);

    if (page.length < pageSize) break;
    offset += pageSize;
  }

  return allRecords;
}

/**
 * Fetch GeoJSON from an ICGC WFS service.
 * @param typeName - WFS layer name (e.g., "divisions_administratives_municipis_5000")
 * @param serviceUrl - Base WFS URL
 */
export async function fetchIcgcWfs(
  typeName: string,
  serviceUrl = 'https://geoserveis.icgc.cat/servei/catalunya/divisions-administratives/wfs',
): Promise<GeoJSON.FeatureCollection> {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeName,
    outputFormat: 'application/json',
    srsName: 'EPSG:4326',
  });

  const url = `${serviceUrl}?${params}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`ICGC WFS error ${response.status}: ${response.statusText}`);
  }

  return response.json() as Promise<GeoJSON.FeatureCollection>;
}

/**
 * Fetch data from the IDESCAT EMEX API for a municipality.
 * @param municipalityCode - IDESCAT municipal code (6 digits)
 */
export async function fetchIdescat(municipalityCode: string): Promise<Record<string, unknown>> {
  const url = `https://api.idescat.cat/emex/v1.json?id=${municipalityCode}&lang=en`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`IDESCAT API error ${response.status}`);
  }

  return response.json() as Promise<Record<string, unknown>>;
}
