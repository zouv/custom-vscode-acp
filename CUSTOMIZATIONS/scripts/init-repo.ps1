#!/usr/bin/env pwsh
<#
.SYNOPSIS
    初始化 acp-client-custom 自定义开发仓库结构。
.DESCRIPTION
    在 clone 本仓库后一键配置 upstream remote、创建分支结构、初始化 CUSTOMIZATIONS 目录。
    与 chatbox 版本的差异：上游 formulahendry/vscode-acp **没有版本 tag**，
    因此基线固定为 upstream/main，vendor 分支固定为 vendor/main，
    registry 的 current_upstream_version 取上游 package.json 的 version 字段。
.PARAMETER UpstreamUrl
    上游仓库 URL
.PARAMETER Ref
    基线 ref，默认 upstream/main。可指定 commit hash。
#>

param(
    [string]$UpstreamUrl = "https://github.com/formulahendry/vscode-acp.git",
    [string]$Ref = "upstream/main"
)

$ErrorActionPreference = "Stop"

Write-Host "=== ACP Client (Custom) 自定义仓库初始化 ===" -ForegroundColor Cyan

if (-not (Test-Path ".git")) {
    Write-Error "当前目录不是 git 仓库"
    exit 1
}

if (-not (Test-Path "package.json")) {
    Write-Error "当前目录下未找到 package.json"
    exit 1
}

# [1] 配置 upstream
Write-Host "`n[1/6] 配置 upstream remote..." -ForegroundColor Yellow
$existingUpstream = git remote get-url upstream 2>$null
if ($LASTEXITCODE -eq 0 -and $existingUpstream) {
    Write-Host "  upstream 已存在: $existingUpstream"
    if ($existingUpstream -ne $UpstreamUrl) {
        git remote set-url upstream $UpstreamUrl
        Write-Host "  已更新为: $UpstreamUrl"
    }
} else {
    git remote add upstream $UpstreamUrl
    Write-Host "  已添加 upstream: $UpstreamUrl"
}

# [2] Fetch 上游
Write-Host "`n[2/6] 获取上游信息..." -ForegroundColor Yellow
git fetch upstream --tags

# 上游无 tag —— 基线固定 upstream/main，版本号取上游 package.json 的 version
$UpstreamVersion = (git show "$Ref`:package.json" | ConvertFrom-Json).version
if (-not $UpstreamVersion) {
    Write-Error "无法从 $Ref 读取 package.json 的 version"
    exit 1
}
Write-Host "  上游版本（package.json）：$UpstreamVersion"
$VendorBranch = "vendor/main"

# [3] 创建 vendor/main
Write-Host "`n[3/6] 创建 vendor 分支..." -ForegroundColor Yellow
$vendorExists = git rev-parse --verify "$VendorBranch" 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "  $VendorBranch 已存在"
} else {
    git checkout -b $VendorBranch $Ref
    Write-Host "  已创建 $VendorBranch (基于 $Ref)"
}
# vendor 分支是上游镜像，推送目标必须是 origin，绝不能误推到 upstream
git branch --set-upstream-to=origin/$VendorBranch $VendorBranch 2>$null | Out-Null

# [4] 创建 custom/main
Write-Host "`n[4/6] 创建 custom/main 分支..." -ForegroundColor Yellow
$customExists = git rev-parse --verify "custom/main" 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "  custom/main 已存在"
    git checkout custom/main
} else {
    git checkout -b custom/main $VendorBranch
    Write-Host "  已创建 custom/main"
}

# [5] 创建目录
Write-Host "`n[5/6] 创建目录结构..." -ForegroundColor Yellow
foreach ($d in @("CUSTOMIZATIONS/src", "CUSTOMIZATIONS/patches", "CUSTOMIZATIONS/scripts", "CUSTOMIZATIONS/release-notes", "CUSTOMIZATIONS/docs")) {
    if (-not (Test-Path $d)) {
        New-Item -ItemType Directory -Path $d -Force | Out-Null
        if (-not (Test-Path "$d/.gitkeep") -and $d -notlike "*release-notes") {
            New-Item -ItemType File -Path "$d/.gitkeep" -Force | Out-Null
        }
        Write-Host "  创建 $d/"
    }
}

# [6] CUSTOMIZATIONS/registry.md
Write-Host "`n[6/6] 初始化 CUSTOMIZATIONS/registry.md..." -ForegroundColor Yellow
if (-not (Test-Path "CUSTOMIZATIONS/registry.md")) {
    Write-Warning "未找到 CUSTOMIZATIONS/registry.md，请从已初始化的自定义仓库复制"
} else {
    $commitHash = git rev-parse $Ref
    $today = Get-Date -Format "yyyy-MM-dd"

    $content = Get-Content "CUSTOMIZATIONS/registry.md" -Raw -Encoding UTF8
    $content = [regex]::Replace($content, '(current_upstream_version:\s*")[^"]*(")', "`${1}$UpstreamVersion`${2}")
    $content = [regex]::Replace($content, '(current_upstream_commit:\s*")[^"]*(")', "`${1}$commitHash`${2}")
    $content = [regex]::Replace($content, '(vendor_branch:\s*")[^"]*(")', "`${1}$VendorBranch`${2}")
    $content = [regex]::Replace($content, '(last_merge_date:\s*")[^"]*(")', "`${1}$today`${2}")
    Set-Content "CUSTOMIZATIONS/registry.md" -Value $content -Encoding UTF8
    Write-Host "  CUSTOMIZATIONS/registry.md 元数据已更新"
    Write-Host "    current_upstream_version = $UpstreamVersion"
    Write-Host "    current_upstream_commit  = $commitHash"

    # 同步替换正文里的 {{...}} 占位符
    $content = Get-Content "CUSTOMIZATIONS/registry.md" -Raw -Encoding UTF8
    $content = $content -replace '\{\{current_upstream_version\}\}', $UpstreamVersion
    $content = $content -replace '\{\{current_upstream_commit\}\}', $commitHash
    $content = $content -replace '\{\{vendor_branch\}\}', $VendorBranch
    $content = $content -replace '\{\{last_merge_date\}\}', $today
    Set-Content "CUSTOMIZATIONS/registry.md" -Value $content -Encoding UTF8
}

Write-Host "`n=== 初始化完成 ===" -ForegroundColor Green
Write-Host "当前分支: $(git branch --show-current)"
Write-Host "Vendor 分支: $VendorBranch ($Ref)"
Write-Host ""
Write-Host "下一步："
Write-Host "  - 在 custom/main 上开发，完成后用 acp-record-change 记录改动"
Write-Host "  - 合并上游版本时用 acp-merge-upstream"
Write-Host "  - 打包发布时用 acp-release"
