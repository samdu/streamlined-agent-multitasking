#!/usr/bin/env python3
"""Tiny HTTP API for cs-spawn session management.

Reads ~/.cs-spawn/*.session files and exposes them over HTTP so the
Chrome extension can enumerate all sessions, not just ones it has
seen tabs for.

Endpoints:
  GET  /sessions       — JSON array of all sessions with alive/dead status
  GET  /repos          — repo tree with worktrees and session cross-references
  GET  /agents         — per-port agent state (branch, agent running/idle/working)
  POST /spawn          — start a code-server session (JSON body: {repo, newtree?})
  POST /stop/{hash}    — SIGTERM a running session
  POST /purge/{hash}   — stop + delete all state for a session
  POST /worktree/remove — git worktree remove + session purge
"""

import glob
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = 19377
PIDDIR = os.path.expanduser("~/.cs-spawn")

# Command queue for Chrome extension
_command_lock = threading.Lock()
_command_queue = []



def is_alive(pidfile):
    if not os.path.exists(pidfile):
        return False
    try:
        pid = int(open(pidfile).read().strip())
        os.kill(pid, 0)
        return True
    except (ValueError, OSError, ProcessLookupError):
        return False


def load_sessions():
    sessions = []
    for sf in sorted(glob.glob(os.path.join(PIDDIR, "*.session"))):
        try:
            with open(sf) as f:
                s = json.load(f)
        except (json.JSONDecodeError, IOError):
            continue
        h = os.path.basename(sf).replace(".session", "")
        pidfile = os.path.join(PIDDIR, f"{h}.pid")
        s["hash"] = h
        s["alive"] = is_alive(pidfile)
        sessions.append(s)
    return sessions


def stop_session(h):
    pidfile = os.path.join(PIDDIR, f"{h}.pid")
    if not os.path.exists(pidfile):
        return False
    try:
        pid = int(open(pidfile).read().strip())
        os.kill(pid, signal.SIGTERM)
    except (ValueError, OSError, ProcessLookupError):
        pass
    try:
        os.remove(pidfile)
    except OSError:
        pass
    return True


def purge_session(h):
    stop_session(h)
    for ext in (".pid", ".port", ".log", ".session"):
        try:
            os.remove(os.path.join(PIDDIR, f"{h}{ext}"))
        except OSError:
            pass
    datadir = os.path.join(PIDDIR, "data", h)
    if os.path.isdir(datadir):
        shutil.rmtree(datadir, ignore_errors=True)
    return True


def get_process_tree():
    """Single ps call to build a pid->info map and parent->children map."""
    try:
        result = subprocess.run(
            ["ps", "-eo", "pid=,ppid=,pcpu=,args="],
            capture_output=True, text=True, timeout=5,
        )
    except Exception:
        return {}, {}
    procs = {}
    children = {}
    for line in result.stdout.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 3)
        if len(parts) < 4:
            continue
        try:
            pid, ppid, pcpu = int(parts[0]), int(parts[1]), float(parts[2])
        except ValueError:
            continue
        procs[pid] = {"pid": pid, "ppid": ppid, "pcpu": pcpu, "args": parts[3]}
        children.setdefault(ppid, []).append(pid)
    return procs, children


def identify_agent(args):
    """Return agent type if this process is a known AI coding agent, else None."""
    if "cursor-agent" in args:
        return "cursor"
    if "claude-code" in args:
        return "claude"
    binary = args.split()[0] if args else ""
    if os.path.basename(binary) == "claude":
        return "claude"
    return None


def find_agent_descendant(pid, procs, children, depth=0):
    """Walk descendants of pid looking for an AI agent process."""
    if depth > 10:
        return None
    for child in children.get(pid, []):
        proc = procs.get(child)
        if proc:
            agent_type = identify_agent(proc["args"])
            if agent_type:
                return {**proc, "agent_type": agent_type}
        found = find_agent_descendant(child, procs, children, depth + 1)
        if found:
            return found
    return None


def get_git_branch(repo_path):
    try:
        result = subprocess.run(
            ["git", "-C", repo_path, "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=2,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception:
        pass
    return None


CPU_THRESHOLD = 2.0  # above this = working, below = idle


def base_repo_name(repo_path):
    """Extract the base repo name, resolving worktree paths.

    Worktrees live in <repo>-worktrees/ adjacent to the source repo,
    so /Users/x/github/data-dbt-worktrees/branch-name → 'data-dbt'.
    Normal repos just use the last path component.
    """
    parts = repo_path.rstrip("/").split("/")
    for part in parts:
        if part.endswith("-worktrees"):
            return part[: -len("-worktrees")]
    return parts[-1] if parts else ""


def get_agent_states():
    """Return per-port dict of repo info + agent state for alive sessions."""
    sessions = load_sessions()
    procs, children = get_process_tree()
    result = {}
    for s in sessions:
        if not s.get("alive"):
            continue
        port = s.get("port")
        if not port:
            continue
        repo_path = s.get("repo_path", "")
        repo_name = base_repo_name(repo_path) if repo_path else s.get("repo_name", "")
        branch = get_git_branch(repo_path) if repo_path else None

        agent_state = None
        h = s.get("hash", "")
        pidfile = os.path.join(PIDDIR, f"{h}.pid")
        try:
            cs_pid = int(open(pidfile).read().strip())
        except Exception:
            cs_pid = None
        if cs_pid:
            agent_proc = find_agent_descendant(cs_pid, procs, children)
            if agent_proc:
                state = "working" if agent_proc["pcpu"] > CPU_THRESHOLD else "idle"
                agent_state = {
                    "state": state,
                    "type": agent_proc.get("agent_type", "unknown"),
                    "pid": agent_proc["pid"],
                    "cpu": agent_proc["pcpu"],
                }
        result[str(port)] = {
            "repo_name": repo_name,
            "repo_path": repo_path,
            "branch": branch,
            "agent": agent_state,
        }
    return result


def load_config():
    """Parse ~/.cs-spawn/config (shell key=value) into a dict."""
    config_path = os.path.join(PIDDIR, "config")
    result = {}
    if not os.path.exists(config_path):
        return result
    try:
        with open(config_path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    key, _, val = line.partition("=")
                    key = key.strip()
                    val = val.strip().strip('"').strip("'")
                    result[key] = val
    except IOError:
        pass
    return result


SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".next", "target",
    "venv", ".venv", "dist", "build", ".mypy_cache", ".pytest_cache",
    ".tox", ".eggs", ".bundle",
}
INACTIVE_DAYS = 14
MTIME_CACHE_TTL = 60  # seconds

_repo_mtime_cache = {}  # path -> (timestamp, mtime_result)


def compute_path_hash(path):
    """Reproduce the session hash: first 8 chars of md5(absolute_path)."""
    return hashlib.md5(path.encode()).hexdigest()[:8]


def get_repo_mtime(repo_path):
    """Return the mtime of the most recently modified file in repo_path.

    Uses os.walk with directory exclusions and early termination once a
    file newer than the 14-day cutoff is found. Results are cached for
    MTIME_CACHE_TTL seconds.
    """
    now = time.time()
    cached = _repo_mtime_cache.get(repo_path)
    if cached and (now - cached[0]) < MTIME_CACHE_TTL:
        return cached[1]

    cutoff = now - INACTIVE_DAYS * 86400
    max_mtime = 0.0
    found_recent = False

    try:
        for root, dirs, files in os.walk(repo_path):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for f in files:
                try:
                    mt = os.path.getmtime(os.path.join(root, f))
                except OSError:
                    continue
                if mt > max_mtime:
                    max_mtime = mt
                if mt > cutoff:
                    found_recent = True
                    break
            if found_recent:
                break
    except OSError:
        pass

    result = max_mtime if max_mtime > 0 else None
    _repo_mtime_cache[repo_path] = (now, result)
    return result


def load_repos():
    """Scan configured REPO_DIRS, discover repos/worktrees, cross-reference sessions."""
    config = load_config()
    raw_dirs = config.get("REPO_DIRS", "~/github")
    repo_dirs = [os.path.expanduser(d.strip()) for d in raw_dirs.split(",") if d.strip()]

    sessions = load_sessions()
    session_by_hash = {s["hash"]: s for s in sessions}

    repos = []
    seen_paths = set()

    for parent_dir in repo_dirs:
        if not os.path.isdir(parent_dir):
            continue
        try:
            entries = sorted(os.listdir(parent_dir))
        except OSError:
            continue

        for name in entries:
            if name.endswith("-worktrees"):
                continue
            repo_path = os.path.join(parent_dir, name)
            if not os.path.isdir(repo_path):
                continue
            git_path = os.path.join(repo_path, ".git")
            if not os.path.exists(git_path):
                continue
            if repo_path in seen_paths:
                continue
            seen_paths.add(repo_path)

            repo_hash = compute_path_hash(repo_path)
            repo_session = session_by_hash.get(repo_hash)

            worktrees = []
            wt_container = os.path.join(parent_dir, f"{name}-worktrees")
            if os.path.isdir(wt_container):
                try:
                    wt_entries = sorted(os.listdir(wt_container))
                except OSError:
                    wt_entries = []
                for wt_name in wt_entries:
                    wt_path = os.path.join(wt_container, wt_name)
                    if not os.path.isdir(wt_path):
                        continue
                    wt_hash = compute_path_hash(wt_path)
                    wt_session = session_by_hash.get(wt_hash)
                    worktrees.append({
                        "name": wt_name,
                        "path": wt_path,
                        "branch": get_git_branch(wt_path),
                        "session": wt_session,
                    })

            # Compute last_activity: best session timestamp, else filesystem mtime
            timestamps = []
            if repo_session and repo_session.get("last_spawned"):
                timestamps.append(repo_session["last_spawned"])
            for wt in worktrees:
                if wt["session"] and wt["session"].get("last_spawned"):
                    timestamps.append(wt["session"]["last_spawned"])

            if timestamps:
                last_activity = max(timestamps)
            else:
                last_activity = get_repo_mtime(repo_path)

            repos.append({
                "name": name,
                "path": repo_path,
                "session": repo_session,
                "worktrees": worktrees,
                "last_activity": last_activity,
            })

    # Also surface sessions whose repo_path doesn't match any discovered repo
    # (e.g. repos in directories not in REPO_DIRS)
    discovered_hashes = set()
    for r in repos:
        if r["session"]:
            discovered_hashes.add(r["session"]["hash"])
        for wt in r["worktrees"]:
            if wt["session"]:
                discovered_hashes.add(wt["session"]["hash"])

    for s in sessions:
        if s["hash"] in discovered_hashes:
            continue
        repo_path = s.get("repo_path", "")
        repos.append({
            "name": s.get("repo_name", os.path.basename(repo_path)),
            "path": repo_path,
            "session": s,
            "worktrees": [],
            "last_activity": s.get("last_spawned"),
        })

    return repos


def remove_worktree(wt_path):
    """Remove a git worktree directory and any associated session.

    Returns (success: bool, error: str|None).
    """
    if "-worktrees/" not in wt_path:
        return False, "path does not look like a worktree"

    # Infer parent repo
    idx = wt_path.index("-worktrees/")
    parent_repo = wt_path[:idx]
    if not os.path.isdir(parent_repo):
        return False, f"parent repo not found: {parent_repo}"

    # Purge any associated session
    wt_hash = compute_path_hash(wt_path)
    sessions = load_sessions()
    for s in sessions:
        if s["hash"] == wt_hash:
            purge_session(wt_hash)
            break

    # git worktree remove
    if os.path.isdir(wt_path):
        try:
            result = subprocess.run(
                ["git", "-C", parent_repo, "worktree", "remove", wt_path, "--force"],
                capture_output=True, text=True, timeout=10,
            )
            if result.returncode != 0 and os.path.isdir(wt_path):
                shutil.rmtree(wt_path, ignore_errors=True)
        except Exception:
            if os.path.isdir(wt_path):
                shutil.rmtree(wt_path, ignore_errors=True)

    # Clean up empty worktree container
    wt_container = os.path.dirname(wt_path)
    try:
        if os.path.isdir(wt_container) and not os.listdir(wt_container):
            os.rmdir(wt_container)
    except OSError:
        pass

    return True, None


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/sessions":
            self._json(200, load_sessions())
        elif self.path == "/repos":
            self._json(200, load_repos())
        elif self.path == "/agents":
            self._json(200, get_agent_states())
        elif self.path == "/config":
            self._json(200, load_config())
        elif self.path == "/health":
            self._json(200, {"ok": True})
        elif self.path == "/commands/pending":
            with _command_lock:
                cmds = list(_command_queue)
                _command_queue.clear()
            self._json(200, cmds)
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/spawn":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            repo = body.get("repo", "")
            newtree = body.get("newtree", "")
            if not repo:
                self._json(400, {"error": "repo is required"})
                return
            cmd = [os.path.expanduser("~/.local/bin/cs-spawn"), repo]
            if newtree == "__auto__":
                cmd.append("--newtree")
            elif newtree:
                cmd.append(f"--newtree={newtree}")
            if body.get("no_open"):
                cmd.append("--no-open")
            try:
                subprocess.Popen(
                    cmd,
                    stdout=open(os.path.join(PIDDIR, "spawn.log"), "a"),
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
                self._json(200, {"spawned": repo})
            except Exception as e:
                self._json(500, {"error": str(e)})
        elif self.path == "/worktree/remove":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            wt_path = body.get("path", "")
            if not wt_path:
                self._json(400, {"error": "path is required"})
                return
            ok, err = remove_worktree(wt_path)
            if ok:
                self._json(200, {"removed": True})
            else:
                self._json(400, {"error": err})
        elif self.path.startswith("/stop/"):
            h = self.path[6:]
            ok = stop_session(h)
            self._json(200 if ok else 404, {"stopped": ok})
        elif self.path.startswith("/purge/"):
            h = self.path[7:]
            ok = purge_session(h)
            self._json(200 if ok else 404, {"purged": ok})
        elif self.path == "/commands":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            cmd_type = body.get("type", "")
            if not cmd_type:
                self._json(400, {"error": "type is required"})
                return
            cmd_id = str(uuid.uuid4())[:8]
            cmd = {"id": cmd_id, "type": cmd_type, "payload": body.get("payload", {}), "ts": time.time()}
            with _command_lock:
                _command_queue.append(cmd)
            self._json(200, {"queued": cmd_id})
        else:
            self._json(404, {"error": "not found"})

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def _json(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def log_message(self, fmt, *args):
        pass  # silence request logging


def main():
    os.makedirs(PIDDIR, exist_ok=True)
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"cs-api listening on 127.0.0.1:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    server.server_close()


if __name__ == "__main__":
    main()
