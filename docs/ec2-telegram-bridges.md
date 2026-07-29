# EC2 Telegram Bridges

This EC2 runs two local Telegram bridges:

- `codex-telegram.service`: local Codex bridge using `/home/ubuntu/codex-telegram-bot.js`.
- `claude-channels.service`: local Claude bridge using this repo's `bot/local-claude-telegram.js`.

The Claude bridge intentionally does **not** use the Claude Code Telegram MCP plugin. The MCP channel plugin was unreliable after restarts (`MCP error -32000: Connection closed`, missing `bun server.ts`, messages consumed without delivery). The local bridge uses the same operational pattern as the Codex bridge: Telegram long polling -> spawn/resume CLI -> parse JSON result -> reply to Telegram.

## Files On The EC2

Runtime files outside the repo:

- `/home/ubuntu/start-claude-channels.sh`: launcher used by systemd. Template: `scripts/start-claude-channels.sh`.
- `/home/ubuntu/watchdog-claude.sh`: health watchdog. Template: `scripts/watchdog-claude.sh`.
- `/etc/systemd/system/claude-channels.service`: Claude bridge unit. Template: `systemd/claude-channels.service`.
- `/etc/ai-bots.env`: secrets and bot config. Do not commit this file.
- `/home/ubuntu/.claude-telegram-offset`: Telegram update offset for the Claude bridge.
- `/home/ubuntu/.claude-telegram-state.json`: per-chat Claude session/model state.
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

## Claude Bridge Behavior

Script: `bot/local-claude-telegram.js`.

Default runtime settings from `scripts/start-claude-channels.sh`:

- model: `fable`
- workdir: `/home/ubuntu/giuliowd`
- allowed chat: `377533459`
- timeout: 30 minutes
- command mode: `claude -p --output-format json --resume <sessionId>`

Telegram commands:

- `/status`: show bridge status, workdir, selected model, Claude session id, and auth state.
- `/auth`: show Claude auth state.
- `/login`: start Claude OAuth login from Telegram. The bridge replies with a browser URL.
- `/login <code>`: submit the code returned by the browser flow. The bridge verifies auth and preserves the saved Claude session/context.
- `/reset`: clear Claude session context for that Telegram chat, preserving selected model.
- `/model`: show current model and options.
- `/model fable`, `/model sonnet`, `/model opus`, `/model claude-sonnet-5`, `/model claude-opus-5`: change model for future turns without resetting context.

Remote Claude login flow when terminal access is unavailable:

```text
/auth
/login
# open the URL returned by Telegram
/login CODE_FROM_BROWSER
/auth
```

Do not send OAuth codes as normal prompts. Only send them as `/login <code>`. The bridge writes the code to the pending `claude auth login` process over stdin and does not store it in state.

The bridge stores one Claude session id per Telegram chat in `/home/ubuntu/.claude-telegram-state.json`. To seed a known Claude session after recovery:

```bash
python3 - <<'PY'
import json, pathlib, datetime
path = pathlib.Path('/home/ubuntu/.claude-telegram-state.json')
state = json.loads(path.read_text()) if path.exists() else {'chats': {}}
state.setdefault('chats', {})['377533459'] = {
    'sessionId': 'OLD_SESSION_ID_HERE',
    'model': 'fable',
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
# Node is required for the bridge. Claude Code must be installed/login-ready.
node --version
/home/ubuntu/.local/bin/claude --version
```

3. Create `/etc/ai-bots.env` with bot tokens and allowed chat ids.

4. Install launcher/watchdog/unit:

```bash
cp /home/ubuntu/aws-claudecode/scripts/start-claude-channels.sh /home/ubuntu/start-claude-channels.sh
cp /home/ubuntu/aws-claudecode/scripts/watchdog-claude.sh /home/ubuntu/watchdog-claude.sh
chmod +x /home/ubuntu/start-claude-channels.sh /home/ubuntu/watchdog-claude.sh
sudo cp /home/ubuntu/aws-claudecode/systemd/claude-channels.service /etc/systemd/system/claude-channels.service
sudo systemctl daemon-reload
sudo systemctl enable --now claude-channels.service
```

5. Initialize Telegram offset to avoid replaying old updates:

```bash
python3 - <<'PY'
import os, json, urllib.request, pathlib
from pathlib import Path
# Run with CLAUDE_TELEGRAM_BOT_TOKEN in the environment, or source it carefully.
tok = os.environ['CLAUDE_TELEGRAM_BOT_TOKEN']
req = urllib.request.Request(
    f'https://api.telegram.org/bot{tok}/getUpdates',
    data=json.dumps({'timeout': 0, 'allowed_updates': ['message']}).encode(),
    headers={'content-type':'application/json'},
)
data = json.load(urllib.request.urlopen(req, timeout=15))
updates = data.get('result', [])
offset = (max([u['update_id'] for u in updates]) + 1) if updates else 0
Path('/home/ubuntu/.claude-telegram-offset').write_text(str(offset))
print(offset)
PY
```

6. Verify:

```bash
systemctl status claude-channels.service --no-pager -l
journalctl -u claude-channels.service -f
/home/ubuntu/watchdog-claude.sh
cat /home/ubuntu/.claude-watchdog-state
```

Expected watchdog state for the local bridge:

```text
ok-local-bridge
```

7. Test auth and model selection in Telegram:

```text
/status
/auth
/login
/model
/model claude-sonnet-5
```

## Operational Notes

- The Claude bridge uses the logged-in Claude Code account. It does not require `ANTHROPIC_API_KEY` and should consume normal Claude Code account usage, not separate API billing.
- The bridge is single-flight: one Telegram request at a time. If Claude is busy, the bot asks the user to retry later.
- If a running Claude task gets stuck, restart with `sudo systemctl restart claude-channels.service`.
- If Telegram replies stop, check `journalctl -u claude-channels.service -f` and `/home/ubuntu/.claude-telegram-offset`.
- Do not run the old Claude Telegram MCP plugin with the same bot token at the same time; Telegram long polling permits only one consumer per bot token.
