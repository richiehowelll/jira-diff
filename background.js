/* ---------- cross-browser shim ---------- */
if (typeof browser !== 'undefined' && typeof chrome === 'undefined') {
  globalThis.chrome = browser;          // Firefox exposes browser.*, we alias it to chrome.*
}
/* --------------------------------------- */

const CUSTOM_CONTENT_SCRIPT_ID = 'jira-diff-custom-domains';

const normalizeDomainPattern = domain => {
  if (!domain || typeof domain !== 'string') return null;
  const normalized = domain.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^\*\./, '').toLowerCase();
  return normalized || null;
};

const isValidDomainPattern = domain => /^[a-z0-9.-]+$/.test(domain) && !domain.includes('..');

const parseDomainPatterns = raw => {
  const values = Array.isArray(raw) ? raw : String(raw || '').split(/[\n,]+/);
  return [...new Set(values.map(normalizeDomainPattern).filter(isValidDomainPattern))];
};

const isAtlassianDomain = domain => domain === 'atlassian.net' || domain.endsWith('.atlassian.net');

const domainToMatchPatterns = domain => {
  // Keep exact and wildcard origins separate so we only register patterns the user granted.
  const patterns = [`https://${domain}/*`];
  if (domain.includes('.')) patterns.push(`https://*.${domain}/*`);
  return patterns;
};

const hasOriginPermission = origin => new Promise(resolve => {
  chrome.permissions.contains({ origins: [origin] }, granted => resolve(Boolean(granted)));
});

const getGrantedPermissionDomains = () => new Promise(resolve => {
  chrome.permissions.getAll(permissions => {
    const origins = Array.isArray(permissions?.origins) ? permissions.origins : [];
    resolve(parseDomainPatterns(origins).filter(domain => !isAtlassianDomain(domain)));
  });
});

async function syncCustomDomainContentScript() {
  if (!chrome.scripting?.registerContentScripts) return;

  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CUSTOM_CONTENT_SCRIPT_ID] });
  } catch {
    // The script may not have been registered yet.
  }

  const { allowedDomains } = await chrome.storage.sync.get('allowedDomains');
  // Permissions are the browser's source of truth; storage can lag after upgrades or manual changes.
  const customDomains = [
    ...parseDomainPatterns(allowedDomains).filter(domain => !isAtlassianDomain(domain)),
    ...await getGrantedPermissionDomains()
  ];
  const matches = [];

  for (const domain of [...new Set(customDomains)]) {
    const origins = domainToMatchPatterns(domain);
    for (const origin of origins) {
      if (await hasOriginPermission(origin)) {
        matches.push(origin);
      }
    }
  }

  if (!matches.length) return;

  await chrome.scripting.registerContentScripts([{
    id: CUSTOM_CONTENT_SCRIPT_ID,
    matches,
    js: ['lib/diff_match_patch.js', 'content/content.js'],
    css: ['content/styles.css']
  }]);
}

chrome.runtime.onInstalled.addListener(async () => {
  if (!chrome.runtime?.id) {
    console.error('Extension context invalidated during installation.');
    return;
  }

  await syncCustomDomainContentScript();

  for (const cs of chrome.runtime.getManifest().content_scripts) {
    const tabs = await chrome.tabs.query({ url: cs.matches });

    for (const tab of tabs) {
      if (/^(chrome|chrome-extension):\/\//i.test(tab.url)) continue;

      try {
        await chrome.scripting.executeScript({
          files: cs.js,
          target: { tabId: tab.id, allFrames: cs.all_frames },
          injectImmediately: cs.run_at === 'document_start'
        });
      } catch (err) {
        console.error('Failed to inject content script via scripting API:', err);
      }
    }
  }
});

chrome.runtime.onStartup?.addListener(() => {
  syncCustomDomainContentScript().catch(err => {
    console.error('Failed to register custom Jira domain content scripts:', err);
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync' || !changes.allowedDomains) return;

  syncCustomDomainContentScript().catch(err => {
    console.error('Failed to register custom Jira domain content scripts:', err);
  });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.action !== 'syncCustomDomainContentScript') return false;

  syncCustomDomainContentScript()
    .then(() => sendResponse({ status: 'success' }))
    .catch(error => {
      console.error('Failed to sync custom Jira domain content scripts:', error);
      sendResponse({ status: 'error', message: error.message });
    });

  return true;
});

chrome.tabs.onActivated.addListener(activeInfo => {
  chrome.tabs.get(activeInfo.tabId, tab => {
    if (!chrome.runtime?.id) {
      console.error('Extension context invalidated during tab activation.');
      return;
    }

    chrome.tabs.sendMessage(tab.id, { action: 'checkExtensionState' }, () => {
      if (chrome.runtime.lastError) {
        // Ignore pages without an injected content script.
      }
    });
  });
});
