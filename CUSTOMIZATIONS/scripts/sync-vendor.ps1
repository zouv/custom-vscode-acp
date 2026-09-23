#!/usr/bin/env pwsh
<#
.SYNOPSIS
    把 vendor/main 同步到上游指定 ref。
.DESCRIPTION
    上游 formulahendry/vscode-acp 没有版本 tag，因此用 -Ref 指定 commit hash 或分支
    （对应 chatbox 版本的 -Version）。只在 vendor/main 上做 fast-forward，不产生新提交。
    同步后 vendor/main 即为新的上游基线，custom/main 的合并由 acp-merge-upstream skill 负责。
.PARAMETER Ref
    目标 ref：commit hash 或 upstream/main（默认 upstream/main）。
.PARAMETER Push
    同步后推送到 origin/vendor/main。
.EXAMPLE
    pwsh ./CUSTOMIZATIONS/scripts/sync-vendor.ps1
    pwsh ./CUSTOMIZATIONS/scripts/sync-vendor.ps1 -Ref 1a2b3c4 -Push
#>

param(
    [string]$Ref = "upstream/main",
    [switch]$Push
)

$ErrorActionPreference = "Stop"

Write-Host "=== 同步 vendor/main ===" -ForegroundColor Cyan

$currentBranch = git branch --show-current
if ($currentBranch -ne "vendor/main") {
    Write-Error "必须在 vendor/main 分支上执行（当前：$currentBranch）"
    exit 1
}

# 工作区必须干净
$dirty = git status --porcelain
if ($dirty) {
    Write-Error "工作区有未提交改动，请先处理：`n$dirty"
    exit 1
}

Write-Host "`n[1/3] 拉取上游..." -ForegroundColor Yellow
git fetch upstream --tags

$targetHash = git rev-parse $Ref
if ($LASTEXITCODE -ne 0) {
    Write-Error "无法解析 ref: $Ref"
    exit 1
}
Write-Host "  目标 ref: $Ref -> $targetHash"

Write-Host "`n[2/3] fast-forward..." -ForegroundColor Yellow
git merge --ff-only $Ref
if ($LASTEXITCODE -ne 0) {
    Write-Error "无法 fast-forward —— vendor/main 可能已被本地提交污染（它应当始终是上游镜像）"
    exit 1
}

Write-Host "`n[3/3] 推送..." -ForegroundColor Yellow
if ($Push) {
    git push origin vendor/main
    Write-Host "  已推送到 origin/vendor/main"
} else {
    Write-Host "  已跳过（加 -Push 才会推送）"
}

Write-Host "`n=== 同步完成 ===" -ForegroundColor Green
Write-Host "vendor/main 现在指向: $targetHash"
Write-Host ""
Write-Host "下一步：用 acp-merge-upstream skill 把上游改动合并进 custom/main"
Write-Host "（提醒：合并后必须重新执行 acp.* -> acpc.* 命名空间扫描）"
