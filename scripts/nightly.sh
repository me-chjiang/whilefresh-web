#!/usr/bin/env bash
set -euo pipefail

# ========== 配置 ==========
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLAN="${PLAN:-$PROJECT_DIR/docs/codex-plan.md}"
STATE_DIR="$PROJECT_DIR/.nightly"   # 被 git 忽略：日志与断点
REPORT_DIR="$STATE_DIR/logs"
CHECKPOINT="$STATE_DIR/checkpoint"
BRANCH="${BRANCH:-feat/round-2}"

PER_TASK=${PER_TASK:-900}        # 单次 codex 调用上限（秒）
MAX_ATTEMPTS=${MAX_ATTEMPTS:-2}  # 每步最多尝试次数，第二次会带上失败信息
TC_FROM=${TC_FROM:-0}            # 从该步起脚本额外跑 TC 复核

mkdir -p "$REPORT_DIR"

# ========== macOS timeout 兜底 ==========
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD=(timeout)
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD=(gtimeout)
else
  # perl alarm 超时以 SIGALRM 退出，退出码 142
  TIMEOUT_CMD=(perl -e 'alarm shift; exec @ARGV')
fi

# ========== 防睡眠（无需 sudo，脚本退出即失效）==========
if command -v caffeinate >/dev/null 2>&1; then
  caffeinate -dimsu -w $$ &
fi

# ========== plan 解析 ==========
get_preamble() {
  awk '/^## [0-9]+\./ { exit } { print }' "$PLAN"
}

get_step() {
  awk -v step="$1" '
    /^## [0-9]+\./ {
      if (found) exit
      if ($0 ~ "^## " step "\\.") found=1
      next
    }
    found { print }
  ' "$PLAN"
}

get_title() {
  sed -n "s/^## $1\. *//p" "$PLAN" | head -1
}

# ========== 主逻辑 ==========
cd "$PROJECT_DIR"

START=0
if [ -f "$CHECKPOINT" ]; then
  START=$(cat "$CHECKPOINT")
  echo "从步骤 $START 继续"
fi

LAST=$(sed -n 's/^## \([0-9]\{1,\}\)\..*/\1/p' "$PLAN" | sort -n | tail -1)
PREAMBLE=$(get_preamble)
echo "步骤范围 0..$LAST"

git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH"

RUN_ID="run-$(date +%Y%m%d-%H%M%S)"
REPORT="$REPORT_DIR/$RUN_ID.md"
{
  echo "# Nightly Run $(date)"
  echo "从步骤 $START 开始，共到步骤 $LAST"
} > "$REPORT"

ALL_DONE=0
i=$START
while [ "$i" -le "$LAST" ]; do
  TITLE=$(get_title "$i")
  STEP_CONTENT=$(get_step "$i")
  echo "=== 步骤 ${i}：$TITLE ===" | tee -a "$REPORT"

  if [ -z "$STEP_CONTENT" ]; then
    echo "步骤 $i 为空，跳过" | tee -a "$REPORT"
    i=$((i + 1)); echo "$i" > "$CHECKPOINT"
    continue
  fi

  # 最后一步 plan 自己要求提交，其余步骤由脚本提交
  if [ "$i" -eq "$LAST" ]; then
    COMMIT_RULE="本步骤按 plan 要求自行 git commit。"
  else
    COMMIT_RULE="不要执行 git commit，提交由外部脚本负责。"
  fi

  PASSED=0
  FEEDBACK=""
  for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
    LOG="$REPORT_DIR/$RUN_ID-step$i-try$attempt.log"
    LAST_MSG="$REPORT_DIR/$RUN_ID-step$i-try$attempt.last.md"

    PROMPT="你在无人值守的过夜流水线中，只执行 codex-plan 的步骤 ${i}，不做其他步骤。

$PREAMBLE

## $i. $TITLE
$STEP_CONTENT

要求：
- 完成后执行本步骤的「验证」命令。
- $COMMIT_RULE
- 回复的最后一行必须单独输出 STEP_RESULT: PASS 或 STEP_RESULT: FAIL（验证全部通过才算 PASS）。FAIL 时在前面简要写出失败原因与日志末尾。"
    if [ -n "$FEEDBACK" ]; then
      PROMPT="$PROMPT

上一次尝试失败，工作区保留了上次的改动，请在此基础上修复。失败信息：
$FEEDBACK"
    fi

    echo "-- 尝试 $attempt/${MAX_ATTEMPTS}（日志 $(basename "$LOG")）" | tee -a "$REPORT"

    set +e
    "${TIMEOUT_CMD[@]}" "$PER_TASK" codex exec \
      --cd "$PROJECT_DIR" \
      --dangerously-bypass-approvals-and-sandbox \
      --color never \
      --output-last-message "$LAST_MSG" \
      "$PROMPT" < /dev/null > "$LOG" 2>&1
    RC=$?
    set -e

    if [ $RC -eq 124 ] || [ $RC -eq 142 ]; then
      FEEDBACK="上次执行超时（${PER_TASK}s）。"
      echo "⏱ 超时" | tee -a "$REPORT"
      continue
    fi
    if [ $RC -ne 0 ]; then
      FEEDBACK="codex 退出码 ${RC}：
$(tail -20 "$LOG")"
      echo "❌ codex 退出码 $RC" | tee -a "$REPORT"
      tail -20 "$LOG" >> "$REPORT"
      continue
    fi

    RESULT=$(grep -o 'STEP_RESULT: [A-Z]*' "$LAST_MSG" 2>/dev/null | tail -1 || true)
    if [ "$RESULT" != "STEP_RESULT: PASS" ]; then
      FEEDBACK=$(tail -40 "$LAST_MSG" 2>/dev/null || echo "（无最终回复）")
      echo "❌ codex 报告：${RESULT:-无结果标记}" | tee -a "$REPORT"
      echo "$FEEDBACK" >> "$REPORT"
      continue
    fi

    if [ "$i" -ge "$TC_FROM" ]; then
      TC_LOG="$REPORT_DIR/$RUN_ID-step$i-try$attempt.tc.log"
      if ! pnpm typecheck > "$TC_LOG" 2>&1; then
        FEEDBACK="codex 报告 PASS，但外部复核 pnpm typecheck 失败：
$(tail -30 "$TC_LOG")"
        echo "❌ 外部 TC 复核失败" | tee -a "$REPORT"
        tail -30 "$TC_LOG" >> "$REPORT"
        continue
      fi
    fi

    PASSED=1
    break
  done

  if [ "$PASSED" -ne 1 ]; then
    echo "🛑 步骤 $i 失败 $MAX_ATTEMPTS 次，停止。工作区保留现场，修复后重跑会从步骤 $i 继续。" | tee -a "$REPORT"
    break
  fi

  echo "✅ 步骤 $i 通过" | tee -a "$REPORT"
  if [ "$i" -ne "$LAST" ] && [ -n "$(git status --porcelain)" ]; then
    git add -A
    git commit -q -m "chore: plan step $i - $TITLE" >> "$REPORT" 2>&1
    git log --oneline -1 | tee -a "$REPORT"
  fi

  i=$((i + 1))
  echo "$i" > "$CHECKPOINT"
  [ "$i" -gt "$LAST" ] && ALL_DONE=1
done

if [ "$ALL_DONE" -eq 1 ]; then
  rm -f "$CHECKPOINT"
  echo "🎉 全部步骤完成" | tee -a "$REPORT"
fi

echo "结束: $(date)" | tee -a "$REPORT"
