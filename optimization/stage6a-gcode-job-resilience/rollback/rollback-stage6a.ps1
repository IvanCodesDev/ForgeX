param(
    [string]$TargetRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path,
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($TargetRoot)
if (-not (Test-Path -LiteralPath $target -PathType Container)) {
    throw "Target root does not exist: $target"
}

$baselineArchive = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\baseline\stage5d-selected-files.zip'))
if (-not (Test-Path -LiteralPath $baselineArchive -PathType Leaf)) {
    throw "Baseline archive is missing: $baselineArchive"
}

$newPaths = @(
    'CHANGELOG.md',
    'backend/src/ForgeX.Application/GCodeJobResilience.cs',
    'tools/verify-gcode-job-resilience.js'
)

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($baselineArchive)
try {
    $entries = @($archive.Entries | Where-Object { -not [string]::IsNullOrEmpty($_.Name) })
    foreach ($entry in $entries) {
        $destination = [IO.Path]::GetFullPath((Join-Path $target $entry.FullName))
        if (-not $destination.StartsWith($target + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Baseline entry escapes target root: $($entry.FullName)"
        }
    }
}
finally {
    $archive.Dispose()
}

foreach ($relative in $newPaths) {
    $candidate = [IO.Path]::GetFullPath((Join-Path $target $relative))
    if (-not $candidate.StartsWith($target + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "New path escapes target root: $relative"
    }
}

if (-not $Apply) {
    Write-Output "DRY_RUN restore=$($entries.Count) remove=$($newPaths.Count) target=$target"
    exit 0
}

Expand-Archive -LiteralPath $baselineArchive -DestinationPath $target -Force
$removed = 0
foreach ($relative in $newPaths) {
    $candidate = [IO.Path]::GetFullPath((Join-Path $target $relative))
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        Remove-Item -LiteralPath $candidate -Force
        $removed++
    }
}

$sha256 = (Get-FileHash -LiteralPath $baselineArchive -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Output "APPLIED restored=$($entries.Count) removed=$removed target=$target baselineSha256=$sha256"
