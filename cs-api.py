#!/usr/bin/env python3
"""Tiny HTTP API for cs-spawn session management.

Reads ~/.cs-spawn/*.session files and exposes them over HTTP so the
Chrome extension can enumerate all sessions, not just ones it has
seen tabs for.

Endpoints:
  GET  /sessions       — JSON array of all sessions with alive/dead status
  GET  /agents         — per-port agent state (branch, agent running/idle/working)
  POST /spawn          — start a code-server session (JSON body: {repo, newtree?})
  POST /stop/{hash}    — SIGTERM a running session
  POST /purge/{hash}   — stop + delete all state for a session
"""

import glob
import json
import os
import shutil
import signal
import subprocess
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = 19377
PIDDIR = os.path.expanduser("~/.cs-spawn")


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


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/sessions":
            self._json(200, load_sessions())
        elif self.path == "/agents":
            self._json(200, get_agent_states())
        elif self.path == "/config":
            self._json(200, load_config())
        elif self.path == "/health":
            self._json(200, {"ok": True})
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
        elif self.path.startswith("/stop/"):
            h = self.path[6:]
            ok = stop_session(h)
            self._json(200 if ok else 404, {"stopped": ok})
        elif self.path.startswith("/purge/"):
            h = self.path[7:]
            ok = purge_session(h)
            self._json(200 if ok else 404, {"purged": ok})
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
