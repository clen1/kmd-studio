'use strict';

// KMD dev server: static files over a root dir + SSE live reload.
// Zero deps, node:http only.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const RELOAD_PATH = '/__kmd_reload';
const RELOAD_SNIPPET =
  "<script>new EventSource('/__kmd_reload').onmessage=function(e){if(e.data==='reload')location.reload()}</script>";
const HEARTBEAT_MS = 25000;

const NOT_FOUND_PAGE =
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<title>404 · KMD</title><style>' +
  'body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
  'font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;' +
  'background:#0c0e14;color:#e6e9f0}' +
  'h1{margin:0;font-size:3rem;background:linear-gradient(135deg,#6366f1,#a855f7);' +
  '-webkit-background-clip:text;background-clip:text;color:transparent}' +
  'p{color:#8b93a3}a{color:#a5b4fc;text-decoration:none}a:hover{text-decoration:underline}' +
  '</style></head><body><h1>404</h1><p>页面不存在或尚未构建。</p><p><a href="/">返回首页</a></p></body></html>';

function serve(options) {
  const opts = options || {};
  const root = path.resolve(opts.root || '.');
  const host = opts.host || '127.0.0.1';
  const port = opts.port == null ? 4173 : opts.port;

  const sseClients = new Set();
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://kmd.local').pathname);
    } catch (err) {
      sendText(res, 400, '400 Bad Request');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, '405 Method Not Allowed');
      return;
    }
    if (pathname === RELOAD_PATH) {
      handleSse(req, res);
      return;
    }
    serveFile(pathname, req, res);
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  // SSE keep-alive comment so proxies/browsers do not time the stream out.
  const heartbeat = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.write(': heartbeat\n\n');
      } catch (err) {
        sseClients.delete(client);
      }
    }
  }, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();

  function handleSse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  }

  function serveFile(pathname, req, res) {
    // Resolve under root and refuse anything that escapes it.
    let target = path.resolve(root, '.' + pathname);
    if (target !== root && !target.startsWith(root + path.sep)) {
      send404(res);
      return;
    }
    let stat = statSafe(target);
    if (stat && stat.isDirectory()) {
      target = path.join(target, 'index.html');
      stat = statSafe(target);
    }
    if (!stat || !stat.isFile()) {
      send404(res);
      return;
    }

    const ext = path.extname(target).toLowerCase();
    const headers = {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    };

    if (ext === '.html') {
      let html;
      try {
        html = fs.readFileSync(target, 'utf8');
      } catch (err) {
        send404(res);
        return;
      }
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : injectReload(html));
      return;
    }

    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(target)
      .on('error', () => res.destroy())
      .pipe(res);
  }

  function statSafe(p) {
    try {
      return fs.statSync(p);
    } catch (err) {
      return null;
    }
  }

  function injectReload(html) {
    const index = html.toLowerCase().lastIndexOf('</body>');
    if (index === -1) return html + RELOAD_SNIPPET;
    return html.slice(0, index) + RELOAD_SNIPPET + html.slice(index);
  }

  function send404(res) {
    res.writeHead(404, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(NOT_FOUND_PAGE);
  }

  function sendText(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(body);
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      const address = server.address();
      const actualPort = address && typeof address === 'object' ? address.port : port;
      resolve({
        url: 'http://' + host + ':' + actualPort,
        broadcastReload() {
          for (const client of sseClients) {
            try {
              client.write('data: reload\n\n');
            } catch (err) {
              sseClients.delete(client);
            }
          }
        },
        close() {
          return new Promise((resolveClose) => {
            clearInterval(heartbeat);
            for (const client of sseClients) client.destroy();
            sseClients.clear();
            server.close(() => resolveClose());
            // Destroy any lingering keep-alive sockets so close() settles.
            for (const socket of sockets) socket.destroy();
          });
        },
      });
    });
  });
}

module.exports = { serve };
