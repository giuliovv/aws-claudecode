# EC2 Telegram Bridges

This EC2 runs two local Telegram bridges:

- `codex-telegram.service`: local Codex bridge using `/home/ubuntu/codex-telegram-bot.js`. Template: `bot/local-codex-telegram.js`.
- `claude-channels.service`: local Claude bridge using this repo's `bot/local-claude-telegram.js`.

The Claude bridge intentionally does **not** use the Claude Code Telegram MCP plugin. The MCP channel plugin was unreliable after restarts (`MCP error -32000: Connection closed`, missing `bun server.ts`, messages consumed without delivery). The local bridge uses the same operational pattern as the Codex bridge: Telegram long polling -> spawn/resume CLI -> parse JSON result -> reply to Telegram.

## Files On The EC2

Runtime files outside the repo:

- `/home/ubuntu/codex-telegram-bot.js`: Codex Telegram bridge. Template: `bot/local-codex-telegram.js`.
- `/etc/systemd/system/codex-telegram.service`: Codex bridge unit. Template: `systemd/codex-telegram.service`.
- `/home/ubuntu/start-claude-channels.sh`: launcher used by systemd. Template: `scripts/start-claude-channels.sh`.
- `/home/ubuntu/watchdog-claude.sh`: health watchdog. Template: `scripts/watchdog-claude.sh`.
- `/etc/systemd/system/claude-channels.service`: Claude bridge unit. Template: `systemd/claude-channels.service`.
- `/etc/ai-bots.env`: secrets and bot config. Do not commit this file.
- `/home/ubuntu/.claude-telegram-offset`: Telegram update offset for the Claude bridge.
- `/home/ubuntu/.claude-telegram-state.json`: per-chat Claude session/model state. The bridge writes this atomically so restarts or crashes do not leave a half-written state file.
- `/home/ubuntu/.codex-telegram-offset`: Telegram update offset for the Codex bridge.
- `/home/ubuntu/.codex-telegram-state.json`: per-chat Codex thread state.

Required secret/config vars in `/etc/ai-bots.env`:

```bash
CLAUDE_TELEGRAM_BOT_TOKEN=...
CODEX_TELEGRAM_BOT_TOKEN=...
# Optional but recommended; restricts bridges to Giulio's Telegram chat.
CLAUDE_ALLOWED_CHAT_ID=377533459
CODEX_ALLOWED_CHAT_ID=377533459
```


## Codex Bridge Behavior

Script template: `bot/local-codex-telegram.js`.

Current runtime settings from `/etc/ai-bots.env` and script defaults:

- model: `gpt-5.3-codex` unless `CODEX_MODEL` overrides it
- workdir: `/home/ubuntu/giuliowd` unless `CODEX_WORKDIR` overrides it
- allowed chat: `377533459` via `CODEX_ALLOWED_CHAT_ID`
- timeout: 20 minutes
- command mode: `codex exec resume <threadId> ... --json` once a thread exists

Telegram commands:

- `/status`: show bridge status, workdir, selected model, and Codex thread id.
- `/reset`: clear Codex thread context for that Telegram chat.
- `/start` or `/help`: show usage.

The bridge stores one Codex thread id per Telegram chat in `/home/ubuntu/.codex-telegram-state.json`. Current known thread for Giulio's chat:

```text
019ddfc7-82fe-7960-8843-09b764d2a5a3
```

To seed a known Codex thread after recovery:

```bash
python3 - <<'PY'
import json, pathlib, datetime
path = pathlib.Path('/home/ubuntu/.codex-telegram-state.json')
state = json.loads(path.read_text()) if path.exists() else {'chats': {}}
state.setdefault('chats', {})['377533459'] = {
    'threadId': 'OLD_THREAD_ID_HERE',
    'updatedAt': datetime.datetime.utcnow().replace(microsecond=0).isoformat() + 'Z',
}
path.write_text(json.dumps(state, indent=2))
PY
```

## Claude Bridge Behavior

Script: `bot/local-claude-telegram.js`.

Default runtime settings from `scripts/start-claude-channels.sh`:

- model: `claude-sonnet-5-5`
- workdir: `/home/ubuntu/giuliowd`
- allowed chat: `377533459`
- timeout: 60 minutes
- command mode: `claude -p --output-format json --resume <sessionId>`

Telegram commands:

- `/status`: show bridge status, workdir, selected model, Claude session id, and auth state.
- `/auth`: show Claude auth state.
- `/login`: start Claude OAuth login from Telegram. The bridge replies with a browser URL.
- `/login <code>`: submit the code returned by the browser flow. The bridge verifies auth and preserves the saved Claude session/context.
- `/reset`: clear Claude session context for that Telegram chat, preserving selected model.
- `/model`: show current model and options.
- `/model fable`, `/model sonnet`, `/model sonnet-5`, `/model sonnet-5.5`, `/model opus`, `/model claude-sonnet-5`, `/model claude-sonnet-5-5`, `/model claude-opus-5`: change model for future turns without resetting context.

Remote Claude login flow when terminal access is unavailable:

```text
/auth
/login
# open the URL returned by Telegram
/login CODE_FROM_BROWSER
/auth
```

Do not send OAuth codes as normal prompts. Only send them as `/login <code>`. The bridge writes the code to the pending `claude auth login` process over stdin and does not store it in state. Login and model changes must not clear `/home/ubuntu/.claude-telegram-state.json`; `/reset` is the only Telegram command that intentionally clears the saved Claude session for a chat.

The bridge stores one Claude session id per Telegram chat in `/home/ubuntu/.claude-telegram-state.json`. To seed a known Claude session after recovery:

```bash
python3 - <<'PY'
import json, pathlib, datetime
path = pathlib.Path('/home/ubuntu/.claude-telegram-state.json')
state = json.loads(path.read_text()) if path.exists() else {'chats': {}}
state.setdefault('chats', {})['377533459'] = {
    'sessionId': 'OLD_SESSION_ID_HERE',
    'model': 'sonnet',
    'updatedAt': datetime.datetime.utcnow().replace(microsecond=0).isoformat() + 'Z',
}
path.write_text(json.dumps(state, indent=2))
PY
```

Current known old Claude session from the MCP era:

```text
e9f32b09-4516-4258-bb62-75b90c00e2c3
```

## Recovery On A Fresh EC2

1. Clone this repo:

```bash
cd /home/ubuntu
git clone git@github.com:giuliovv/aws-claudecode.git
```

2. Install runtime prerequisites:

```bash
# Node is required for both Telegram bridges.
node --version

# Codex CLI must be installed and login-ready for the Codex bridge.
codex --version

# Claude Code must be installed and login-ready for the Claude bridge.
/home/ubuntu/.local/bin/claude --version
/home/ubuntu/.local/bin/claude update
```

3. Create `/etc/ai-bots.env` with bot tokens and allowed chat ids.

4. Install bridge scripts, launcher, watchdog, and units:

```bash
cp /home/ubuntu/aws-claudecode/bot/local-codex-telegram.js /home/ubuntu/codex-telegram-bot.js
cp /home/ubuntu/aws-claudecode/scripts/start-claude-channels.sh /home/ubuntu/start-claude-channels.sh
cp /home/ubuntu/aws-claudecode/scripts/watchdog-claude.sh /home/ubuntu/watchdog-claude.sh
chmod +x /home/ubuntu/codex-telegram-bot.js /home/ubuntu/start-claude-channels.sh /home/ubuntu/watchdog-claude.sh
sudo cp /home/ubuntu/aws-claudecode/systemd/codex-telegram.service /etc/systemd/system/codex-telegram.service
sudo cp /home/ubuntu/aws-claudecode/systemd/claude-channels.service /etc/systemd/system/claude-channels.service
sudo systemctl daemon-reload
sudo systemctl enable --now codex-telegram.service claude-channels.service
```

5. Initialize Telegram offset to avoid replaying old updates:

```bash
python3 - <<'PY'
import os, json, urllib.request, pathlib
from pathlib import Path
# Run once per bot token with TOKEN_ENV set, for example:
# TOKEN_ENV=CLAUDE_TELEGRAM_BOT_TOKEN python3 init-offset.py
# TOKEN_ENV=CODEX_TELEGRAM_BOT_TOKEN python3 init-offset.py
tok = os.environ[os.environ.get('TOKEN_ENV', 'CLAUDE_TELEGRAM_BOT_TOKEN')]
req = urllib.request.Request(
    f'https://api.telegram.org/bot{tok}/getUpdates',
    data=json.dumps({'timeout': 0, 'allowed_updates': ['message']}).encode(),
    headers={'content-type':'application/json'},
)
data = json.load(urllib.request.urlopen(req, timeout=15))
updates = data.get('result', [])
offset = (max([u['update_id'] for u in updates]) + 1) if updates else 0
offset_path = '/home/ubuntu/.codex-telegram-offset' if os.environ.get('TOKEN_ENV') == 'CODEX_TELEGRAM_BOT_TOKEN' else '/home/ubuntu/.claude-telegram-offset'
Path(offset_path).write_text(str(offset))
print(offset)
PY
```

6. Verify:

```bash
systemctl status codex-telegram.service claude-channels.service --no-pager -l
journalctl -u codex-telegram.service -f
journalctl -u claude-channels.service -f
/home/ubuntu/watchdog-claude.sh
cat /home/ubuntu/.claude-watchdog-state
```

Expected watchdog state for the local bridge:

```text
ok-local-bridge
```

7. Test both bridges in Telegram:

```text
# Codex bot
/status

# Claude bot
/status
/auth
/login
/model
/model claude-sonnet-5-5
```

## Operational Notes

- The Claude bridge uses the logged-in Claude Code account. It does not require `ANTHROPIC_API_KEY` and should consume normal Claude Code account usage, not separate API billing.
- The bridge is single-flight: one Telegram request at a time. If Claude is busy, the bot asks the user to retry later.
- If a running Claude task gets stuck, restart with `sudo systemctl restart claude-channels.service`.
- If Codex Telegram replies stop, check `journalctl -u codex-telegram.service -f` and `/home/ubuntu/.codex-telegram-offset`.
- If Claude Telegram replies stop, check `journalctl -u claude-channels.service -f` and `/home/ubuntu/.claude-telegram-offset`.
- Do not run the old Claude Telegram MCP plugin with the same bot token at the same time; Telegram long polling permits only one consumer per bot token.
