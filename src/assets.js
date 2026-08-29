'use strict';

// Asset layer for files that ship inside the repo (theme.css, Studio UI).
// In a SEA single-file bundle the real fs paths do not exist, so the bundler
// embeds an asset table on global.__KMD_ASSETS__ (keys are posix repo-relative
// paths) and reads come from there; otherwise we read from the repo on disk.

const fs = require('node:fs');
const path = require('node:path');

function embeddedTable() {
  const t = global.__KMD_ASSETS__;
  return t && typeof t === 'object' ? t : null;
}

function normalizeKey(repoRel) {
  return String(repoRel).replace(/\\/g, '/').replace(/^\/+/, '');
}

// readAsset(repoRel) -> utf8 string. Throws when the asset is missing.
function readAsset(repoRel) {
  const key = normalizeKey(repoRel);
  const table = embeddedTable();
  if (table) {
    if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
    throw new Error(`asset not embedded: ${key}`);
  }
  return fs.readFileSync(path.join(__dirname, '..', key), 'utf8');
}

function hasAsset(repoRel) {
  const key = normalizeKey(repoRel);
  const table = embeddedTable();
  if (table) return Object.prototype.hasOwnProperty.call(table, key);
  try {
    fs.accessSync(path.join(__dirname, '..', key));
    return true;
  } catch {
    return false;
  }
}

// assetKeys() -> embedded asset paths (embedded mode only; [] otherwise).
function assetKeys() {
  const table = embeddedTable();
  return table ? Object.keys(table) : [];
}

module.exports = { readAsset, hasAsset, assetKeys };
