// Watches for code-server tabs, auto-groups them by repo name, and monitors
// server health so we can redirect to a reconnect page when a server dies.

// Map of tabId -> { port, repo, repoName, folder, url }
const trackedTabs = new Map();

// --- Tab tracking ---

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.url) return;

  let url;
  try {
    url = new URL(tab.url);
  } catch {
    return;
  }

  // Only act on local code-server instances
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return;

  const repoName = url.searchParams.get("cs-repo");
  if (!repoName) return;

  // Track this tab for health monitoring
  const folder = url.searchParams.get("folder") || "";
  // Derive the repo arg (relative to $HOME) from the folder path
  const homePrefix = folder.match(/^\/Users\/[^/]+\//)?.[0] || "";
  const repo = homePrefix ? folder.replace(homePrefix, "") : folder;

  trackedTabs.set(tabId, {
    port: url.port,
    repo,
    repoName,
    folder,
    url: tab.url,
  });

  // Group tab on complete
  if (changeInfo.status === "complete") {
    if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
      groupTab(tabId, repoName);
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  trackedTabs.delete(tabId);
});

// --- Tab grouping ---

async function groupTab(tabId, repoName) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const groups = await chrome.tabGroups.query({ windowId: tab.windowId });
    const existing = groups.find((g) => g.title === repoName);

    let groupId;
    if (existing) {
      groupId = existing.id;
      await chrome.tabs.group({ tabIds: [tabId], groupId });
    } else {
      groupId = await chrome.tabs.group({ tabIds: [tabId] });
      const colors = [
        "blue", "red", "yellow", "green",
        "pink", "purple", "cyan", "orange",
      ];
      const hash = [...repoName].reduce((a, c) => a + c.charCodeAt(0), 0);
      const color = colors[hash % colors.length];
      await chrome.tabGroups.update(groupId, {
        title: repoName,
        color,
        collapsed: false,
      });
    }
  } catch (err) {
    console.error("cs-grouper:", err);
  }
}

// --- Health monitoring ---

const HEALTH_INTERVAL_MS = 15_000;
const deadPorts = new Set();

async function checkHealth() {
  for (const [tabId, info] of trackedTabs) {
    // Verify tab still exists
    try {
      await chrome.tabs.get(tabId);
    } catch {
      trackedTabs.delete(tabId);
      continue;
    }

    // Skip tabs that are already on the reconnect page
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url && tab.url.includes("reconnect.html")) continue;
    } catch {
      continue;
    }

    try {
      const resp = await fetch(`http://127.0.0.1:${info.port}/healthz`, {
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        deadPorts.delete(info.port);
        continue;
      }
    } catch {
      // Server is unreachable
    }

    // Require two consecutive failures before redirecting (avoids flapping
    // during brief restarts or network hiccups)
    if (!deadPorts.has(info.port)) {
      deadPorts.add(info.port);
      continue;
    }

    // Server is confirmed dead — redirect to reconnect page
    const reconnectUrl =
      chrome.runtime.getURL("reconnect.html") +
      `?repo=${encodeURIComponent(info.repo)}` +
      `&port=${encodeURIComponent(info.port)}` +
      `&folder=${encodeURIComponent(info.folder)}` +
      `&name=${encodeURIComponent(info.repoName)}`;

    try {
      await chrome.tabs.update(tabId, { url: reconnectUrl });
    } catch (err) {
      console.error("cs-reconnect: failed to redirect tab", tabId, err);
    }
  }
}

// --- Command queue polling ---

async function pollCommands() {
  try {
    const resp = await fetch("http://127.0.0.1:19377/commands/pending", {
      signal: AbortSignal.timeout(3000),
    });
    const cmds = await resp.json();
    for (const cmd of cmds) {
      try {
        if (cmd.type === "create-tab-group") {
          await handleCreateTabGroup(cmd.payload);
        } else if (cmd.type === "add-to-tab-group") {
          await handleAddToTabGroup(cmd.payload);
        }
      } catch (err) {
        console.error("cs-command:", cmd.type, err);
      }
    }
  } catch {
    // cs-api unreachable, skip
  }
}

const GROUP_COLORS = [
  "blue", "red", "yellow", "green",
  "pink", "purple", "cyan", "orange",
];

function pickColor(name) {
  const hash = [...(name || "")].reduce((a, c) => a + c.charCodeAt(0), 0);
  return GROUP_COLORS[hash % GROUP_COLORS.length];
}

async function handleCreateTabGroup({ name, urls, color }) {
  if (!urls || urls.length === 0) return;

  // Check for an existing group with this name in the focused window
  const [win] = await chrome.windows.getAll({ windowTypes: ["normal"] });
  if (!win) return;
  const groups = await chrome.tabGroups.query({ windowId: win.id });
  const existing = groups.find((g) => g.title === name);

  const tabIds = [];
  for (const url of urls) {
    const tab = await chrome.tabs.create({ url, active: false, windowId: win.id });
    tabIds.push(tab.id);
  }

  let groupId;
  if (existing) {
    // Add to existing group
    groupId = existing.id;
    await chrome.tabs.group({ tabIds, groupId });
  } else {
    groupId = await chrome.tabs.group({ tabIds });
    await chrome.tabGroups.update(groupId, {
      title: name || "Untitled",
      color: color || pickColor(name),
      collapsed: false,
    });
  }
}

async function handleAddToTabGroup({ name, urls }) {
  if (!urls || urls.length === 0 || !name) return;
  const [win] = await chrome.windows.getAll({ windowTypes: ["normal"] });
  if (!win) return;
  const groups = await chrome.tabGroups.query({ windowId: win.id });
  const existing = groups.find((g) => g.title === name);
  if (!existing) {
    // Fall back to creating a new group
    await handleCreateTabGroup({ name, urls });
    return;
  }
  const tabIds = [];
  for (const url of urls) {
    const tab = await chrome.tabs.create({ url, active: false, windowId: win.id });
    tabIds.push(tab.id);
  }
  await chrome.tabs.group({ tabIds, groupId: existing.id });
}

// MV3 service workers can't use setInterval reliably, so use the alarms API
chrome.alarms.create("cs-health-check", { periodInMinutes: 0.25 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "cs-health-check") {
    checkHealth();
    pollCommands();
  }
});

// --- Spawn handler (receives from popup) ---
// Popup dies before fetch() can complete, so it delegates here.

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "spawn") {
    fetch("http://127.0.0.1:19377/spawn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: msg.repo, newtree: msg.newtree || "" }),
    }).catch((err) => console.error("cs-spawn:", err));
  }
});

// --- Session dashboard shortcut (Cmd+Shift+,) ---

const SESSIONS_PATH = "sessions.html";

chrome.commands.onCommand.addListener((command) => {
  if (command === "open-sessions") {
    openSessionsDashboard();
  }
});

async function openSessionsDashboard() {
  const sessionsUrl = chrome.runtime.getURL(SESSIONS_PATH);
  const tabs = await chrome.tabs.query({ url: sessionsUrl });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: sessionsUrl });
  }
}
