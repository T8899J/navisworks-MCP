[CmdletBinding()]
param(
    [string]$Configuration = "Release",
    [string]$NavisworksPath = "F:\Navisworks\Navisworks Manage 2023"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$artifactRoot = Join-Path $repoRoot "artifacts"
$bundleSource = Join-Path $repoRoot "navisworks-plugin\package\NavisworksCodexMcp.bundle"
$pluginOutput = Join-Path $repoRoot "navisworks-plugin\src\NavisworksCodexMcp.Plugin\bin\$Configuration\NavisworksCodexMcp.Plugin.dll"
$bundleArtifact = Join-Path $artifactRoot "NavisworksCodexMcp.bundle"
$bundleContents = Join-Path $bundleArtifact "Contents\v20"
$mcpArtifact = Join-Path $artifactRoot "mcp-server\navisworks-mcp.mjs"

$resolvedRepoRoot = [System.IO.Path]::GetFullPath($repoRoot).TrimEnd("\")
$resolvedArtifactRoot = [System.IO.Path]::GetFullPath($artifactRoot)
if (-not $resolvedArtifactRoot.StartsWith(
        $resolvedRepoRoot + "\",
        [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Artifact path escaped the repository root."
}

$roamerPath = Join-Path $NavisworksPath "Roamer.exe"
$apiPath = Join-Path $NavisworksPath "Autodesk.Navisworks.Api.dll"
if (-not (Test-Path -LiteralPath $roamerPath -PathType Leaf)) {
    throw "Roamer.exe not found: $roamerPath"
}
if (-not (Test-Path -LiteralPath $apiPath -PathType Leaf)) {
    throw "Autodesk.Navisworks.Api.dll not found: $apiPath"
}
if (-not (Test-Path -LiteralPath $pluginOutput -PathType Leaf)) {
    throw "Plugin build output not found: $pluginOutput"
}
if (-not (Test-Path -LiteralPath $mcpArtifact -PathType Leaf)) {
    throw "MCP bundle not found: $mcpArtifact"
}

$apiVersion = (Get-Item -LiteralPath $apiPath).VersionInfo.FileVersion
if (-not $apiVersion.StartsWith("20.", [System.StringComparison]::Ordinal)) {
    throw "Expected Navisworks 2023 API version 20.x, found $apiVersion."
}

if (Test-Path -LiteralPath $bundleArtifact) {
    Remove-Item -LiteralPath $bundleArtifact -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $bundleContents | Out-Null
Copy-Item -LiteralPath (Join-Path $bundleSource "PackageContents.xml") -Destination $bundleArtifact
Copy-Item -LiteralPath $pluginOutput -Destination $bundleContents

$hashTargets = @(
    Join-Path $bundleArtifact "PackageContents.xml"
    Join-Path $bundleContents "NavisworksCodexMcp.Plugin.dll"
    $mcpArtifact
)
$hashLines = foreach ($file in $hashTargets) {
    $hash = Get-FileHash -LiteralPath $file -Algorithm SHA256
    $relativePath = $file.Substring($artifactRoot.Length).TrimStart("\")
    "{0} *{1}" -f $hash.Hash, $relativePath
}
$hashLines | Set-Content -LiteralPath (Join-Path $artifactRoot "SHA256SUMS.txt") -Encoding ascii

Write-Output "PACKAGE: PASS"
Write-Output "Bundle: $bundleArtifact"
Write-Output "MCP: $mcpArtifact"
