/* ---------- cross-browser shim ---------- */
if (typeof browser !== 'undefined' && typeof chrome === 'undefined') {
  globalThis.chrome = browser;
}
/* --------------------------------------- */

const isExtensionValid = () => chrome.runtime && chrome.runtime.id;

const DiffHighlighter = {
  async init() {
    try {
      if (!isExtensionValid()) return;
      const data = await chrome.storage.sync.get('extensionEnabled');
      if (data.extensionEnabled !== false) {
        this.enhanceDiff();
        this.setupObserver();
      }
    } catch (error) {
      console.error('Error initializing DiffHighlighter:', error);
    }
  },

  async enhanceDiff() {
    try {
      if (!isExtensionValid()) return;
      const data = await chrome.storage.sync.get('extensionEnabled');
      if (data.extensionEnabled !== false) {
        const diffContainers = this.findDiffContainers();
        
        for (const [index, container] of diffContainers.entries()) {
          if (container.querySelector('.enhanced-diff')) continue;
      
          const containerId = `diff-container-${Date.now()}-${index}`;
          container.id = containerId;
      
          const originalContent = container.innerHTML;
          await chrome.storage.local.set({[containerId]: originalContent});
      
          const oldText = container.children[0]?.textContent || '';
          const newText = container.children[2]?.textContent || '';
  
          if (!oldText || !newText) {
            console.error('Error: Expected child elements not found in diff container');
            continue;
          }
          
          const enhancedDiff = this.createEnhancedDiff(oldText, newText);
          
          container.innerHTML = '';
          container.appendChild(enhancedDiff);
        }
      }
    } catch (error) {
      console.error('Error enhancing diff:', error);
    }
  },

  findDiffContainers() {
    const updateElements = Array.from(document.querySelectorAll('div'))
      .filter(el => el.textContent.includes('updated the Description'));

    return updateElements.map(el => {
      const possibleDiffContainer = el.nextElementSibling;
      return (possibleDiffContainer && possibleDiffContainer.children.length === 3) ? possibleDiffContainer : null;
    }).filter(Boolean);
  },

  createEnhancedDiff(oldText, newText) {
    const diffContainer = document.createElement('div');
    diffContainer.className = 'enhanced-diff';

    let dmp;
    try {
      dmp = new diff_match_patch();
    } catch (e) {
      console.error('Failed to create diff_match_patch instance:', e);
      return this.fallbackDiffDisplay(oldText, newText);
    }

    let diffs;
    try {
      diffs = dmp.diff_main(oldText, newText);
      dmp.diff_cleanupSemantic(diffs);
    } catch (e) {
      console.error('Failed to compute diff:', e);
      return this.fallbackDiffDisplay(oldText, newText);
    }

    if (!Array.isArray(diffs)) {
      console.error('diff_main did not return an array');
      return this.fallbackDiffDisplay(oldText, newText);
    }

    const oldContainer = document.createElement('div');
    oldContainer.className = 'old-text';
    
    const newContainer = document.createElement('div');
    newContainer.className = 'new-text';

    let isLargeInsertion = false;
    let insertionBuffer = '';

    diffs.forEach((diff) => {
      const operation = diff[0];
      const text = diff[1];
      const formattedText = this.formatText(text);

      switch(operation) {
        case 0: // DIFF_EQUAL
          if (isLargeInsertion) {
            oldContainer.innerHTML += `<div class="large-change-indicator">Large insertion (${insertionBuffer.length} characters)</div>`;
            newContainer.innerHTML += `<div class="large-change">${insertionBuffer}</div>`;
            isLargeInsertion = false;
            insertionBuffer = '';
          }
          oldContainer.innerHTML += formattedText;
          newContainer.innerHTML += formattedText;
          break;
        case -1: // DIFF_DELETE
          oldContainer.innerHTML += `<span class="deleted">${formattedText}</span>`;
          break;
        case 1: // DIFF_INSERT
          if (text.length > 50) {
            isLargeInsertion = true;
            insertionBuffer += formattedText;
          } else {
            newContainer.innerHTML += `<span class="inserted">${formattedText}</span>`;
            oldContainer.innerHTML += `<span class="placeholder">${'&nbsp;'.repeat(Math.min(text.length, 10))}</span>`;
          }
          break;
      }
    });

    // Handle any remaining large insertion at the end
    if (isLargeInsertion) {
      oldContainer.innerHTML += `<div class="large-change-indicator">Large insertion (${insertionBuffer.length} characters)</div>`;
      newContainer.innerHTML += `<div class="large-change">${insertionBuffer}</div>`;
    }

    diffContainer.appendChild(oldContainer);
    diffContainer.appendChild(newContainer);

    return diffContainer;
  },

  fallbackDiffDisplay(oldText, newText) {
    const diffContainer = document.createElement('div');
    diffContainer.className = 'enhanced-diff';

    const oldContainer = document.createElement('div');
    oldContainer.className = 'old-text';
    oldContainer.innerHTML = this.formatText(oldText);

    const newContainer = document.createElement('div');
    newContainer.className = 'new-text';
    newContainer.innerHTML = this.formatText(newText);

    diffContainer.appendChild(oldContainer);
    diffContainer.appendChild(newContainer);

    return diffContainer;
  },

  formatText(text) {
    return text
      .replace(/\*/g, '•')
      .split('\n')
      .map(line => `<p>${line.trim()}</p>`)
      .join('');
  },

  setupObserver() {
    window.diffObserver = new MutationObserver(mutations => {
      if (mutations.some(mutation => mutation.addedNodes.length > 0)) {
        this.debouncedEnhanceDiff();
      }
    });
    window.diffObserver.observe(document.body, { childList: true, subtree: true });
  },

  async removeEnhancements() {
    try {
      if (!isExtensionValid()) return;
      const enhancedDiffs = document.querySelectorAll('.enhanced-diff');
      for (const enhancedDiff of enhancedDiffs) {
        const parentContainer = enhancedDiff.closest('div[id^="diff-container-"]');
        if (parentContainer) {
          const containerId = parentContainer.id;
          const result = await chrome.storage.local.get(containerId);
          if (result[containerId]) {
            parentContainer.innerHTML = result[containerId];
            await chrome.storage.local.remove(containerId);
          } else {
            enhancedDiff.remove();
          }
        } else {
          enhancedDiff.remove();
        }
      }
    } catch (error) {
      console.error('Error removing enhancements:', error);
    }
  },

  debouncedEnhanceDiff: null  // set in init
};

const MessageHandler = {
  async handleMessage(request, sender, sendResponse) {
    try {
      if (!isExtensionValid()) return;
      if (request.action === "toggleExtension") {
        await chrome.storage.sync.set({extensionEnabled: request.enabled});
        if (request.enabled) {
          await DiffHighlighter.enhanceDiff();
          DiffHighlighter.setupObserver();
        } else {
          await DiffHighlighter.removeEnhancements();
          if (window.diffObserver) {
            window.diffObserver.disconnect();
          }
        }
        sendResponse({status: "success"});
      } else if (request.action === "checkExtensionState") {
        const data = await chrome.storage.sync.get('extensionEnabled');
        if (data.extensionEnabled) {
          await DiffHighlighter.enhanceDiff();
          DiffHighlighter.setupObserver();
        } else {
          await DiffHighlighter.removeEnhancements();
          if (window.diffObserver) {
            window.diffObserver.disconnect();
          }
        }
        sendResponse({status: "success"});
      }
    } catch (error) {
      console.error('Error handling message:', error);
      sendResponse({status: "error", message: error.message});
    }
  }
};

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func.apply(this, args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Initialize
DiffHighlighter.debouncedEnhanceDiff = debounce(DiffHighlighter.enhanceDiff.bind(DiffHighlighter), 250);
DiffHighlighter.init();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  MessageHandler.handleMessage(request, sender, sendResponse)
    .catch(error => {
      console.error('Error in message listener:', error);
      sendResponse({status: "error", message: error.message});
    });
  return true;
});