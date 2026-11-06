/* ---------- cross-browser shim ---------- */
if (typeof browser !== 'undefined' && typeof chrome === 'undefined') {
  globalThis.chrome = browser;
}
/* --------------------------------------- */

const isExtensionValid = () => chrome.runtime && chrome.runtime.id;
const DEFAULT_LARGE_CHANGE_LIMIT = 500;
const MIN_LARGE_CHANGE_LIMIT = 1;
const MAX_LARGE_CHANGE_LIMIT = 10000;

const normalizeLargeChangeLimit = value => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LARGE_CHANGE_LIMIT;
  return Math.min(Math.max(parsed, MIN_LARGE_CHANGE_LIMIT), MAX_LARGE_CHANGE_LIMIT);
};

const getLargeChangeLimit = async () => {
  const { largeChangeLimit } = await chrome.storage.sync.get('largeChangeLimit');
  return normalizeLargeChangeLimit(largeChangeLimit);
};

const normalizeDomainPattern = domain => {
  if (!domain || typeof domain !== 'string') return null;
  // Accept pasted URLs or wildcard origins, but store only the comparable hostname.
  const normalized = domain.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^\*\./, '').toLowerCase();
  return normalized || null;
}

const isValidDomainPattern = domain => typeof domain === 'string' && /^[a-z0-9.-]+$/.test(domain) && !domain.includes('..');

const parseDomainPatterns = raw => {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map(normalizeDomainPattern).filter(isValidDomainPattern);
  }
  return String(raw)
    .split(/[\n,]+/)
    .map(normalizeDomainPattern)
    .filter(isValidDomainPattern);
};

const getAllowedDomainPatterns = async () => {
  const { allowedDomains } = await chrome.storage.sync.get('allowedDomains');
  const patterns = parseDomainPatterns(allowedDomains);
  return [...new Set(['atlassian.net', ...patterns])];
};

const urlMatchesAllowedDomain = async url => {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const patterns = await getAllowedDomainPatterns();
    return patterns.some(pattern => host === pattern || host.endsWith(`.${pattern}`));
  } catch {
    return false;
  }
};

const DiffHighlighter = {
  isForbiddenContainer(el) {
    return !!el?.closest('[data-testid*="issue-create"]');
  },

  isLikelyJiraPage() {
    try {
      const path = new URL(window.location.href).pathname;
      if (/(\/browse\/|\/jira\/|\/issues\/|\/secure\/(?:Issue|ViewIssue)\b)/i.test(path)) {
        return true;
      }
    } catch {
      // fall through
    }

    return Boolean(
      document.querySelector('[data-testid*=\"issue-activity-feed.ui.buttons.\"]') ||
      document.querySelector('[data-testid*=\"issue.views.issue-base.foundation.breadcrumbs.breadcrumbs-container\"]')
    );
  },

  async isAllowedJiraPage() {
    const matched = await urlMatchesAllowedDomain(window.location.href);
    if (matched) return true;

    const { allowedDomains } = await chrome.storage.sync.get('allowedDomains');
    if (!Array.isArray(allowedDomains) || allowedDomains.length === 0) {
      return this.isLikelyJiraPage();
    }

    return false;
  },

  async init() {
    try {
      if (!isExtensionValid()) return;
      if (!await this.isAllowedJiraPage()) return;
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

      await this.enhanceDataCenterDiffs();

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

        const raw = await RawText.resolve(oldText, newText);
        if (!container.isConnected || container.children.length !== 3) continue;
        if (container.querySelector('.enhanced-diff')) continue;

        const containerId = `diff-container-${Date.now()}-${index}`;
        container.id = containerId;

        const originalContent = container.innerHTML;
        await chrome.storage.local.set({ [containerId]: originalContent });

        const enhancedDiff = await GitDiffView.create(raw.oldText, raw.newText, raw.exact);

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

  /* ---------- Jira Data Center / Server: History table "Original: … | New: …" ---------- */
  DC_OLD_LABEL: /^\s*(Original|Ursprünglich|Ursprungswert|Alt|Original value)\s*:\s*/i,
  DC_NEW_LABEL: /^\s*(New|Neu|New value)\s*:\s*/i,
  DC_FIELDS: ['description', 'beschreibung'],

  // Read a cell's text with its rendered line breaks, minus the leading "Original:" / "New:" label.
  dcCellText(td, labelRe) {
    const clone = td.cloneNode(true);
    const label = clone.querySelector('strong, b, .hist-label');
    if (label && /:\s*$/.test(label.textContent)) label.remove();
    clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
    const text = clone.textContent.replace(/\u00A0/g, ' ').replace(labelRe, '');
    return text.replace(/^\n+/, '').replace(/\s+$/, '');
  },

  findDataCenterRows() {
    const rows = [];
    for (const td of document.querySelectorAll('td')) {
      if (td.closest('.enhanced-diff')) continue;
      const next = td.nextElementSibling;
      if (!next || next.tagName !== 'TD') continue;
      if (!this.DC_OLD_LABEL.test(td.textContent) || !this.DC_NEW_LABEL.test(next.textContent)) continue;
      const tr = td.parentElement;
      const nameCell = td.previousElementSibling;
      const field = (nameCell?.textContent || '').trim().toLowerCase();
      if (!this.DC_FIELDS.includes(field)) continue;
      rows.push({ tr, oldTd: td, newTd: next });
    }
    return rows;
  },

  async enhanceDataCenterDiffs() {
    const rows = this.findDataCenterRows();
    for (const [index, { tr, oldTd, newTd }] of rows.entries()) {
      if (tr.querySelector('.enhanced-diff')) continue;
      const oldText = this.dcCellText(oldTd, this.DC_OLD_LABEL);
      const newText = this.dcCellText(newTd, this.DC_NEW_LABEL);
      if (!oldText && !newText) continue;

      const containerId = `diff-container-${Date.now()}-dc${index}`;
      tr.id = containerId;
      await chrome.storage.local.set({ [containerId]: tr.innerHTML });

      const enhancedDiff = await GitDiffView.create(oldText, newText, true);
      const cell = document.createElement('td');
      cell.colSpan = 2;
      cell.className = 'gd-dc-cell';
      cell.appendChild(enhancedDiff);
      oldTd.replaceWith(cell);
      newTd.remove();
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

    /* build flattened accent‑stripped keyword sets */
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

  createEnhancedDiff(oldText, newText, largeChangeLimit = DEFAULT_LARGE_CHANGE_LIMIT) {
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
    let isBufferingLargeDeletion = false;
    let largeDeletionTextBuffer = '';

    const createLargeChangeToggle = (type, text) => {
      const wrapper = document.createElement('div');
      wrapper.className = `large-change-wrapper large-${type}-wrapper`;

      const indicator = document.createElement('div');
      indicator.className = `large-change-indicator large-${type}-indicator`;

      const label = document.createElement('span');
      label.textContent = `Large ${type} (${text.length} characters)`;

      const toggleButton = document.createElement('button');
      toggleButton.type = 'button';
      toggleButton.className = 'large-change-toggle';
      toggleButton.textContent = 'Show full text';
      toggleButton.setAttribute('aria-expanded', 'false');

      let fullTextElement = null;

      toggleButton.addEventListener('click', () => {
        const isExpanded = toggleButton.getAttribute('aria-expanded') === 'true';

        if (isExpanded) {
          fullTextElement?.remove();
          fullTextElement = null;
          toggleButton.textContent = 'Show full text';
          toggleButton.setAttribute('aria-expanded', 'false');
          return;
        }

        fullTextElement = document.createElement('div');
        fullTextElement.className = `large-change-full-text large-${type}-full-text`;
        fullTextElement.appendChild(this.createTextFragment(text));
        wrapper.appendChild(fullTextElement);
        toggleButton.textContent = 'Hide full text';
        toggleButton.setAttribute('aria-expanded', 'true');
      });

      indicator.append(label, toggleButton);
      wrapper.appendChild(indicator);

      return wrapper;
    };

    const flushLargeInsertionBuffer = () => {
      if (!isBufferingLargeInsertion) return;

      newContainer.appendChild(createLargeChangeToggle('insertion', largeInsertionTextBuffer));

      isBufferingLargeInsertion = false;
      largeInsertionTextBuffer = '';
    };

    const flushLargeDeletionBuffer = () => {
      if (!isBufferingLargeDeletion) return;

      oldContainer.appendChild(createLargeChangeToggle('deletion', largeDeletionTextBuffer));

      isBufferingLargeDeletion = false;
      largeDeletionTextBuffer = '';
    };

    const flushLargeChangeBuffers = () => {
      flushLargeInsertionBuffer();
      flushLargeDeletionBuffer();
    };

    diffs.forEach((diffTuple) => {
      const operation = diffTuple[0];
      const diffText = diffTuple[1];

      const formattedPlainText = this.formatTextPlain(diffText);

      switch (operation) {
        case 0: // DIFF_EQUAL
          flushLargeChangeBuffers();
          this.appendText(oldContainer, formattedPlainText);
          this.appendText(newContainer, formattedPlainText);
          break;

        case -1: // DIFF_DELETE
          flushLargeInsertionBuffer();
          if (diffText.length > largeChangeLimit) {
            isBufferingLargeDeletion = true;
            largeDeletionTextBuffer += formattedPlainText;
          } else {
            flushLargeDeletionBuffer();
            this.appendText(oldContainer, formattedPlainText, 'deleted');
          }
          break;

        case 1: // DIFF_INSERT
          flushLargeDeletionBuffer();
          if (diffText.length > largeChangeLimit) {
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

    // Handle any remaining large changes at the end
    flushLargeChangeBuffers();

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
        const parentContainer = enhancedDiff.closest('[id^="diff-container-"]');
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
        if (data.extensionEnabled !== false) {
          await DiffHighlighter.removeEnhancements();
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

/* ---------- raw description text from the Jira changelog API ---------- */
const RawText = {
  cache: new Map(), // issueKey -> { fetchedAt, items: [{ from, to }] }

  squash: s => String(s ?? '').replace(/\s+/g, ''),

  getIssueKey() {
    const keyRe = /^[A-Z][A-Z0-9_]+-\d+$/;
    const url = new URL(window.location.href);
    const selected = url.searchParams.get('selectedIssue');
    if (selected && keyRe.test(selected)) return selected;
    const m = url.pathname.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/);
    return m ? m[1] : null;
  },

  async fetchDescriptionChanges(key) {
    const items = [];
    let startAt = 0;
    for (let page = 0; page < 50; page++) {
      const res = await fetch(
        `${location.origin}/rest/api/3/issue/${encodeURIComponent(key)}/changelog?startAt=${startAt}&maxResults=100`,
        { credentials: 'include', headers: { Accept: 'application/json' } }
      );
      if (!res.ok) throw new Error(`Changelog request failed: ${res.status}`);
      const data = await res.json();
      for (const entry of data.values || []) {
        for (const item of entry.items || []) {
          if (item.fieldId === 'description' || item.field === 'description') {
            items.push({ from: item.fromString || '', to: item.toString || '' });
          }
        }
      }
      startAt += (data.values || []).length;
      if (data.isLast || !(data.values || []).length || startAt >= (data.total ?? Infinity)) break;
    }
    return items;
  },

  findMatch(items, oldSq, newSq) {
    return items.find(i => this.squash(i.from) === oldSq && this.squash(i.to) === newSq);
  },

  async resolve(oldText, newText) {
    const key = this.getIssueKey();
    if (key) {
      try {
        const oldSq = this.squash(oldText);
        const newSq = this.squash(newText);
        let cached = this.cache.get(key);
        let match = cached && this.findMatch(cached.items, oldSq, newSq);
        if (!match && (!cached || Date.now() - cached.fetchedAt > 3000)) {
          cached = { fetchedAt: Date.now(), items: await this.fetchDescriptionChanges(key) };
          this.cache.set(key, cached);
          match = this.findMatch(cached.items, oldSq, newSq);
        }
        if (match) return { oldText: match.from, newText: match.to, exact: true };
      } catch (e) {
        console.warn('[DH] Could not load raw description from changelog:', e);
      }
    }
    return { oldText: this.guessLines(oldText), newText: this.guessLines(newText), exact: false };
  },

  // Fallback: rebuild line breaks from Jira wiki markup markers (headings, bullets, tables).
  guessLines(text) {
    return String(text ?? '')
      .replace(/\s+(?=(h[1-6]\.\s|\*+\s|#+\s|\|\||-\s))/g, '\n')
      .trim();
  }
};

/* ---------- GitHub-style line diff ---------- */
const GitDiffView = {
  CONTEXT: 3,

  splitLines(text) {
    const t = String(text ?? '').replace(/\r\n?/g, '\n');
    const lines = t.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  },

  // Build a model: list of { kind: 'eq', oldNo, newNo, text } | { kind: 'hunk', dels: [...], ins: [...] }
  buildModel(oldText, newText) {
    const dmp = new diff_match_patch();
    const a = this.splitLines(oldText).join('\n') + '\n';
    const b = this.splitLines(newText).join('\n') + '\n';
    const lc = dmp.diff_linesToChars_(a, b);
    const diffs = dmp.diff_main(lc.chars1, lc.chars2, false);
    dmp.diff_charsToLines_(diffs, lc.lineArray);

    const model = [];
    let oldNo = 1, newNo = 1;
    let hunk = null;
    const flush = () => { if (hunk) { model.push(hunk); hunk = null; } };

    for (const { 0: op, 1: text } of diffs) {
      const lines = this.splitLines(text);
      if (op === 0) {
        flush();
        for (const line of lines) model.push({ kind: 'eq', oldNo: oldNo++, newNo: newNo++, text: line });
      } else {
        hunk = hunk || { kind: 'hunk', dels: [], ins: [] };
        for (const line of lines) {
          if (op === -1) hunk.dels.push({ no: oldNo++, text: line });
          else hunk.ins.push({ no: newNo++, text: line });
        }
      }
    }
    flush();

    // Word-level highlights for paired lines
    for (const item of model) {
      if (item.kind !== 'hunk') continue;
      const n = Math.min(item.dels.length, item.ins.length);
      for (let i = 0; i < n; i++) {
        const d = item.dels[i], s = item.ins[i];
        const wd = dmp.diff_main(d.text, s.text);
        dmp.diff_cleanupSemantic(wd);
        const parts = wd.map(x => [x[0], x[1]]);
        const same = parts.filter(x => x[0] === 0).reduce((acc, x) => acc + x[1].length, 0);
        if (same < 0.4 * Math.max(d.text.length, s.text.length)) continue;
        d.parts = parts.filter(x => x[0] !== 1);
        s.parts = parts.filter(x => x[0] !== -1);
      }
    }
    return model;
  },

  // Group model into segments; long runs of unchanged lines become collapsible
  segment(model) {
    const segs = [];
    let i = 0;
    while (i < model.length) {
      if (model[i].kind !== 'eq') { segs.push({ type: 'hunk', item: model[i] }); i++; continue; }
      let j = i;
      while (j < model.length && model[j].kind === 'eq') j++;
      const run = model.slice(i, j);
      const lead = i === 0 ? 0 : this.CONTEXT;
      const trail = j === model.length ? 0 : this.CONTEXT;
      if (run.length > lead + trail + 1) {
        if (lead) segs.push({ type: 'eq', rows: run.slice(0, lead) });
        segs.push({ type: 'fold', rows: run.slice(lead, run.length - trail) });
        if (trail) segs.push({ type: 'eq', rows: run.slice(run.length - trail) });
      } else {
        segs.push({ type: 'eq', rows: run });
      }
      i = j;
    }
    return segs;
  },

  textCell(sign, line, cls) {
    const td = document.createElement('td');
    td.className = `gd-code ${cls || ''}`;
    const signEl = document.createElement('span');
    signEl.className = 'gd-sign';
    signEl.textContent = sign;
    td.appendChild(signEl);
    if (!line) return td;
    if (line.parts) {
      for (const [op, t] of line.parts) {
        if (op === 0) td.appendChild(document.createTextNode(t));
        else {
          const mark = document.createElement('span');
          mark.className = op === -1 ? 'gd-word-del' : 'gd-word-ins';
          mark.textContent = t;
          td.appendChild(mark);
        }
      }
    } else {
      td.appendChild(document.createTextNode(line.text));
    }
    return td;
  },

  numCell(no, cls) {
    const td = document.createElement('td');
    td.className = `gd-num ${cls || ''}`;
    td.textContent = no ?? '';
    return td;
  },

  row(...cells) {
    const tr = document.createElement('tr');
    cells.forEach(c => tr.appendChild(c));
    return tr;
  },

  eqRow(r, mode) {
    return mode === 'split'
      ? this.row(this.numCell(r.oldNo), this.textCell(' ', r), this.numCell(r.newNo), this.textCell(' ', r))
      : this.row(this.numCell(r.oldNo), this.numCell(r.newNo), this.textCell(' ', r));
  },

  hunkRows(h, mode) {
    const rows = [];
    if (mode === 'split') {
      const n = Math.max(h.dels.length, h.ins.length);
      for (let i = 0; i < n; i++) {
        const d = h.dels[i], s = h.ins[i];
        rows.push(this.row(
          this.numCell(d?.no, d ? 'gd-del' : 'gd-empty'),
          this.textCell(d ? '-' : '', d, d ? 'gd-del' : 'gd-empty'),
          this.numCell(s?.no, s ? 'gd-ins' : 'gd-empty'),
          this.textCell(s ? '+' : '', s, s ? 'gd-ins' : 'gd-empty')
        ));
      }
    } else {
      for (const d of h.dels) rows.push(this.row(this.numCell(d.no, 'gd-del'), this.numCell('', 'gd-del'), this.textCell('-', d, 'gd-del')));
      for (const s of h.ins) rows.push(this.row(this.numCell('', 'gd-ins'), this.numCell(s.no, 'gd-ins'), this.textCell('+', s, 'gd-ins')));
    }
    return rows;
  },

  render(root, mode) {
    root.querySelector('.gd-table')?.remove();
    root.querySelectorAll('.gd-mode button').forEach(b => b.classList.toggle('gd-active', b.dataset.mode === mode));

    const table = document.createElement('table');
    table.className = `gd-table gd-${mode}`;
    const colgroup = document.createElement('colgroup');
    const cols = mode === 'split' ? ['gd-c-num', 'gd-c-code', 'gd-c-num', 'gd-c-code'] : ['gd-c-num', 'gd-c-num', 'gd-c-code'];
    cols.forEach(c => { const col = document.createElement('col'); col.className = c; colgroup.appendChild(col); });
    table.appendChild(colgroup);
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);

    for (const seg of root._segments) {
      if (seg.type === 'eq') seg.rows.forEach(r => tbody.appendChild(this.eqRow(r, mode)));
      else if (seg.type === 'hunk') this.hunkRows(seg.item, mode).forEach(r => tbody.appendChild(r));
      else if (seg.type === 'fold') {
        if (seg.expanded) { seg.rows.forEach(r => tbody.appendChild(this.eqRow(r, mode))); continue; }
        const tr = document.createElement('tr');
        tr.className = 'gd-fold';
        const td = document.createElement('td');
        td.colSpan = cols.length;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = `↕ Show ${seg.rows.length} unchanged line${seg.rows.length === 1 ? '' : 's'}`;
        btn.addEventListener('click', () => { seg.expanded = true; this.render(root, root._mode); });
        td.appendChild(btn);
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
    }
    root._mode = mode;
    root.appendChild(table);
  },

  async create(oldText, newText, exact) {
    const root = document.createElement('div');
    root.className = 'enhanced-diff gd-root';

    let model;
    try {
      model = this.buildModel(oldText, newText);
    } catch (e) {
      console.error('Failed to compute line diff:', e);
      return DiffHighlighter.fallbackDiffDisplay(oldText, newText);
    }
    root._segments = this.segment(model);

    const added = model.filter(m => m.kind === 'hunk').reduce((a, h) => a + h.ins.length, 0);
    const removed = model.filter(m => m.kind === 'hunk').reduce((a, h) => a + h.dels.length, 0);

    const toolbar = document.createElement('div');
    toolbar.className = 'gd-toolbar';
    const stats = document.createElement('span');
    stats.className = 'gd-stats';
    stats.innerHTML = `<span class="gd-stat-ins">+${added}</span> <span class="gd-stat-del">−${removed}</span>`;
    toolbar.appendChild(stats);
    if (!exact) {
      const note = document.createElement('span');
      note.className = 'gd-note';
      note.textContent = 'Line breaks estimated (raw text unavailable)';
      toolbar.appendChild(note);
    }
    const modeBox = document.createElement('span');
    modeBox.className = 'gd-mode';
    for (const [m, label] of [['split', 'Split'], ['unified', 'Unified']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.mode = m;
      b.textContent = label;
      b.addEventListener('click', async () => {
        await chrome.storage.sync.set({ diffViewMode: m });
        document.querySelectorAll('.gd-root').forEach(el => GitDiffView.render(el, m));
      });
      modeBox.appendChild(b);
    }
    toolbar.appendChild(modeBox);
    root.appendChild(toolbar);

    const { diffViewMode } = await chrome.storage.sync.get('diffViewMode');
    this.render(root, diffViewMode === 'unified' ? 'unified' : 'split');
    return root;
  }
};

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
