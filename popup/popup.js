/* ---------- cross-browser shim ---------- */
if (typeof browser !== 'undefined' && typeof chrome === 'undefined') {
  globalThis.chrome = browser;
}
/* --------------------------------------- */

document.addEventListener('DOMContentLoaded', () => {
  const DEFAULT_LARGE_CHANGE_LIMIT = 500;
  const MIN_LARGE_CHANGE_LIMIT = 1;
  const MAX_LARGE_CHANGE_LIMIT = 10000;

  const els = {
    toggle: document.getElementById('extensionToggle'),
    largeChangeLimit: document.getElementById('largeChangeLimit'),
    domainInput: document.getElementById('allowedDomains'),
    addDomain: document.getElementById('addDomain'),
    domainList: document.getElementById('domainList'),
    emptyDomains: document.getElementById('emptyDomains'),
    status: document.getElementById('statusMessage')
  };

  const state = {
    domains: []
  };

  const normalizeDomains = value => [...new Set(String(value || '')
    .split(/[\n,]+/)
    .map(domain => domain.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^\*\./, '').toLowerCase())
    .filter(domain => /^[a-z0-9.-]+$/.test(domain) && !domain.includes('..')))];

  const isAtlassianDomain = domain => domain === 'atlassian.net' || domain.endsWith('.atlassian.net');

  const normalizeLargeChangeLimit = value => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_LARGE_CHANGE_LIMIT;
    return Math.min(Math.max(parsed, MIN_LARGE_CHANGE_LIMIT), MAX_LARGE_CHANGE_LIMIT);
  };

  const domainToOrigins = domain => {
    // Request the bare domain and its subdomains without requiring broad install-time access.
    const origins = [`https://${domain}/*`];
    if (domain.includes('.')) origins.push(`https://*.${domain}/*`);
    return origins;
  };

  const customOriginsFor = domains => domains
    .filter(domain => !isAtlassianDomain(domain))
    .flatMap(domainToOrigins);

  const setStatus = (text, type) => {
    els.status.textContent = text || '';
    els.status.style.color = type === 'error' ? '#D32F2F' : type === 'success' ? '#2E7D32' : '#333';
  };

  const setSaving = saving => {
    els.addDomain.disabled = saving;
    els.addDomain.textContent = saving ? 'Saving...' : 'Add';
  };

  const storageGet = keys => new Promise(resolve => chrome.storage.sync.get(keys, resolve));
  const storageSet = data => new Promise(resolve => chrome.storage.sync.set(data, resolve));
  const permissionRequest = origins => new Promise(resolve => {
    if (!origins.length) {
      resolve(true);
      return;
    }

    chrome.permissions.request({ origins }, granted => resolve(Boolean(granted)));
  });
  const permissionRemove = origins => new Promise(resolve => {
    if (!origins.length) {
      resolve(true);
      return;
    }

    chrome.permissions.remove({ origins }, removed => resolve(Boolean(removed)));
  });
  const permissionDomains = () => new Promise(resolve => {
    chrome.permissions.getAll(permissions => {
      resolve(normalizeDomains(permissions?.origins || []).filter(domain => !isAtlassianDomain(domain)));
    });
  });
  const syncContentScripts = () => new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'syncCustomDomainContentScript' }, response => {
      resolve(!chrome.runtime.lastError && response?.status !== 'error');
    });
  });

  const renderDomains = () => {
    els.domainList.textContent = '';
    els.emptyDomains.style.display = state.domains.length ? 'none' : 'block';

    for (const domain of state.domains) {
      const item = document.createElement('li');
      item.className = 'domain-item';

      const label = document.createElement('span');
      label.textContent = domain;

      const removeButton = document.createElement('button');
      removeButton.className = 'remove-domain';
      removeButton.type = 'button';
      removeButton.textContent = 'x';
      removeButton.setAttribute('aria-label', `Remove ${domain}`);
      removeButton.addEventListener('click', () => saveDomains(state.domains.filter(item => item !== domain)));

      item.append(label, removeButton);
      els.domainList.appendChild(item);
    }
  };

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
    chrome.scripting.insertCSS({ target: { tabId }, files: ['content/styles.css'] }, () => {
      chrome.scripting.executeScript({
        target: { tabId },
        files: ['lib/diff_match_patch.js', 'content/content.js']
      }, () => resolve(!chrome.runtime.lastError));
    });
  });

  const applyToCurrentTab = domains => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs[0];
      if (!tab?.url || !/^https?:\/\//i.test(tab.url) || !isHostAllowed(tab.url, domains)) return;

      chrome.tabs.sendMessage(tab.id, { action: 'checkExtensionState' }, async () => {
        // Newly granted custom domains may need an immediate manual injection before the next reload.
        if (!chrome.runtime.lastError || await injectIntoTab(tab.id)) {
          setStatus('Applied to the current Jira page.', 'success');
          return;
        }

        setStatus('Saved. Reload this Jira page to apply changes.', 'success');
      });
    });
  };

  async function saveDomains(nextDomains) {
    const domains = [...new Set(nextDomains)];
    const addedOrigins = customOriginsFor(domains.filter(domain => !state.domains.includes(domain)));
    const removedOrigins = customOriginsFor(state.domains.filter(domain => !domains.includes(domain)));

    setSaving(true);

    try {
      if (!await permissionRequest(addedOrigins)) {
        setStatus('Custom Jira domain access was not granted.', 'error');
        return;
      }

      await permissionRemove(removedOrigins);
      await storageSet({ allowedDomains: domains });
      state.domains = domains;
      renderDomains();
      await syncContentScripts();
      setStatus('Jira domains saved.', 'success');
      applyToCurrentTab(domains);
    } finally {
      setSaving(false);
    }
  }

  const addDomain = () => {
    const [domain] = normalizeDomains(els.domainInput.value);
    if (!domain) {
      setStatus('Enter a valid Jira domain.', 'error');
      return;
    }

    if (state.domains.includes(domain)) {
      els.domainInput.value = '';
      setStatus('That Jira domain is already added.', 'success');
      return;
    }

    els.domainInput.value = '';
    saveDomains([...state.domains, domain]);
  };

  const loadDomains = async () => {
    const data = await storageGet([
      'extensionEnabled',
      'allowedDomains',
      'largeChangeLimit',
      'largeInsertionLimit'
    ]);
    const configuredDomains = Array.isArray(data.allowedDomains)
      ? data.allowedDomains
      : normalizeDomains(data.allowedDomains);
    const grantedDomains = await permissionDomains();

    els.toggle.checked = data.extensionEnabled !== false;
    els.largeChangeLimit.value = normalizeLargeChangeLimit(data.largeChangeLimit ?? data.largeInsertionLimit);
    state.domains = [...new Set([...configuredDomains, ...grantedDomains])];
    renderDomains();

    // Reconcile storage if the browser already has optional permissions for a domain.
    if (grantedDomains.some(domain => !configuredDomains.includes(domain))) {
      await storageSet({ allowedDomains: state.domains });
      await syncContentScripts();
    }
  };

  els.toggle.addEventListener('change', () => {
    chrome.storage.sync.set({ extensionEnabled: els.toggle.checked });
    applyToCurrentTab(state.domains);
  });
  els.largeChangeLimit.addEventListener('change', async () => {
    const largeChangeLimit = normalizeLargeChangeLimit(els.largeChangeLimit.value);
    els.largeChangeLimit.value = largeChangeLimit;
    await storageSet({ largeChangeLimit });
    setStatus('Large change limit saved.', 'success');
    applyToCurrentTab(state.domains);
  });
  els.addDomain.addEventListener('click', addDomain);
  els.domainInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') addDomain();
  });
  els.domainInput.addEventListener('input', () => setStatus('', 'info'));

  loadDomains().catch(() => {
    setStatus('Could not load saved Jira domains.', 'error');
  });
});
