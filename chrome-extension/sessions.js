const API = "http://127.0.0.1:19377";
const REFRESH_MS = 5000;
const INACTIVE_DAYS = 14;

const repoListEl = document.getElementById("repo-list");
const hiddenSection = document.getElementById("hidden-section");
const hiddenToggle = document.getElementById("hidden-toggle");
const hiddenLabel = document.getElementById("hidden-label");
const hiddenListEl = document.getElementById("hidden-list");
const errorBanner = document.getElementById("error-banner");
const refreshIndicator = document.getElementById("refresh-indicator");

let refreshTimer = null;
let collapseState = {};  // repoPath -> bool (true = collapsed)

chrome.storage.local.get(["repoCollapseState"], (data) => {
  collapseState = data.repoCollapseState || {};
  refresh();
  refreshTimer = setInterval(refresh, REFRESH_MS);
});

// --- Main refresh ---

function hasActiveInput() {
  return !!document.querySelector(".wt-create-row");
}

async function refresh() {
  refreshIndicator.classList.add("active");
  try {
    const [repos, tabs] = await Promise.all([
      fetchRepos(),
      queryCodeServerTabs(),
    ]);
    errorBanner.style.display = "none";

    if (hasActiveInput()) return;

    const tabsByPort = new Map();
    for (const tab of tabs) {
      try {
        const url = new URL(tab.url);
        if (!tabsByPort.has(url.port)) tabsByPort.set(url.port, []);
        tabsByPort.get(url.port).push(tab);
      } catch {}
    }

    annotateWithTabs(repos, tabsByPort);
    const { active, hidden } = classifyRepos(repos);
    renderActive(active);
    renderHidden(hidden);
  } catch (err) {
    errorBanner.innerHTML =
      `Can't reach session daemon at <code>${API}</code>. ` +
      `Make sure <code>cs-api</code> is running.`;
    errorBanner.style.display = "block";
  } finally {
    refreshIndicator.classList.remove("active");
  }
}

async function fetchRepos() {
  const resp = await fetch(`${API}/repos`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function queryCodeServerTabs() {
  return chrome.tabs.query({ url: "http://127.0.0.1:*/*" });
}

// --- Tab cross-referencing ---

function annotateWithTabs(repos, tabsByPort) {
  for (const repo of repos) {
    annotateSession(repo, tabsByPort);
    for (const wt of repo.worktrees) {
      annotateSession(wt, tabsByPort);
    }
  }
}

function annotateSession(node, tabsByPort) {
  const s = node.session;
  if (!s) {
    node._tabs = [];
    node._hasTab = false;
    return;
  }
  const port = String(s.port || "");
  node._tabs = tabsByPort.get(port) || [];
  node._hasTab = node._tabs.length > 0;
}

// --- Classification ---

function classifyRepos(repos) {
  const cutoff = Date.now() / 1000 - INACTIVE_DAYS * 86400;
  const active = [];
  const hidden = [];

  for (const repo of repos) {
    const hasSession = !!repo.session;
    const hasWorktrees = repo.worktrees.length > 0;
    const recentActivity = repo.last_activity && repo.last_activity > cutoff;

    if (hasSession || hasWorktrees || recentActivity) {
      active.push(repo);
    } else {
      hidden.push(repo);
    }
  }

  active.sort(repoSorter);
  hidden.sort((a, b) => a.name.localeCompare(b.name));
  return { active, hidden };
}

function repoSorter(a, b) {
  const aAlive = hasAliveSession(a);
  const bAlive = hasAliveSession(b);
  if (aAlive !== bAlive) return bAlive - aAlive;
  const aTime = a.last_activity || 0;
  const bTime = b.last_activity || 0;
  if (aTime !== bTime) return bTime - aTime;
  return a.name.localeCompare(b.name);
}

function hasAliveSession(repo) {
  if (repo.session && repo.session.alive) return true;
  for (const wt of repo.worktrees) {
    if (wt.session && wt.session.alive) return true;
  }
  return false;
}

// --- Render active repos ---

function renderActive(repos) {
  if (repos.length === 0) {
    repoListEl.innerHTML = '<div class="empty">No active repos</div>';
    return;
  }
  repoListEl.innerHTML = repos.map(renderRepoGroup).join("");
}

function renderRepoGroup(repo) {
  const hasWt = repo.worktrees.length > 0;
  const collapsed = hasWt && collapseState[repo.path] === true;
  const autoExpand = hasWt && !collapsed && repo.worktrees.some(
    wt => wt.session && wt.session.alive
  );
  const isExpanded = hasWt && (autoExpand || collapseState[repo.path] === false || !(repo.path in collapseState));

  const toggleHtml = hasWt
    ? `<span class="toggle" data-action="toggle" data-path="${esc(repo.path)}">${isExpanded ? "▾" : "▸"}</span>`
    : `<span class="toggle empty"></span>`;

  const repoRow = renderRow("repo-row", toggleHtml, repo, repo.session, true);

  let wtHtml = "";
  if (hasWt && isExpanded) {
    const wtRows = repo.worktrees.map((wt, i) => {
      const isLast = i === repo.worktrees.length - 1;
      return renderRow(`wt-row${isLast ? " last" : ""}`, "", wt, wt.session, false);
    }).join("");
    wtHtml = `<div class="worktrees-container">${wtRows}</div>`;
  }

  return `<div class="repo-group">${repoRow}${wtHtml}</div>`;
}

function renderRow(className, toggleHtml, node, session, isRepo) {
  const s = session;
  const alive = s && s.alive;
  const hasTab = node._hasTab;

  let dotClass = "none";
  if (alive && hasTab) dotClass = "active";
  else if (alive && !hasTab) dotClass = "orphaned";
  else if (s && !alive) dotClass = "stopped";

  const nameClass = (alive || s) ? "" : " dimmed";
  const badge = alive
    ? (hasTab
      ? `<span class="tab-badge has-tab">${node._tabs.length} tab${node._tabs.length > 1 ? "s" : ""}</span>`
      : '<span class="tab-badge no-tab">no tab</span>')
    : "";

  const port = s && s.port ? `port ${s.port}` : "";
  const pid = alive && s.pid ? `PID ${s.pid}` : "";
  const age = s && s.last_spawned ? timeAgo(s.last_spawned * 1000) : "";
  const meta = [port, pid, age].filter(Boolean).join(" · ");
  const pathDisplay = node.path || "";

  const actions = buildActions(node, session, isRepo);

  return `
    <div class="${className}">
      ${toggleHtml}
      <div class="status-dot ${dotClass}"></div>
      <div class="session-info">
        <div class="session-name${nameClass}" title="${esc(pathDisplay)}">${esc(node.name)}</div>
        <div class="session-meta">
          <span>${esc(pathDisplay)}</span>
          ${meta ? `<span>${meta}</span>` : ""}
        </div>
      </div>
      ${badge}
      <div class="actions">${actions}</div>
    </div>`;
}

function buildActions(node, session, isRepo) {
  const s = session;
  const alive = s && s.alive;
  const hasTab = node._hasTab;
  const parts = [];

  if (alive && hasTab) {
    parts.push(btn("Focus", "btn-focus", { action: "focus", port: s.port }));
    parts.push(btn("Stop", "btn-stop", { action: "stop", hash: s.hash }));
  } else if (alive && !hasTab) {
    parts.push(btn("Open", "btn-open", { action: "open", repoPath: node.path, port: s.port, repoName: node.name }));
    parts.push(btn("Stop", "btn-stop", { action: "stop", hash: s.hash }));
  } else if (s && !alive) {
    parts.push(btn("Resurrect", "btn-resurrect", { action: "resurrect", repoPath: node.path, repoName: node.name }));
    parts.push(btn("Purge", "btn-purge", { action: "purge", hash: s.hash }));
  } else {
    parts.push(btn("Spawn", "btn-spawn", { action: "spawn", repoPath: node.path, repoName: node.name }));
  }

  if (isRepo) {
    parts.push(btn("+", "btn-add", { action: "add-worktree", repoPath: node.path, repoName: node.name }));
  } else {
    parts.push(btn("Remove", "btn-remove", { action: "remove-worktree", wtPath: node.path }));
  }

  return parts.join("");
}

// --- Render hidden repos ---

function renderHidden(repos) {
  if (repos.length === 0) {
    hiddenSection.style.display = "none";
    return;
  }
  hiddenSection.style.display = "block";
  hiddenLabel.textContent = `${repos.length} other repo${repos.length !== 1 ? "s" : ""}`;
  hiddenListEl.innerHTML = repos.map(repo => `
    <div class="hidden-row">
      <div class="session-info">
        <div class="session-name">${esc(repo.name)}</div>
        <div class="session-meta"><span>${esc(repo.path)}</span></div>
      </div>
      <div class="actions">
        ${btn("Spawn", "btn-spawn", { action: "spawn", repoPath: repo.path, repoName: repo.name })}
        ${btn("+", "btn-add", { action: "add-worktree", repoPath: repo.path, repoName: repo.name })}
      </div>
    </div>
  `).join("");
}

// --- Helpers ---

function btn(label, cls, data) {
  const attrs = Object.entries(data)
    .map(([k, v]) => `data-${k}="${esc(String(v))}"`)
    .join(" ");
  return `<button class="btn ${cls}" data-orig-label="${esc(label)}" ${attrs}>${label}</button>`;
}

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

function saveCollapseState() {
  chrome.storage.local.set({ repoCollapseState: collapseState });
}

// --- Actions (event delegation) ---

document.addEventListener("click", async (e) => {
  const button = e.target.closest("button[data-action]");
  const toggle = e.target.closest(".toggle[data-action='toggle']");

  if (toggle) {
    const path = toggle.dataset.path;
    const wasCollapsed = collapseState[path] === true;
    collapseState[path] = !wasCollapsed;
    saveCollapseState();
    refresh();
    return;
  }

  if (!button) return;

  const action = button.dataset.action;
  button.disabled = true;

  try {
    switch (action) {
      case "focus": {
        const tabs = await chrome.tabs.query({ url: `http://127.0.0.1:${button.dataset.port}/*` });
        if (tabs.length > 0) {
          await chrome.tabs.update(tabs[0].id, { active: true });
          await chrome.windows.update(tabs[0].windowId, { focused: true });
          flashButton(button, "Focused!");
        } else {
          flashButton(button, "No tab", true);
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
        flashButton(button, resp.ok ? "Stopped!" : "Failed", !resp.ok);
        setTimeout(refresh, 500);
        break;
      }
      case "resurrect": {
        fireCodeServerUrl(button.dataset.repopath);
        flashButton(button, "Launching…");
        setTimeout(refresh, 3000);
        break;
      }
      case "purge": {
        const resp = await fetch(`${API}/purge/${button.dataset.hash}`, { method: "POST" });
        flashButton(button, resp.ok ? "Purged!" : "Failed", !resp.ok);
        setTimeout(refresh, 500);
        break;
      }
      case "spawn": {
        const resp = await fetch(`${API}/spawn`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo: button.dataset.repopath }),
        });
        flashButton(button, resp.ok ? "Spawning…" : "Failed", !resp.ok);
        setTimeout(refresh, 3000);
        break;
      }
      case "add-worktree": {
        showWorktreeInput(button);
        break;
      }
      case "remove-worktree": {
        const resp = await fetch(`${API}/worktree/remove`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: button.dataset.wtpath }),
        });
        flashButton(button, resp.ok ? "Removed!" : "Failed", !resp.ok);
        setTimeout(refresh, 500);
        break;
      }
    }
  } catch (err) {
    flashButton(button, "Error", true);
    console.error(`cs-sessions: ${action} failed`, err);
  }
});

function fireCodeServerUrl(repoPath) {
  const homePrefix = repoPath.match(/^\/Users\/[^/]+\//)?.[0] || "";
  const repo = homePrefix ? repoPath.replace(homePrefix, "") : repoPath;
  const url = `codeserver://open?repo=${encodeURIComponent(repo)}`;
  const iframe = document.createElement("iframe");
  iframe.style.display = "none";
  iframe.src = url;
  document.body.appendChild(iframe);
  setTimeout(() => iframe.remove(), 2000);
}

// --- Inline worktree creation ---

function showWorktreeInput(addButton) {
  const repoPath = addButton.dataset.repopath;
  const repoGroup = addButton.closest(".repo-group") || addButton.closest(".hidden-row");
  if (!repoGroup) return;

  const existing = repoGroup.querySelector(".wt-create-row");
  if (existing) {
    existing.querySelector(".wt-input").focus();
    return;
  }

  const row = document.createElement("div");
  row.className = "wt-create-row";
  row.innerHTML = `<input class="wt-input" type="text" placeholder="branch name (empty for auto)">`;
  repoGroup.appendChild(row);

  const input = row.querySelector(".wt-input");
  input.focus();

  input.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") {
      row.remove();
      return;
    }
    if (e.key === "Enter") {
      const name = input.value.trim();
      input.disabled = true;
      try {
        const resp = await fetch(`${API}/spawn`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repo: repoPath,
            newtree: name || "__auto__",
          }),
        });
        if (resp.ok) {
          row.remove();
          setTimeout(refresh, 3000);
        } else {
          input.disabled = false;
          input.style.borderColor = "#f85149";
        }
      } catch {
        input.disabled = false;
        input.style.borderColor = "#f85149";
      }
    }
  });

  input.addEventListener("blur", () => {
    setTimeout(() => {
      if (document.activeElement !== input) row.remove();
    }, 200);
  });

  addButton.disabled = false;
}

// --- Hidden repos toggle ---

hiddenToggle.addEventListener("click", () => {
  hiddenToggle.classList.toggle("open");
  hiddenListEl.classList.toggle("open");
});

// --- Visibility-aware auto-refresh ---

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  } else {
    refresh();
    refreshTimer = setInterval(refresh, REFRESH_MS);
  }
});
