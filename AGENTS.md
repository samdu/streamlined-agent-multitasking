# AGENTS.md

Things that aren't obvious from reading the code but matter if you're modifying this project.

## Architecture

The full invocation chain is: **Chrome extension popup → `codeserver://` URL scheme → macOS AppleScript app bundle → `cs-spawn-from-url` → `cs-spawn` → code-server process → Chrome tab → extension groups the tab**. If something isn't working, figure out which link in the chain broke.

The Chrome extension can also trigger `codeserver://` URLs via hidden iframes (used by both the popup launcher and the reconnect page). This is how a browser page can start a local process without a native messaging host.

## Session identity

Sessions are keyed by an 8-character md5 hash of the **absolute repo path**. Same path always maps to the same hash, same port file, same user-data-dir. This is what makes port reuse and state persistence work. The hashing uses macOS `md5` (not `md5sum` — this is a macOS-only project).

## code-server state persistence

code-server is VS Code under the hood. The `--user-data-dir` flag controls where it stores **all** workspace state: open editors, unsaved file backups (hot exit), editor layout, terminal scrollback, extension state. Each repo gets its own at `~/.cs-spawn/data/<hash>/`. Without this flag, all instances share the default dir and stomp on each other.

## `.session` files are the source of truth

PID and port files tell you about the *current* process. Session files (`<hash>.session`) are JSON metadata that survives process death and are what enable resurrection. `cs-stop` intentionally preserves these; only `--purge` removes them.

## Port reuse matters more than you'd think

When code-server restarts on a new random port, every existing Chrome tab pointing at the old port is dead. Reusing the stored port means tabs auto-reconnect when the server comes back — no user intervention needed. The fallback to a random port only happens if the previous port is occupied by something else.

## Chrome extension: MV3 gotchas

- Service workers get suspended aggressively. `setInterval` is unreliable — use `chrome.alarms` for anything periodic.
- `fetch()` to `127.0.0.1` requires `host_permissions` in the manifest, not just `permissions`.
- The health check requires two consecutive failures before redirecting a tab to the reconnect page. This avoids flapping during brief server restarts (e.g., when `cs-spawn` is restarting a session).

## Testing

There's no test suite. To manually verify changes:
1. `./setup.sh` to install scripts
2. Reload the extension at `chrome://extensions`
3. `cs-spawn github/<some-repo>` to start a session
4. Kill the code-server process (`cs-stop <name>`) and watch the Chrome tab redirect to the reconnect page
5. Click "Restart server" and verify it comes back with previous editor state
6. `cs-spawn --resurrect` to verify batch resurrection works
