[CmdletBinding()]
param(
    [string]$NavisworksPath = "F:\Navisworks\Navisworks Manage 2023",
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$mcpRoot = Join-Path $repoRoot "mcp-server"
$pluginProject = Join-Path $repoRoot "navisworks-plugin\src\NavisworksCodexMcp.Plugin\NavisworksCodexMcp.Plugin.csproj"
$testProject = Join-Path $repoRoot "navisworks-plugin\tests\NavisworksCodexMcp.ProtocolTests\NavisworksCodexMcp.ProtocolTests.csproj"
$testExecutable = Join-Path $repoRoot "navisworks-plugin\tests\NavisworksCodexMcp.ProtocolTests\bin\$Configuration\NavisworksCodexMcp.ProtocolTests.exe"
$nugetPackages = Join-Path $repoRoot ".nuget\packages"
$npmCache = Join-Path $repoRoot ".npm-cache"

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
    throw "Visual Studio Installer vswhere.exe was not found."
}
$msbuild = & $vswhere -products * -requires Microsoft.Component.MSBuild -find "MSBuild\**\Bin\MSBuild.exe" |
    Select-Object -First 1
if (-not $msbuild -or -not (Test-Path -LiteralPath $msbuild -PathType Leaf)) {
    throw "Visual Studio MSBuild was not found."
}

if (Test-Path -LiteralPath $mcpRoot -PathType Container) {
    Push-Location $mcpRoot
    try {
        & npm ci --cache $npmCache
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci failed."
        }
        & npm run verify
        if ($LASTEXITCODE -ne 0) {
            throw "MCP verification failed."
        }
    }
    finally {
        Pop-Location
    }
}
else {
    # mcp-server 源码已从仓库移除；artifacts\mcp-server\navisworks-mcp.mjs 是唯一交付副本，
    # 由 package.ps1 计入 SHA256SUMS.txt、verify.ps1 校验，无需重新构建。
    Write-Output "SKIP: mcp-server source not present; reusing artifacts\mcp-server\navisworks-mcp.mjs."
}

& $msbuild $pluginProject /restore /t:Rebuild `
    "/p:Configuration=$Configuration" `
    /p:Platform=x64 `
    "/p:NavisworksPath=$NavisworksPath" `
    "/p:RestorePackagesPath=$nugetPackages" `
    /v:m
if ($LASTEXITCODE -ne 0) {
    throw "Navisworks plug-in build failed."
}

& $msbuild $testProject /restore /t:Rebuild `
    "/p:Configuration=$Configuration" `
    "/p:RestorePackagesPath=$nugetPackages" `
    /v:m
if ($LASTEXITCODE -ne 0) {
    throw "Protocol test build failed."
}

& $testExecutable
if ($LASTEXITCODE -ne 0) {
    throw "Protocol tests failed."
}

& (Join-Path $PSScriptRoot "package.ps1") `
    -Configuration $Configuration `
    -NavisworksPath $NavisworksPath
& (Join-Path $PSScriptRoot "verify.ps1")

Write-Output "BUILD_VERIFY: PASS"

