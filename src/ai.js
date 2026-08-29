'use strict';

// AI block execution + disk cache (see docs/contracts.md).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BASE_URL = 'https://api.moonshot.cn/v1';
const DEFAULT_MODEL = 'kimi-k2-0905-preview';
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_CONCURRENCY = 3;

function resolveProvider(env) {
  env = env || {};
  const baseUrl = env.KMD_AI_BASE_URL || env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
  const apiKey = env.KMD_AI_API_KEY || env.OPENAI_API_KEY || env.MOONSHOT_API_KEY || null;
  const model = env.KMD_AI_MODEL || DEFAULT_MODEL;
  return { baseUrl, apiKey, model, hasKey: Boolean(apiKey) };
}

function cacheKey(model, prompt) {
  return crypto.createHash('sha256').update(model + '\n' + prompt).digest('hex');
}

// Returns cached markdown string, or null on miss/corrupt entry.
function readCache(cacheFile) {
  try {
    const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (data && typeof data.markdown === 'string') return data.markdown;
  } catch {
    // missing or corrupt -> ignore
  }
  return null;
}

async function callProvider(provider, fetchImpl, { model, temperature, prompt, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const url = provider.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = { model, messages: [{ role: 'user', content: prompt }] };
  if (temperature !== undefined) body.temperature = temperature;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`request timed out after ${timeoutMs / 1000}s`);
    }
    throw new Error(`network error: ${err && err.message ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let text = '';
    try {
      text = await res.text();
    } catch {
      // body unreadable; status alone still reported
    }
    throw new Error(`http ${res.status}: ${String(text).slice(0, 200)}`);
  }

  const data = await res.json();
  const content =
    data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof content !== 'string') {
    throw new Error('invalid response: missing choices[0].message.content');
  }
  return content;
}

async function fillAiBlocks(blocks, opts) {
  opts = opts || {};
  const { env = process.env, cacheDir, useCache = true, onLog = () => {} } = opts;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const provider = resolveProvider(env);

  if (!provider.hasKey) {
    for (const block of blocks) block.error = 'no-api-key';
    return blocks;
  }

  let cacheDirReady = false;

  async function processBlock(block, index) {
    const config = block.config || {};
    const model = config.model || provider.model;
    const temperature = config.temperature;
    const prompt = typeof block.prompt === 'string' ? block.prompt : String(block.prompt ?? '');
    const cacheFile = cacheDir && useCache ? path.join(cacheDir, cacheKey(model, prompt) + '.json') : null;

    if (cacheFile) {
      const cached = readCache(cacheFile);
      if (cached !== null) {
        block.markdown = cached;
        block.fromCache = true;
        onLog(`[ai] block ${index}: cached`);
        return;
      }
    }

    try {
      const markdown = await callProvider(provider, fetchImpl, { model, temperature, prompt });
      block.markdown = markdown;
      block.fromCache = false;
      onLog(`[ai] block ${index}: generated`);
      if (cacheFile) {
        try {
          if (!cacheDirReady) {
            fs.mkdirSync(cacheDir, { recursive: true });
            cacheDirReady = true;
          }
          fs.writeFileSync(
            cacheFile,
            JSON.stringify({ model, prompt, markdown, at: new Date().toISOString() })
          );
        } catch {
          // cache write failure is non-fatal
        }
      }
    } catch (err) {
      block.error = err && err.message ? err.message : String(err);
      onLog(`[ai] block ${index}: error - ${block.error}`);
    }
  }

  // Worker pool: at most MAX_CONCURRENCY blocks in flight.
  let next = 0;
  async function worker() {
    while (next < blocks.length) {
      const index = next++;
      await processBlock(blocks[index], index);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(MAX_CONCURRENCY, blocks.length); i++) workers.push(worker());
  await Promise.all(workers);
  return blocks;
}

// One-shot interactive prompt (KMD Studio). No caching.
// opts: { env = process.env, model?, temperature?, fetchImpl = globalThis.fetch,
//         timeoutMs = 90000 }
// -> markdown string. Throws Error('no-api-key') (exact) when no key is
// configured; http/network errors use the same message formats as fillAiBlocks.
async function runPrompt(prompt, opts) {
  opts = opts || {};
  const { env = process.env, model, temperature, timeoutMs = REQUEST_TIMEOUT_MS } = opts;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const provider = resolveProvider(env);
  if (!provider.hasKey) throw new Error('no-api-key');
  return callProvider(provider, fetchImpl, {
    model: model || provider.model,
    temperature,
    prompt: typeof prompt === 'string' ? prompt : String(prompt ?? ''),
    timeoutMs,
  });
}

module.exports = { fillAiBlocks, resolveProvider, runPrompt };
