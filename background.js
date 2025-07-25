/* ---------- cross-browser shim ---------- */
if (typeof browser !== 'undefined' && typeof chrome === 'undefined') {
  globalThis.chrome = browser;          // Firefox exposes browser.*, we alias it to chrome.*
}
/* --------------------------------------- */

chrome.runtime.onInstalled.addListener(async () => {
  if (!chrome.runtime?.id) {
    console.error('Extension context invalidated during installation.');
    return;
  }

  for (const cs of chrome.runtime.getManifest().content_scripts) {
    const tabs = await chrome.tabs.query({ url: cs.matches });

    for (const tab of tabs) {
      if (/^(chrome|chrome-extension):\/\//i.test(tab.url)) continue;

      try {
        await chrome.scripting.executeScript({
          files: cs.js,
          target: { tabId: tab.id, allFrames: cs.all_frames },
          injectImmediately: cs.run_at === 'document_start'
        });
      } catch (err) {
        console.error('Failed to inject content script via scripting API:', err);
      }
    }
  }
});

chrome.tabs.onActivated.addListener(activeInfo => {
  chrome.tabs.get(activeInfo.tabId, tab => {
    if (!chrome.runtime?.id) {
      console.error('Extension context invalidated during tab activation.');
      return;
    }

    if (tab.url && (tab.url.includes('atlassian.net/jira') || tab.url.includes('atlassian.net/browse'))) {
      chrome.tabs.sendMessage(tab.id, { action: 'checkExtensionState' });
    }
  });
});
