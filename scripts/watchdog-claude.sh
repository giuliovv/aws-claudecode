#!/bin/bash
set -euo pipefail

LOG=/home/ubuntu/watchdog.log
STATE=/home/ubuntu/.claude-watchdog-state
PANE=/tmp/claude-watchdog-pane.txt

log() {
  echo "$(date -Is): $*" >> "$LOG"
}

set_state() {
  local new_state="$1"
  local detail="${2:-}"
  local old_state=""
  [[ -f "$STATE" ]] && old_state="$(cat "$STATE" 2>/dev/null || true)"
  if [[ "$new_state" != "$old_state" ]]; then
    echo "$new_state" > "$STATE"
    log "state=$new_state ${detail}"
  fi
}

if ! systemctl is-active --quiet claude-channels; then
  set_state "service-down" "restarting claude-channels"
  sudo systemctl restart claude-channels
  exit 0
fi

if pgrep -u ubuntu -f "/home/ubuntu/aws-claudecode/bot/local-claude-telegram.js" > /dev/null; then
  set_state "ok-local-bridge" "Claude Telegram local bridge is running"
  exit 0
fi

# Legacy fallback for the older Claude Channels MCP/tmux setup.
if ! pgrep -u ubuntu -f "bun.*server.ts" > /dev/null; then
  set_state "plugin-dead" "bun telegram plugin missing; restarting claude-channels"
  sudo systemctl restart claude-channels
  exit 0
fi

if ! tmux has-session -t claude-channels 2>/dev/null; then
  set_state "tmux-missing" "restarting claude-channels"
  sudo systemctl restart claude-channels
  exit 0
fi

tmux capture-pane -t claude-channels -p -S -120 > "$PANE" || true

if grep -q "You've hit your limit" "$PANE"; then
  set_state "rate-limited" "Claude is at the rate-limit menu"
  exit 0
fi

if grep -q "How is Claude doing this session" "$PANE"; then
  set_state "idle-feedback-prompt" "Claude is waiting at optional feedback prompt; restart clears it"
  exit 0
fi

last_prompt="$(LC_ALL=C grep -a $'^\342\235\257' "$PANE" | tail -n 1 || true)"
input_text="$(printf '%s' "$last_prompt" | perl -CS -pe 's/^.//; s/^[\s\x{00a0}]*//; s/[\s\x{00a0}]+$//')"
if [[ -n "$input_text" ]] && [[ ! "$input_text" =~ ^Try[[:space:]] ]]; then
  set_state "input-pending" "Claude has text sitting in the input box"
  exit 0
fi

followers="$(pgrep -u ubuntu -af 'aws logs tail .*--follow|tail -f /tmp/claude' || true)"
if [[ -n "$followers" ]]; then
  oldest_minutes="$(ps -o etimes= -p "$(echo "$followers" | awk 'NR==1 {print $1}')" 2>/dev/null | awk '{print int($1/60)}')"
  set_state "stale-followers" "background follow processes present oldest_minutes=${oldest_minutes:-unknown}"
  exit 0
fi

if grep -Eq "Bash\(|Update\(|Write\(|Read [0-9]+ file|Running in the background|Channeling|Cogitating|Hashing|Incubating" "$PANE"; then
  set_state "ok-active" "Claude appears active"
else
  set_state "ok-idle" "Claude is idle at prompt"
fi
