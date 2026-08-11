param(
    [Parameter(Mandatory = $true)]
    [string]$Workspace
)
$ErrorActionPreference = "Stop"
$artifactRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$archive = Join-Path $artifactRoot "baseline/stage5c-selected-files.zip"
$record = Join-Path $artifactRoot "baseline/baseline-record.txt"
$expectedArchiveSha256 = "906c9a340aa7c93aa5203aca08047f0e543659e9575c0c8e6209947430816b8b"
$workspaceRoot = (Resolve-Path -LiteralPath $Workspace).Path
$actualArchiveSha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualArchiveSha256 -ne $expectedArchiveSha256) {
    throw "Baseline archive SHA-256 mismatch: $actualArchiveSha256"
}
$lines = Get-Content -LiteralPath $record
$marker = [Array]::IndexOf($lines, "trackedPaths:")
if ($marker -lt 0 -or $marker -eq $lines.Count - 1) { throw "Baseline path manifest is empty" }
$paths = @($lines[($marker + 1)..($lines.Count - 1)] | Where-Object { $_ })
$temp = Join-Path (Join-Path $artifactRoot "rollback") (".restore-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $temp | Out-Null
try {
    Expand-Archive -LiteralPath $archive -DestinationPath $temp -Force
    foreach ($path in $paths) {
        $source = Join-Path $temp $path
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Baseline file missing: $path" }
        $target = [IO.Path]::GetFullPath((Join-Path $workspaceRoot $path))
        if (-not $target.StartsWith($workspaceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Rollback target escaped workspace: $path"
        }
        New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
        Copy-Item -LiteralPath $source -Destination $target -Force
    }
    Write-Output "ROLLBACK_STAGE5D_OK restored=$($paths.Count) baseline=7beb2c5761336d8575f6d5d5d005689fec4c2844"
}
finally {
    $resolvedTemp = [IO.Path]::GetFullPath($temp)
    $rollbackRoot = [IO.Path]::GetFullPath((Join-Path $artifactRoot "rollback"))
    if ($resolvedTemp.StartsWith($rollbackRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $resolvedTemp)) {
        Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
    }
}