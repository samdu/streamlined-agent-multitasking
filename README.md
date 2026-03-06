# streamlined-agent-multitasking

One-click code-server + worktree spawner. Open a browser-based IDE in a Chrome tab, grouped alongside your ticket and PR tabs.

## Prerequisites

```bash
brew install code-server
```

## Install

```bash
chmod +x setup.sh cs-spawn.sh cs-stop.sh cs-spawn-from-url.sh
./setup.sh
```

This installs `cs-spawn`, `cs-stop`, and `cs-spawn-from-url` to `~/.local/bin/`, creates a macOS AppleScript applet at `~/Applications/CodeServerSpawn.app` that registers the `codeserver://` URL scheme, and configures code-server to skip workspace trust and first-run dialogs.

### Chrome extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `chrome-extension/` folder

The extension provides:
- **Cmd+Shift+.** opens a launcher popup
- Auto-groups code-server tabs by repo name with consistent colors
- Recent repo history with arrow-key navigation

### Bypass the Chrome URL scheme dialog

```bash
# Auto-launch without confirmation
/usr/libexec/PlistBuddy \
  -c "Add :AutoLaunchProtocolsFromOrigins array" \
  -c "Add :AutoLaunchProtocolsFromOrigins:0 dict" \
  -c "Add :AutoLaunchProtocolsFromOrigins:0:protocol string codeserver" \
  -c "Add :AutoLaunchProtocolsFromOrigins:0:allowed_origins array" \
  -c "Add :AutoLaunchProtocolsFromOrigins:0:allowed_origins:0 string '*'" \
  ~/Library/Preferences/com.google.Chrome.plist

# Show "Always allow" checkbox as fallback
defaults write com.google.Chrome ExternalProtocolDialogShowAlwaysOpenCheckbox -bool true
```

Restart Chrome, verify at `chrome://policy`.

## Usage

### Chrome extension popup (Cmd+Shift+.)

Type a repo path relative to `$HOME` and hit Enter:

- `github/data-dbt` — open repo in code-server
- `github/data-dbt&newtree` — create auto-named worktree
- `github/data-dbt&newtree=sam/my-feature` — create named worktree

Worktrees are created in `<repo>-worktrees/` and inherit upstream tracking from the source branch.

### Chrome bookmarks

```
codeserver://open?repo=github/data-dbt
codeserver://open?repo=github/data-dbt&newtree
codeserver://open?repo=github/data-dbt&newtree=sam/my-feature
```

### Terminal

```bash
cs-spawn github/data-dbt
cs-spawn github/data-dbt --newtree
cs-spawn github/data-dbt --newtree=sam/my-feature
cs-spawn   # opens a folder picker
```

### Managing instances

```bash
cs-stop              # list running + stopped sessions
cs-stop my-repo      # stop by name (preserves session state)
cs-stop --all        # stop all running
cs-stop --purge repo # stop + delete all state for a session
cs-stop --purge-all  # nuclear option
```

### Session persistence

Sessions survive process death. When a code-server instance is stopped or crashes:

- **Editor state is preserved** — open files, unsaved changes, layout, terminal history all persist in a per-repo data directory (`~/.cs-spawn/data/`)
- **Port is reused** — re-spawning a repo reuses its previous port, so existing Chrome tabs auto-reconnect
- **Chrome extension detects dead servers** — tabs are redirected to a reconnect page with a one-click restart button that auto-redirects back once the server is up

#### Resurrect dead sessions

```bash
cs-spawn --resurrect          # restart all dead sessions
cs-spawn --resurrect=abcd1234 # restart a specific session by hash
```

Session hashes are shown by `cs-stop` in the stopped sessions list.

## How it works

```
Chrome popup / bookmark (codeserver://open?repo=...)
  → macOS AppleScript applet (URL scheme handler)
    → cs-spawn-from-url (URL parser)
      → cs-spawn (starts code-server on free port, creates worktree if requested)
        → opens Chrome tab with ?cs-repo= param
          → Chrome extension creates named tab group
```

## Files

```
~/.cs-spawn/                  # PID files, port files, logs, session metadata
~/.cs-spawn/data/<hash>/      # per-repo VS Code state (editors, settings, etc.)
~/.cs-spawn/<hash>.session    # session metadata (survives process death)
~/.local/bin/cs-spawn         # main spawn script
~/.local/bin/cs-stop          # instance manager
~/.local/bin/cs-spawn-from-url  # URL parser for scheme handler
~/Applications/CodeServerSpawn.app  # AppleScript URL scheme handler
```
