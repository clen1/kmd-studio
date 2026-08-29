'use strict';

// Token estimation (see docs/contracts.md). Rough heuristic, no tokenizer dep.

// CJK ranges: unified ideographs, compat ideographs, CJK punctuation,
// halfwidth/fullwidth forms.
function isCjk(cp) {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0xff00 && cp <= 0xffef)
  );
}

function countTokens(text) {
  text = typeof text === 'string' ? text : String(text ?? '');
  let cjk = 0;
  let rest = 0;
  for (const ch of text) {
    if (isCjk(ch.codePointAt(0))) cjk++;
    else rest++;
  }
  return cjk + Math.ceil(rest / 4);
}

function estimateReport(files) {
  return (files || []).map((file) => {
    const text = typeof file.text === 'string' ? file.text : String(file.text ?? '');
    return { path: file.path, chars: text.length, tokens: countTokens(text) };
  });
}

module.exports = { countTokens, estimateReport };
