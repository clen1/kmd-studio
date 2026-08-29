'use strict';
// kmd.config.json loading. Contract: docs/contracts.md "src/config.js (Agent D)".
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  siteTitle: 'KMD Docs',
  description: '',
  outDir: 'site',
  port: 4173,
  ai: {},
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Deep-merge `over` onto `base`; nested plain objects merge, everything else replaces.
// Always returns fresh objects (defaults are never mutated/shared).
function deepMerge(base, over) {
  const out = {};
  for (const [k, v] of Object.entries(base)) {
    out[k] = isPlainObject(v) ? deepMerge(v, {}) : v;
  }
  if (!isPlainObject(over)) return out;
  for (const [k, v] of Object.entries(over)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else if (isPlainObject(v)) out[k] = deepMerge(v, {});
    else out[k] = v;
  }
  return out;
}

// loadConfig(cwd) -> { siteTitle, description, outDir, port, ai: {} }
// Reads <cwd>/kmd.config.json if present; malformed JSON throws naming the file.
function loadConfig(cwd) {
  const file = path.join(cwd, 'kmd.config.json');
  if (!fs.existsSync(file)) return deepMerge(DEFAULTS, {});
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`无法读取配置文件 ${file}：${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`配置文件 ${file} 不是合法的 JSON：${err.message}`);
  }
  if (!isPlainObject(data)) {
    throw new Error(`配置文件 ${file} 的顶层必须是 JSON 对象`);
  }
  return deepMerge(DEFAULTS, data);
}

module.exports = { loadConfig, DEFAULTS };
