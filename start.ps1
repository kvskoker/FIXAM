# FIXAM Docker start helper (Windows).
#
# Checks the ports the stack publishes are free before bringing it up, so a
# conflict (most commonly a local PostgreSQL already on 5432) fails here with a
# clear message instead of "dependency postgres failed to start".
#
# Usage: powershell -ExecutionPolicy Bypass -File .\start.ps1
#        (or run start.cmd, which does the same)

$ErrorActionPreference = 'Stop'

# "Port, EnvVar, Description" -- same defaults and env overrides as docker-compose.yml
$checks = @(
    @{ Port = 5432; Env = 'DB_PORT';         Name = 'PostgreSQL' },
    @{ Port = 8080; Env = 'NOMINATIM_PORT';  Name = 'Geocoding (Nominatim)' },
    @{ Port = 8000; Env = 'AI_ENGINE_PORT';  Name = 'AI engine' },
    @{ Port = 5000; Env = 'BACKEND_PORT';    Name = 'Backend API' },
    @{ Port = 4001; Env = 'SIMULATOR_PORT';  Name = 'WhatsApp simulator' },
    @{ Port = 80;   Env = 'FRONTEND_PORT';   Name = 'Frontend (nginx)' }
)

Write-Host 'Checking ports before starting FIXAM...'
Write-Host ''

$failed = $false
foreach ($c in $checks) {
    $port = $c.Port
    $envVal = [Environment]::GetEnvironmentVariable($c.Env)
    if ($envVal) { $port = [int]$envVal }

    $listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($listening) {
        Write-Host "[X] Port $port ($($c.Name)) is already in use." -ForegroundColor Red
        Write-Host "    Stop the other service, or set $($c.Env) to a free port in .env and retry."
        Write-Host ''
        $failed = $true
    } else {
        Write-Host "[OK] Port $port free ($($c.Name))" -ForegroundColor Green
    }
}

if ($failed) {
    Write-Host 'Aborting: free the ports above before starting.' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host 'All ports free. Starting FIXAM...' -ForegroundColor Green
docker compose --profile simulator up -d --build
