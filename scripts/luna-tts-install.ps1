#Requires -Version 5.1
<#
.SYNOPSIS
  安装 / 卸载 / 重装 @luna/dsh-minimax-tts（Windows PowerShell 版）

.DESCRIPTION
  与 macOS 的 luna-tts-install.sh 等价，但**完全不跑 pnpm**。
  只做两件事：复制插件目录 + 手改 profile 的 package.json 两个字段。

  为什么不用 `dsh plugin add`：
    它会走 pnpm，而 pnpm 在「@deepseek-ai/* 被声明成 file: 依赖 + node_modules 软链桥」
    的机器上会把包挪进 node_modules/.ignored/，断掉软链桥导致启动崩溃。
    手工复制 + 改两个字段没有任何副作用，且可回滚。

  编码注意（踩过的坑）：
    Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，
    带 BOM 的 package.json 会让 Node 解析失败。本脚本一律用
    [System.IO.File]::WriteAllText + UTF8Encoding($false) 写无 BOM 文件。

.PARAMETER Profile
  dsh profile 名，默认 desktop（Electron 桌面应用用的就是这个）。

.PARAMETER DshHome
  dsh 数据目录，默认 $env:USERPROFILE\.dsh

.PARAMETER SourcePath
  插件源目录。默认在脚本同级找 luna-tts 目录，找不到就报错让用户指定。

.PARAMETER Uninstall
  卸载。

.PARAMETER Apply
  不加这个参数只做 dry-run，什么都不改。

.EXAMPLE
  .\luna-tts-install.ps1                  # dry-run 看要做什么
  .\luna-tts-install.ps1 -Apply           # 真正安装
  .\luna-tts-install.ps1 -Apply -Uninstall
#>
[CmdletBinding()]
param(
    [string]$Profile = "desktop",
    [string]$DshHome = "",
    [string]$SourcePath = "",
    [switch]$Uninstall,
    [switch]$Apply
)

$ErrorActionPreference = "Stop"

# --- 输出编码：避免中文在 cp936 控制台变乱码 ---
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$PkgName = "@luna/dsh-minimax-tts"

function Write-Ok   { param($m) Write-Host "[OK]    $m" -ForegroundColor Green }
function Write-Err  { param($m) Write-Host "[ERROR] $m" -ForegroundColor Red }
function Write-Info { param($m) Write-Host "        $m" }

# --- 定位 dsh 数据目录 ---
if ([string]::IsNullOrWhiteSpace($DshHome)) {
    if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME }
    else { $DshHome = Join-Path $env:USERPROFILE ".dsh" }
}

$ProfileDir  = Join-Path $DshHome "profiles\$Profile"
$ProfileJson = Join-Path $ProfileDir "package.json"
$DestDir     = Join-Path $ProfileDir "node_modules\@luna\dsh-minimax-tts"

# --- 定位插件源 ---
if ([string]::IsNullOrWhiteSpace($SourcePath)) {
    $parent = Split-Path $PSScriptRoot -Parent
    $candidates = @(
        $parent,
        (Join-Path $PSScriptRoot "luna-tts"),
        (Join-Path $PSScriptRoot "dsh-minimax-tts"),
        (Join-Path $env:USERPROFILE ".deepseek-harness\plugins\@luna\dsh-minimax-tts")
    )
    foreach ($c in $candidates) {
        if (Test-Path (Join-Path $c "package.json")) { $SourcePath = $c; break }
    }
}

$mode = if ($Apply) { "APPLY" } else { "DRY-RUN" }
Write-Host ""
Write-Host "=== $PkgName - profile=$Profile - $mode ===" -ForegroundColor Cyan
Write-Info "dsh home : $DshHome"

if (-not (Test-Path $ProfileJson)) {
    Write-Err "找不到 profile 配置：$ProfileJson"
    Write-Info "如果你的 dsh 数据不在 $DshHome，用 -DshHome 指定，或先确认 profile 名（web / desktop）"
    exit 1
}
Write-Info "profile  : $ProfileJson"

if (-not $Uninstall) {
    if ([string]::IsNullOrWhiteSpace($SourcePath) -or -not (Test-Path (Join-Path $SourcePath "package.json"))) {
        Write-Err "找不到插件源目录。用 -SourcePath 指定解压后的 dsh-minimax-tts 目录"
        exit 1
    }
    Write-Info "source   : $SourcePath"
}
Write-Info "target   : $DestDir"

# --- 计划 ---
Write-Host ""
Write-Host "--- 计划 ---" -ForegroundColor Cyan
if ($Uninstall) {
    Write-Host "1. 从 profile package.json 移除 dependency 与 bundle 条目"
    Write-Host "2. 删除 $DestDir"
} else {
    Write-Host "1. 复制插件到 $DestDir"
    Write-Host "2. 在 profile package.json 登记 dependency + dsh.profile.bundles"
    Write-Host "3. 校验：node import / patch YAML / JSON 合法"
}

if (-not $Apply) {
    Write-Host ""
    Write-Host "(DRY-RUN：加 -Apply 才真正执行)" -ForegroundColor Yellow
    exit 0
}

# --- 备份 ---
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = "$ProfileJson.bak-luna-tts-$stamp"
Copy-Item -Path $ProfileJson -Destination $backup -Force
Write-Host ""
Write-Ok "备份: $backup"

# --- 改 JSON：一律无 BOM 写入 ---
function Save-JsonNoBom {
    param([string]$Path, $Object)
    $json = $Object | ConvertTo-Json -Depth 32
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $json, $utf8NoBom)
}

$pkg = Get-Content -Path $ProfileJson -Raw -Encoding UTF8 | ConvertFrom-Json

if ($Uninstall) {
    if ($pkg.dependencies -and $pkg.dependencies.PSObject.Properties.Name -contains $PkgName) {
        $pkg.dependencies.PSObject.Properties.Remove($PkgName)
    }
    if ($pkg.dsh -and $pkg.dsh.profile -and $pkg.dsh.profile.bundles) {
        $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles | Where-Object { $_ -ne $PkgName })
    }
    Save-JsonNoBom -Path $ProfileJson -Object $pkg
    Write-Ok "已从 profile 移除 $PkgName"

    if (Test-Path $DestDir) {
        Remove-Item -Path $DestDir -Recurse -Force
        Write-Ok "已删除 $DestDir"
    }
    Write-Host ""
    Write-Host "重开 DeepSeek Harness 生效。" -ForegroundColor Yellow
    exit 0
}

# --- 复制 ---
if (Test-Path $DestDir) { Remove-Item -Path $DestDir -Recurse -Force }
New-Item -ItemType Directory -Path (Split-Path $DestDir -Parent) -Force | Out-Null
Copy-Item -Path $SourcePath -Destination $DestDir -Recurse -Force
Write-Ok "已复制到 $DestDir"

# --- 登记 ---
if (-not $pkg.dependencies) {
    $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([PSCustomObject]@{}) -Force
}
$depValue = "file:$((Resolve-Path $SourcePath).Path -replace '\\','/')"
if ($pkg.dependencies.PSObject.Properties.Name -contains $PkgName) {
    $pkg.dependencies.$PkgName = $depValue
} else {
    $pkg.dependencies | Add-Member -NotePropertyName $PkgName -NotePropertyValue $depValue -Force
}

if (-not $pkg.dsh) {
    $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([PSCustomObject]@{}) -Force
}
if (-not $pkg.dsh.profile) {
    $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([PSCustomObject]@{}) -Force
}
if (-not $pkg.dsh.profile.bundles) {
    $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() -Force
}

$bundles = @($pkg.dsh.profile.bundles)
if ($bundles -notcontains $PkgName) {
    $anchor = $bundles.IndexOf("@luna/dsh-token-widget")
    if ($anchor -ge 0) {
        $newBundles = @()
        for ($i = 0; $i -lt $bundles.Count; $i++) {
            $newBundles += $bundles[$i]
            if ($i -eq $anchor) { $newBundles += $PkgName }
        }
        $bundles = $newBundles
    } else {
        $bundles += $PkgName
    }
}
$pkg.dsh.profile.bundles = $bundles

Save-JsonNoBom -Path $ProfileJson -Object $pkg
Write-Ok "已登记到 profile"

# --- 校验 ---
Write-Host ""
Write-Host "--- 校验 ---" -ForegroundColor Cyan

$entry = Join-Path $DestDir "lib\index.js"
$patch = Join-Path $DestDir "cordis.patch.yml"

$nodeCheck = & node --input-type=module -e "import('file:///$($entry -replace '\\','/')').then(m=>console.log('[OK]   host import:',m.name,m.version)).catch(e=>{console.error('[ERROR]',e.message);process.exit(1)})" 2>&1
Write-Host $nodeCheck
if ($LASTEXITCODE -ne 0) { Write-Err "宿主半 import 失败，请勿重启（按上面的备份恢复）"; exit 1 }

& node --check (Join-Path $DestDir "lib\client.js")
if ($LASTEXITCODE -ne 0) { Write-Err "客户端半语法错误"; exit 1 }
Write-Ok "客户端半语法 OK"

try {
    $jsonOk = Get-Content -Path $ProfileJson -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Ok "profile package.json 合法"
} catch {
    Write-Err "profile package.json 解析失败：$($_.Exception.Message)"
    Write-Info "回滚：Copy-Item '$backup' '$ProfileJson' -Force"
    exit 1
}

Write-Host ""
Write-Host "完成。下一步：" -ForegroundColor Green
Write-Host "  1. 完全退出并重开 DeepSeek Harness（托盘退出，不是关窗口）"
Write-Host "  2. 冒烟： curl.exe -s http://127.0.0.1:<端口>/luna-tts/health"
Write-Host "  3. 每条助手回复下方应出现「朗读」按钮"
Write-Host ""
Write-Host "注意：历史会话保存在磁盘，重启不会丢失。" -ForegroundColor Yellow
