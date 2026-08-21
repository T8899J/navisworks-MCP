[CmdletBinding()]
param(
    [string]$ArtifactRoot,
    [switch]$Force,
    [switch]$SkipCodexRegistration
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ArtifactRoot)) {
    $ArtifactRoot = Join-Path $repoRoot "artifacts"
}

& (Join-Path $PSScriptRoot "verify.ps1") -ArtifactRoot $ArtifactRoot

$sourceBundle = Join-Path $ArtifactRoot "NavisworksCodexMcp.bundle"
$sourceMcp = Join-Path $ArtifactRoot "mcp-server\navisworks-mcp.mjs"
$pluginParent = Join-Path $env:APPDATA "Autodesk\ApplicationPlugins"
$pluginTarget = Join-Path $pluginParent "NavisworksCodexMcp.bundle"
$mcpTargetDirectory = Join-Path $env:LOCALAPPDATA "NavisworksCodexMcp\mcp-server"
$mcpTarget = Join-Path $mcpTargetDirectory "navisworks-mcp.mjs"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"

$existingMcp = & codex mcp get navisworks --json 2>$null
$mcpExists = $LASTEXITCODE -eq 0
if ($mcpExists -and -not $Force) {
    throw "Codex MCP entry 'navisworks' already exists. Re-run with -Force only after reviewing it."
}

$runningRoamer = Get-Process -Name Roamer -ErrorAction SilentlyContinue
if ($runningRoamer) {
    Write-Warning "Navisworks is running. Installation will not stop it; restart Navisworks after installation."
}

New-Item -ItemType Directory -Force -Path $pluginParent | Out-Null
New-Item -ItemType Directory -Force -Path $mcpTargetDirectory | Out-Null

$bundleStage = Join-Path $pluginParent ("NavisworksCodexMcp.bundle.stage-" + [guid]::NewGuid().ToString("N"))
$pluginBackup = $null
$mcpBackup = $null
$pluginInstalled = $false
$mcpInstalled = $false
$codexAdded = $false

try {
    Copy-Item -LiteralPath $sourceBundle -Destination $bundleStage -Recurse

    if (Test-Path -LiteralPath $pluginTarget) {
        $pluginBackup = "$pluginTarget.backup-$timestamp"
        Move-Item -LiteralPath $pluginTarget -Destination $pluginBackup
    }
    Move-Item -LiteralPath $bundleStage -Destination $pluginTarget
    $pluginInstalled = $true

    if (Test-Path -LiteralPath $mcpTarget) {
        $mcpBackup = "$mcpTarget.backup-$timestamp"
        Copy-Item -LiteralPath $mcpTarget -Destination $mcpBackup
    }
    Copy-Item -LiteralPath $sourceMcp -Destination $mcpTarget -Force
    $mcpInstalled = $true

    if (-not $SkipCodexRegistration) {
        if ($mcpExists) {
            & codex mcp remove navisworks
            if ($LASTEXITCODE -ne 0) {
                throw "Could not remove the existing Codex MCP entry."
            }
        }

        $nodePath = (Get-Command node -ErrorAction Stop).Source
        & codex mcp add navisworks -- $nodePath $mcpTarget
        if ($LASTEXITCODE -ne 0) {
            throw "Could not register the Codex MCP entry."
        }
        $codexAdded = $true
    }
}
catch {
    if ($codexAdded) {
        & codex mcp remove navisworks 2>$null
    }
    if (Test-Path -LiteralPath $bundleStage) {
        Remove-Item -LiteralPath $bundleStage -Recurse -Force
    }
    if ($pluginBackup -and (Test-Path -LiteralPath $pluginBackup)) {
        if (Test-Path -LiteralPath $pluginTarget) {
            Remove-Item -LiteralPath $pluginTarget -Recurse -Force
        }
        Move-Item -LiteralPath $pluginBackup -Destination $pluginTarget
    }
    elseif ($pluginInstalled -and (Test-Path -LiteralPath $pluginTarget)) {
        Remove-Item -LiteralPath $pluginTarget -Recurse -Force
    }
    if ($mcpBackup -and (Test-Path -LiteralPath $mcpBackup)) {
        Copy-Item -LiteralPath $mcpBackup -Destination $mcpTarget -Force
    }
    elseif ($mcpInstalled -and (Test-Path -LiteralPath $mcpTarget)) {
        Remove-Item -LiteralPath $mcpTarget -Force
    }
    throw
}

Write-Output "INSTALL: PASS"
Write-Output "Plugin: $pluginTarget"
Write-Output "MCP server: $mcpTarget"
if (-not $SkipCodexRegistration) {
    Write-Output "Codex entry: navisworks"
}
Write-Output "Restart Navisworks and Codex before the end-to-end test."
