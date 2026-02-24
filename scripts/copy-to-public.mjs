/**
 * @file Copy resources folder to public/resources so Vite serves them as static assets.
 */
import { cpSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const src = join(__dirname, '..', 'resources');
const dest = join(__dirname, '..', 'public', 'resources');

console.log('Copying resources/ -> public/resources/ ...');
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true, force: true });
console.log('Done.\n');
