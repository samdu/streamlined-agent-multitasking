// Watches for code-server tabs and auto-creates a tab group named after the repo.
// Detects the repo name from the ?cs-repo= query param that cs-spawn injects.

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;

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

  // Don't re-group if already grouped
  if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) return;

  groupTab(tabId, repoName);
});

async function groupTab(tabId, repoName) {
  try {
    // Check if a group for this repo already exists in the same window
    const tab = await chrome.tabs.get(tabId);
    const groups = await chrome.tabGroups.query({ windowId: tab.windowId });
    const existing = groups.find(
      (g) => g.title === repoName
    );

    let groupId;
    if (existing) {
      // Add to existing group
      groupId = existing.id;
      await chrome.tabs.group({ tabIds: [tabId], groupId });
    } else {
      // Create new group
      groupId = await chrome.tabs.group({ tabIds: [tabId] });
      // Pick a color based on repo name hash so it's consistent
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
