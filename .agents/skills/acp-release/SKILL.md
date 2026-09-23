---
name: "acp-release"
description: "Build and publish the custom ACP Client extension: version bump, lint/compile/test, vsce package, GitHub Release upload. Invoke when user asks to build, package, make a .vsix, or publish a release."
---

# ACP Client (Custom) 打包与发布 Skill

本 Skill 把自定义源码**打包成 `.vsix` 并发布到 GitHub Release**。
起点：干净的 `custom/main` 工作区；终点：GitHub Release 上的 `.vsix` 产物。

> **与 chatbox 的差异**：chatbox 把"源码→安装包"（release）与"安装包→GitHub"（publish）拆成两个 skill，
> 因为 electron-builder 打安装包很重。本扩展用 `vsce package`，是秒级单命令，因此**合并为一个 skill**。

## 触发条件

- 用户说"打包"、"打个包"、"生成 .vsix"、"build"、"package"、"打 release 包"
- 用户说"发布到 GitHub"、"上传 release"、"传安装包"、"创建 Release"

## 参数收集

1. **版本号**：格式 `<上游版本>-custom.N`（N 为序号），例如 `0.2.0-custom.1`。
   - 用户未指定时，从已有 tag 读最大序号 +1：
     ```bash
     git tag -l "v*-custom.*" --sort=-v:refname | head -5
     ```
   - **必须在打包前定好**——它内嵌在 `package.json`、产物文件名与 Release 里。
   - 必须是合法 semver，`vsce` 会强校验；`release-vsix.sh` 也会先校验格式。
2. **是否发布**：只打包（本地出 `.vsix`）还是同时发布到 GitHub Release。默认**打包后停下来**，发布前再确认。

## 前置检查

```bash
git branch --show-current    # 必须在 custom/main
git status --porcelain       # 必须干净（release-vsix.sh 会拦）
```

工作区不干净 → 先让用户提交或 stash。**不要在脏工作区上打包**。

同时确认 registry.md 里的自定义改动都已登记（`node CUSTOMIZATIONS/scripts/check-registry.mjs` 全绿）。

---

## 执行流程

### 1. 定版本号并写入 package.json

```bash
node -e "
const fs=require('fs');
const p=JSON.parse(fs.readFileSync('package.json','utf8'));
console.log('当前版本:', p.version);
"
# 目标版本 = <上游 version>-custom.<已有最大序号+1>
```

`release-vsix.sh` 会自动写入 `package.json` 的 `version`，无需手改。

### 2. 写 release notes

新建 `CUSTOMIZATIONS/release-notes/v<版本>.md`，结构参考：

```markdown
# v0.2.0-custom.1

基于上游 formulahendry/vscode-acp <上游版本>（commit <短 hash>）

## 本版本自定义改动

- <change-id>：<一句话>

## 与上游并存的说明

本扩展的命令前缀为 `acpc.*`（上游为 `acp.*`），扩展 id 为 `zouv.acp-client-custom`，
可与上游 `formulahendry.acp-client` 同时安装、独立配置。

## 安装

下载下方的 `zouv.acp-client-custom-<版本>.vsix`，然后：
code --install-extension zouv.acp-client-custom-<版本>.vsix
```

### 3. 打包（构建 + lint + 测试 + vsce）

```bash
bash CUSTOMIZATIONS/scripts/release-vsix.sh <版本>
```

该脚本依次执行：分支/工作区检查 → 写版本号 → `npm install` → `npm run lint` → `npm run compile` →
`npm test`（拉起真实 VS Code Extension Host）→ `npx @vscode/vsce package` → 校验产物洁净 →
输出 `release/zouv.acp-client-custom-<版本>.vsix`。

**任何一步失败都必须停下**，不要跳过测试强行打包。

### 4. 更新 registry.md frontmatter

| 字段 | 新值 |
|---|---|
| `custom_version` | `<版本>`（不含 `v` 前缀） |
| `last_release_version` | `v<版本>` |
| `last_release_date` | 今天 |

### 5. 提交与打 tag（需用户明确同意）

```bash
git add package.json package-lock.json CUSTOMIZATIONS/registry.md CUSTOMIZATIONS/release-notes/
git commit -m "chore(release): bump version to v<版本>"
git tag v<版本>
git push origin custom/main
git push origin v<版本>
```

> **打 tag 前务必确认提交已定稿**——`git tag` 后不要再用 `--amend` 改提交，
> 否则 tag 会悬在游离提交上（见 chatbox 的同类坑）。要改就删 tag 重打。

### 6. 发布到 GitHub Release

```bash
gh release create v<版本> \
  --title "v<版本>" \
  --notes-file CUSTOMIZATIONS/release-notes/v<版本>.md \
  "release/zouv.acp-client-custom-<版本>.vsix"
```

> **本仓库是 fork，`gh` 默认可能认上游仓库。** 务必显式指定仓库：
> ```bash
> gh release create v<版本> -R zouv/custom-vscode-acp --title ... --notes-file ... "<vsix>"
> ```
> 或先 `gh repo set-default zouv/custom-vscode-acp`。

**幂等性**：若 Release 已存在，用 `gh release upload v<版本> "<vsix>" --clobber` 覆盖产物，
或 `gh release edit v<版本> --notes-file ...` 更新说明。

### 7. 验证发布

```bash
gh release view v<版本> -R zouv/custom-vscode-acp
gh release download v<版本> -R zouv/custom-vscode-acp -p "*.vsix" -D /tmp/verify
code --install-extension /tmp/verify/zouv.acp-client-custom-<版本>.vsix
```

确认：Release 页有 `.vsix` 资产、大小与本地一致；本地能装上并能激活。

---

## 重要约束

1. **不在脏工作区打包**；不在非 `custom/main` 分支打包（脚本会拦）。
2. **不跳过测试**——`npm test` 是命名空间正确性的自动化兜底。
3. **未经用户明确指示不 push / 不发 Release**（见根 AGENTS.md 禁止操作第一条）。打包产物先给用户确认，再发布。
4. **发 Release 必须带 `-R zouv/custom-vscode-acp`**，防止误发到上游仓库。
5. **tag 一旦推送就不要改写**。
6. 本仓库**不发布到 VS Code Marketplace / Open VSX**（如需发布，另议 publisher 与 PAT，且注意上游 `publish.yml` 的遗留配置）。

## 输出要求

向用户报告：
- 版本号与产物路径、大小
- `npm run lint` / `compile` / `test` 的实际结果（测试通过数）
- `.vsix` 内容校验结果（不含 CUSTOMIZATIONS/ 等开发文件）
- registry.md frontmatter 更新情况
- 若已发布：Release URL 与资产清单
