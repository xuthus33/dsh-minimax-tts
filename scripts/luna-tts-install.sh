#!/bin/bash
# luna-tts-install.sh — 安装 / 重装 / 卸载 @luna/dsh-minimax-tts
#
# 2026-11-06 建立（主人要求"音色用 MiniMax female-shaonv，要保持一致"）
#
# 🔴 为什么不用 `dsh plugin add`：
#    本机 profile 上跑 pnpm 会把 @deepseek-ai/* 挪进 node_modules/.ignored/
#    断掉软链桥 → 启动崩溃循环（2026-09-24 三天停机就是这个原因）。
#    见 skills/dsh-plugin-standards §0 死点 4。
#    本脚本只做两件事：cp 目录 + 手改 profile package.json 的两个字段。
#
# 🔴 改完必须重启界面（或 Ctrl+R）：写 profile 配置会触发重组，可能中断当前会话。
#    历史全在磁盘，不会丢。
#
# 用法：
#   bash luna-tts-install.sh                  # dry-run，只报告将做什么
#   bash luna-tts-install.sh --apply          # 真正安装/重装
#   bash luna-tts-install.sh --apply --uninstall
#   bash luna-tts-install.sh --apply --profile web

set -u

PKG="@luna/dsh-minimax-tts"
SRC="$HOME/.deepseek-harness/plugins/@luna/dsh-minimax-tts"
PROFILE_NAME="desktop"
APPLY=0
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --profile) PROFILE_NAME="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "未知参数: $1"; exit 2 ;;
  esac
done

PROFILE_DIR="$HOME/.dsh/profiles/$PROFILE_NAME"
PROFILE_JSON="$PROFILE_DIR/package.json"
DST="$PROFILE_DIR/node_modules/@luna/dsh-minimax-tts"

echo "=== $PKG · profile=$PROFILE_NAME · $([ $APPLY -eq 1 ] && echo 执行 || echo DRY-RUN) ==="

if [ ! -f "$PROFILE_JSON" ]; then echo "❌ 找不到 $PROFILE_JSON"; exit 1; fi

if [ $UNINSTALL -eq 0 ] && [ ! -d "$SRC" ]; then
  echo "❌ 找不到插件源目录 $SRC"; exit 1
fi

echo ""
echo "--- 计划 ---"
if [ $UNINSTALL -eq 1 ]; then
  echo "1. 从 $PROFILE_JSON 删除依赖与 bundle 条目"
  echo "2. 删除 $DST"
else
  echo "1. 复制 $SRC → $DST"
  echo "2. 在 $PROFILE_JSON 里登记 dependency + dsh.profile.bundles"
  echo "3. 校验：import 宿主半 / patch YAML / 条目唯一性"
fi

if [ $APPLY -eq 0 ]; then
  echo ""
  echo "（DRY-RUN：加 --apply 才真正执行）"
  exit 0
fi

echo ""
echo "⚠️  提醒：本次改动的是 profile 配置。界面可能需要 Ctrl+R 刷新或重开 App。"
echo "    历史保存在磁盘，不会丢失。"

STAMP=$(date +%Y%m%d-%H%M%S)
cp "$PROFILE_JSON" "$PROFILE_JSON.bak-luna-tts-$STAMP" || exit 1
echo "备份: $PROFILE_JSON.bak-luna-tts-$STAMP"

if [ $UNINSTALL -eq 1 ]; then
  python3 - "$PROFILE_JSON" "$PKG" <<'PY'
import json, sys
path, pkg = sys.argv[1], sys.argv[2]
d = json.load(open(path))
d.get("dependencies", {}).pop(pkg, None)
bundles = d.get("dsh", {}).get("profile", {}).get("bundles", [])
d["dsh"]["profile"]["bundles"] = [b for b in bundles if b != pkg]
open(path, "w").write(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
print("已从 profile 移除", pkg)
PY
  rm -rf "$DST" && echo "已删除 $DST"
  exit 0
fi

# ---- 安装 ----
rm -rf "$DST"
mkdir -p "$(dirname "$DST")"
cp -R "$SRC" "$DST" || { echo "❌ 复制失败"; exit 1; }
echo "已复制到 $DST"

python3 - "$PROFILE_JSON" "$PKG" "$SRC" <<'PY'
import json, sys
path, pkg, src = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(path))
d.setdefault("dependencies", {})[pkg] = f"file:{src}"
bundles = d.setdefault("dsh", {}).setdefault("profile", {}).setdefault("bundles", [])
if pkg not in bundles:
    try:
        i = bundles.index("@luna/dsh-token-widget") + 1
    except ValueError:
        i = len(bundles)
    bundles.insert(i, pkg)
open(path, "w").write(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
print("已登记到 profile")
PY

echo ""
echo "--- 校验 ---"
node --input-type=module -e "
import('file://$DST/lib/index.js')
  .then(m => console.log('✅ 宿主半 import 成功:', m.name, m.version, JSON.stringify(m.inject)))
  .catch(e => { console.error('❌ 宿主半 import 失败:', e.message); process.exit(1) })
" || exit 1

node --check "$DST/lib/client.js" && echo "✅ 客户端半语法 OK"

python3 - "$DST/cordis.patch.yml" <<'PY'
import sys
try:
    import yaml
except ImportError:
    print("（无 pyyaml，跳过 patch 校验）"); raise SystemExit(0)
d = yaml.safe_load(open(sys.argv[1]))
if not d: print("❌ patch 为空 —— 会弄死启动"); raise SystemExit(1)
print("✅ patch 合法:", d[0]["insert"][0]["id"])
PY

python3 -c "import json;json.load(open('$PROFILE_JSON'));print('✅ profile package.json 合法')" || exit 1

echo ""
echo "✅ 完成。下一步："
echo "   1. 刷新界面（Ctrl+R）或重开 App"
echo "   2. 冒烟： curl -s http://127.0.0.1:53332/luna-tts/health"
echo "   3. 每条回复下方应出现「朗读」按钮"
