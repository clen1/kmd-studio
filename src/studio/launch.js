'use strict';
// KMD Studio launcher: open the app URL in a Chromium --app window
// (Edge/Chrome), falling back to the OS default browser.
// Contract: docs/studio-contract.md "src/studio/launch.js".
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Candidate install roots come from env vars so tests can substitute them.
function candidates(env) {
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
  const out = [];
  for (const root of roots) {
    out.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  for (const root of roots) {
    out.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  return out;
}

// findBrowser(env?) -> absolute path of the first existing Edge/Chrome, or null.
function findBrowser(env = process.env) {
  for (const p of candidates(env)) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // keep looking
    }
  }
  return null;
}

// launchApp(url): fire-and-forget, never throws.
function launchApp(url) {
  try {
    const browser = findBrowser();
    if (browser) {
      spawn(browser, [`--app=${url}`, '--window-size=1440,900', '--new-window'], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      return;
    }
    // No Chromium found -> default browser for the platform.
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', `"${url}"`], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // launch is best-effort; the URL is already printed for manual opening
  }
}

module.exports = { launchApp, findBrowser };
