/**
 * @file Download transit station data from multiple sources:
 *       - FGC stations from GTFS zip (www.fgc.cat/google/google_transit.zip)
 *       - Rodalies / railway stations from Renfe GTFS or Socrata fallback
 *       Merges into a unified GeoJSON file.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RESOURCES = join(__dirname, '..', 'resources');

function toGeoJSONFeature(name, lat, lon, system, line) {
  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [parseFloat(lon), parseFloat(lat)],
    },
    properties: { name, system, line: line || '', lat: parseFloat(lat), lon: parseFloat(lon) },
  };
}

/** Parse a simple CSV (no quoted commas) into array of objects. */
function parseCsv(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  return lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim().replace(/"/g, ''));
    const obj = {};
    headers.forEach((h, i) => { obj[h] = values[i] || ''; });
    return obj;
  });
}

async function main() {
  const outDir = join(RESOURCES, 'transit');
  mkdirSync(outDir, { recursive: true });

  const features = [];

  // --- 1. Download FGC GTFS and extract stops ---
  console.log('[Transit 1/3] Downloading FGC GTFS...');
  try {
    const gtfsUrl = 'https://www.fgc.cat/google/google_transit.zip';
    const zipPath = join(outDir, 'fgc_gtfs.zip');

    const response = await fetch(gtfsUrl);
    if (!response.ok) throw new Error(`FGC GTFS HTTP ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(zipPath, buffer);
    console.log(`  Downloaded GTFS zip (${(buffer.length / 1024).toFixed(0)} KB)`);

    const extractDir = join(outDir, 'fgc_gtfs');
    mkdirSync(extractDir, { recursive: true });
    execSync(
      `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
      { stdio: 'pipe' },
    );

    const stopsFile = join(extractDir, 'stops.txt');
    if (existsSync(stopsFile)) {
      const stopsText = readFileSync(stopsFile, 'utf-8');
      const stops = parseCsv(stopsText);
      console.log(`  Parsed ${stops.length} FGC stops from GTFS`);
      for (const stop of stops) {
        const lat = stop.stop_lat;
        const lon = stop.stop_lon;
        const name = stop.stop_name || '';
        if (lat && lon && parseFloat(lat) !== 0) {
          features.push(toGeoJSONFeature(name, lat, lon, 'fgc', ''));
        }
      }
    } else {
      console.log('  stops.txt not found in extracted GTFS archive');
    }
  } catch (err) {
    console.error('  FGC GTFS download failed:', err.message);
  }

  // --- 2. Try Rodalies GTFS ---
  console.log('[Transit 2/3] Trying Rodalies GTFS...');
  try {
    const rodaliesUrl = 'https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip';
    const zipPath = join(outDir, 'rodalies_gtfs.zip');

    const response = await fetch(rodaliesUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      redirect: 'follow',
    });

    if (response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(zipPath, buffer);
      console.log(`  Downloaded Rodalies GTFS (${(buffer.length / 1024).toFixed(0)} KB)`);

      const extractDir = join(outDir, 'rodalies_gtfs');
      mkdirSync(extractDir, { recursive: true });
      execSync(
        `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
        { stdio: 'pipe' },
      );

      const stopsFile = join(extractDir, 'stops.txt');
      if (existsSync(stopsFile)) {
        const stopsText = readFileSync(stopsFile, 'utf-8');
        const stops = parseCsv(stopsText);
        const catStops = stops.filter(s => {
          const lat = parseFloat(s.stop_lat);
          const lon = parseFloat(s.stop_lon);
          return lat >= 40.5 && lat <= 42.9 && lon >= 0.1 && lon <= 3.4;
        });
        console.log(`  Parsed ${catStops.length} Rodalies stops in Catalonia (of ${stops.length} total)`);
        for (const stop of catStops) {
          features.push(toGeoJSONFeature(stop.stop_name || '', stop.stop_lat, stop.stop_lon, 'renfe', ''));
        }
      }
    } else {
      console.log(`  Rodalies GTFS returned HTTP ${response.status}, skipping`);
    }
  } catch (err) {
    console.error('  Rodalies GTFS failed:', err.message);
  }

  // --- 3. Socrata railway dataset (try anyway) ---
  console.log('[Transit 3/3] Trying Socrata railway dataset...');
  try {
    const url = 'https://analisi.transparenciacatalunya.cat/resource/af2z-inqq.json?$limit=5000';
    const response = await fetch(url);
    if (response.ok) {
      const stations = await response.json();
      console.log(`  Got ${stations.length} railway station records from Socrata`);
      for (const station of stations) {
        const lat = station.latitud || station.coordenada_y_etrs89;
        const lon = station.longitud || station.coordenada_x_etrs89;
        const name = station.nom || station.estacio || '';
        if (!lat || !lon) continue;
        const tipo = (station.tipus || '').toLowerCase();
        let system = 'other';
        if (tipo.includes('fgc')) system = 'fgc';
        else if (tipo.includes('renfe') || tipo.includes('adif') || tipo.includes('rodal')) system = 'renfe';
        else if (tipo.includes('metro') || tipo.includes('tmb')) system = 'metro';
        features.push(toGeoJSONFeature(name, lat, lon, system, ''));
      }
    } else {
      console.log(`  Socrata returned ${response.status}, skipping`);
    }
  } catch (err) {
    console.error('  Socrata railway fetch failed:', err.message);
  }

  // --- Fallback: well-known stations if nothing else worked ---
  if (features.length === 0) {
    console.log('  No live data obtained. Adding fallback station list...');
    const fallback = [
      { name: 'Barcelona Sants', lat: 41.3792, lon: 2.1400, system: 'renfe' },
      { name: 'Barcelona Passeig de Gracia', lat: 41.3920, lon: 2.1650, system: 'renfe' },
      { name: 'Barcelona Clot-Arago', lat: 41.4065, lon: 2.1880, system: 'renfe' },
      { name: 'Barcelona Arc de Triomf', lat: 41.3913, lon: 2.1811, system: 'renfe' },
      { name: 'Girona', lat: 41.9794, lon: 2.8178, system: 'renfe' },
      { name: 'Tarragona', lat: 41.1116, lon: 1.2524, system: 'renfe' },
      { name: 'Lleida Pirineus', lat: 41.6240, lon: 0.6310, system: 'renfe' },
      { name: 'Manresa', lat: 41.7249, lon: 1.8266, system: 'fgc' },
      { name: 'Terrassa', lat: 41.5621, lon: 2.0091, system: 'fgc' },
      { name: 'Sabadell', lat: 41.5486, lon: 2.1039, system: 'fgc' },
      { name: 'Figueres', lat: 42.2679, lon: 2.9616, system: 'renfe' },
      { name: 'Reus', lat: 41.1556, lon: 1.1080, system: 'renfe' },
      { name: 'Vic', lat: 41.8878, lon: 2.2528, system: 'renfe' },
      { name: 'Mataro', lat: 41.5381, lon: 2.4445, system: 'renfe' },
      { name: 'Granollers Centre', lat: 41.6078, lon: 2.2889, system: 'renfe' },
      { name: 'Vilanova i la Geltru', lat: 41.2226, lon: 1.7259, system: 'renfe' },
      { name: 'Martorell', lat: 41.4749, lon: 1.9319, system: 'fgc' },
      { name: 'Igualada', lat: 41.5791, lon: 1.6192, system: 'fgc' },
      { name: 'Barcelona Pl. Catalunya (FGC)', lat: 41.3870, lon: 2.1700, system: 'fgc' },
      { name: 'Barcelona Pl. Espanya (FGC)', lat: 41.3754, lon: 2.1493, system: 'fgc' },
    ];
    for (const s of fallback) {
      features.push(toGeoJSONFeature(s.name, s.lat, s.lon, s.system, ''));
    }
  }

  // Deduplicate by name+coordinates (round to 4 decimals)
  const seen = new Set();
  const unique = features.filter(f => {
    const key = `${f.properties.name}|${f.geometry.coordinates[0].toFixed(4)}|${f.geometry.coordinates[1].toFixed(4)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const geojson = { type: 'FeatureCollection', features: unique };
  const outPath = join(outDir, 'all_stations.geojson');
  writeFileSync(outPath, JSON.stringify(geojson));
  console.log(`  Saved ${unique.length} unique stations to all_stations.geojson`);
  console.log('Done: transit stations.\n');
}

main().catch(console.error);
