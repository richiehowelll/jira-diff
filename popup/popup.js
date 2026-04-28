/* ---------- cross-browser shim ---------- */
if (typeof browser !== 'undefined' && typeof chrome === 'undefined') {
  globalThis.chrome = browser;
}
/* --------------------------------------- */

document.addEventListener('DOMContentLoaded', () => {
  const toggleSwitch = document.getElementById('extensionToggle');
  const allowedDomainsInput = document.getElementById('allowedDomains');

  const normalizeDomainValue = value => String(value || '')
    .split(/[\n,]+/)
    .map(domain => domain.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase())
    .filter(Boolean);

  const saveAllowedDomains = domains => {
    chrome.storage.sync.set({ allowedDomains: domains });
  };

  const statusMessage = document.getElementById('statusMessage');

  const updateStatusMessage = (text, type) => {
    statusMessage.textContent = text || '';
    statusMessage.style.color = type === 'error' ? '#D32F2F' : type === 'success' ? '#2E7D32' : '#333';
  };

  const getCleanDomains = value => normalizeDomainValue(value);

  const isHttpUrl = url => /^https?:\/\//i.test(url);

  const isHostAllowed = (url, domains) => {
    try {
      const host = new URL(url).hostname.toLowerCase();
      const patterns = domains.length ? domains : ['atlassian.net'];
      return patterns.some(pattern => host === pattern || host.endsWith(`.${pattern}`));
    } catch {
      return false;
    }
  };

  const applyToCurrentTab = domains => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs[0];
      if (!tab || !tab.url || !isHttpUrl(tab.url)) return;

      const shouldReload = isHostAllowed(tab.url, domains);
      chrome.tabs.sendMessage(tab.id, { action: 'checkExtensionState' }, () => {
        if (chrome.runtime.lastError) {
          if (shouldReload) {
            updateStatusMessage('Reloading page to apply Jira domain changes...', 'success');
            chrome.tabs.reload(tab.id);
          }
        } else if (shouldReload) {
          updateStatusMessage('Applied changes to current page.', 'success');
        }
      });
    });
  };

  chrome.storage.sync.get(['extensionEnabled', 'allowedDomains'], data => {
    toggleSwitch.checked = data.extensionEnabled !== false;
    allowedDomainsInput.value = (Array.isArray(data.allowedDomains) ? data.allowedDomains : []).join('\n');
  });

  toggleSwitch.addEventListener('change', function () {
    const isEnabled = this.checked;
    chrome.storage.sync.set({ extensionEnabled: isEnabled });
    chrome.storage.sync.get('allowedDomains', data => {
      const domains = Array.isArray(data.allowedDomains)
        ? data.allowedDomains
        : normalizeDomainValue(data.allowedDomains);
      applyToCurrentTab(domains);
    });
  });

  let saveTimeout;
  allowedDomainsInput.addEventListener('input', () => {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      const domains = getCleanDomains(allowedDomainsInput.value);
      saveAllowedDomains(domains);
      applyToCurrentTab(domains);
    }, 400);
  });
});
