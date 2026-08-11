param(
    [Parameter(Mandatory = $true)][string]$PreviousNodeImage,
    [Parameter(Mandatory = $true)][string]$PreviousApiImage,
    [string]$EnvFile = "deploy/.env",
    [switch]$Apply
)

$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$compose = Join-Path $workspace "deploy/docker-compose.yml"
$env:FORGEX_NODE_IMAGE = $PreviousNodeImage
$env:FORGEX_API_IMAGE = $PreviousApiImage

Push-Location $workspace
try {
    docker compose --env-file $EnvFile --file $compose config --quiet
    if ($LASTEXITCODE -ne 0) { throw "compose rollback config validation failed" }
    Write-Output "Validated rollback images: node=$PreviousNodeImage api=$PreviousApiImage"

    if ($Apply) {
        docker compose --env-file $EnvFile --file $compose up -d --no-build
        if ($LASTEXITCODE -ne 0) { throw "compose rollback apply failed" }
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 http://127.0.0.1:8787/healthz | Out-Null
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 http://127.0.0.1:8787/react/ | Out-Null
        docker compose --env-file $EnvFile --file $compose exec -T forgex-api `
            wget -qO- http://127.0.0.1:8788/health/ready
        if ($LASTEXITCODE -ne 0) { throw "authority readiness failed after rollback" }
        Write-Output "Applied and verified rollback image pair; named volumes were preserved."
    }
}
finally {
    Pop-Location
}
