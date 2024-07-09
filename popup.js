document.addEventListener('DOMContentLoaded', function() {
    var toggleSwitch = document.getElementById('highlighterToggle');
  
    // Load the current state
    chrome.storage.sync.get('highlighterEnabled', function(data) {
        toggleSwitch.checked = data.highlighterEnabled !== false;
    });
  
    // Save the state and send message when the toggle is clicked
    toggleSwitch.addEventListener('change', function() {
        const isEnabled = this.checked;
        chrome.storage.sync.set({highlighterEnabled: isEnabled}, function() {
            console.log('Highlighter enabled: ' + isEnabled);
        });
      
        // Send message to content script
        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            chrome.tabs.sendMessage(tabs[0].id, {action: "toggleHighlighter", enabled: isEnabled}, function(response) {
                if (chrome.runtime.lastError) {
                    console.error(chrome.runtime.lastError);
                } else if (response && response.status === "success") {
                    console.log("Toggle successful");
                }
            });
        });
    });
});