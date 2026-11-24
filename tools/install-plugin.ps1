<#
.SYNOPSIS
    把本地构建的 Quality Center 插件安装到 IntelliJ IDEA，并在需要时重启 IDE。

.DESCRIPTION
    1) 自动定位构建产物 zip（idea-plugin\build\distributions 下最新的 quality-center-idea-*.zip）
    2) 自动定位 IDEA 的配置目录（%APPDATA%\JetBrains\IntelliJIdea<版本>），可在 -ConfigRoot 覆盖
    3) 解压到 <config>\plugins\quality-center-idea，覆盖旧版本
    4) 从 disabled_plugins.txt 里移除本插件 id，避免被禁用
    5) 若 IDEA 正在运行：先优雅关闭，装完再启动（-NoRestart 可跳过）

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\install-plugin.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\install-plugin.ps1 -Zip "D:\...\quality-center-idea-0.1.12.zip" -NoRestart
#>
[CmdletBinding()]
param(
    [string]$Zip = "",
    [string]$IdeaHome = "D:\Tools\IntelliJ IDEA 2026.3",
    [string]$ConfigRoot = "",
    [string]$PluginId = "com.dsda56180.qualitycenter",
    [string]$PluginFolder = "quality-center-idea",
    [switch]$NoRestart,
    [switch]$KeepBackup
)

$ErrorActionPreference = "Stop"

function Fail($message) {
    Write-Host "[ERROR] $message" -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------- 1. 构建产物
if ([string]::IsNullOrWhiteSpace($Zip)) {
    $dist = Join-Path (Split-Path -Parent $PSScriptRoot) "idea-plugin\build\distributions"
    if (-not (Test-Path $dist)) { Fail "找不到构建目录：$dist，请先执行 gradle buildPlugin" }
    $Zip = Get-ChildItem $dist -Filter "quality-center-idea-*.zip" |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $Zip -or -not (Test-Path $Zip)) { Fail "插件包不存在：$Zip" }
Write-Host "插件包：$Zip"

# ---------------------------------------------------------------- 2. IDEA 配置目录
if ([string]::IsNullOrWhiteSpace($ConfigRoot)) {
    $productInfo = Join-Path $IdeaHome "product-info.json"
    if (-not (Test-Path $productInfo)) { Fail "IDEA 目录不正确（缺少 product-info.json）：$IdeaHome" }
    $version = (Get-Content $productInfo -Raw | ConvertFrom-Json).version   # 例如 2026.3
    $configName = "IntelliJIdea$version"
    $candidate = Join-Path $env:APPDATA "JetBrains\$configName"
    if (-not (Test-Path $candidate)) {
        # 版本文件夹名可能带后缀，退化为模糊匹配
        $candidate = Get-ChildItem (Join-Path $env:APPDATA "JetBrains") -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "IntelliJIdea$($version.Split('.')[0])*" } |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $candidate) { Fail "找不到 IDEA 配置目录，请用 -ConfigRoot 指定" }
    $ConfigRoot = $candidate
}
Write-Host "配置目录：$ConfigRoot"

# ---------------------------------------------------------------- 3. 关闭运行中的 IDEA
$ideaExe = Join-Path $IdeaHome "bin\idea64.exe"
$wasRunning = $false
$targets = @(Get-Process -Name "idea64" -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $ideaExe })
if ($targets.Count -gt 0) {
    $wasRunning = $true
    if ($NoRestart) {
        Write-Host "[WARN] IDEA 正在运行，-NoRestart 下不会关闭它；插件要重启后才会生效。" -ForegroundColor Yellow
    } else {
        Write-Host "正在关闭 IDEA（会尽量优雅退出，最多等 30 秒）..."
        foreach ($p in $targets) { $null = $p.CloseMainWindow() }
        $deadline = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $deadline -and @(Get-Process -Name "idea64" -ErrorAction SilentlyContinue |
                Where-Object { $_.Path -eq $ideaExe }).Count -gt 0) {
            Start-Sleep -Milliseconds 500
        }
        $still = @(Get-Process -Name "idea64" -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -eq $ideaExe })
        if ($still.Count -gt 0) {
            Write-Host "[WARN] IDEA 未在 30 秒内退出，强制结束进程（未保存的改动请自行确认）" -ForegroundColor Yellow
            $still | Stop-Process -Force
            Start-Sleep -Seconds 2
        }
    }
} else {
    Write-Host "IDEA 当前未运行，安装完成后下次启动生效。"
}

# ---------------------------------------------------------------- 4. 解压安装
$pluginsDir = Join-Path $ConfigRoot "plugins"
New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null
$target = Join-Path $pluginsDir $PluginFolder

if (Test-Path $target) {
    if ($KeepBackup) {
        $backupDir = Join-Path $pluginsDir ".backup"
        New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
        $backup = Join-Path $backupDir ("$PluginFolder-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
        Move-Item $target $backup
        Write-Host "旧版本已备份到：$backup"
    } else {
        Remove-Item $target -Recurse -Force
    }
}

$temp = Join-Path $env:TEMP ("qc-plugin-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $temp | Out-Null
try {
    Expand-Archive -Path $Zip -DestinationPath $temp -Force
    $inner = Join-Path $temp $PluginFolder
    if (-not (Test-Path $inner)) {
        # 兜底：zip 顶层目录名与预期不同时，取唯一的一级目录
        $inner = Get-ChildItem $temp -Directory | Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $inner -or -not (Test-Path $inner)) { Fail "插件包结构异常：解压后找不到插件目录" }
    Move-Item $inner $target
} finally {
    Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
}

$jar = Get-ChildItem (Join-Path $target "lib") -Filter "quality-center-idea-*.jar" -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not $jar) { Fail "安装后未找到插件 jar，请检查 $target\lib" }
Write-Host "已安装：$($jar.FullName)"

# ---------------------------------------------------------------- 5. 从禁用列表中移除
$disabled = Join-Path $ConfigRoot "disabled_plugins.txt"
if (Test-Path $disabled) {
    $lines = Get-Content $disabled
    if ($lines -contains $PluginId) {
        $lines | Where-Object { $_ -ne $PluginId } | Set-Content $disabled -Encoding UTF8
        Write-Host "已从 disabled_plugins.txt 移除 $PluginId"
    }
}

# ---------------------------------------------------------------- 6. 重启 IDEA
# 重要：脚本可能被一个环境变量被裁剪过的父进程（如 AI 沙箱里的 shell）调用，
# 那样 Start-Process 拉起的 IDEA 会继承残缺的 PATH，插件里所有 "git/mvn/cmd" 调用都会失败。
# 启动前用注册表里的机器级 + 用户级 PATH 把环境补回来。
function Repair-PathEnv {
    $machinePath = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -ErrorAction SilentlyContinue).Path
    $userPath = (Get-ItemProperty 'HKCU:\Environment' -ErrorAction SilentlyContinue).Path
    $parts = @()
    foreach ($p in @($machinePath, $userPath, $env:PATH)) {
        if ($p) { $parts += $p.TrimEnd(';') }
    }
    $env:PATH = ($parts -join ';')
}

if ($wasRunning -and -not $NoRestart) {
    Repair-PathEnv
    Write-Host "正在启动 IDEA..."
    Start-Process -FilePath $ideaExe -WorkingDirectory $IdeaHome | Out-Null
    Write-Host "IDEA 已启动，插件已生效。"
} elseif (-not $wasRunning) {
    Write-Host "完成。下次打开 IDEA 时插件生效。"
}

Write-Host ""
Write-Host "提示：插件 id = $PluginId，安装目录 = $target" -ForegroundColor Green
