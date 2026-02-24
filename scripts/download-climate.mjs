/**
 * @file Download climate data from METEOCAT stations (Socrata).
 *       - Station metadata: yqwd-vj5e
 *       - Variable metadata: 4fb2-n3yi
 *       - Readings: nzvn-apee (fetching annual averages)
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RESOURCES = join(__dirname, '..', 'resources');

const SOCRATA_BASE = 'https://analisi.transparenciacatalunya.cat/resource';

async function fetchSocrata(datasetId, params = {}) {
  const queryParams = new URLSearchParams({ ...params, $limit: '50000' });
  const url = `${SOCRATA_BASE}/${datasetId}.json?${queryParams}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Socrata ${response.status}`);
  return response.json();
}

async function main() {
  const outDir = join(RESOURCES, 'climate');
  mkdirSync(outDir, { recursive: true });

  console.log('[Climate] Downloading METEOCAT station data...');

  try {
    // Fetch station metadata
    const stations = await fetchSocrata('yqwd-vj5e');
    console.log(`  Got ${stations.length} station records`);

    const stationGeojson = {
      type: 'FeatureCollection',
      features: stations
        .filter(s => s.latitud && s.longitud)
        .map(s => ({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [parseFloat(s.longitud), parseFloat(s.latitud)],
          },
          properties: {
            id: s.codi_estacio || s.codi || '',
            name: s.nom_estacio || s.nom || '',
            municipality: s.nom_municipi || '',
            altitude: parseFloat(s.altitud || '0'),
          },
        })),
    };

    writeFileSync(join(outDir, 'stations.geojson'), JSON.stringify(stationGeojson));
    console.log(`  Saved ${stationGeojson.features.length} climate stations`);

    // Fetch recent temperature & precipitation readings (raw, no aggregation)
    console.log('  Fetching recent climate readings...');

    // Try to get temp readings (variable 32) - limit to keep it manageable
    let climateRecords = [];
    try {
      climateRecords = await fetchSocrata('nzvn-apee', {
        $where: "data_lectura >= '2025-01-01' AND codi_variable in('32','35')",
        $select: 'codi_estacio,codi_variable,valor_lectura',
      });
    } catch {
      console.log('  Readings query failed, trying simpler query...');
      try {
        climateRecords = await fetchSocrata('nzvn-apee', {
          $where: "data_lectura >= '2025-06-01'",
          $select: 'codi_estacio,codi_variable,valor_lectura',
        });
      } catch (e2) {
        console.log('  Readings fetch failed entirely:', e2.message);
      }
    }

    console.log(`  Got ${climateRecords.length} climate reading records`);

    // Average client-side
    const byStation = {};
    for (const record of climateRecords) {
      const stationId = record.codi_estacio;
      if (!stationId) continue;

      if (!byStation[stationId]) {
        byStation[stationId] = { id: stationId, tempSum: 0, tempN: 0, precipSum: 0, precipN: 0 };
      }

      const variable = String(record.codi_variable);
      const value = parseFloat(record.valor_lectura || '0');
      if (isNaN(value)) continue;

      if (variable === '32') { byStation[stationId].tempSum += value; byStation[stationId].tempN++; }
      else if (variable === '35') { byStation[stationId].precipSum += value; byStation[stationId].precipN++; }
    }

    const stationClimateData = Object.values(byStation)
      .filter(s => s.tempN > 0)
      .map(s => ({
        id: s.id,
        avgTemp: Math.round((s.tempSum / s.tempN) * 10) / 10,
        avgPrecip: s.precipN > 0 ? Math.round((s.precipSum / s.precipN) * 10) / 10 : null,
      }));
    writeFileSync(join(outDir, 'station_climate.json'), JSON.stringify(stationClimateData, null, 2));
    console.log(`  Saved climate averages for ${stationClimateData.length} stations`);

    // Create a placeholder municipality_climate.json
    // To properly fill this, we'd need to do nearest-station interpolation per municipality
    writeFileSync(join(outDir, 'municipality_climate.json'), '[]');
  } catch (err) {
    console.error('  Failed:', err.message);
    writeFileSync(join(outDir, 'stations.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [] }));
    writeFileSync(join(outDir, 'municipality_climate.json'), '[]');
  }

  console.log('Done: climate.\n');
}

main().catch(console.error);
