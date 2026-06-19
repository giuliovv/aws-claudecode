# Local Claude Ops Scripts

## `claude-login-repair`

Repairs the long-running Claude Code + Telegram tmux session after OAuth/auth drift.

Usage:

```bash
claude-login-repair begin
# complete the browser login flow and copy the returned code
claude-login-repair finish
```

The script intentionally reads the OAuth code from stdin instead of accepting it as an argument, because command-line arguments can leak through shell history and process listings.

It automates the repeatable parts:

- restarts `claude-channels.service` for a clean session
- runs `/login` in the `claude-channels` tmux session
- pastes the OAuth code through a temporary tmux buffer
- restarts the service again so fresh credentials are loaded by the long-running process
- verifies standalone Claude auth with `AUTH_OK`
- verifies live tmux Claude auth with `LIVE_AUTH_OK`
- clears tmux history after login

Other commands:

```bash
claude-login-repair status
claude-login-repair verify
```
