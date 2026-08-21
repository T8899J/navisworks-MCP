[CmdletBinding(SupportsShouldProcess)]
param()

$ErrorActionPreference = "Stop"
$pluginTarget = Join-Path $env:APPDATA "Autodesk\ApplicationPlugins\NavisworksCodexMcp.bundle"
$mcpTargetDirectory = Join-Path $env:LOCALAPPDATA "NavisworksCodexMcp\mcp-server"

if ($PSCmdlet.ShouldProcess($pluginTarget, "Remove Navisworks plug-in bundle")) {
    if (Test-Path -LiteralPath $pluginTarget) {
        Remove-Item -LiteralPath $pluginTarget -Recurse -Force
    }
}
if ($PSCmdlet.ShouldProcess($mcpTargetDirectory, "Remove installed MCP server")) {
    if (Test-Path -LiteralPath $mcpTargetDirectory) {
        Remove-Item -LiteralPath $mcpTargetDirectory -Recurse -Force
    }
}
if ($PSCmdlet.ShouldProcess("Codex MCP entry navisworks", "Remove")) {
    & codex mcp remove navisworks
}

Write-Output "UNINSTALL: PASS"

