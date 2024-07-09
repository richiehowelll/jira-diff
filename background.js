chrome.runtime.onInstalled.addListener(async () => {
  for (const cs of chrome.runtime.getManifest().content_scripts) {
    for (const tab of await chrome.tabs.query({url: cs.matches})) {
      if (tab.url.match(/(chrome|chrome-extension):\/\//gi)) {
        continue;
      }
      chrome.scripting.executeScript({
        files: cs.js,
        target: {tabId: tab.id, allFrames: cs.all_frames},
        injectImmediately: cs.run_at === 'document_start',
      });
    }
  }
});

chrome.tabs.onActivated.addListener(function(activeInfo) {
  chrome.tabs.get(activeInfo.tabId, function(tab) {
    if (tab.url && (tab.url.includes('atlassian.net/jira') || tab.url.includes('atlassian.net/browse'))) {
      chrome.tabs.sendMessage(tab.id, {action: "checkExtensionState"});
    }
  });
});