/**
 * @file Download crime data from Mossos d'Esquadra (qnyt-emjc).
 *       Data is aggregated by police region (ABP), not municipality.
 *       Fields: mes, any, regi_policial_rp, rea_b_sica_policial_abp,
 *               t_tol_codi_penal, tipus_de_fet, coneguts, resolts, detencions
 *       We aggregate total offenses per ABP for the latest available year.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RESOURCES = join(__dirname, '..', 'resources');

const SOCRATA_BASE = 'https://analisi.transparenciacatalunya.cat/resource';

async function fetchSocrata(datasetId, params = {}) {
  const pageSize = 10000;
  const all = [];
  let offset = 0;
  while (true) {
    const queryParams = new URLSearchParams({ ...params, $limit: String(pageSize), $offset: String(offset) });
    const url = `${SOCRATA_BASE}/${datasetId}.json?${queryParams}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Socrata ${response.status}`);
    const page = await response.json();
    all.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
    await new Promise(r => setTimeout(r, 200));
  }
  return all;
}

async function main() {
  const outDir = join(RESOURCES, 'crime');
  mkdirSync(outDir, { recursive: true });

  console.log('[Crime] Downloading crime data...');

  try {
    // Fetch only the latest year to keep data small
    const data = await fetchSocrata('qnyt-emjc', {
      $order: 'any DESC',
      $where: "any >= '2023'",
    });

    console.log(`  Got ${data.length} crime records`);

    // Find latest year in data
    let maxYear = 0;
    for (const r of data) {
      const y = parseInt(r.any || '0', 10);
      if (y > maxYear) maxYear = y;
    }
    console.log(`  Latest year: ${maxYear}`);

    // Aggregate by ABP for latest year
    const byAbp = {};
    for (const record of data) {
      const year = parseInt(record.any || '0', 10);
      if (year !== maxYear) continue;

      const region = record.regi_policial_rp || 'Unknown';
      const abp = record.rea_b_sica_policial_abp || 'Unknown';
      const known = parseInt(record.coneguts || '0', 10);
      const solved = parseInt(record.resolts || '0', 10);
      const arrests = parseInt(record.detencions || '0', 10);

      const key = `${region}|${abp}`;
      if (!byAbp[key]) {
        byAbp[key] = { region, abp, year: maxYear, totalOffenses: 0, resolved: 0, arrests: 0 };
      }
      byAbp[key].totalOffenses += known;
      byAbp[key].resolved += solved;
      byAbp[key].arrests += arrests;
    }

    const crimeData = Object.values(byAbp).sort((a, b) => b.totalOffenses - a.totalOffenses);

    writeFileSync(join(outDir, 'crime_by_abp.json'), JSON.stringify(crimeData, null, 2));
    console.log(`  Saved crime data for ${crimeData.length} ABPs (year ${maxYear})`);
  } catch (err) {
    console.error('  Failed:', err.message);
    writeFileSync(join(outDir, 'crime_by_abp.json'), '[]');
  }

  console.log('Done: crime.\n');
}

main().catch(console.error);
