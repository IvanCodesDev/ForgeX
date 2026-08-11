param(
    [Parameter(Mandatory = $true)][string]$TargetRoot,
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($TargetRoot)
if (-not (Test-Path -LiteralPath $target -PathType Container)) { throw "Target root does not exist: $target" }
if ($target -eq [IO.Path]::GetPathRoot($target)) { throw "Target root may not be a filesystem root: $target" }
if (-not (Test-Path -LiteralPath (Join-Path $target 'package.json') -PathType Leaf)) { throw "Target does not contain the ForgeX package marker: $target" }
$baselineArchive = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\baseline\stage6a-selected-files.zip'))
$manifestPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\baseline\baseline-manifest.txt'))
if (-not (Test-Path -LiteralPath $baselineArchive -PathType Leaf)) { throw "Baseline archive is missing: $baselineArchive" }
$changedPaths = @(
    '.github/dependabot.yml',
    '.github/workflows/ci.yml',
    'CHANGELOG.md',
    'README.md',
    'backend/README.md',
    'backend/src/ForgeX.Api/CallerContextBoundary.cs',
    'backend/src/ForgeX.Api/ForgeXMetrics.cs',
    'backend/src/ForgeX.Api/GCodeJobEndpoints.cs',
    'backend/src/ForgeX.Api/Program.cs',
    'backend/src/ForgeX.Api/appsettings.json',
    'backend/src/ForgeX.Api/openapi/v1.json',
    'backend/src/ForgeX.Application/GCodeJobAdmission.cs',
    'backend/src/ForgeX.Application/GCodeJobPorts.cs',
    'backend/src/ForgeX.Infrastructure/FileGCodeJobRepository.cs',
    'backend/tests/ForgeX.JobGate/Program.cs',
    'config/dependency-policy.json',
    'deploy/.env.example',
    'deploy/README.md',
    'deploy/RUNBOOK.md',
    'deploy/SLO.md',
    'deploy/alerts/forgex.rules.yml',
    'deploy/capacity-plan.md',
    'deploy/docker-compose.yml',
    'deploy/drills/rehearse-version-rollback.ps1',
    'doc/FORGE-X优化开发手册-React-TypeScript-CSharp.md',
    'frontend/src/generated/forgex-api.ts',
    'package.json',
    'tests/e2e/react-stage3b-jobs.spec.js',
    'tools/rehearse-release-rollback.js',
    'tools/run-recovery-drill.js',
    'tools/security-audit.js',
    'tools/validate-operations.js',
    'tools/verify-gcode-capacity.js',
    'tools/verify-openapi-runtime.js'
)
$newPaths = @(
    '.github/dependabot.yml',
    'backend/src/ForgeX.Application/GCodeJobAdmission.cs',
    'config/dependency-policy.json',
    'deploy/RUNBOOK.md',
    'deploy/SLO.md',
    'deploy/alerts/forgex.rules.yml',
    'deploy/capacity-plan.md',
    'deploy/drills/rehearse-version-rollback.ps1',
    'tools/rehearse-release-rollback.js',
    'tools/run-recovery-drill.js',
    'tools/security-audit.js',
    'tools/validate-operations.js',
    'tools/verify-gcode-capacity.js'
)
foreach ($relative in $changedPaths) {
    $candidate = [IO.Path]::GetFullPath((Join-Path $target $relative))
    if (-not $candidate.StartsWith($target + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Path escapes target root: $relative" }
}
if (-not $Apply) { Write-Output "DRY_RUN restore=$((Get-Content -LiteralPath $manifestPath).Count) remove=$($newPaths.Count) target=$target"; exit 0 }
foreach ($relative in $changedPaths) {
    $candidate = [IO.Path]::GetFullPath((Join-Path $target $relative))
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { Remove-Item -LiteralPath $candidate -Force }
}
Expand-Archive -LiteralPath $baselineArchive -DestinationPath $target -Force
$verified = 0
foreach ($line in Get-Content -LiteralPath $manifestPath) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $parts = $line -split '\|', 3
    $candidate = Join-Path $target $parts[0]
    $actual = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $parts[1]) { throw "Rollback hash mismatch: $($parts[0])" }
    $verified++
}
foreach ($relative in $newPaths) { if (Test-Path -LiteralPath (Join-Path $target $relative) -PathType Leaf) { throw "Rollback new path remains: $relative" } }
Write-Output "APPLIED verified=$verified removed=$($newPaths.Count) target=$target"
