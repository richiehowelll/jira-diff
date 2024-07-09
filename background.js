chrome.tabs.onActivated.addListener(function(activeInfo) {
    chrome.tabs.get(activeInfo.tabId, function(tab) {
      if (tab.url && (tab.url.includes('atlassian.net/jira') || tab.url.includes('atlassian.net/browse'))) {
        chrome.tabs.sendMessage(tab.id, {action: "checkEnhancerState"});
      }
    });
  });