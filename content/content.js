/* ---------- cross-browser shim ---------- */
if (typeof browser !== 'undefined' && typeof chrome === 'undefined') {
  globalThis.chrome = browser;
}
/* --------------------------------------- */

const isExtensionValid = () => chrome.runtime && chrome.runtime.id;

const DiffHighlighter = {
  isForbiddenContainer(el) {
    return !!el?.closest('[data-testid*="issue-create"]');
  },

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
      if (this.isEnhancing) return;
      this.isEnhancing = true;

      if (!isExtensionValid()) return;

      const { extensionEnabled } = await chrome.storage.sync.get('extensionEnabled');
      if (extensionEnabled === false) return;

      const diffContainers = this.findDiffContainers();

      for (const [index, container] of diffContainers.entries()) {
        if (!container || !(container instanceof HTMLElement)) continue;
        if (container.querySelector('.enhanced-diff')) continue;
        if (this.isForbiddenContainer(container)) continue;

        if (container.children.length !== 3) continue;

        const oldNode = container.children[0];
        const newNode = container.children[2];

        const oldText = oldNode?.textContent || '';
        const newText = newNode?.textContent || '';

        if (!oldText || !newText) {
          console.error('Error: Expected diff child elements not found in container');
          continue;
        }

        const containerId = `diff-container-${Date.now()}-${index}`;
        container.id = containerId;

        const originalContent = container.innerHTML;
        await chrome.storage.local.set({ [containerId]: originalContent });

        const enhancedDiff = this.createEnhancedDiff(oldText, newText);

        container.replaceChild(enhancedDiff, container.children[0]);
        if (container.children[1]) container.removeChild(container.children[1]);
        if (container.children[1]) container.removeChild(container.children[1]);

        // Watch this container; if Jira wipes our diff node, quietly re‑apply it
        new MutationObserver((muts, obs) => {
          if (!enhancedDiff.isConnected) {
            obs.disconnect();
            this.debouncedEnhanceDiff();
          }
        }).observe(container, { childList: true });
      }
    } catch (error) {
      console.error('Error enhancing diff:', error);
    } finally {
      this.isEnhancing = false;
    }
  },

  findDiffContainers() {
    const LANG_MAP = {
      en: { update: ['updated'],      desc: 'description' },
      es: { update: ['actualizado'],  desc: 'descripción' },
      de: { update: ['aktualisiert'], desc: 'beschreibung' },
      fr: { update: ['mis à jour'],   desc: 'description' },
      it: { update: ['aggiornato'],   desc: 'descrizione' },
      pt: { update: ['atualizou'],    desc: 'descrição' },
      ru: { update: ['обновил'],      desc: 'описание' },
      ja: { update: ['更新'],         desc: '説明' },
      zh: { update: ['更新'],         desc: '描述' },
      nl: { update: ['bijgewerkt'],   desc: 'beschrijving' },
    };

    const norm = s => String(s ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();

    const DESC_SET = new Set(Object.values(LANG_MAP).map(l => norm(l.desc)));
    const UPDATE_SET = new Set(
      Object.values(LANG_MAP).flatMap(l => l.update.map(norm))
    );

    const candidates = [];
    const seen = new Set();

    const allDivs = document.querySelectorAll('div');

    for (const el of allDivs) {
      if (!(el instanceof HTMLElement)) continue;
      if (this.isForbiddenContainer(el)) continue;
      if (el.closest('.enhanced-diff')) continue;

      const txt = norm(el.textContent);
      if (!txt) continue;

      const hasDesc = [...DESC_SET].some(word => txt.includes(word));
      const hasUpdate = [...UPDATE_SET].some(word => txt.includes(word));

      if (!hasDesc || !hasUpdate) continue;

      // Look for the diff container near the anchor, not anywhere on the page
      const nearby = [
        el.nextElementSibling,
        el.parentElement?.nextElementSibling,
        el.closest('div')?.nextElementSibling,
      ];

      for (const diff of nearby) {
        if (!(diff instanceof HTMLElement)) continue;
        if (this.isForbiddenContainer(diff)) continue;
        if (diff.closest('.enhanced-diff')) continue;
        if (diff.children.length !== 3) continue;

        const oldNode = diff.children[0];
        const newNode = diff.children[2];

        if (!(oldNode instanceof HTMLElement) || !(newNode instanceof HTMLElement)) {
          continue;
        }

        const oldText = oldNode.textContent?.trim() || '';
        const newText = newNode.textContent?.trim() || '';

        if (!oldText || !newText) continue;

        // Avoid obvious interactive/layout UI
        if (diff.querySelector('button, input, textarea, select')) continue;

        if (!seen.has(diff)) {
          seen.add(diff);
          candidates.push(diff);
        }
      }
    }

    return candidates;
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

    let isBufferingLargeInsertion = false;
    let largeInsertionTextBuffer = '';

    const flushLargeInsertionBuffer = () => {
      if (!isBufferingLargeInsertion) return;

      const indicator = document.createElement('div');
      indicator.className = 'large-change-indicator';
      indicator.textContent = `Large insertion (${largeInsertionTextBuffer.length} characters)`;
      oldContainer.appendChild(indicator);

      const largeChange = document.createElement('div');
      largeChange.className = 'large-change';
      largeChange.appendChild(this.createTextFragment(largeInsertionTextBuffer));
      newContainer.appendChild(largeChange);

      isBufferingLargeInsertion = false;
      largeInsertionTextBuffer = '';
    };

    diffs.forEach((diffTuple) => {
      const operation = diffTuple[0];
      const diffText = diffTuple[1];

      const formattedPlainText = this.formatTextPlain(diffText);

      switch (operation) {
        case 0: // DIFF_EQUAL
          flushLargeInsertionBuffer();
          this.appendText(oldContainer, formattedPlainText);
          this.appendText(newContainer, formattedPlainText);
          break;

        case -1: // DIFF_DELETE
          flushLargeInsertionBuffer();
          this.appendText(oldContainer, formattedPlainText, 'deleted');
          break;

        case 1: // DIFF_INSERT
          if (diffText.length > 50) {
            isBufferingLargeInsertion = true;
            largeInsertionTextBuffer += formattedPlainText;
          } else {
            flushLargeInsertionBuffer();
            this.appendText(newContainer, formattedPlainText, 'inserted');

            const placeholderSpan = document.createElement('span');
            placeholderSpan.className = 'placeholder';
            placeholderSpan.textContent = '\u00A0'.repeat(Math.min(diffText.length, 10));
            oldContainer.appendChild(placeholderSpan);
          }
          break;
      }
    });

    // Handle any remaining large insertion at the end
    flushLargeInsertionBuffer();

    diffContainer.appendChild(oldContainer);
    diffContainer.appendChild(newContainer);
    
    // Pane scroll sync
    oldContainer.addEventListener('scroll', () => {
      newContainer.scrollTop = oldContainer.scrollTop;
    });
    newContainer.addEventListener('scroll', () => {
      oldContainer.scrollTop = newContainer.scrollTop;
    });

    return diffContainer;
  },

  fallbackDiffDisplay(oldText, newText) {
    const diffContainer = document.createElement('div');
    diffContainer.className = 'enhanced-diff';

    const oldContainer = document.createElement('div');
    oldContainer.className = 'old-text';
    oldContainer.appendChild(this.createTextFragment(oldText));

    const newContainer = document.createElement('div');
    newContainer.className = 'new-text';
    newContainer.appendChild(this.createTextFragment(newText));

    diffContainer.appendChild(oldContainer);
    diffContainer.appendChild(newContainer);

    return diffContainer;
  },

formatTextPlain(text) {
  return String(text ?? '')
    .replace(/\*/g, '•')
    .split('\n')
    .map((line) => line.trim())
    .join('\n');
},

createTextFragment(text) {
  // convert plain text into a DocumentFragment with <br> elements for newlines
  const textFragment = document.createDocumentFragment();
  const lines = this.formatTextPlain(text).split('\n');

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    textFragment.appendChild(document.createTextNode(lines[lineIndex]));
    if (lineIndex < lines.length - 1) {
      textFragment.appendChild(document.createElement('br'));
    }
  }

  return textFragment;
},

appendText(parentElement, text, wrapperClassName = null) {
  if (!parentElement) return;

  const contentFragment = this.createTextFragment(text);

  if (wrapperClassName) {
    const wrapperSpan = document.createElement('span');
    wrapperSpan.className = wrapperClassName;
    wrapperSpan.appendChild(contentFragment);
    parentElement.appendChild(wrapperSpan);
    return;
  }

  parentElement.appendChild(contentFragment);
},

  setupObserver() {
    if (window.diffObserver) return;

    const triggerEnhance = () => {
      if (!this.isEnhancing) this.debouncedEnhanceDiff();
    };

    window.diffObserver = new MutationObserver(muts => {
      const relevant = muts.some(m =>
        (m.addedNodes.length || m.removedNodes.length || m.type === 'characterData') &&
        !m.target.closest('.enhanced-diff')
      );
      if (relevant) triggerEnhance();
    });

    window.diffObserver.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true
    });

    document.addEventListener(
      'click',
      e => {
        const btn = e.target.closest(
          '[data-testid^="issue-activity-feed.ui.buttons."]'
        );
        if (!btn) return;

        console.log('[DH] activity button clicked:', btn.dataset.testid);

        setTimeout(triggerEnhance, 200);
      },
      true
    );
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
