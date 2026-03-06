# cs-spawn

One-click code-server instances from Chrome bookmarks, auto-grouped by repo name.

## Prerequisites

```bash
brew install code-server
```

## Install

```bash
chmod +x setup.sh cs-spawn.sh cs-stop.sh
./setup.sh
```

This does three things:

1. Installs `cs-spawn` to `~/.local/bin/`
2. Creates `~/Applications/CodeServerSpawn.app` — a headless app that registers the `codeserver://` URL scheme
3. Registers the scheme with macOS LaunchServices

## Chrome Extension

Load the extension for automatic tab grouping:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `chrome-extension/` folder
4. Done — code-server tabs will auto-group by repo name

## Usage

### Chrome bookmarks

Create bookmarks with URLs like:

```
codeserver://open?repo=/Users/sam/code/my-repo
```

When clicked, this:
- Starts a code-server instance on a random port (or reuses an existing one)
- Opens `http://127.0.0.1:<port>` in Chrome
- The extension auto-creates a tab group named `my-repo`

### Terminal

```bash
cs-spawn /path/to/repo
cs-spawn                  # opens a folder picker
```

### Managing instances

```bash
cs-stop          # list running instances
cs-stop my-repo  # stop by name
cs-stop --all    # stop all
```

## How it works

```
Chrome bookmark (codeserver://open?repo=...)
  → macOS URL scheme handler (CodeServerSpawn.app)
    → cs-spawn script
      → starts code-server on free port
      → opens Chrome with ?cs-repo= param
        → Chrome extension reads param, creates tab group
```

Each repo gets a deterministic color based on its name, so the groups are visually consistent across sessions.

## Files

```
~/.cs-spawn/           # PID files, port files, logs
~/.local/bin/cs-spawn  # the spawn script
~/.local/bin/cs-stop   # the stop script
~/Applications/CodeServerSpawn.app  # URL scheme handler
```
