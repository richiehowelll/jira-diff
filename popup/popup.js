/* ---------- cross-browser shim ---------- */
if (typeof browser !== 'undefined' && typeof chrome === 'undefined') {
  globalThis.chrome = browser;
}
/* --------------------------------------- */

document.addEventListener('DOMContentLoaded', () => {
  const toggleSwitch = document.getElementById('extensionToggle');

  chrome.storage.sync.get('extensionEnabled', data => {
    toggleSwitch.checked = data.extensionEnabled !== false;
  });

  toggleSwitch.addEventListener('change', function () {
    const isEnabled = this.checked;
    chrome.storage.sync.set({ extensionEnabled: isEnabled });

    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      chrome.tabs.sendMessage(
        tabs[0].id,
        { action: 'toggleExtension', enabled: isEnabled },
        () => {
          if (chrome.runtime.lastError) {
            console.error(chrome.runtime.lastError);
          }
        }
      );
    });
  });
});
