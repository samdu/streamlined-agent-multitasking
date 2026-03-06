const params = new URLSearchParams(location.search);
const repo = params.get("repo") || "";
const port = params.get("port") || "";
const folder = params.get("folder") || "";
const repoName = params.get("name") || repo;

const repoNameEl = document.getElementById("repo-name");
const statusEl = document.getElementById("status");
const btn = document.getElementById("reconnect-btn");
const hintEl = document.getElementById("hint");

repoNameEl.textContent = repoName;

const healthUrl = `http://127.0.0.1:${port}/healthz`;
const serverUrl = `http://127.0.0.1:${port}/?folder=${encodeURIComponent(folder)}&cs-repo=${encodeURIComponent(repoName)}`;

let polling = false;

btn.addEventListener("click", () => {
  const schemeUrl = `codeserver://open?repo=${encodeURIComponent(repo)}`;
  const iframe = document.createElement("iframe");
  iframe.style.display = "none";
  iframe.src = schemeUrl;
  document.body.appendChild(iframe);

  btn.disabled = true;
  btn.textContent = "Starting...";
  statusEl.className = "status polling";
  statusEl.innerHTML = '<span class="spinner"></span>Waiting for server...';
  hintEl.textContent = "This usually takes a few seconds";

  startPolling();
});

function startPolling() {
  if (polling) return;
  polling = true;
  poll();
}

function poll() {
  fetch(healthUrl, { mode: "no-cors" })
    .then(() => {
      return fetch(healthUrl).catch(() => null);
    })
    .then((resp) => {
      if (resp && resp.ok) {
        statusEl.className = "status alive";
        statusEl.textContent = "Server is back — redirecting...";
        setTimeout(() => {
          location.href = serverUrl;
        }, 500);
        return;
      }
      setTimeout(poll, 1500);
    })
    .catch(() => {
      setTimeout(poll, 1500);
    });
}

// Check immediately on load — maybe it's already back
fetch(healthUrl)
  .then((resp) => {
    if (resp.ok) {
      statusEl.className = "status alive";
      statusEl.textContent = "Server is running — redirecting...";
      setTimeout(() => {
        location.href = serverUrl;
      }, 500);
    }
  })
  .catch(() => {});
