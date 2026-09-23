#!/usr/bin/env pwsh
<#
.SYNOPSIS
    查看当前自定义改动清单。
.DESCRIPTION
    从 registry.md frontmatter 读取 vendor_branch 作为基线，展示：
      1) 相对上游基线的文件改动统计
      2) 代码中所有 [CUSTOM-BEGIN] 标记的 change-id 分布
      3) registry.md 改动总览的条目数
.EXAMPLE
    pwsh ./CUSTOMIZATIONS/scripts/list-custom.ps1
#>

$ErrorActionPreference = "Stop"

$registry = "CUSTOMIZATIONS/registry.md"
if (-not (Test-Path $registry)) {
    Write-Error "未找到 $registry"
    exit 1
}

$content = Get-Content $registry -Raw -Encoding UTF8

$vendorBranch = if ($content -match '(?m)^vendor_branch:\s*"([^"]*)"') { $Matches[1] } else { "vendor/main" }
$upstreamVersion = if ($content -match '(?m)^current_upstream_version:\s*"([^"]*)"') { $Matches[1] } else { "?" }
$upstreamCommit = if ($content -match '(?m)^current_upstream_commit:\s*"([^"]*)"') { $Matches[1] } else { "?" }
$customVersion = if ($content -match '(?m)^custom_version:\s*"([^"]*)"') { $Matches[1] } else { "?" }

Write-Host "=== 自定义改动总览 ===" -ForegroundColor Cyan
Write-Host "  上游版本:   $upstreamVersion"
Write-Host "  上游 commit: $upstreamCommit"
Write-Host "  vendor 基线: $vendorBranch"
Write-Host "  自定义版本: $customVersion"
Write-Host ""

Write-Host "[1] 相对上游基线的改动统计" -ForegroundColor Yellow
git diff --stat "$vendorBranch...HEAD"
Write-Host ""

Write-Host "[2] 代码中的 CUSTOM 标记分布" -ForegroundColor Yellow
$markers = git grep -n "CUSTOM-BEGIN" -- "src/*" "CUSTOMIZATIONS/*" 2>$null
if ($markers) {
    $ids = $markers | ForEach-Object {
        if ($_ -match 'CUSTOM-(\d{8}-\d{3})') { "CUSTOM-$($Matches[1])" }
    } | Where-Object { $_ } | Sort-Object -Unique
    Write-Host ("  change-id: " + ($ids -join ", "))
    Write-Host "  含标记文件数: $(($markers | ForEach-Object { ($_ -split ':')[0] } | Sort-Object -Unique).Count)"
} else {
    Write-Host "  (无标记)"
}
Write-Host ""

Write-Host "[3] registry.md 改动总览条目数" -ForegroundColor Yellow
$overviewRowCount = 0
$inTable = $false
foreach ($line in ($content -split "`n")) {
    if ($line -match '^## 改动总览') { $inTable = $true; continue }
    if ($line -match '^## 变更日志') { break }
    if ($inTable -and $line.StartsWith('|') -and $line -notmatch '文件\s*\|' -and $line -notmatch '^\|[\s\-:|]+\|$') {
        $overviewRowCount++
    }
}
Write-Host "  $overviewRowCount 条"
Write-Host ""

Write-Host "一致性自检: sh CUSTOMIZATIONS/scripts/check-registry.sh" -ForegroundColor Green
