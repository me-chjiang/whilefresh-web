#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

api_key=""
if ! api_key="$(security find-generic-password -s landing-project-deepseek -w 2>/dev/null)"; then
    echo "未配置密钥，可使用演示模式" >&2
fi
export WHILEFRESH_DEEPSEEK_API_KEY="$api_key"
unset api_key

pnpm build && pnpm start
