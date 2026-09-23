#!/usr/bin/env bash
# =============================================================================
# check-registry.sh — 代码 CUSTOM 标记 ↔ registry.md 改动总览 一致性自检
# 用法（Git Bash）：bash CUSTOMIZATIONS/scripts/check-registry.sh
# 退出码：0 一致；1 有差异（按提示修文档或补标记）
#
# 注意：本文件自身含 "CUSTOM-BEGIN" 字面量，会被扫描到；它由总览里的
#      「CUSTOMIZATIONS/scripts/（…）」聚合行以目录前缀方式覆盖，属预期行为。
# =============================================================================
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REGISTRY="${PROJECT_ROOT}/CUSTOMIZATIONS/registry.md"

# 收集代码中的 CUSTOM 标记：file -> 排序去重的 change-id 集合
# 排除：registry.md 自身、.md 文档（正文里会引用标记语法）、node_modules、release 产物
declare -A CODE_MARKERS=()
while IFS= read -r line; do
  file="${line%%:*}"
  rest="${line#*:}"
  id=""
  if [[ "$rest" =~ CUSTOM-([0-9]{8}-[0-9]{3}) ]]; then
    id="CUSTOM-${BASH_REMATCH[1]}"
  else
    continue
  fi
  # 归一化路径分隔符
  file="${file//\\//}"
  CODE_MARKERS["$file"]+="$id "
done < <(grep -rn "CUSTOM-BEGIN" \
  --include="*.ts" --include="*.sh" --include="*.json" --include="*.yml" --include="*.yaml" \
  --include=".gitignore" --include=".vscodeignore" \
  "${PROJECT_ROOT}/src" "${PROJECT_ROOT}/CUSTOMIZATIONS" "${PROJECT_ROOT}/.github" \
  "${PROJECT_ROOT}/.gitignore" "${PROJECT_ROOT}/.vscodeignore" 2>/dev/null \
  | grep -v node_modules | grep -v "\.test\." | grep -v "registry.md" || true)

# 从 registry.md 改动总览表收集已登记文件
# 总览表以「## 改动总览」开头、「## 变更日志」结尾
# DOC_FILES: 精确文件路径（参与 §2 严格校验）
# DOC_PREFIXES: 目录前缀（聚合行/通配行，仅参与 §1 前缀匹配）
declare -A DOC_FILES=()
declare -A DOC_PREFIXES=()
in_table=false
while IFS= read -r line; do
  if [[ "$line" == "## 改动总览"* ]]; then in_table=true; continue; fi
  if [[ "$line" == "## 变更日志"* ]]; then break; fi
  if $in_table && [[ "$line" == \|* ]]; then
    # 整行标记为「未改动 / 非改动」的行是"故意保留"的说明行，不要求代码标记
    [[ "$line" == *未改动* || "$line" == *非改动* ]] && continue
    file="$(echo "$line" | awk -F'|' '{gsub(/^ +| +$/, "", $2); print $2}')"
    [[ "$file" == "" || "$file" == 文件* || "$file" == --* ]] && continue
    # 聚合行「DIR/（a、b、c）」或通配「DIR/*」：登记目录前缀
    if [[ "$file" == *"（"* || "$file" == *"*"* ]]; then
      prefix="${file%%（*}"; prefix="${prefix%%\**}"
      prefix="$(echo "$prefix" | sed 's/^ *//;s/ *$//')"
      [[ "$prefix" == */ || "$prefix" == "" ]] && DOC_PREFIXES["${prefix%/}"]=1 || DOC_PREFIXES["$prefix"]=1
      continue
    fi
    # 一行聚合多个文件（、分隔）时拆开逐个登记
    IFS='、' read -r -a parts <<< "$file"
    for p in "${parts[@]}"; do
      p="$(echo "$p" | sed 's/^ *//;s/ *$//')"
      [[ "$p" == "" ]] && continue
      DOC_FILES["$p"]=1
    done
  fi
done < "${REGISTRY}"

errors=0
echo "== 1) 代码里有 CUSTOM 标记但总览表未登记（或路径写法对不上）=="
for file in "${!CODE_MARKERS[@]}"; do
  rel="${file#"${PROJECT_ROOT}/"}"
  found=0
  for doc in "${!DOC_FILES[@]}"; do
    [[ "$rel" == "$doc" ]] && { found=1; break; }
    # 相对通配行
    if [[ "$doc" == *"*"* ]]; then
      wprefix="${doc%%\**}"
      [[ "$rel" == "${wprefix}"* ]] && { found=1; break; }
    fi
  done
  if [[ $found -eq 0 ]]; then
    for prefix in "${!DOC_PREFIXES[@]}"; do
      [[ "$rel" == "${prefix}"/* || "$rel" == "$prefix" ]] && { found=1; break; }
    done
  fi
  if [[ $found -eq 0 ]]; then
    echo "  [MISSING-IN-DOC] $rel  (标记: $(echo "${CODE_MARKERS[$file]}" | tr ' ' '\n' | sort -u | tr '\n' ' '))"
    errors=$((errors+1))
  fi
done
[[ $errors -eq 0 ]] && echo "  (全部已登记)"

echo ""
echo "== 2) 总览表登记的文件但代码里找不到对应标记 =="
# 仅校验精确路径行；纯自定义路径（上游不存在）、测试文件、JSON（无注释）不要求标记
is_custom_only() {
  case "$1" in
    CUSTOMIZATIONS/*|.agents/*|AGENTS.md) return 0 ;;
    .gitignore|.vscodeignore) return 0 ;;
    package.json|package-lock.json) return 0 ;;
    *.test.*) return 0 ;;
    *) return 1 ;;
  esac
}
for doc in "${!DOC_FILES[@]}"; do
  is_custom_only "$doc" && continue
  abs="${PROJECT_ROOT}/${doc}"
  if [[ ! -f "$abs" ]]; then
    echo "  [FILE-NOT-FOUND] $doc"
    errors=$((errors+1))
    continue
  fi
  if ! grep -q "CUSTOM-BEGIN" "$abs" 2>/dev/null; then
    echo "  [NO-MARKER] $doc（若确属无标记的已知缺口，请在总览标注「已知无标记缺口」）"
    errors=$((errors+1))
  fi
done
[[ $errors -eq 0 ]] && echo "  (全部匹配)"

echo ""
echo "== 3) 命名空间卫生：src/ 与 package.json 不应残留上游 acp.* 标识符 =="
# 只查"全局可冲突标识符"的典型形态；允许：协议名 ACP、包名 agentclientprotocol、
# 标记注释文本、以及两处故意保留（Memento key / clientInfo name）
NS_HITS=$(grep -rn "registerCommand('acp\.\|executeCommand('acp\.\|getConfiguration('acp')\|createTreeView('acp-\|createOutputChannel('ACP Client')\|createOutputChannel('ACP Traffic')\|'acp-sessions'\|'acp-chat'\|== acp-sessions\|== acp-chat\|command:acp\." \
  "${PROJECT_ROOT}/src" "${PROJECT_ROOT}/package.json" 2>/dev/null || true)
if [[ -n "$NS_HITS" ]]; then
  echo "$NS_HITS" | sed 's/^/  [NS-RESIDUE] /'
  errors=$((errors+$(echo "$NS_HITS" | wc -l)))
else
  echo "  (无残留)"
fi

echo ""
echo "== 4) 换行符卫生：上游共有文件必须为 CRLF（纯自定义文件保持 LF）=="
# 上游以 CRLF 入库；若被编辑工具转成 LF，会产生整文件伪差异并毁掉三方合并能力。
# 反向也成立：CUSTOMIZATIONS/ 下的 .sh 若被转成 CRLF，在 Linux/macOS 上会执行失败。
# 详见 .gitattributes 与 CUSTOMIZATIONS/docs/pitfalls.md #7。
if command -v node >/dev/null 2>&1; then
  if ! node "$PROJECT_ROOT/CUSTOMIZATIONS/scripts/normalize-eol.mjs" --check > /tmp/eol-check.txt 2>&1; then
    grep "\[LF\]" /tmp/eol-check.txt | sed 's/^/  [EOL-RESIDUE]/' || true
    echo "  → 运行 node CUSTOMIZATIONS/scripts/normalize-eol.mjs 修正"
    errors=$((errors+1))
  else
    echo "  (全部 CRLF)"
  fi
else
  echo "  (跳过：未找到 node)"
fi

echo ""
if [[ $errors -eq 0 ]]; then
  echo "[OK] 代码标记与改动总览一致（$(echo "${#CODE_MARKERS[@]}") 个含标记文件均已登记；命名空间无残留；换行符一致）"
  exit 0
else
  echo "[DIFF] 发现 $errors 处不一致——修文档（路径写法对齐）或补代码标记后重跑"
  exit 1
fi
