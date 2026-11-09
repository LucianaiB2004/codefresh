#!/usr/bin/env bash
# CodeFresh 发布准备脚本 —— 默认只做「准备 + 检查」，不会推送、不会建仓库、不会部署。
# 真正发布需要仓库主人确认后，手动执行脚本最后打印出的命令，或加 --yes-i-approved 运行。
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="${CODEFRESH_REPO:-LucianaiB2004/codefresh}"

echo "== 1/4 单元测试"; npm test --silent
echo "== 2/4 构建 GitHub Pages 产物"; node scripts/build-pages.mjs
echo "== 3/4 密钥扫描（含 dist/）"; node scripts/scan-secrets.mjs
echo "== 4/4 git 检查"
if git ls-files --error-unmatch .env >/dev/null 2>&1; then echo "✗ .env 被 git 跟踪，停止"; exit 1; fi
git status --short

cat <<EOF

准备完成。以下命令需要仓库主人确认后再执行（本脚本默认不执行）：

  gh repo create ${REPO} --public --source=. --remote=origin --description "CodeFresh 教程保质期 · AI 知识保鲜站"
  git push -u origin main
  # Pages：用 GitHub Actions 或 gh-pages 分支发布 dist/，例如：
  git subtree push --prefix dist origin gh-pages   # 需先临时提交 dist/，或改用 Actions
  gh api -X POST repos/${REPO}/pages -f "source[branch]=gh-pages" -f "source[path]=/"

EOF
if [[ "${1:-}" == "--yes-i-approved" ]]; then
  read -r -p "确认要推送到 ${REPO} 吗？输入 PUBLISH 继续：" ans
  [[ "$ans" == "PUBLISH" ]] || { echo "已取消"; exit 1; }
  echo "请逐条手动执行上面的命令（脚本有意不自动推送，避免误操作）。"
fi
