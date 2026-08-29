'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { serve } = require('../src/server');

const RELOAD_MARKER = "new EventSource('/__kmd_reload')";

function makeSite(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kmd-server-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<!doctype html>\n<html lang="zh-CN">\n<body>\n<h1>首页</h1>\n</body>\n</html>\n'
  );
  fs.writeFileSync(path.join(dir, 'a.txt'), 'plain text content');
  fs.writeFileSync(path.join(dir, 'nobody.html'), '<h1>无 body 标签</h1>');
  return dir;
}

test('static files, html reload injection, mime types, traversal protection', async (t) => {
  const dir = makeSite(t);
  const app = await serve({ root: dir, port: 0 });
  t.after(() => app.close());

  const assignedPort = Number(new URL(app.url).port);
  assert.ok(assignedPort > 0, 'url reports the OS-assigned port');

  // GET / -> directory index, snippet injected before </body>.
  let res = await fetch(app.url + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  let body = await res.text();
  assert.ok(body.includes('<h1>首页</h1>'));
  assert.ok(body.includes(RELOAD_MARKER));
  assert.ok(body.indexOf(RELOAD_MARKER) < body.toLowerCase().indexOf('</body>'));

  // HTML without </body> -> snippet appended at the end.
  res = await fetch(app.url + '/nobody.html');
  assert.equal(res.status, 200);
  body = await res.text();
  assert.ok(body.includes(RELOAD_MARKER));
  assert.ok(body.trimEnd().endsWith('</script>'));

  // Plain text file with a text/plain-ish mime.
  res = await fetch(app.url + '/a.txt');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/plain/);
  assert.equal(await res.text(), 'plain text content');

  // Missing file -> 404 page.
  res = await fetch(app.url + '/missing.html');
  assert.equal(res.status, 404);
  assert.ok((await res.text()).includes('404'));

  // Traversal attempts never escape root (encoded dots + raw dots).
  res = await fetch(app.url + '/..%2f..%2f..%2fetc%2fpasswd');
  assert.ok([400, 404].includes(res.status), 'encoded traversal rejected');
  const rawStatus = await new Promise((resolve, reject) => {
    const u = new URL(app.url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: '/../../../etc/passwd', method: 'GET' },
      (r) => {
        r.resume();
        r.on('end', () => resolve(r.statusCode));
      }
    );
    req.on('error', reject);
    req.end();
  });
  assert.ok([400, 404].includes(rawStatus), 'raw traversal rejected');
});

test('SSE endpoint, broadcastReload, and await-able close', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kmd-server-'));
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>x</h1>');
    const app = await serve({ root: dir, port: 0 });

    const sseRes = await new Promise((resolve, reject) => {
      const req = http.get(app.url + '/__kmd_reload', resolve);
      req.on('error', reject);
    });
    assert.equal(sseRes.statusCode, 200);
    assert.match(sseRes.headers['content-type'] || '', /text\/event-stream/);
    assert.match(sseRes.headers['cache-control'] || '', /no-cache/);

    sseRes.setEncoding('utf8');
    let received = '';
    const gotReload = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for reload chunk')),
        3000
      );
      sseRes.on('data', (chunk) => {
        received += chunk;
        if (received.includes('data: reload')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    app.broadcastReload();
    await gotReload;
    assert.ok(received.includes('data: reload'));
    sseRes.destroy();

    await app.close();
    await assert.rejects(() => fetch(app.url + '/'), 'fetch after close must fail');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
