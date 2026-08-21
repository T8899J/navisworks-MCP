[CmdletBinding()]
param(
    [string]$ArtifactRoot
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ArtifactRoot)) {
    $ArtifactRoot = Join-Path $repoRoot "artifacts"
}

$bundleRoot = Join-Path $ArtifactRoot "NavisworksCodexMcp.bundle"
$manifestPath = Join-Path $bundleRoot "PackageContents.xml"
$pluginPath = Join-Path $bundleRoot "Contents\v20\NavisworksCodexMcp.Plugin.dll"
$mcpPath = Join-Path $ArtifactRoot "mcp-server\navisworks-mcp.mjs"
$hashPath = Join-Path $ArtifactRoot "SHA256SUMS.txt"

$requiredFiles = @($manifestPath, $pluginPath, $mcpPath, $hashPath)
foreach ($file in $requiredFiles) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Required artifact is missing: $file"
    }
}

$unexpectedAutodeskAssemblies = Get-ChildItem -LiteralPath $bundleRoot -Recurse -File |
    Where-Object { $_.Name -like "Autodesk*.dll" }
if ($unexpectedAutodeskAssemblies) {
    throw "Autodesk assemblies must not be included in the bundle."
}

[xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw
$runtime = $manifest.ApplicationPackage.Components.RuntimeRequirements
$entry = $manifest.ApplicationPackage.Components.ComponentEntry
if ($runtime.OS -ne "Win64" -or
    $runtime.Platform -ne "NAVMAN" -or
    $runtime.SeriesMin -ne "Nw20" -or
    $runtime.SeriesMax -ne "Nw20") {
    throw "PackageContents.xml is not restricted to Navisworks Manage 2023 x64."
}
if ($entry.AppType -ne "ManagedPlugin" -or
    $entry.ModuleName -ne "./Contents/v20/NavisworksCodexMcp.Plugin.dll") {
    throw "PackageContents.xml points to an unexpected module."
}

$bytes = [System.IO.File]::ReadAllBytes($pluginPath)
if ($bytes.Length -lt 256) {
    throw "Plugin assembly is unexpectedly small."
}
$peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
$machine = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
if ($machine -ne 0x8664) {
    throw ("Plugin is not x64. PE machine: 0x{0:X4}" -f $machine)
}

$assemblyName = [System.Reflection.AssemblyName]::GetAssemblyName($pluginPath)
if ($assemblyName.Name -ne "NavisworksCodexMcp.Plugin" -or
    $assemblyName.Version.ToString() -ne "0.1.0.0") {
    throw "Plugin assembly identity or version is unexpected."
}

$expectedHashes = @{}
foreach ($line in Get-Content -LiteralPath $hashPath) {
    if ($line -notmatch "^([A-Fa-f0-9]{64}) \*(.+)$") {
        throw "Invalid SHA256SUMS.txt entry: $line"
    }
    $expectedHashes[$Matches[2]] = $Matches[1].ToUpperInvariant()
}

foreach ($relativePath in $expectedHashes.Keys) {
    $fullPath = Join-Path $ArtifactRoot $relativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "Hashed artifact is missing: $relativePath"
    }
    $actualHash = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash
    if ($actualHash -ne $expectedHashes[$relativePath]) {
        throw "Hash mismatch: $relativePath"
    }
}

if ($expectedHashes.Count -ne 3) {
    throw "Expected exactly three hashed deliverables."
}

Write-Output "ARTIFACT_VERIFY: PASS"
Write-Output "Assembly: $($assemblyName.Name) $($assemblyName.Version)"
Write-Output ("PE machine: 0x{0:X4}" -f $machine)
Write-Output "Hashed files: $($expectedHashes.Count)"

