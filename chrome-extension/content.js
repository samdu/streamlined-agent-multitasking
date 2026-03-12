// Injected into code-server pages. Polls cs-api for agent state and
// overrides document.title + favicon to reflect repo/branch and agent status.
// Also prevents Chrome from throttling background tabs (which kills the
// WebSocket connection between the code-server UI and server process).

const CS_API = "http://127.0.0.1:19377";

// --- Anti-throttle (silent audio) ---
// Chrome throttles JS timers in background tabs to ~1/min, which starves the
// code-server WebSocket heartbeat and causes repeated "Connection lost" cycles.
// An active AudioContext with connected nodes exempts the tab from throttling.

(function initAntiThrottle() {
  let ctx;
  try {
    ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 1;
    gain.gain.value = 0.001;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
  } catch {
    return;
  }
  if (ctx.state === "suspended") {
    const resume = () => ctx.resume();
    document.addEventListener("click", resume, { once: true });
    document.addEventListener("keydown", resume, { once: true });
  }
})();
const POLL_MS = 5000;
const PORT = location.port;

// --- Favicon SVGs (colored rounded square with agent-specific symbol) ---

function svgIcon(fill, innerSvg) {
  return (
    `data:image/svg+xml,` +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
        `<rect width="32" height="32" rx="8" fill="${fill}"/>` +
        innerSvg +
        `</svg>`
    )
  );
}

const CARET = `<path d="M12 9L21 16L12 23" stroke="rgba(255,255,255,0.9)" stroke-width="3" ` +
  `stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;

const SPARKLE = `<path d="M16 7L18 13L24 16L18 19L16 25L14 19L8 16L14 13Z" ` +
  `fill="rgba(255,255,255,0.9)"/>`;

const FAVICON = {
  none: svgIcon("#6B7280", ""),
  cursor_idle: svgIcon("#22C55E", CARET),
  cursor_working: svgIcon("#3B82F6", CARET),
  claude_idle: svgIcon("#22C55E", SPARKLE),
  claude_working: svgIcon("#3B82F6", SPARKLE),
};

// --- Title management ---
// code-server (VS Code) constantly resets document.title based on the active
// editor. We use a MutationObserver on <title> to immediately override it.

let desiredTitle = null;
let suppressTitleObserver = false;

const titleObserver = new MutationObserver(() => {
  if (suppressTitleObserver) return;
  if (desiredTitle && document.title !== desiredTitle) {
    suppressTitleObserver = true;
    document.title = desiredTitle;
    suppressTitleObserver = false;
  }
});

function watchTitle() {
  const el = document.querySelector("title");
  if (el) {
    titleObserver.observe(el, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return;
  }
  setTimeout(watchTitle, 500);
}
watchTitle();

function setTitle(title) {
  desiredTitle = title;
  if (document.title !== title) {
    suppressTitleObserver = true;
    document.title = title;
    suppressTitleObserver = false;
  }
}

// --- Favicon management ---
// code-server also sets its own favicon. We remove theirs and block new ones.

let currentFavicon = null;

function setFavicon(dataUri) {
  if (currentFavicon === dataUri) return;
  currentFavicon = dataUri;
  document
    .querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]')
    .forEach((el) => el.remove());
  const link = document.createElement("link");
  link.rel = "icon";
  link.type = "image/svg+xml";
  link.href = dataUri;
  document.head.appendChild(link);
}

const headObserver = new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (
        node.nodeType === 1 &&
        node.tagName === "LINK" &&
        (node.rel === "icon" || node.rel === "shortcut icon") &&
        currentFavicon &&
        node.href !== currentFavicon
      ) {
        node.remove();
      }
    }
  }
});
if (document.head) {
  headObserver.observe(document.head, { childList: true });
}

// --- Polling ---

async function poll() {
  try {
    const resp = await fetch(`${CS_API}/agents`, {
      signal: AbortSignal.timeout(3000),
    });
    const agents = await resp.json();
    const state = agents[PORT];
    if (!state) return;

    const branch = state.branch || "?";
    setTitle(`${state.repo_name}/${branch}`);

    if (!state.agent) {
      setFavicon(FAVICON.none);
    } else {
      const type = state.agent.type || "cursor";
      const key = `${type}_${state.agent.state}`;
      setFavicon(FAVICON[key] || FAVICON.none);
    }
  } catch {
    // cs-api not reachable — leave current state as-is
  }
}

poll();
setInterval(poll, POLL_MS);
