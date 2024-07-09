// Check if the extension is enabled before running
chrome.storage.sync.get('extensionEnabled', function(data) {
  if (data.extensionEnabled !== false) {
    enhanceDiff();
    setupObserver();
  }
});

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

function findDiffContainers() {
  const updateElements = Array.from(document.querySelectorAll('div'))
    .filter(el => el.textContent.includes('updated the Description'));

  return updateElements.map(el => {
    const possibleDiffContainer = el.nextElementSibling;
    if (possibleDiffContainer && possibleDiffContainer.children.length === 3) {
      return possibleDiffContainer;
    }
    return null;
  }).filter(Boolean);
}

function enhanceDiff() {
  chrome.storage.sync.get('extensionEnabled', function(data) {
    if (data.extensionEnabled !== false) {
      const diffContainers = findDiffContainers();
      
      diffContainers.forEach((container, index) => {
        if (container.querySelector('.enhanced-diff')) return; // Skip if already enhanced
    
        const containerId = `diff-container-${Date.now()}-${index}`;
        container.id = containerId;
    
        // Store the original content
        const originalContent = container.innerHTML;
        chrome.storage.local.set({[containerId]: originalContent}, function() {
          console.log('Original content saved for', containerId);
        });
    
        const oldText = container.children[0].textContent;
        const newText = container.children[2].textContent;
        
        const enhancedDiff = createEnhancedDiff(oldText, newText);
        
        // Replace the original content with the enhanced diff
        container.innerHTML = '';
        container.appendChild(enhancedDiff);
      });
    }
  });
}

function createEnhancedDiff(oldText, newText) {
  const diffContainer = document.createElement('div');
  diffContainer.className = 'enhanced-diff';

  let dmp;
  try {
    dmp = new diff_match_patch();
  } catch (e) {
    console.error('Failed to create diff_match_patch instance:', e);
    return fallbackDiffDisplay(oldText, newText);
  }

  let diffs;
  try {
    diffs = dmp.diff_main(oldText, newText);
    dmp.diff_cleanupSemantic(diffs);
  } catch (e) {
    console.error('Failed to compute diff:', e);
    return fallbackDiffDisplay(oldText, newText);
  }

  if (!Array.isArray(diffs)) {
    console.error('diff_main did not return an array');
    return fallbackDiffDisplay(oldText, newText);
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
    const formattedText = formatText(text);

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
}

function fallbackDiffDisplay(oldText, newText) {
  const diffContainer = document.createElement('div');
  diffContainer.className = 'enhanced-diff';

  const oldContainer = document.createElement('div');
  oldContainer.className = 'old-text';
  oldContainer.innerHTML = formatText(oldText);

  const newContainer = document.createElement('div');
  newContainer.className = 'new-text';
  newContainer.innerHTML = formatText(newText);

  diffContainer.appendChild(oldContainer);
  diffContainer.appendChild(newContainer);

  return diffContainer;
}

function formatText(text) {
  return text
    .replace(/\*/g, '•')
    .split('\n')
    .map(line => `<p>${line.trim()}</p>`)
    .join('');
}

// Debounce the enhanceDiff function
const debouncedEnhanceDiff = debounce(enhanceDiff, 250);

function setupObserver() {
  window.diffObserver = new MutationObserver(mutations => {
    if (mutations.some(mutation => mutation.addedNodes.length > 0)) {
      debouncedEnhanceDiff();
    }
  });
  window.diffObserver.observe(document.body, { childList: true, subtree: true });
}

function removeEnhancements() {
  const enhancedDiffs = document.querySelectorAll('.enhanced-diff');
  enhancedDiffs.forEach(enhancedDiff => {
    const parentContainer = enhancedDiff.closest('div[id^="diff-container-"]');
    if (parentContainer) {
      const containerId = parentContainer.id;
      chrome.storage.local.get(containerId, function(result) {
        if (result[containerId]) {
          parentContainer.innerHTML = result[containerId];
          // Clean up stored content
          chrome.storage.local.remove(containerId);
        } else {
          // If we can't find the original content, just remove the enhanced diff
          enhancedDiff.remove();
        }
      });
    } else {
      // If we can't find the parent container, just remove the enhanced diff
      enhancedDiff.remove();
    }
  });
}

// Listen for messages from the popup and background script
chrome.runtime.onMessage.addListener(
  function(request, sender, sendResponse) {
    if (request.action === "toggleExtension") {
      chrome.storage.sync.set({extensionEnabled: request.enabled}, function() {
        if (request.enabled) {
          enhanceDiff();
          setupObserver();
        } else {
          removeEnhancements();
          if (window.diffObserver) {
            window.diffObserver.disconnect();
          }
        }
        sendResponse({status: "success"});
      });
      return true; // Indicates that the response is sent asynchronously
    } else if (request.action === "checkExtensionState") {
      chrome.storage.sync.get('extensionEnabled', function(data) {
        if (data.extensionEnabled) {
          enhanceDiff();
          setupObserver();
        } else {
          removeEnhancements();
          if (window.diffObserver) {
            window.diffObserver.disconnect();
          }
        }
      });
    }
  }
);