'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/config');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kmd-config-'));
}

test('returns defaults when kmd.config.json is absent', () => {
  const c = loadConfig(tmp());
  assert.deepEqual(c, {
    siteTitle: 'KMD Docs',
    description: '',
    outDir: 'site',
    port: 4173,
    ai: {},
  });
});

test('merges a real config file over defaults (deep merge, defaults kept)', () => {
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, 'kmd.config.json'),
    JSON.stringify({
      siteTitle: '我的站点',
      port: 8080,
      ai: { model: 'kimi-k2', baseUrl: 'https://example.com/v1' },
    }),
  );
  const c = loadConfig(dir);
  assert.equal(c.siteTitle, '我的站点');
  assert.equal(c.port, 8080);
  assert.equal(c.outDir, 'site'); // default preserved
  assert.equal(c.description, ''); // default preserved
  assert.deepEqual(c.ai, { model: 'kimi-k2', baseUrl: 'https://example.com/v1' });
});

test('does not share or mutate the default objects between calls', () => {
  const a = loadConfig(tmp());
  a.siteTitle = 'changed';
  a.ai.injected = true;
  const b = loadConfig(tmp());
  assert.equal(b.siteTitle, 'KMD Docs');
  assert.deepEqual(b.ai, {});
});

test('malformed JSON throws naming the file', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'kmd.config.json'), '{ not json ,,,');
  assert.throws(() => loadConfig(dir), /kmd\.config\.json/);
});

test('non-object top level throws naming the file', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'kmd.config.json'), '[1,2,3]');
  assert.throws(() => loadConfig(dir), /kmd\.config\.json/);
});
