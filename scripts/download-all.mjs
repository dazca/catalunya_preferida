/**
 * @file Master download script: runs all data download scripts sequentially.
 *       Usage: node scripts/download-all.mjs
 *
 *       Each sub-script writes to the resources/ directory.
 *       Errors in individual scripts are caught so the pipeline continues.
 */
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCRIPTS = [
  'download-municipalities.mjs',
  'download-votes.mjs',
  'download-transit.mjs',
  'download-air-quality.mjs',
  'download-crime.mjs',
  'download-facilities.mjs',
  'download-climate.mjs',
  'download-rental-prices.mjs',
  'download-employment.mjs',
  'download-synthetic.mjs',
];

async function main() {
  console.log('=== Better Idealista: Data Download Pipeline ===\n');
  console.log(`Running ${SCRIPTS.length} download scripts...\n`);

  let succeeded = 0;
  let failed = 0;

  for (const script of SCRIPTS) {
    const path = join(__dirname, script);
    console.log(`--- Running ${script} ---`);

    try {
      execSync(`node "${path}"`, {
        stdio: 'inherit',
        timeout: 120000, // 2 min per script
      });
      succeeded++;
    } catch (err) {
      console.error(`  FAILED: ${script} - ${err.message}\n`);
      failed++;
    }
  }

  console.log('=== Download Pipeline Complete ===');
  console.log(`  Succeeded: ${succeeded}/${SCRIPTS.length}`);
  console.log(`  Failed: ${failed}/${SCRIPTS.length}`);

  if (failed > 0) {
    console.log('\nNote: Failed scripts may have created empty placeholder files.');
    console.log('The app will still work but some layers will have no data.');
  }
}

main().catch(console.error);
