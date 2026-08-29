'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { fillAiBlocks, resolveProvider, runPrompt } = require('../src/ai');

function makeFetch(impl, calls) {
  return async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    return impl();
  };
}

const okImpl = () => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content: 'hello' } }] }),
});

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

test('resolveProvider: defaults', () => {
  assert.deepEqual(resolveProvider({}), {
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKey: null,
    model: 'kimi-k2-0905-preview',
    hasKey: false,
  });
});

test('resolveProvider: KMD_AI_* beats OPENAI_* beats MOONSHOT_*', () => {
  const full = resolveProvider({
    KMD_AI_BASE_URL: 'https://kmd.example/v1',
    OPENAI_BASE_URL: 'https://openai.example/v1',
    KMD_AI_API_KEY: 'k1',
    OPENAI_API_KEY: 'k2',
    MOONSHOT_API_KEY: 'k3',
    KMD_AI_MODEL: 'm1',
  });
  assert.equal(full.baseUrl, 'https://kmd.example/v1');
  assert.equal(full.apiKey, 'k1');
  assert.equal(full.model, 'm1');
  assert.equal(full.hasKey, true);

  const openai = resolveProvider({ OPENAI_BASE_URL: 'https://openai.example/v1', OPENAI_API_KEY: 'k2', MOONSHOT_API_KEY: 'k3' });
  assert.equal(openai.baseUrl, 'https://openai.example/v1');
  assert.equal(openai.apiKey, 'k2');

  const moonshot = resolveProvider({ MOONSHOT_API_KEY: 'k3' });
  assert.equal(moonshot.apiKey, 'k3');
  assert.equal(moonshot.baseUrl, 'https://api.moonshot.cn/v1');
});

test('fillAiBlocks: success path mutates block and sends correct request', async () => {
  const calls = [];
  const fetchImpl = makeFetch(okImpl, calls);
  const blocks = [{ id: 0, prompt: 'say hi', config: {} }];
  await fillAiBlocks(blocks, { env: { KMD_AI_API_KEY: 'sk-test' }, fetchImpl, useCache: false });

  assert.equal(blocks[0].markdown, 'hello');
  assert.equal(blocks[0].fromCache, false);
  assert.equal(blocks[0].error, undefined);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.moonshot.cn/v1/chat/completions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
  assert.deepEqual(calls[0].body, {
    model: 'kimi-k2-0905-preview',
    messages: [{ role: 'user', content: 'say hi' }],
  });
  assert.ok(!('temperature' in calls[0].body));
});

test('fillAiBlocks: non-2xx sets error with status and body excerpt', async () => {
  const calls = [];
  const fetchImpl = makeFetch(() => ({ ok: false, status: 500, text: async () => 'boom' }), calls);
  const blocks = [{ id: 0, prompt: 'p', config: {} }];
  await fillAiBlocks(blocks, { env: { KMD_AI_API_KEY: 'sk-test' }, fetchImpl, useCache: false });

  assert.equal(blocks[0].markdown, undefined);
  assert.ok(blocks[0].error.includes('500'));
  assert.ok(blocks[0].error.includes('boom'));
});

test('fillAiBlocks: network error produces clear message', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };
  const blocks = [{ id: 0, prompt: 'p', config: {} }];
  await fillAiBlocks(blocks, { env: { KMD_AI_API_KEY: 'sk-test' }, fetchImpl, useCache: false });
  assert.ok(blocks[0].error.includes('ECONNREFUSED'));
});

test('fillAiBlocks: missing apiKey short-circuits with exact no-api-key error', async () => {
  let called = 0;
  const fetchImpl = async () => {
    called++;
    return okImpl();
  };
  const blocks = [
    { id: 0, prompt: 'a', config: {} },
    { id: 1, prompt: 'b', config: {} },
  ];
  await fillAiBlocks(blocks, { env: {}, fetchImpl });
  assert.equal(blocks[0].error, 'no-api-key');
  assert.equal(blocks[1].error, 'no-api-key');
  assert.equal(called, 0);
});

test('fillAiBlocks: disk cache hit on second call, file shape correct', async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kmd-ai-'));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));

  let called = 0;
  const fetchImpl = async () => {
    called++;
    return okImpl();
  };
  const env = { KMD_AI_API_KEY: 'sk-test' };
  const prompt = 'cache me';

  const first = [{ id: 0, prompt, config: {} }];
  await fillAiBlocks(first, { env, fetchImpl, cacheDir });
  assert.equal(called, 1);
  assert.equal(first[0].fromCache, false);

  const cacheFile = path.join(cacheDir, sha256('kimi-k2-0905-preview\n' + prompt) + '.json');
  const entry = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(entry.model, 'kimi-k2-0905-preview');
  assert.equal(entry.prompt, prompt);
  assert.equal(entry.markdown, 'hello');
  assert.equal(typeof entry.at, 'string');

  const second = [{ id: 0, prompt, config: {} }];
  await fillAiBlocks(second, { env, fetchImpl, cacheDir });
  assert.equal(called, 1, 'fetch must not run on cache hit');
  assert.equal(second[0].markdown, 'hello');
  assert.equal(second[0].fromCache, true);
});

test('fillAiBlocks: corrupt cache entry is ignored and re-fetched', async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kmd-ai-'));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));

  const prompt = 'corrupt me';
  fs.writeFileSync(path.join(cacheDir, sha256('kimi-k2-0905-preview\n' + prompt) + '.json'), 'not json{{{');

  let called = 0;
  const fetchImpl = async () => {
    called++;
    return okImpl();
  };
  const blocks = [{ id: 0, prompt, config: {} }];
  await fillAiBlocks(blocks, { env: { KMD_AI_API_KEY: 'sk-test' }, fetchImpl, cacheDir });
  assert.equal(called, 1);
  assert.equal(blocks[0].markdown, 'hello');
  assert.equal(blocks[0].fromCache, false);
});

test('fillAiBlocks: config.model/temperature override hit request body and cache key', async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kmd-ai-'));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));

  const calls = [];
  const fetchImpl = makeFetch(okImpl, calls);
  const prompt = 'override me';
  const blocks = [{ id: 0, prompt, config: { model: 'custom-model', temperature: 0.3 } }];
  await fillAiBlocks(blocks, { env: { KMD_AI_API_KEY: 'sk-test' }, fetchImpl, cacheDir });

  assert.equal(calls[0].body.model, 'custom-model');
  assert.equal(calls[0].body.temperature, 0.3);

  const overrideKey = sha256('custom-model\n' + prompt) + '.json';
  const defaultKey = sha256('kimi-k2-0905-preview\n' + prompt) + '.json';
  assert.ok(fs.readdirSync(cacheDir).includes(overrideKey));
  assert.ok(!fs.readdirSync(cacheDir).includes(defaultKey));
});

test('fillAiBlocks: at most 3 requests in flight', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight--;
    return okImpl();
  };
  const blocks = Array.from({ length: 7 }, (_, i) => ({ id: i, prompt: 'p' + i, config: {} }));
  await fillAiBlocks(blocks, { env: { KMD_AI_API_KEY: 'sk-test' }, fetchImpl, useCache: false });

  assert.ok(maxInFlight <= 3, `max in flight ${maxInFlight}`);
  assert.ok(maxInFlight >= 2, 'work actually parallelized');
  for (const block of blocks) assert.equal(block.markdown, 'hello');
});

// --- runPrompt (KMD Studio interactive use; no caching) ---

test('runPrompt: returns markdown string and sends correct request', async () => {
  const calls = [];
  const fetchImpl = makeFetch(okImpl, calls);
  const out = await runPrompt('say hi', { env: { KMD_AI_API_KEY: 'sk-test' }, fetchImpl });

  assert.equal(out, 'hello');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.moonshot.cn/v1/chat/completions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
  assert.deepEqual(calls[0].body, {
    model: 'kimi-k2-0905-preview',
    messages: [{ role: 'user', content: 'say hi' }],
  });
  assert.ok(!('temperature' in calls[0].body));
});

test('runPrompt: model/temperature opts hit the request body', async () => {
  const calls = [];
  const fetchImpl = makeFetch(okImpl, calls);
  await runPrompt('p', {
    env: { KMD_AI_API_KEY: 'sk-test' },
    model: 'custom-model',
    temperature: 0.2,
    fetchImpl,
  });
  assert.equal(calls[0].body.model, 'custom-model');
  assert.equal(calls[0].body.temperature, 0.2);
});

test('runPrompt: missing apiKey throws Error with exact no-api-key message', async () => {
  let called = 0;
  const fetchImpl = async () => {
    called++;
    return okImpl();
  };
  await assert.rejects(runPrompt('p', { env: {}, fetchImpl }), (err) => {
    assert.equal(err.message, 'no-api-key');
    return true;
  });
  assert.equal(called, 0);
});

test('runPrompt: non-2xx throws with status and body excerpt', async () => {
  const fetchImpl = makeFetch(() => ({ ok: false, status: 500, text: async () => 'boom' }), []);
  await assert.rejects(runPrompt('p', { env: { KMD_AI_API_KEY: 'sk-test' }, fetchImpl }), (err) => {
    assert.ok(err.message.includes('500'));
    assert.ok(err.message.includes('boom'));
    return true;
  });
});

test('runPrompt: network error throws with clear message', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };
  await assert.rejects(runPrompt('p', { env: { KMD_AI_API_KEY: 'sk-test' }, fetchImpl }), (err) => {
    assert.ok(err.message.includes('ECONNREFUSED'));
    return true;
  });
});

test('runPrompt: does not touch the disk cache', async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kmd-ai-'));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  const fetchImpl = makeFetch(okImpl, []);
  await runPrompt('cache me', {
    env: { KMD_AI_API_KEY: 'sk-test' },
    fetchImpl,
    // runPrompt has no cacheDir opt; passing one must be ignored
    cacheDir,
  });
  assert.deepEqual(fs.readdirSync(cacheDir), []);
});
