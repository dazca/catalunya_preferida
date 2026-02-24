#!/usr/bin/env node
/**
 * @file upload.mjs – deploy dist/ to the server via SFTP.
 *
 * Usage:
 *   npm run build && node upload.mjs
 *
 * Uploads the contents of dist/ to /web/altres/catmap on the server.
 * The site will be live at https://azemar.eu/altres/catmap
 */

import Client from 'ssh2-sftp-client';
import path from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

const SFTP_CONFIG = {
  host: requiredEnv('SFTP_HOST'),
  username: requiredEnv('SFTP_USERNAME'),
  password: requiredEnv('SFTP_PASSWORD'),
  port: Number(process.env.SFTP_PORT || '22'),
};

const LOCAL_DIST = path.join(__dirname, 'dist');
const REMOTE_DIR = process.env.SFTP_REMOTE_DIR || '/web/altres/catmap';

async function deploy() {
  const sftp = new Client();

  console.log('Connecting to server...');
  await sftp.connect(SFTP_CONFIG);
  console.log('Connected');

  try {
    // Wipe old deployment so stale assets don't accumulate
    try {
      console.log(`Removing old ${REMOTE_DIR}...`);
      await sftp.rmdir(REMOTE_DIR, true);
      console.log('Old deployment removed');
    } catch {
      console.log(`${REMOTE_DIR} does not exist yet, skipping cleanup`);
    }

    // (Re)create target directory
    await sftp.mkdir(REMOTE_DIR, true);

    console.log(`Uploading dist/ -> ${REMOTE_DIR} ...`);
    await sftp.uploadDir(LOCAL_DIST, REMOTE_DIR);

    console.log('Upload complete');
    console.log('Site live at: https://azemar.eu/altres/catmap');
  } finally {
    await sftp.end();
  }
}

deploy().catch((err) => {
  console.error('Deploy failed:', err.message);
  process.exit(1);
});
