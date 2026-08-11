param(
    [string]$Root = ".",
    [string]$Patch = (Join-Path $PSScriptRoot "stage5b-authoritative-layer-plan.patch")
)

$ErrorActionPreference = "Stop"
$target = (Resolve-Path -LiteralPath $Root).Path
$patchPath = (Resolve-Path -LiteralPath $Patch).Path

Push-Location $target
try {
    git apply --check --reverse --unidiff-zero --whitespace=nowarn $patchPath
    if ($LASTEXITCODE -ne 0) {
        throw "Stage 5-B reverse patch preflight failed"
    }

    git apply --reverse --unidiff-zero --whitespace=nowarn $patchPath
    if ($LASTEXITCODE -ne 0) {
        throw "Stage 5-B reverse patch failed"
    }
}
finally {
    Pop-Location
}

Write-Output "rollback=ok stage=5-B root=$target"
