# AGENTS.md

Things that aren't obvious from reading the code but matter if you're modifying this project.

## Architecture

The full invocation chain is: **Chrome extension popup → `codeserver://` URL scheme → macOS AppleScript app bundle → `cs-spawn-from-url` → `cs-spawn` → code-server process → Chrome tab → extension groups the tab**. If something isn't working, figure out which link in the chain broke.

The Chrome extension triggers `codeserver://` URLs via hidden iframes. This is how a browser page can start a local process without a native messaging host.

## Platform constraints

**macOS bash 3.2**: The default `/bin/bash` on macOS is ancient. Do not use:
- Redirects on `for` lines: `for x in *.txt 2>/dev/null; do` — syntax error in bash 3.2. Use a guard inside the loop (`[ -f "$x" ] || continue`) instead.
- Associative arrays, `mapfile`, `readarray`, `|&`, or any bash 4+ feature.

**AppleScript `do shell script` has no PATH**: The URL scheme handler runs via AppleScript, which does not source `.zshrc`, `.bash_profile`, or any login shell config. Every script that may be invoked from the handler must set `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"` near the top. This is the single most common cause of "it works in my terminal but not from the bookmark."

**macOS `md5` not `md5sum`**: Sessions are keyed by an 8-character md5 hash of the absolute repo path. The hashing uses macOS `md5` — this is a macOS-only project.

## URL scheme handler (CodeServerSpawn.app)

The app is a **compiled AppleScript applet** (built with `osacompile`), not a shell-based `.app` bundle. macOS delivers custom URL schemes via Apple Events (`on open location`), which shell scripts cannot receive. If rebuilding, the flow is:

1. AppleScript receives URL via `on open location`
2. Calls `~/.local/bin/cs-spawn-from-url` (URL parser)
3. Which calls `~/.local/bin/cs-spawn` (main logic)

The Info.plist URL scheme registration is injected via `defaults write` after `osacompile`, then re-registered with `lsregister -f`.

## Chrome extension (Manifest V3)

- **No inline scripts**: `<script>` blocks in extension HTML are silently blocked by CSP. All JS must be in separate `.js` files loaded via `<script src="...">`.
- **No `autofocus`**: The `autofocus` attribute doesn't work in extension popups. Use `element.focus()` in JS instead.
- **Don't navigate tabs to trigger URL schemes**: `chrome.tabs.update({ url: "codeserver://..." })` replaces the active tab content. Use a hidden iframe (`iframe.src = url`) to fire the OS URL scheme handler without disturbing any tab.
- Service workers get suspended aggressively. `setInterval` is unreliable — use `chrome.alarms` for anything periodic.
- `fetch()` to `127.0.0.1` requires `host_permissions` in the manifest, not just `permissions`.

## code-server readiness

- **Don't use `curl -L` for health checks**: code-server's `/` returns a 302 redirect. With `-L`, `curl -w '%{http_code}'` concatenates status codes across redirects (e.g., `"302200"`), which breaks string comparisons. Use `/healthz` which returns a clean 200 with no redirect.
- **Use `curl -sf --max-time 2`** for the readiness loop, not `-o /dev/null` with status parsing.

## code-server state persistence

code-server is VS Code under the hood. The `--user-data-dir` flag controls where it stores all workspace state: open editors, unsaved file backups (hot exit), editor layout, terminal scrollback, extension state. If multiple instances share the default dir, they stomp on each other.

## Git worktrees

- `git worktree add -b <new-branch>` creates a local branch with **no upstream tracking**. IDEs (VS Code, Cursor) will show a "publish branch" prompt. After creating a worktree, set upstream from the source branch:
  ```bash
  SOURCE_UPSTREAM=$(git rev-parse --abbrev-ref "${BRANCH}@{upstream}" 2>/dev/null)
  cd "$WORKTREE_DIR" && git branch --set-upstream-to="$SOURCE_UPSTREAM"
  ```
- Worktrees are created in `<repo>-worktrees/` adjacent to the source repo.

## Testing

There's no test suite. Always test the full URL scheme flow (`open 'codeserver://open?repo=...'`), not just direct script invocation. The two paths have different environments (shell profile vs AppleScript) and different failure modes.

To manually verify changes:
1. `./setup.sh` to install scripts
2. Reload the extension at `chrome://extensions`
3. `cs-spawn github/<some-repo>` from terminal — verify it works
4. `open 'codeserver://open?repo=github/<some-repo>'` — verify URL scheme works
5. Cmd+Shift+. in Chrome — verify popup opens, Enter triggers launch
