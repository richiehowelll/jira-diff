// popup.js
document.addEventListener('DOMContentLoaded', () => {
    const toggleHighlighting = document.getElementById('toggleHighlighting');

    chrome.storage.sync.get('highlightingEnabled', (data) => {
        toggleHighlighting.checked = data.highlightingEnabled !== false;
    });

    toggleHighlighting.addEventListener('change', () => {
        chrome.storage.sync.set({ highlightingEnabled: toggleHighlighting.checked });
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            chrome.tabs.sendMessage(tabs[0].id, { highlightingEnabled: toggleHighlighting.checked });
        });
    });
});
