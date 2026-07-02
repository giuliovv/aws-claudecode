#!/bin/bash
set -euo pipefail

: "${CLAUDE_TELEGRAM_BOT_TOKEN:?missing CLAUDE_TELEGRAM_BOT_TOKEN}"

export HOME=/home/ubuntu
export CLAUDE_MODEL="${CLAUDE_MODEL:-fable}"
export CLAUDE_WORKDIR="${CLAUDE_WORKDIR:-/home/ubuntu/giuliowd}"
export CLAUDE_ALLOWED_CHAT_ID="${CLAUDE_ALLOWED_CHAT_ID:-377533459}"
export CLAUDE_TASK_TIMEOUT_MS="${CLAUDE_TASK_TIMEOUT_MS:-1800000}"
export CLAUDE_APPEND_SYSTEM_PROMPT="${CLAUDE_APPEND_SYSTEM_PROMPT:-You are running unattended behind a Telegram bridge. Return concise final answers suitable for Telegram. If you need user input, ask for it explicitly in the final answer instead of waiting silently.}"

exec /usr/bin/node /home/ubuntu/aws-claudecode/bot/local-claude-telegram.js
