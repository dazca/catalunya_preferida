/**
 * @file Download air quality station data from the Socrata transparency portal.
 *       Dataset tasf-thgu: hourly readings from XVPCA stations.
 *       Fields: codi_eoi, nom_estacio, data, contaminant, h01..h24, latitud, longitud, codi_ine, municipi
 *       We fetch recent readings, average across hours/days, group by station + contaminant.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RESOURCES = join(__dirname, '..', 'resources');

const SOCRATA_BASE = 'https://analisi.transparenciacatalunya.cat/resource';

async function fetchSocrata(datasetId, params = {}) {
  const queryParams = new URLSearchParams({ ...params });
  const url = `${SOCRATA_BASE}/${datasetId}.json?${queryParams}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Socrata ${response.status}: ${await response.text().catch(() => '')}`);
  return response.json();
}

async function main() {
  const outDir = join(RESOURCES, 'air');
  mkdirSync(outDir, { recursive: true });

  console.log('[Air Quality] Downloading recent readings...');

  try {
    // Fetch recent data - get key contaminants: NO2, PM10, PM2.5, O3
    const target = ['NO2', 'PM10', 'PM2.5', 'O3'];
    const whereClause = `contaminant in('${target.join("','")}') AND data >= '2025-01-01'`;

    const data = await fetchSocrata('tasf-thgu', {
      $limit: '50000',
      $select: 'codi_eoi,nom_estacio,contaminant,latitud,longitud,codi_ine,municipi,h01,h02,h03,h04,h05,h06,h07,h08,h09,h10,h11,h12,h13,h14,h15,h16,h17,h18,h19,h20,h21,h22,h23,h24',
      $where: whereClause,
    });

    console.log(`  Got ${data.length} records`);

    // Average hourly values per record, then average across records per station+contaminant
    const stationMap = {};

    for (const record of data) {
      const id = record.codi_eoi;
      if (!id) continue;

      // Compute daily average from h01..h24
      const hours = [];
      for (let i = 1; i <= 24; i++) {
        const key = `h${String(i).padStart(2, '0')}`;
        const val = parseFloat(record[key]);
        if (!isNaN(val)) hours.push(val);
      }
      if (hours.length === 0) continue;
      const dayAvg = hours.reduce((a, b) => a + b, 0) / hours.length;

      if (!stationMap[id]) {
        stationMap[id] = {
          codi: record.codi_ine || id,
          stationId: id,
          stationName: record.nom_estacio || '',
          lat: parseFloat(record.latitud || '0'),
          lon: parseFloat(record.longitud || '0'),
          municipi: record.municipi || '',
          readings: {},
        };
      }

      const contam = record.contaminant;
      if (!stationMap[id].readings[contam]) {
        stationMap[id].readings[contam] = { sum: 0, count: 0 };
      }
      stationMap[id].readings[contam].sum += dayAvg;
      stationMap[id].readings[contam].count += 1;
    }

    // Build final station objects
    const stationsArr = Object.values(stationMap)
      .filter(s => s.lat !== 0 && s.lon !== 0)
      .map(s => {
        const r = s.readings;
        const avg = (c) => r[c] ? Math.round((r[c].sum / r[c].count) * 10) / 10 : undefined;
        return {
          codi: s.codi,
          stationId: s.stationId,
          stationName: s.stationName,
          lat: s.lat,
          lon: s.lon,
          municipi: s.municipi,
          no2: avg('NO2'),
          pm10: avg('PM10'),
          pm25: avg('PM2.5'),
          o3: avg('O3'),
        };
      });

    writeFileSync(join(outDir, 'stations.json'), JSON.stringify(stationsArr, null, 2));
    console.log(`  Saved ${stationsArr.length} air quality stations`);

    const geojson = {
      type: 'FeatureCollection',
      features: stationsArr.map(s => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
        properties: s,
      })),
    };
    writeFileSync(join(outDir, 'stations.geojson'), JSON.stringify(geojson));
  } catch (err) {
    console.error('  Failed:', err.message);
    writeFileSync(join(outDir, 'stations.json'), '[]');
  }

  console.log('Done: air quality.\n');
}

main().catch(console.error);
