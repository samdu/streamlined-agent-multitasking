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

## Platform constraints

**macOS bash 3.2**: The default `/bin/bash` on macOS is ancient. Do not use:
- Redirects on `for` lines: `for x in *.txt 2>/dev/null; do` — syntax error in bash 3.2. Use a guard inside the loop (`[ -f "$x" ] || continue`) instead.
- Associative arrays, `mapfile`, `readarray`, `|&`, or any bash 4+ feature.

**AppleScript `do shell script` has no PATH**: The URL scheme handler runs via AppleScript, which does not source `.zshrc`, `.bash_profile`, or any login shell config. Every script that may be invoked from the handler must set `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"` near the top. This is the single most common cause of "it works in my terminal but not from the bookmark."

## URL scheme handler (CodeServerSpawn.app)

The app is a **compiled AppleScript applet** (built with `osacompile`), not a shell-based `.app` bundle. macOS delivers custom URL schemes via Apple Events (`on open location`), which shell scripts cannot receive. If rebuilding, the flow is:

1. AppleScript receives URL via `on open location`
2. Calls `~/.local/bin/cs-spawn-from-url` (URL parser)
3. Which calls `~/.local/bin/cs-spawn` (main logic)

The Info.plist URL scheme registration is injected via `defaults write` after `osacompile`, then re-registered with `lsregister -f`.

**Do not replace `osacompile` with a manual `.app` bundle.** Setting `CFBundleExecutable` to a bash script produces a structurally valid but functionally dead app bundle — macOS launches the script, sends the URL via Apple Event, and the script never receives it. This failure is completely silent: no error, no alert, no log. The process starts and exits immediately. If URL scheme launches stop working, check `CFBundleExecutable` in the installed Info.plist (`defaults read ~/Applications/CodeServerSpawn.app/Contents/Info CFBundleExecutable`) — it must be `applet`, not a shell script name.

**Do not duplicate URL parsing in the handler.** The AppleScript should delegate to `cs-spawn-from-url`, which handles URL-encoded params, relative paths (`github/foo` → `$HOME/github/foo`), and `--newtree` flags. Inline URL parsing with `sed` in a handler script will miss edge cases (especially the relative path resolution, which happens inside `cs-spawn`).

`setup.sh` does `rm -rf` on the app bundle before rebuilding. This is intentional — stale files from previous builds (e.g., a leftover `handler` script alongside `applet`) create confusing states. The AppleScript handler logs to `~/.cs-spawn/url-handler.log` for diagnostics.

## Session API daemon (`cs-api`)

The Chrome extension can't read `~/.cs-spawn/*.session` files directly (no filesystem access), so a tiny Python HTTP server bridges the gap. It runs on `127.0.0.1:19377`, reads session files, checks PIDs, and exposes `GET /sessions` (JSON array) plus `POST /stop/{hash}` and `POST /purge/{hash}`. CORS is wide open (`*`) because the requesting origin is `chrome-extension://` which varies per install.

The daemon is managed by launchd (`com.cs-spawn.api` LaunchAgent) with `KeepAlive: true`. If it dies, launchd restarts it. Logs go to `~/.cs-spawn/api.log`.

The session dashboard page (`sessions.html`) fetches from this API and cross-references with `chrome.tabs.query()` to determine which running sessions have open browser tabs vs. which are orphaned.

## Chrome extension: MV3 gotchas

- **No inline scripts**: `<script>` blocks in extension HTML are silently blocked by CSP. All JS must be in separate `.js` files loaded via `<script src="...">`.
- **No `autofocus`**: The `autofocus` attribute doesn't work in extension popups. Use `element.focus()` in JS instead.
- **Don't navigate tabs to trigger URL schemes**: `chrome.tabs.update({ url: "codeserver://..." })` replaces the active tab content. Use a hidden iframe (`iframe.src = url`) to fire the OS URL scheme handler without disturbing any tab.
- Service workers get suspended aggressively. `setInterval` is unreliable — use `chrome.alarms` for anything periodic.
- `fetch()` to `127.0.0.1` requires `host_permissions` in the manifest, not just `permissions`.
- The health check requires two consecutive failures before redirecting a tab to the reconnect page. This avoids flapping during brief server restarts (e.g., when `cs-spawn` is restarting a session).

## code-server readiness

- **Don't use `curl -L` for health checks**: code-server's `/` returns a 302 redirect. With `-L`, `curl -w '%{http_code}'` concatenates status codes across redirects (e.g., `"302200"`), which breaks string comparisons. Use `/healthz` which returns a clean 200 with no redirect.
- **Use `curl -sf --max-time 2`** for the readiness loop, not `-o /dev/null` with status parsing.

## Git worktrees

- `git worktree add -b <new-branch>` creates a local branch with **no upstream tracking**. IDEs (VS Code, Cursor) will show a "publish branch" prompt. After creating a worktree, set upstream from the source branch:
  ```bash
  SOURCE_UPSTREAM=$(git rev-parse --abbrev-ref "${BRANCH}@{upstream}" 2>/dev/null)
  cd "$WORKTREE_DIR" && git branch --set-upstream-to="$SOURCE_UPSTREAM"
  ```
- Worktrees are created in `<repo>-worktrees/` adjacent to the source repo.

## Testing

There's no test suite. To manually verify changes:
1. `./setup.sh` to install scripts
2. Reload the extension at `chrome://extensions`
3. `cs-spawn github/<some-repo>` to start a session
4. Kill the code-server process (`cs-stop <n>`) and watch the Chrome tab redirect to the reconnect page
5. Click "Restart server" and verify it comes back with previous editor state
6. `cs-spawn --resurrect` to verify batch resurrection works
7. **Always test the full URL scheme flow** (`open 'codeserver://open?repo=...'`), not just direct script invocation — the two paths have completely different environments (shell profile vs AppleScript `do shell script`) and different failure modes. `cs-spawn github/foo` working in your terminal proves nothing about whether the URL scheme works. The URL scheme path is: Chrome iframe → macOS Apple Event → AppleScript → `cs-spawn-from-url` → `cs-spawn`. If any link is broken, the failure is silent.
8. After running `setup.sh`, verify the app bundle: `defaults read ~/Applications/CodeServerSpawn.app/Contents/Info CFBundleExecutable` should print `applet`. If it prints anything else, the URL scheme handler is broken.
9. Check `~/.cs-spawn/url-handler.log` for output from URL scheme invocations. No output after triggering a URL means the AppleScript handler didn't fire.
