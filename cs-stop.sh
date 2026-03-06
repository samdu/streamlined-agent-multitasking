#!/bin/bash
# cs-stop - Stop and manage code-server instances
# Usage: cs-stop                  (list all sessions)
#        cs-stop <repo-name>      (stop a specific one)
#        cs-stop --all            (stop all running)
#        cs-stop --purge <name>   (stop + delete all state)
#        cs-stop --purge-all      (nuclear option)

PIDDIR="${HOME}/.cs-spawn"

session_info() {
  local hash="$1"
  local sessionfile="$PIDDIR/$hash.session"

  if [ -f "$sessionfile" ]; then
    python3 -c "
import json, sys
s = json.load(open(sys.argv[1]))
print(s.get('repo_name', '?'), s.get('repo_path', '?'))
" "$sessionfile"
  else
    # Fallback: check log file
    local logfile="$PIDDIR/$hash.log"
    if [ -f "$logfile" ]; then
      echo "unknown $(head -5 "$logfile" | grep -o '/[^ ]*' | head -1 || echo "?")"
    else
      echo "unknown unknown"
    fi
  fi
}

list_instances() {
  local found_running=0
  local found_stopped=0

  echo "Running:"
  for sessionfile in "$PIDDIR"/*.session; do
    [ -f "$sessionfile" ] || continue
    local hash=$(basename "$sessionfile" .session)
    local pidfile="$PIDDIR/$hash.pid"
    local portfile="$PIDDIR/$hash.port"

    local pid="" port=""
    [ -f "$pidfile" ] && pid=$(cat "$pidfile")
    [ -f "$portfile" ] && port=$(cat "$portfile")

    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      read -r name path <<< "$(session_info "$hash")"
      echo "  ● $name  port $port  PID $pid  $path"
      found_running=1
    fi
  done
  [ "$found_running" = 0 ] && echo "  (none)"

  echo ""
  echo "Stopped (resurrectable):"
  for sessionfile in "$PIDDIR"/*.session; do
    [ -f "$sessionfile" ] || continue
    local hash=$(basename "$sessionfile" .session)
    local pidfile="$PIDDIR/$hash.pid"
    local portfile="$PIDDIR/$hash.port"

    local pid="" port=""
    [ -f "$pidfile" ] && pid=$(cat "$pidfile")
    [ -f "$portfile" ] && port=$(cat "$portfile")

    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
      read -r name path <<< "$(session_info "$hash")"
      echo "  ○ $name  port ${port:-?}  $path  [$hash]"
      found_stopped=1
    fi
  done
  [ "$found_stopped" = 0 ] && echo "  (none)"
}

stop_by_hash() {
  local hash="$1"
  local pidfile="$PIDDIR/$hash.pid"
  if [ -f "$pidfile" ]; then
    local pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid"
      read -r name _ <<< "$(session_info "$hash")"
      echo "Stopped $name (PID $pid)"
    fi
    rm -f "$pidfile"
  fi
}

stop_all() {
  for sessionfile in "$PIDDIR"/*.session; do
    [ -f "$sessionfile" ] || continue
    local hash=$(basename "$sessionfile" .session)
    stop_by_hash "$hash"
  done
  # Also catch any orphan PID files without sessions
  for pidfile in "$PIDDIR"/*.pid; do
    [ -f "$pidfile" ] || continue
    local pid=$(cat "$pidfile")
    kill "$pid" 2>/dev/null && echo "Stopped orphan PID $pid"
    rm -f "$pidfile"
  done
}

purge_by_hash() {
  local hash="$1"
  stop_by_hash "$hash"
  rm -f "$PIDDIR/$hash.pid" "$PIDDIR/$hash.port" "$PIDDIR/$hash.log" "$PIDDIR/$hash.session"
  rm -rf "$PIDDIR/data/$hash"
  read -r name _ <<< "$(session_info "$hash" 2>/dev/null || echo "unknown")"
  echo "Purged session $name [$hash]"
}

find_hash_by_name() {
  local query="$1"
  for sessionfile in "$PIDDIR"/*.session; do
    [ -f "$sessionfile" ] || continue
    local hash=$(basename "$sessionfile" .session)
    if python3 -c "
import json, sys
s = json.load(open(sys.argv[1]))
q = sys.argv[2].lower()
if q in s.get('repo_name','').lower() or q in s.get('repo_path','').lower():
    sys.exit(0)
sys.exit(1)
" "$sessionfile" "$query" 2>/dev/null; then
      echo "$hash"
      return 0
    fi
  done
  # Fallback: search log files
  for logfile in "$PIDDIR"/*.log; do
    [ -f "$logfile" ] || continue
    if grep -q "$query" "$logfile" 2>/dev/null; then
      echo "$(basename "$logfile" .log)"
      return 0
    fi
  done
  return 1
}

case "${1:-}" in
  "")
    list_instances
    ;;
  --all)
    stop_all
    ;;
  --purge-all)
    for sessionfile in "$PIDDIR"/*.session; do
      [ -f "$sessionfile" ] || continue
      purge_by_hash "$(basename "$sessionfile" .session)"
    done
    ;;
  --purge)
    if [ -z "${2:-}" ]; then
      echo "Usage: cs-stop --purge <repo-name>"
      exit 1
    fi
    hash=$(find_hash_by_name "$2") || { echo "No session matching '$2'"; exit 1; }
    purge_by_hash "$hash"
    ;;
  *)
    hash=$(find_hash_by_name "$1") || { echo "No session matching '$1'"; exit 1; }
    stop_by_hash "$hash"
    ;;
esac
