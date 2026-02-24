# Catalunya Preferida

Web map to score municipalities in Catalonia.

## Dev setup

1. Install dependencies and pull runtime datasets from server:
   - `npm run setup:dev`
2. Start app:
   - `npm run dev`

Windows alternative:
- `powershell -ExecutionPolicy Bypass -File scripts/setup-dev.ps1`

## Data strategy

- Large generated/raw data is **not committed** (`resources/`, `public/resources/` are ignored).
- Dev bootstrap pulls only required runtime files from:
  - `https://azemar.eu/altres/catmap/resources/...`
- Override source with env var:
  - `DATA_BASE_URL=https://your-host/path npm run bootstrap:data`

## Deploy

`upload.mjs` now reads credentials from env vars:

- `SFTP_HOST`
- `SFTP_PORT` (optional, default `22`)
- `SFTP_USERNAME`
- `SFTP_PASSWORD`
- `SFTP_REMOTE_DIR` (optional, default `/web/altres/catmap`)

Example (PowerShell):

```powershell
$env:SFTP_HOST='185.42.104.215'
$env:SFTP_USERNAME='user'
$env:SFTP_PASSWORD='pass'
$env:SFTP_REMOTE_DIR='/web/altres/catmap'
npm run deploy
```

## Git LFS

LFS is configured for typical large binary/geodata artifact extensions in `.gitattributes`.
