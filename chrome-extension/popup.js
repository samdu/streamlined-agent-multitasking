const q = document.getElementById("q");
const recentsEl = document.getElementById("recents");
const emptyEl = document.getElementById("empty");
let recents = [];
let selectedIdx = -1;
q.focus();

// Load recents + default repo
chrome.storage.local.get(["recents", "defaultRepo"], (data) => {
  recents = data.recents || [];
  if (data.defaultRepo) {
    q.value = data.defaultRepo;
  }
  q.select();
  renderRecents();
});

function renderRecents(filter = "") {
  const filtered = filter
    ? recents.filter(r => r.repo.toLowerCase().includes(filter.toLowerCase()))
    : recents;

  if (filtered.length === 0) {
    recentsEl.innerHTML = "";
    emptyEl.style.display = filter ? "none" : "block";
    return;
  }
  emptyEl.style.display = "none";

  let html = '<div class="section-label">Recent</div>';
  filtered.forEach((r, i) => {
    const wt = r.newtree ? `<span class="wt-badge">wt</span>` : "";
    html += `<div class="repo-item${i === selectedIdx ? " selected" : ""}" data-idx="${i}">
      <span class="name">${esc(r.repo)}</span>
      ${wt}
      <span class="meta">${timeAgo(r.ts)}</span>
      <span class="pin" data-repo="${esc(r.repo)}" title="Set as default">&#x25C9;</span>
      <span class="remove" data-repo="${esc(r.repo)}">&times;</span>
    </div>`;
  });
  recentsEl.innerHTML = html;

  recentsEl.querySelectorAll(".repo-item").forEach(el => {
    el.addEventListener("click", (e) => {
      if (e.target.classList.contains("remove")) {
        removeRecent(e.target.dataset.repo);
        return;
      }
      if (e.target.classList.contains("pin")) {
        setDefault(e.target.dataset.repo);
        return;
      }
      const r = filtered[el.dataset.idx];
      launch(r.repo, r.newtree || "");
    });
  });
}

q.addEventListener("input", () => {
  selectedIdx = -1;
  renderRecents(q.value.split("&")[0]);
});

q.addEventListener("keydown", (e) => {
  const items = recentsEl.querySelectorAll(".repo-item");
  if (e.key === "ArrowDown") {
    e.preventDefault();
    selectedIdx = Math.min(selectedIdx + 1, items.length - 1);
    renderRecents(q.value.split("&")[0]);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectedIdx = Math.max(selectedIdx - 1, -1);
    renderRecents(q.value.split("&")[0]);
  } else if (e.key === "Enter" && e.shiftKey) {
    e.preventDefault();
    if (q.value.trim()) {
      setDefault(q.value.split("&")[0].trim());
    }
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (selectedIdx >= 0 && items[selectedIdx]) {
      items[selectedIdx].click();
    } else if (q.value.trim()) {
      parseAndLaunch(q.value.trim());
    }
  }
});

function parseAndLaunch(input) {
  // Parse: "data-dbt", "data-dbt&newtree", "data-dbt&newtree=name"
  const parts = input.split("&");
  const repo = parts[0].trim();
  let newtree = "";
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i].trim();
    if (p === "newtree") {
      newtree = "__auto__";
    } else if (p.startsWith("newtree=")) {
      newtree = p.substring(8);
    }
  }
  launch(repo, newtree);
}

function launch(repo, newtree) {
  // Save to recents
  addRecent(repo, newtree);

  // Delegate to background worker (popup dies before fetch completes)
  chrome.runtime.sendMessage({ action: "spawn", repo, newtree });
  window.close();
}

function addRecent(repo, newtree) {
  // Remove duplicates
  recents = recents.filter(r => r.repo !== repo);
  recents.unshift({ repo, newtree, ts: Date.now() });
  recents = recents.slice(0, 20);
  chrome.storage.local.set({ recents });
}

function setDefault(repo) {
  chrome.storage.local.set({ defaultRepo: repo });
  q.value = repo;
  q.select();
  // Brief visual confirmation
  q.style.borderColor = "#3fb950";
  setTimeout(() => { q.style.borderColor = ""; }, 600);
}

function removeRecent(repo) {
  recents = recents.filter(r => r.repo !== repo);
  chrome.storage.local.set({ recents });
  renderRecents(q.value.split("&")[0]);
}

function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return "now";
  if (d < 3600000) return Math.floor(d / 60000) + "m";
  if (d < 86400000) return Math.floor(d / 3600000) + "h";
  return Math.floor(d / 86400000) + "d";
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

document.getElementById("sessions-link").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("sessions.html") });
  window.close();
});
