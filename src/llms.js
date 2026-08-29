'use strict';

// llms.txt generation per llmstxt.org (see docs/contracts.md).

function generateLlmsTxt({ siteTitle, description, pages } = {}) {
  const lines = [];
  lines.push(`# ${siteTitle || ''}`);
  lines.push('');
  if (description) {
    lines.push(`> ${description}`);
    lines.push('');
  }
  lines.push('## Docs');
  lines.push('');
  for (const page of pages || []) {
    let item = `- [${page.title}](${page.url})`;
    if (page.description) item += `: ${page.description}`;
    lines.push(item);
  }
  return lines.join('\n') + '\n';
}

module.exports = { generateLlmsTxt };
