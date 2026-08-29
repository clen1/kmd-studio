'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { generateLlmsTxt } = require('../src/llms');

test('generateLlmsTxt: full snapshot with description', () => {
  const out = generateLlmsTxt({
    siteTitle: 'KMD Docs',
    description: 'AI-era Markdown compiler',
    pages: [
      { title: 'Guide', url: 'guide.md', description: 'How to use KMD' },
      { title: 'Index', url: 'index.md' },
    ],
  });
  assert.equal(
    out,
    '# KMD Docs\n' +
      '\n' +
      '> AI-era Markdown compiler\n' +
      '\n' +
      '## Docs\n' +
      '\n' +
      '- [Guide](guide.md): How to use KMD\n' +
      '- [Index](index.md)\n'
  );
});

test('generateLlmsTxt: no site description omits the > line', () => {
  const out = generateLlmsTxt({
    siteTitle: 'KMD Docs',
    description: '',
    pages: [{ title: 'Index', url: 'index.md' }],
  });
  assert.equal(out, '# KMD Docs\n\n## Docs\n\n- [Index](index.md)\n');
});

test('generateLlmsTxt: item without description omits the suffix', () => {
  const out = generateLlmsTxt({
    siteTitle: 'T',
    pages: [{ title: 'A', url: 'a.md', description: 'has one' }, { title: 'B', url: 'b.md' }],
  });
  assert.equal(out, '# T\n\n## Docs\n\n- [A](a.md): has one\n- [B](b.md)\n');
});
