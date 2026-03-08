#!/bin/bash
# cs-spawn - Start a code-server instance for a repo and open it in Chrome
# Usage: cs-spawn /path/to/repo [--newtree[=name]]
#        cs-spawn --resurrect [hash|all]
#        cs-spawn (opens picker dialog)

set -euo pipefail

# Ensure homebrew is in PATH (needed when launched from URL scheme handler)
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

PIDDIR="${HOME}/.cs-spawn"
mkdir -p "$PIDDIR"

# --- Parse args ---
REPO_PATH=""
NEWTREE=""
RESURRECT=""
NO_OPEN=""

for arg in "$@"; do
  case "$arg" in
    --newtree=*)   NEWTREE="${arg#--newtree=}" ;;
    --newtree)     NEWTREE="__auto__" ;;
    --resurrect=*) RESURRECT="${arg#--resurrect=}" ;;
    --resurrect)   RESURRECT="all" ;;
    --no-open)     NO_OPEN=1 ;;
    *)             REPO_PATH="$arg" ;;
  esac
done

# --- Resurrect mode: restart dead sessions ---
if [ -n "$RESURRECT" ]; then
  resurrected=0
  for sessionfile in "$PIDDIR"/*.session; do
    [ -f "$sessionfile" ] || continue
    hash=$(basename "$sessionfile" .session)

    if [ "$RESURRECT" != "all" ] && [ "$hash" != "$RESURRECT" ]; then
      continue
    fi

    # Read session metadata
    s_repo=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['repo_path'])" "$sessionfile" 2>/dev/null || echo "")
    s_pid=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('pid',''))" "$sessionfile" 2>/dev/null || echo "")

    [ -z "$s_repo" ] && continue
    [ ! -d "$s_repo" ] && { echo "skip $hash: directory gone ($s_repo)"; continue; }

    # Check if already alive
    if [ -n "$s_pid" ] && kill -0 "$s_pid" 2>/dev/null; then
      echo "skip $hash: already running (PID $s_pid)"
      continue
    fi

    echo "resurrecting: $s_repo"
    "$0" "$s_repo" --no-open
    resurrected=$((resurrected + 1))
  done
  echo "resurrected $resurrected session(s)"
  exit 0
fi

# --- Load per-machine config ---
CS_SPAWN_CONFIG="${HOME}/.cs-spawn/config"
[ -f "$CS_SPAWN_CONFIG" ] && source "$CS_SPAWN_CONFIG"

if [ -z "$REPO_PATH" ]; then
  if [ -n "${DEFAULT_REPO:-}" ]; then
    REPO_PATH="$DEFAULT_REPO"
  else
    REPO_PATH=$(osascript -e 'POSIX path of (choose folder with prompt "Select a repo to open in code-server")')
    [ -z "$REPO_PATH" ] && exit 0
  fi
fi

# --- Resolve path (relative to $HOME if not absolute) ---
if [[ "$REPO_PATH" != /* ]]; then
  REPO_PATH="${HOME}/${REPO_PATH}"
fi
REPO_PATH="${REPO_PATH%/}"  # strip trailing slash

if [ ! -d "$REPO_PATH" ]; then
  osascript -e "display alert \"cs-spawn\" message \"Not a directory: $REPO_PATH\""
  exit 1
fi

REPO_PATH="$(cd "$REPO_PATH" && pwd)"
REPO_NAME="$(basename "$REPO_PATH")"

# --- Handle worktree creation ---
if [ -n "$NEWTREE" ]; then
  if [ ! -d "$REPO_PATH/.git" ] && [ ! -f "$REPO_PATH/.git" ]; then
    osascript -e "display alert \"cs-spawn\" message \"Not a git repo: $REPO_PATH\""
    exit 1
  fi

  # Get current branch for naming and upstream tracking
  BRANCH=$(cd "$REPO_PATH" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")

  # Auto-generate name from current branch + timestamp
  if [ "$NEWTREE" = "__auto__" ]; then
    NEWTREE="${BRANCH}-wt-$(date +%s)"
  fi

  WORKTREE_DIR="${REPO_PATH}-worktrees/${NEWTREE}"
  mkdir -p "$(dirname "$WORKTREE_DIR")"

  if [ -d "$WORKTREE_DIR" ]; then
    echo "Worktree already exists: $WORKTREE_DIR"
  else
    # Create a new branch and worktree
    (cd "$REPO_PATH" && git worktree add "$WORKTREE_DIR" -b "$NEWTREE" 2>&1) || {
      # Branch might already exist, try without -b
      (cd "$REPO_PATH" && git worktree add "$WORKTREE_DIR" "$NEWTREE" 2>&1) || {
        osascript -e "display alert \"cs-spawn\" message \"Failed to create worktree: $NEWTREE\""
        exit 1
      }
    }
    echo "Created worktree: $WORKTREE_DIR"

    # Set upstream tracking to match the source branch
    SOURCE_UPSTREAM=$(cd "$REPO_PATH" && git rev-parse --abbrev-ref "${BRANCH}@{upstream}" 2>/dev/null || echo "")
    if [ -n "$SOURCE_UPSTREAM" ]; then
      (cd "$WORKTREE_DIR" && git branch --set-upstream-to="$SOURCE_UPSTREAM" 2>&1) || true
      echo "Tracking: $SOURCE_UPSTREAM"
    fi
  fi

  # Redirect to serve the worktree instead
  REPO_PATH="$WORKTREE_DIR"
  REPO_NAME="$NEWTREE"
fi

# --- Session identity ---
HASH=$(echo -n "$REPO_PATH" | md5 | cut -c1-8)
PIDFILE="$PIDDIR/$HASH.pid"
PORTFILE="$PIDDIR/$HASH.port"
SESSIONFILE="$PIDDIR/$HASH.session"
DATADIR="$PIDDIR/data/$HASH"
LOGFILE="$PIDDIR/$HASH.log"

mkdir -p "$DATADIR"

# --- Check if already running for this path ---
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  PORT=$(cat "$PORTFILE")
  echo "code-server already running for $REPO_NAME on port $PORT"
  [ -z "${NO_OPEN:-}" ] && open "http://127.0.0.1:${PORT}/?folder=${REPO_PATH}&cs-repo=${REPO_NAME}"
  exit 0
fi

# --- Port selection: reuse previous port if available and free ---
PORT=""
if [ -f "$PORTFILE" ]; then
  PREV_PORT=$(cat "$PORTFILE")
  if ! lsof -i :"$PREV_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    PORT="$PREV_PORT"
  fi
fi
if [ -z "$PORT" ]; then
  PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()')
fi

# --- Start code-server with persistent user-data-dir ---
code-server \
  --bind-addr "127.0.0.1:${PORT}" \
  --auth none \
  --disable-telemetry \
  --user-data-dir "$DATADIR" \
  "$REPO_PATH" \
  > "$LOGFILE" 2>&1 &

CS_PID=$!
echo "$CS_PID" > "$PIDFILE"
echo "$PORT" > "$PORTFILE"

# --- Write session metadata (survives process death) ---
python3 -c "
import json, sys, time
json.dump({
    'hash': sys.argv[1],
    'repo_path': sys.argv[2],
    'repo_name': sys.argv[3],
    'port': int(sys.argv[4]),
    'pid': int(sys.argv[5]),
    'data_dir': sys.argv[6],
    'created_at': time.time(),
    'last_spawned': time.time(),
}, open(sys.argv[7], 'w'), indent=2)
" "$HASH" "$REPO_PATH" "$REPO_NAME" "$PORT" "$CS_PID" "$DATADIR" "$SESSIONFILE"

# --- Wait for ready ---
READY=0
for i in $(seq 1 120); do
  if curl -sf --max-time 2 -o /dev/null "http://127.0.0.1:${PORT}/healthz" 2>/dev/null; then
    READY=1
    break
  fi
  sleep 0.5
done
if [ "$READY" = "0" ]; then
  echo "Warning: code-server not ready after 60s"
fi

# --- Open in Chrome ---
[ -z "${NO_OPEN:-}" ] && open "http://127.0.0.1:${PORT}/?folder=${REPO_PATH}&cs-repo=${REPO_NAME}"

echo "code-server for $REPO_NAME on port $PORT (PID $CS_PID)"
