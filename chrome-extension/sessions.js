const API = "http://127.0.0.1:19377";
const REFRESH_MS = 5000;

const runningList = document.getElementById("running-list");
const stoppedList = document.getElementById("stopped-list");
const runningCount = document.getElementById("running-count");
const stoppedCount = document.getElementById("stopped-count");
const errorBanner = document.getElementById("error-banner");
const refreshIndicator = document.getElementById("refresh-indicator");

let refreshTimer = null;

async function refresh() {
  refreshIndicator.classList.add("active");
  try {
    const [sessions, tabs] = await Promise.all([
      fetchSessions(),
      queryCodeServerTabs(),
    ]);

    errorBanner.style.display = "none";

    const tabsByPort = new Map();
    for (const tab of tabs) {
      try {
        const url = new URL(tab.url);
        const port = url.port;
        if (!tabsByPort.has(port)) tabsByPort.set(port, []);
        tabsByPort.get(port).push(tab);
      } catch {}
    }

    const running = [];
    const stopped = [];
    for (const s of sessions) {
      const port = String(s.port || "");
      s._tabs = tabsByPort.get(port) || [];
      s._hasTab = s._tabs.length > 0;
      if (s.alive) {
        running.push(s);
      } else {
        stopped.push(s);
      }
    }

    running.sort((a, b) => (b.last_spawned || 0) - (a.last_spawned || 0));
    stopped.sort((a, b) => (b.last_spawned || 0) - (a.last_spawned || 0));

    renderRunning(running);
    renderStopped(stopped);
    runningCount.textContent = running.length;
    stoppedCount.textContent = stopped.length;
  } catch (err) {
    errorBanner.innerHTML =
      `Can't reach session daemon at <code>${API}</code>. ` +
      `Make sure <code>cs-api</code> is running.`;
    errorBanner.style.display = "block";
  } finally {
    refreshIndicator.classList.remove("active");
  }
}

async function fetchSessions() {
  const resp = await fetch(`${API}/sessions`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function queryCodeServerTabs() {
  return chrome.tabs.query({ url: "http://127.0.0.1:*/*" });
}

function renderRunning(sessions) {
  if (sessions.length === 0) {
    runningList.innerHTML = '<div class="empty">No running sessions</div>';
    return;
  }
  runningList.innerHTML = sessions.map((s) => {
    const dotClass = s._hasTab ? "active" : "orphaned";
    const badge = s._hasTab
      ? `<span class="tab-badge has-tab">${s._tabs.length} tab${s._tabs.length > 1 ? "s" : ""}</span>`
      : '<span class="tab-badge no-tab">no tab</span>';

    const actions = [];
    if (s._hasTab) {
      actions.push(btn("Focus", "btn-focus", { action: "focus", port: s.port }));
    } else {
      actions.push(btn("Open", "btn-open", { action: "open", repoPath: s.repo_path, port: s.port, repoName: s.repo_name }));
    }
    actions.push(btn("Stop", "btn-stop", { action: "stop", hash: s.hash }));

    return sessionRow(dotClass, s, badge, actions.join(""));
  }).join("");
}

function renderStopped(sessions) {
  if (sessions.length === 0) {
    stoppedList.innerHTML = '<div class="empty">No stopped sessions</div>';
    return;
  }
  stoppedList.innerHTML = sessions.map((s) => {
    const actions = [
      btn("Resurrect", "btn-resurrect", { action: "resurrect", repoPath: s.repo_path, port: s.port, repoName: s.repo_name }),
      btn("Purge", "btn-purge", { action: "purge", hash: s.hash }),
    ];
    return sessionRow("stopped", s, "", actions.join(""));
  }).join("");
}

function sessionRow(dotClass, s, badge, actionsHtml) {
  const port = s.port ? `port ${s.port}` : "";
  const pid = s.alive && s.pid ? `PID ${s.pid}` : "";
  const age = s.last_spawned ? timeAgo(s.last_spawned * 1000) : "";
  const meta = [port, pid, age].filter(Boolean).join(" · ");

  return `
    <div class="session-row">
      <div class="status-dot ${dotClass}"></div>
      <div class="session-info">
        <div class="session-name" title="${esc(s.repo_path || "")}">${esc(s.repo_name || s.hash)}</div>
        <div class="session-meta">
          <span>${esc(s.repo_path || "")}</span>
          <span>${meta}</span>
        </div>
      </div>
      ${badge}
      <div class="actions">${actionsHtml}</div>
    </div>`;
}

function btn(label, cls, data) {
  const attrs = Object.entries(data)
    .map(([k, v]) => `data-${k}="${esc(String(v))}"`)
    .join(" ");
  return `<button class="btn ${cls}" data-orig-label="${esc(label)}" ${attrs}>${label}</button>`;
}

// --- Actions (event delegation — onclick attrs are blocked by MV3 CSP) ---

document.addEventListener("click", async (e) => {
  const button = e.target.closest("button[data-action]");
  if (!button) return;

  const action = button.dataset.action;
  button.disabled = true;
  const origLabel = button.textContent;

  try {
    switch (action) {
      case "focus": {
        const tabs = await chrome.tabs.query({ url: `http://127.0.0.1:${button.dataset.port}/*` });
        if (tabs.length > 0) {
          await chrome.tabs.update(tabs[0].id, { active: true });
          await chrome.windows.update(tabs[0].windowId, { focused: true });
          flashButton(button, "Focused!");
        } else {
          flashButton(button, "No tab found", true);
        }
        break;
      }
      case "open": {
        const folder = encodeURIComponent(button.dataset.repopath);
        const name = encodeURIComponent(button.dataset.reponame);
        await chrome.tabs.create({
          url: `http://127.0.0.1:${button.dataset.port}/?folder=${folder}&cs-repo=${name}`,
        });
        flashButton(button, "Opened!");
        setTimeout(refresh, 500);
        break;
      }
      case "stop": {
        const resp = await fetch(`${API}/stop/${button.dataset.hash}`, { method: "POST" });
        if (resp.ok) {
          flashButton(button, "Stopped!");
        } else {
          flashButton(button, "Failed", true);
        }
        setTimeout(refresh, 500);
        break;
      }
      case "resurrect": {
        const repoPath = button.dataset.repopath;
        const homePrefix = repoPath.match(/^\/Users\/[^/]+\//)?.[0] || "";
        const repo = homePrefix ? repoPath.replace(homePrefix, "") : repoPath;
        const url = `codeserver://open?repo=${encodeURIComponent(repo)}`;
        const iframe = document.createElement("iframe");
        iframe.style.display = "none";
        iframe.src = url;
        document.body.appendChild(iframe);
        setTimeout(() => iframe.remove(), 2000);
        flashButton(button, "Launching…");
        setTimeout(refresh, 3000);
        break;
      }
      case "purge": {
        const resp = await fetch(`${API}/purge/${button.dataset.hash}`, { method: "POST" });
        if (resp.ok) {
          flashButton(button, "Purged!");
        } else {
          flashButton(button, "Failed", true);
        }
        setTimeout(refresh, 500);
        break;
      }
    }
  } catch (err) {
    flashButton(button, "Error", true);
    console.error(`cs-sessions: ${action} failed`, err);
  }
});

function flashButton(button, text, isError) {
  button.textContent = text;
  if (isError) button.style.color = "#f85149";
  const origLabel = button.dataset.origLabel;
  setTimeout(() => {
    button.disabled = false;
    button.textContent = origLabel || text;
    button.style.color = "";
  }, 1500);
}

// --- Helpers ---

function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return "just now";
  if (d < 3600000) return Math.floor(d / 60000) + "m ago";
  if (d < 86400000) return Math.floor(d / 3600000) + "h ago";
  return Math.floor(d / 86400000) + "d ago";
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML.replace(/'/g, "&#39;");
}

// --- Init ---

refresh();
refreshTimer = setInterval(refresh, REFRESH_MS);

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  } else {
    refresh();
    refreshTimer = setInterval(refresh, REFRESH_MS);
  }
});
