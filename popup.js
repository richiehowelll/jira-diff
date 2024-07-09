document.addEventListener('DOMContentLoaded', function() {
    var toggleSwitch = document.getElementById('enhancerToggle');
  
    // Load the current state
    chrome.storage.sync.get('enhancerEnabled', function(data) {
        toggleSwitch.checked = data.enhancerEnabled !== false;
    });
  
    // Save the state and send message when the toggle is clicked
    toggleSwitch.addEventListener('change', function() {
        const isEnabled = this.checked;
        chrome.storage.sync.set({enhancerEnabled: isEnabled}, function() {
            console.log('Enhancer enabled: ' + isEnabled);
        });
      
        // Send message to content script
        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            chrome.tabs.sendMessage(tabs[0].id, {action: "toggleEnhancer", enabled: isEnabled}, function(response) {
                if (chrome.runtime.lastError) {
                    console.error(chrome.runtime.lastError);
                } else if (response && response.status === "success") {
                    console.log("Toggle successful");
                }
            });
        });
    });
});