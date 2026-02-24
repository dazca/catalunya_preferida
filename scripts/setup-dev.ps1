Param(
  [switch]$ForceData
)

$ErrorActionPreference = 'Stop'

Write-Host 'Installing npm dependencies...'
npm install

Write-Host 'Bootstrapping runtime data into public/resources...'
if ($ForceData) {
  node scripts/bootstrap-data.mjs --force
} else {
  node scripts/bootstrap-data.mjs
}

Write-Host 'Dev environment ready. Start with: npm run dev'
