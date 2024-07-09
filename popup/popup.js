document.addEventListener('DOMContentLoaded', function() {
    var toggleSwitch = document.getElementById('extensionToggle');
  
    // Load the current state
    chrome.storage.sync.get('extensionEnabled', function(data) {
        toggleSwitch.checked = data.extensionEnabled !== false;
    });
  
    // Save the state and send message when the toggle is clicked
    toggleSwitch.addEventListener('change', function() {
        const isEnabled = this.checked;
        chrome.storage.sync.set({extensionEnabled: isEnabled});
      
        // Send message to content script
        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            chrome.tabs.sendMessage(tabs[0].id, {action: "toggleExtension", enabled: isEnabled}, function(response) {
                if (chrome.runtime.lastError) {
                    console.error(chrome.runtime.lastError);
                }
            });
        });
    });
});