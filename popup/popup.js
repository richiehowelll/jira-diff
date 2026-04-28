/* ---------- cross-browser shim ---------- */
if (typeof browser !== 'undefined' && typeof chrome === 'undefined') {
  globalThis.chrome = browser;
}
/* --------------------------------------- */

document.addEventListener('DOMContentLoaded', () => {
  const toggleSwitch = document.getElementById('extensionToggle');
  const allowedDomainsInput = document.getElementById('allowedDomains');
  const saveDomainsButton = document.getElementById('saveDomains');
  const statusMessage = document.getElementById('statusMessage');
  let storedDomains = [];

  const normalizeDomainValue = value => [...new Set(String(value || '')
    .split(/[\n,]+/)
    .map(domain => domain.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^\*\./, '').toLowerCase())
    .filter(domain => /^[a-z0-9.-]+$/.test(domain) && !domain.includes('..')))];

  const isAtlassianDomain = domain => domain === 'atlassian.net' || domain.endsWith('.atlassian.net');

  const domainToOrigins = domain => {
    const origins = [`https://${domain}/*`];
    if (domain.includes('.')) origins.push(`https://*.${domain}/*`);
    return origins;
  };

  const setSaveState = saving => {
    saveDomainsButton.disabled = saving;
    saveDomainsButton.textContent = saving ? 'Saving...' : 'Save domains';
  };

  const updateStatusMessage = (text, type) => {
    statusMessage.textContent = text || '';
    statusMessage.style.color = type === 'error' ? '#D32F2F' : type === 'success' ? '#2E7D32' : '#333';
  };

  const requestOrigins = origins => new Promise(resolve => {
    if (!origins.length) {
      resolve(true);
      return;
    }

    chrome.permissions.request({ origins }, granted => {
      resolve(Boolean(granted));
    });
  });

  const removeOrigins = origins => new Promise(resolve => {
    if (!origins.length) {
      resolve(true);
      return;
    }

    chrome.permissions.remove({ origins }, removed => {
      resolve(Boolean(removed));
    });
  });

  const syncCustomDomainContentScript = () => new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'syncCustomDomainContentScript' }, response => {
      if (chrome.runtime.lastError || response?.status === 'error') {
        resolve(false);
        return;
      }

      resolve(true);
    });
  });

  const saveAllowedDomains = domains => new Promise(resolve => {
    chrome.storage.sync.set({ allowedDomains: domains }, resolve);
  });

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

  const injectIntoTab = tabId => new Promise(resolve => {
    chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content/styles.css']
    }, () => {
      chrome.scripting.executeScript({
        target: { tabId },
        files: ['lib/diff_match_patch.js', 'content/content.js']
      }, () => {
        resolve(!chrome.runtime.lastError);
      });
    });
  });

  const applyToCurrentTab = domains => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs[0];
      if (!tab || !tab.url || !isHttpUrl(tab.url) || !isHostAllowed(tab.url, domains)) return;

      chrome.tabs.sendMessage(tab.id, { action: 'checkExtensionState' }, async () => {
        if (!chrome.runtime.lastError) {
          updateStatusMessage('Saved and applied to the current Jira page.', 'success');
          return;
        }

        const injected = await injectIntoTab(tab.id);
        if (injected) {
          updateStatusMessage('Saved and applied to the current Jira page.', 'success');
        } else {
          updateStatusMessage('Saved. Reload this Jira page to apply changes.', 'success');
        }
      });
    });
  };

  const saveDomains = async () => {
    const domains = normalizeDomainValue(allowedDomainsInput.value);
    const customOrigins = domains
      .filter(domain => !isAtlassianDomain(domain))
      .flatMap(domainToOrigins);

    setSaveState(true);

    try {
      const granted = await requestOrigins(customOrigins);
      if (!granted) {
        updateStatusMessage('Custom Jira domain access was not granted.', 'error');
        return;
      }

      const nextOriginSet = new Set(customOrigins);
      const removedOrigins = storedDomains
        .filter(domain => !isAtlassianDomain(domain))
        .flatMap(domainToOrigins)
        .filter(origin => !nextOriginSet.has(origin));

      await removeOrigins(removedOrigins);
      await saveAllowedDomains(domains);
      storedDomains = domains;
      await syncCustomDomainContentScript();
      allowedDomainsInput.value = domains.join('\n');
      updateStatusMessage('Jira domains saved.', 'success');
      applyToCurrentTab(domains);
    } finally {
      setSaveState(false);
    }
  };

  chrome.storage.sync.get(['extensionEnabled', 'allowedDomains'], data => {
    toggleSwitch.checked = data.extensionEnabled !== false;
    storedDomains = Array.isArray(data.allowedDomains)
      ? data.allowedDomains
      : normalizeDomainValue(data.allowedDomains);
    allowedDomainsInput.value = storedDomains.join('\n');
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

  allowedDomainsInput.addEventListener('input', () => {
    updateStatusMessage('Unsaved domain changes.', 'info');
  });

  saveDomainsButton.addEventListener('click', saveDomains);
});
