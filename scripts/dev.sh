#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

lexmount_config="${WHILEFRESH_LEXMOUNT_CONFIG:-$HOME/.config/lexmount/config.yaml}"

lexmount_config_value() {
    [[ -f "$lexmount_config" ]] || return 0
    sed -n -E "s/^$1:[[:space:]]*//p" "$lexmount_config" | head -n 1 \
        | sed -E "s/[[:space:]]+#.*$//; s/^[\"']//; s/[\"'][[:space:]]*$//; s/[[:space:]]+$//"
}

export_lexmount_credentials() {
    local key project
    key="$(lexmount_config_value api-key)"
    project="$(lexmount_config_value project-id)"
    export WHILEFRESH_LEXMOUNT_API_KEY="$key" WHILEFRESH_LEXMOUNT_PROJECT_ID="$project"
    if [[ -z "$key" || -z "$project" ]]; then
        echo "未配置 Lexmount，菜谱搜索不可用" >&2
    fi
}

export_lexmount_credentials

api_key=""
if ! api_key="$(security find-generic-password -s landing-project-deepseek -w 2>/dev/null)"; then
    echo "未配置密钥，可使用演示模式" >&2
fi
export WHILEFRESH_DEEPSEEK_API_KEY="$api_key"
unset api_key

pnpm dev
