# Jira Diff Highlighter

Jira Diff Highlighter is a cross-browser extension (Chrome & Firefox) that enhances the readability of Jira issue description diffs. It transforms standard Jira diffs into a more user-friendly, side-by-side comparison with highlighted changes.

## Features
- **Enhanced Diff View**: Converts standard Jira diffs into a side-by-side comparison for easier reading.
- **Highlighted Changes**: Color-codes additions, deletions, and modifications for quick identification.
- **Configurable Large Change Handling**: Collapses large insertions and deletions above your chosen character limit, with one-click access to show the full text.
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
- Set the large change limit from the extension popup. The default is 500 characters, and collapsed changes can be expanded inline with "Show full text".
- The extension works on Atlassian-hosted Jira pages by default. Custom Jira domains can be enabled from the extension popup with per-site access (see below).

---

## Self-hosted Jira (Data Center / Server)

The extension also supports the History tab of self-hosted Jira (Data Center / Server), where changes are shown as a table with **Original** and **New** columns. Because a self-hosted Jira runs on your own domain, you need to enable that domain once:

1. Open a ticket in your self-hosted Jira, e.g. `https://jira.example.com/browse/PROJ-123`.
2. Click the extension icon to open the popup.
3. Enter the host name of your Jira (e.g. `jira.example.com`, without `https://` or a path) and click **Add**.
4. Allow access when the browser asks for permission.
5. Reload the Jira page and open the **History** tab of an issue.

Notes:
- Only the host name matters. Context paths such as `https://jira.example.com/tracker/…` are covered automatically.
- Adding a custom domain also covers its subdomains, and Atlassian Cloud (`*.atlassian.net`) stays enabled.
- To remove a domain, click **x** next to it in the popup. This also revokes the browser permission.
- If the diff still doesn't appear, check **Extensions → Details → Site access** and make sure your Jira domain is listed. Managed (company) browsers may block extensions from requesting additional site access; in that case ask your IT department, or add the domain to `host_permissions` and `content_scripts.matches` in a local, uncommitted copy of `manifest.base.json` and rebuild.

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
