'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { countTokens, estimateReport } = require('../src/tokens');

test('countTokens: pure ASCII uses ceil(len/4)', () => {
  assert.equal(countTokens('hello world'), 3); // ceil(11/4)
  assert.equal(countTokens('abcd'), 1);
  assert.equal(countTokens('abcde'), 2);
  assert.equal(countTokens(''), 0);
});

test('countTokens: pure CJK counts 1 per char', () => {
  assert.equal(countTokens('你好世界'), 4);
  assert.equal(countTokens('豈'), 1); // compat ideograph U+F900
});

test('countTokens: CJK punctuation and fullwidth forms count as CJK', () => {
  assert.equal(countTokens('。'), 1); // U+3002
  assert.equal(countTokens('Ａ'), 1); // fullwidth A, U+FF21
});

test('countTokens: mixed text sums both parts', () => {
  // 2 CJK + 5 ASCII -> 2 + ceil(5/4) = 4
  assert.equal(countTokens('你好world'), 4);
});

test('estimateReport: shape and values', () => {
  const report = estimateReport([
    { path: 'a.md', text: 'hello world' },
    { path: 'b.md', text: '你好世界' },
  ]);
  assert.deepEqual(report, [
    { path: 'a.md', chars: 11, tokens: 3 },
    { path: 'b.md', chars: 4, tokens: 4 },
  ]);
});
