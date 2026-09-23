#!/usr/bin/env bash
# =============================================================================
# release-vsix.sh — 把源码打成 .vsix（终点：release/zouv.acp-client-custom-<版本>.vsix）
# 用法（Git Bash）：sh CUSTOMIZATIONS/scripts/release-vsix.sh 0.2.0-custom.1
#
# 只负责「源码 → 产物」。发布到 GitHub Release 用 acp-release skill 的后半段（gh release create）。
# =============================================================================
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT"

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "用法: sh CUSTOMIZATIONS/scripts/release-vsix.sh <版本号>"
  echo "示例: sh CUSTOMIZATIONS/scripts/release-vsix.sh 0.2.0-custom.1"
  echo ""
  echo "已有 tag："
  git tag -l "v*-custom.*" --sort=-v:refname | head -5 || echo "  (还没有)"
  exit 1
fi

# 版本号必须是合法 semver（vsce 会强校验）：<上游版本>-custom.<序号>
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-custom\.[0-9]+$ ]]; then
  echo "[错误] 版本号格式应为 <上游版本>-custom.<序号>，如 0.2.0-custom.1"
  echo "       收到: $VERSION"
  exit 1
fi

echo "=== 打包 .vsix：$VERSION ==="

echo ""
echo "[1/6] 分支与工作区检查"
BRANCH="$(git branch --show-current)"
if [[ "$BRANCH" != "custom/main" ]]; then
  echo "[错误] 必须在 custom/main 分支上打包（当前：$BRANCH）"
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "[错误] 工作区有未提交改动，请先提交或 stash："
  git status --short
  exit 1
fi
echo "  分支 custom/main，工作区干净 ✓"

echo ""
echo "[2/6] 写入 package.json 版本号 $VERSION"
node -e "
const fs=require('fs');
const p=JSON.parse(fs.readFileSync('package.json','utf8'));
const prev=p.version;
p.version='$VERSION';
fs.writeFileSync('package.json', JSON.stringify(p,null,2)+'\n');
console.log('  '+prev+' -> $VERSION');
"

echo ""
echo "[3/6] npm install（确保依赖与锁文件一致）"
npm install --silent

# npm 会把 package-lock.json 重写成 LF，与上游的 CRLF blob 不一致，
# 会产生整文件伪差异。这里立刻归一化回来（见 pitfalls #7）。
node CUSTOMIZATIONS/scripts/normalize-eol.mjs package-lock.json

echo ""
echo "[4/6] lint + 编译 + 测试"
npm run lint
npm run compile
npm test

echo ""
echo "[5/6] vsce package"
mkdir -p release
VSIX="release/zouv.acp-client-custom-${VERSION}.vsix"
rm -f "$VSIX"
npx @vscode/vsce package -o "$VSIX"

echo ""
echo "[6/6] 产物校验：确认自定义目录未被打进 .vsix"
if npx @vscode/vsce ls 2>/dev/null | grep -qiE "customizations|^\.agents|AGENTS\.md"; then
  echo "[错误] .vsix 中混入了自定义开发文件，检查 .vscodeignore"
  exit 1
fi
echo "  产物洁净 ✓"

echo ""
echo "=== 打包完成 ==="
echo "  产物: $VSIX"
echo "  大小: $(du -h "$VSIX" | cut -f1)"
echo ""
echo "下一步（acp-release skill 后半段）："
echo "  1. 写 CUSTOMIZATIONS/release-notes/v${VERSION}.md"
echo "  2. 更新 CUSTOMIZATIONS/registry.md 的 custom_version / last_release_* frontmatter"
echo "  3. git add package.json package-lock.json CUSTOMIZATIONS/registry.md CUSTOMIZATIONS/release-notes/"
echo "  4. git commit -m \"chore(release): bump version to v${VERSION}\""
echo "  5. git tag v${VERSION} && git push origin custom/main v${VERSION}"
echo "  6. gh release create v${VERSION} --title \"v${VERSION}\" --notes-file CUSTOMIZATIONS/release-notes/v${VERSION}.md \"$VSIX\""
