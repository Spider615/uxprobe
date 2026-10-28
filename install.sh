#!/usr/bin/env bash
# 安装 uxprobe：给 Claude Code / Codex / ~/.agents 接上使用说明（skill/），把 uxprobe 命令放上 PATH（~/.local/bin/uxprobe）。
# 全用软链：git pull 之后自动生效；可以重复执行。别人放在这些位置的东西一律不动，只提示。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
NAME="uxprobe"
SKILL_SRC="${ROOT}/skill"
BIN_SRC="${ROOT}/bin/uxprobe"
CLAUDE_SKILLS="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/skills"
CODEX_SKILLS="${CODEX_HOME:-${HOME}/.codex}/skills"
AGENTS_SKILLS="${AGENTS_SKILLS_DIR:-${HOME}/.agents/skills}"
BIN_LINK="${HOME}/.local/bin/uxprobe"

skipped=""
link() {
  local target="$1" dest="$2" current
  mkdir -p "$(dirname "${dest}")"
  if [ -L "${dest}" ]; then
    current="$(readlink "${dest}")"
    if [ "${current}" = "${target}" ]; then echo "  已存在 ${dest}"; return; fi
    # 指向另一份 uxprobe 仓库（挪过位置）或已经不存在：改指
    if [ ! -e "${dest}" ] || grep -Eq "^name:[[:space:]]*${NAME}[[:space:]]*$" "${current}/SKILL.md" 2>/dev/null || [ -f "$(dirname "${current}")/uxprobe.mjs" ]; then
      rm "${dest}"; ln -s "${target}" "${dest}"; echo "  改指 ${dest} -> ${target}（原来指向 ${current}）"; return
    fi
    echo "  ⚠️ 跳过 ${dest}：它指向 ${current}，不是 uxprobe，没动它"; skipped="${skipped} ${dest}"; return
  fi
  if [ -e "${dest}" ]; then echo "  ⚠️ 跳过 ${dest}：那里已有别的文件，没动它"; skipped="${skipped} ${dest}"; return; fi
  ln -s "${target}" "${dest}"
  echo "  链接 ${dest} -> ${target}"
}

echo "安装 uxprobe（${ROOT}）"
if [ ! -d "${ROOT}/node_modules/playwright" ]; then
  echo "  安装依赖…"
  "${BIN_SRC}" --version >/dev/null 2>&1 || true
  ( cd "${ROOT}" && PATH="$(dirname "$("${ROOT}/bin/uxprobe" --node-path)"):${PATH}" npm install --no-audit --no-fund >/dev/null )
fi
chmod +x "${BIN_SRC}" "${ROOT}/bin/uxprobe.mjs"
link "${SKILL_SRC}" "${CLAUDE_SKILLS}/${NAME}"
link "${SKILL_SRC}" "${CODEX_SKILLS}/${NAME}"
link "${SKILL_SRC}" "${AGENTS_SKILLS}/${NAME}"
link "${BIN_SRC}" "${BIN_LINK}"
mkdir -p "${HOME}/.uxprobe/configs"

case ":${PATH}:" in
  *":${HOME}/.local/bin:"*) ;;
  *) echo "⚠️ ${HOME}/.local/bin 不在 PATH 里：在 ~/.zshrc 加一行 export PATH=\"\$HOME/.local/bin:\$PATH\"，然后重开终端" ;;
esac
if [ -n "${skipped}" ]; then
  echo "没装全：${skipped# } 这些位置上有别人的东西，没动它们。确认不是你要的，挪走后再跑一次 ./install.sh"
  exit 1
fi
echo
"${BIN_LINK}" --version
echo "完成。新开一个 Claude Code 会话，说「检查一下这个项目的交互有没有 bug」会自动用 uxprobe（或输入 /${NAME}）。"
echo "更新：git pull 之后再跑一次 ./install.sh"
