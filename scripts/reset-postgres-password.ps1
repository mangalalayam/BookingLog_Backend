#Requires -RunAsAdministrator
<#
  One-time helper: sets the local PostgreSQL "postgres" password to the one in
  .env (DATABASE_URL), for when the original install password is forgotten.

  Run from an ADMINISTRATOR terminal, in the BookingLog-backend folder:

    powershell -ExecutionPolicy Bypass -File .\scripts\reset-postgres-password.ps1

  What it does:
    1. Backs up pg_hba.conf (PostgreSQL's login rules).
    2. Temporarily allows local logins without a password, restarts PostgreSQL.
    3. Sets the new password.
    4. Restores the original login rules and restarts PostgreSQL again.
  Step 4 runs even if something fails, so password checking is never left off.
#>
$ErrorActionPreference = 'Stop'

$pgRoot  = 'C:\Program Files\PostgreSQL\18'
$service = 'postgresql-x64-18'
$hba     = Join-Path $pgRoot 'data\pg_hba.conf'
$psql    = Join-Path $pgRoot 'bin\psql.exe'
$isReady = Join-Path $pgRoot 'bin\pg_isready.exe'
$backup  = "$hba.before-password-reset"

# --- Read the wanted password from .env -------------------------------------
$envFile = Join-Path $PSScriptRoot '..\.env'
if (-not (Test-Path $envFile)) { throw ".env not found at $envFile" }
$line = Get-Content $envFile | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
if ($line -notmatch '^DATABASE_URL=postgres(ql)?://postgres:([^@]+)@') {
  throw 'Could not read the password from DATABASE_URL in .env'
}
$password = [uri]::UnescapeDataString($Matches[2])
$sqlPassword = $password.Replace("'", "''")

function Wait-ForPostgres {
  foreach ($i in 1..30) {
    & $isReady -h localhost -q
    if ($LASTEXITCODE -eq 0) { return }
    Start-Sleep -Seconds 1
  }
  throw 'PostgreSQL did not come back up within 30 seconds.'
}

# --- Reset -------------------------------------------------------------------
Copy-Item $hba $backup -Force
Write-Host 'Backed up login rules.'

try {
  (Get-Content $hba) -replace 'scram-sha-256', 'trust' -replace '\bmd5\b', 'trust' |
    Set-Content $hba -Encoding ascii
  Restart-Service $service
  Wait-ForPostgres
  Write-Host 'Password check temporarily off. Setting the new password...'

  & $psql -U postgres -h localhost -w -d postgres -c "ALTER USER postgres PASSWORD '$sqlPassword';"
  if ($LASTEXITCODE -ne 0) { throw 'Setting the password failed.' }
}
finally {
  Copy-Item $backup $hba -Force
  Restart-Service $service
  Wait-ForPostgres
  Remove-Item $backup -Force
  Write-Host 'Original login rules restored; password check is back on.'
}

# --- Verify -------------------------------------------------------------------
$env:PGPASSWORD = $password
& $psql -U postgres -h localhost -w -d postgres -Atc "select 'ok'" | Out-Null
$worked = ($LASTEXITCODE -eq 0)
Remove-Item Env:PGPASSWORD

if ($worked) {
  Write-Host ''
  Write-Host 'Done. PostgreSQL now accepts the password from .env.' -ForegroundColor Green
} else {
  throw 'The password was set, but logging in with it still fails.'
}
