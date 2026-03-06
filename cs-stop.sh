#!/bin/bash
# cs-stop - Stop code-server instances
# Usage: cs-stop              (list running instances)
#        cs-stop <repo-name>  (stop a specific one)
#        cs-stop --all        (stop all)

PIDDIR="${HOME}/.cs-spawn"

list_instances() {
  local found=0
  for portfile in "$PIDDIR"/*.port; do
    [ -f "$portfile" ] || continue
    local hash=$(basename "$portfile" .port)
    local pidfile="$PIDDIR/$hash.pid"
    [ -f "$pidfile" ] || continue

    local pid=$(cat "$pidfile")
    local port=$(cat "$portfile")

    if kill -0 "$pid" 2>/dev/null; then
      # Read the log to find the repo path
      local logfile="$PIDDIR/$hash.log"
      local path="unknown"
      if [ -f "$logfile" ]; then
        path=$(head -5 "$logfile" | grep -o '/[^ ]*' | head -1 || echo "unknown")
      fi
      echo "  PID $pid  port $port  $path"
      found=1
    else
      # Stale, clean up
      rm -f "$pidfile" "$portfile"
    fi
  done
  [ "$found" = 0 ] && echo "  (none running)"
}

stop_all() {
  for pidfile in "$PIDDIR"/*.pid; do
    [ -f "$pidfile" ] || continue
    local pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid"
      echo "Stopped PID $pid"
    fi
    rm -f "$pidfile"
    rm -f "${pidfile%.pid}.port"
  done
}

case "${1:-}" in
  "")
    echo "Running code-server instances:"
    list_instances
    ;;
  --all)
    stop_all
    ;;
  *)
    # Find by repo name substring
    for portfile in "$PIDDIR"/*.port; do
      [ -f "$portfile" ] || continue
      hash=$(basename "$portfile" .port)
      logfile="$PIDDIR/$hash.log"
      if [ -f "$logfile" ] && grep -q "$1" "$logfile" 2>/dev/null; then
        pidfile="$PIDDIR/$hash.pid"
        pid=$(cat "$pidfile")
        kill "$pid" 2>/dev/null && echo "Stopped $1 (PID $pid)"
        rm -f "$pidfile" "$portfile"
      fi
    done
    ;;
esac
