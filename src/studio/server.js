'use strict';
// KMD Studio HTTP server: 127.0.0.1-only, token-authed /api/*, UI assets,
// /preview/* static serving, heartbeat watchdog.
// Contract: docs/studio-contract.md "src/studio/server.js".
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createApi } = require('./api');
const { readAsset, hasAsset } = require('../assets');

const WATCHDOG_MS = 45_000;
const BODY_CAP = 10 * 1024 * 1024; // 10MB

// Repo-relative asset keys (posix) so the same lookup works from the embedded
// asset table inside a SEA bundle and from the repo fs in dev.
const UI_FILES = {
  '/': 'src/studio/ui/index.html',
  '/index.html': 'src/studio/ui/index.html',
  '/app.css': 'src/studio/ui/app.css',
  '/app.js': 'src/studio/ui/app.js',
  '/favicon.svg': 'src/studio/ui/favicon.svg',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Case-normalized absolute path (Windows FS is case-insensitive).
function normalizeAbs(p) {
  const abs = path.resolve(String(p));
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

// Join urlPath under root; null when the result escapes root (traversal).
function safeJoin(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const abs = path.resolve(root, decoded);
  const normRoot = normalizeAbs(root);
  const norm = normalizeAbs(abs);
  if (norm !== normRoot && !norm.startsWith(normRoot + path.sep)) return null;
  return abs;
}

// Read body with 10MB cap; parse JSON (empty -> {}). Throws { status } on
// oversize body or malformed JSON.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > BODY_CAP) {
        aborted = true;
        const err = new Error('body too large');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        const err = new Error('invalid JSON body');
        err.status = 400;
        reject(err);
      }
    });
    req.on('error', () => {
      if (aborted) return;
      aborted = true;
      const err = new Error('failed to read request body');
      err.status = 400;
      reject(err);
    });
  });
}

// await studioServer({ port = 0, cwd, env, onLog, watchdog = true })
// -> { url, token, port, close(), getState, api }
async function studioServer(opts = {}) {
  const { port = 0, cwd = process.cwd(), env = process.env, onLog = () => {} } = opts;
  const watchdogEnabled = opts.watchdog !== false;
  const token = crypto.randomBytes(16).toString('hex');

  // Watchdog: armed by the FIRST heartbeat, reset by each subsequent one;
  // 45s of silence -> the app window is gone, close and exit.
  let watchdogTimer = null;
  function armWatchdog() {
    if (!watchdogEnabled) return;
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      onLog('[studio] 超过 45s 未收到心跳，自动退出');
      try {
        server.close();
      } catch {
        // already closed
      }
      process.exit(0);
    }, WATCHDOG_MS);
  }

  function serveFile(res, abs) {
    fs.readFile(abs, (err, data) => {
      if (err) {
        sendJson(res, 404, { error: 'not-found' });
        return;
      }
      const mime = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length });
      res.end(data);
    });
  }

  // UI assets go through the asset layer; 404 when absent (dev mode without
  // the frontend files), always present in a SEA bundle.
  function serveUiAsset(res, repoRel) {
    if (!hasAsset(repoRel)) {
      sendJson(res, 404, { error: 'not-found' });
      return;
    }
    let data;
    try {
      data = Buffer.from(readAsset(repoRel), 'utf8');
    } catch {
      sendJson(res, 404, { error: 'not-found' });
      return;
    }
    const mime = MIME[path.extname(repoRel).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length });
    res.end(data);
  }

  const api = createApi({
    cwd,
    env,
    onLog,
    onShutdown: () => close(),
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const pathname = url.pathname;

      if (pathname.startsWith('/api/')) {
        // Token middleware: every /api/* call needs the X-KMD-Token header.
        if (req.headers['x-kmd-token'] !== token) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        // Heartbeat reaches the server layer first: reset the watchdog timer
        // before delegating to the API router.
        if (pathname === '/api/heartbeat' && req.method === 'POST') armWatchdog();
        let body = {};
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
          body = await readJsonBody(req);
        }
        await api.handle(req, res, body);
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method-not-allowed' });
        return;
      }

      // UI assets (owned by the frontend agent; 404 gracefully when absent).
      if (Object.prototype.hasOwnProperty.call(UI_FILES, pathname)) {
        serveUiAsset(res, UI_FILES[pathname]);
        return;
      }

      // Built site preview: <currentProject>/site, no token required.
      if (pathname === '/preview' || pathname.startsWith('/preview/')) {
        const state = api.currentProject();
        if (!state.project) {
          sendJson(res, 404, { error: 'no-project' });
          return;
        }
        const siteRoot = path.join(state.project.path, 'site');
        const rel = (pathname === '/preview' ? '/' : pathname.slice('/preview'.length)).replace(/^\/+/, '');
        let abs = safeJoin(siteRoot, rel);
        if (!abs) {
          sendJson(res, 404, { error: 'not-found' });
          return;
        }
        try {
          if (fs.statSync(abs).isDirectory()) abs = path.join(abs, 'index.html');
        } catch {
          // missing -> serveFile reports 404
        }
        serveFile(res, abs);
        return;
      }

      sendJson(res, 404, { error: 'not-found' });
    } catch (err) {
      // Never crash the process on a bad request.
      if (!res.headersSent) {
        sendJson(res, err && err.status ? err.status : 500, {
          error: err && err.message ? err.message : String(err),
        });
      } else {
        try {
          res.end();
        } catch {
          // socket already gone
        }
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;

  function close() {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return {
    url: `http://127.0.0.1:${actualPort}/?k=${token}`,
    token,
    port: actualPort,
    close,
    getState: () => ({ project: api.currentProject().project }),
    api,
  };
}

module.exports = { studioServer };
