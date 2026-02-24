/**
 * @file Download population and employment data.
 *       - Population by municipality: b4rr-d25b (age/sex breakdown)
 *       - Ens locals general data: 6nei-4b44 (may have economic indicators)
 *       Produces a combined employment/demographics file per municipality.
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
  const outDir = join(RESOURCES, 'economy');
  mkdirSync(outDir, { recursive: true });

  console.log('[Employment] Downloading population data...');

  try {
    // Population data by municipality (b4rr-d25b)
    const popData = await fetchSocrata('b4rr-d25b', {
      $order: 'any DESC',
    });

    console.log(`  Got ${popData.length} population records`);

    // Take latest year per municipality
    const byMuni = {};
    for (const record of popData) {
      const codi = record.codi || '';
      const nom = record.literal || '';
      const year = parseInt(record.any || '0', 10);

      if (!codi) continue;
      if (byMuni[codi] && byMuni[codi].year >= year) continue;

      const youth = parseInt(record.total_de_0_a_14_anys || '0', 10);
      const working = parseInt(record.total_de_15_a_64_anys || '0', 10);
      const elderly = parseInt(record.total_de_65_anys_i_m_s || '0', 10);
      const total = youth + working + elderly;

      byMuni[codi] = {
        codi,
        nom,
        year,
        population: total,
        youth,
        workingAge: working,
        elderly,
        unemploymentPct: 0,    // placeholder
        avgIncome: null,       // not available from this source
      };
    }

    const employment = Object.values(byMuni);
    writeFileSync(join(outDir, 'employment.json'), JSON.stringify(employment, null, 2));
    console.log(`  Saved population/employment data for ${employment.length} municipalities`);
  } catch (err) {
    console.error('  Failed:', err.message);
    writeFileSync(join(outDir, 'employment.json'), '[]');
  }

  console.log('Done: employment.\n');
}

main().catch(console.error);
