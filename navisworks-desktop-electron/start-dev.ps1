[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectDirectory = [System.IO.Path]::GetFullPath($PSScriptRoot)
$electronViteCli = Join-Path $projectDirectory 'node_modules\electron-vite\bin\electron-vite.js'
$electronRuntime = Join-Path $projectDirectory 'node_modules\electron\dist\electron.exe'

function Wait-BeforeClose {
    param([string]$Prompt = '按 Enter 键关闭窗口')

    [void](Read-Host $Prompt)
}

function Stop-WithGuidance {
    param(
        [Parameter(Mandatory)]
        [string]$Message
    )

    Write-Host ''
    Write-Host $Message -ForegroundColor Yellow
    Write-Host ''
    Write-Host '请在本项目目录中依次执行：' -ForegroundColor Cyan
    Write-Host '  pnpm install'
    Write-Host '  pnpm rebuild electron'
    Write-Host ''
    Wait-BeforeClose
}

function Select-FirstExistingNodeExecutable {
    param([string[]]$Candidates)

    $seenPaths = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )

    foreach ($candidate in $Candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) {
            continue
        }

        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            continue
        }

        $fullPath = [System.IO.Path]::GetFullPath($candidate)
        if ($seenPaths.Add($fullPath)) {
            return [string]$fullPath
        }
    }

    return $null
}

$nodeCandidates = [System.Collections.Generic.List[string]]::new()
if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
    $nodeCandidates.Add((Join-Path $env:ProgramFiles 'nodejs\node.exe'))
}

$discoveredNodeCommands = @(Get-Command node.exe -CommandType Application -All -ErrorAction SilentlyContinue)
foreach ($command in $discoveredNodeCommands) {
    $candidatePath = if (-not [string]::IsNullOrWhiteSpace($command.Path)) {
        $command.Path
    }
    else {
        $command.Source
    }

    if (-not [string]::IsNullOrWhiteSpace($candidatePath)) {
        $nodeCandidates.Add([string]$candidatePath)
    }
}

$nodeExecutable = Select-FirstExistingNodeExecutable -Candidates $nodeCandidates.ToArray()
if ($null -eq $nodeExecutable) {
    Stop-WithGuidance '未找到系统 node.exe。请先安装 Node.js，再安装项目依赖。'
    return
}

if (-not (Test-Path -LiteralPath $electronViteCli -PathType Leaf)) {
    Stop-WithGuidance "项目本地 electron-vite CLI 不存在：$electronViteCli"
    return
}

if (-not (Test-Path -LiteralPath $electronRuntime -PathType Leaf)) {
    Stop-WithGuidance "Electron runtime 未完整落盘：$electronRuntime"
    return
}

Write-Host "项目目录：$projectDirectory" -ForegroundColor DarkGray
Write-Host '正在启动 Electron 开发模式…' -ForegroundColor Cyan

$processExitCode = 1
Push-Location -LiteralPath $projectDirectory
try {
    & $nodeExecutable $electronViteCli dev
    $processExitCode = $LASTEXITCODE
}
catch {
    Write-Host ''
    Write-Host "启动失败：$($_.Exception.Message)" -ForegroundColor Red
}
finally {
    Pop-Location
}

if ($processExitCode -ne 0) {
    Write-Host ''
    Write-Host "Electron 开发进程异常退出，退出码：$processExitCode" -ForegroundColor Red
    Wait-BeforeClose
}
