# Jira Diff Highlighter

Jira Diff Highlighter is a cross-browser extension (Chrome & Firefox) that enhances the readability of Jira issue description diffs. It transforms standard Jira diffs into a more user-friendly, side-by-side comparison with highlighted changes.

## Features
- **Enhanced Diff View**: Converts standard Jira diffs into a side-by-side comparison for easier reading.
- **Highlighted Changes**: Color-codes additions, deletions, and modifications for quick identification.
- **Large Change Handling**: Efficiently displays large insertions or deletions without cluttering the view.
- **Toggle Functionality**: Easily switch between enhanced and original diff views.
- **Multi-Tab Support**: Maintains consistent state across multiple Jira tabs.
  
---

## Installation
| Browser | Link |
|---------|------|
| **Chrome / Edge** | [Chrome Web Store](https://chromewebstore.google.com/detail/jira-diff-highlighter/imlebnoogjdcbkaaighofkpfciamehni) |
| **Firefox** | [Mozilla Add-ons](https://addons.mozilla.org/firefox/addon/jira-diff-highlighter/) |

---

## Usage

- The extension automatically enhances diff views on Jira pages.
- Use the extension's toggle button to switch between enhanced and original views.
- The extension works on all Atlassian-hosted Jira instances (*.atlassian.net).

---

## Devlopment / Building from Source
npm install

#### Live-reload dev session
```
npm run dev:chrome       # opens Chrome/Edge with hot reload
npm run dev:firefox      # opens a temp Firefox with hot reload
```

#### Production packages
```
npm run build:chrome     # → jira-diff-highlighter.zip
npm run build:firefox    # → web-ext-artifacts/*.zip
```
