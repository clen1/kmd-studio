'use strict';

/**
 * src/parser.js — KMD markdown engine.
 *
 * parseMarkdown(src, { allowAi = true }) -> { html, toc, meta, flags, aiBlocks }
 *
 * Architecture: a line-based block tokenizer (headings, fences, quotes,
 * lists, tables, math, paragraphs) whose leaf content is rendered by a
 * recursive-descent inline parser (emphasis, code spans, links, autolinks,
 * math, footnote refs, escapes). Safe by default: all raw HTML in the
 * source is escaped, and rendering never throws on bad input.
 */

const { highlight } = require('./highlight');

// ---------------------------------------------------------------------------
// Escaping helpers
// ---------------------------------------------------------------------------

/** Text nodes: escape & < > " */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Attribute values: additionally escape ' */
function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

const isBlank = (line) => /^[ \t]*$/.test(line);

/** ASCII punctuation (the set CommonMark allows after a backslash). */
const ASCII_PUNCT = /^[!-/:-@[-`{-~]$/;
const RE_ESCAPABLE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g;

// ---------------------------------------------------------------------------
// Frontmatter (simple YAML subset)
// ---------------------------------------------------------------------------

function coerceScalar(v) {
  v = v.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function parseMetaValue(v) {
  v = v.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1); // quoted strings stay strings, commas included
  }
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map(coerceScalar);
  }
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.includes(',')) return v.split(',').map(coerceScalar);
  return v;
}

/** Frontmatter: file must start with `---\n`; closes at a line exactly `---`. */
function parseFrontmatter(src) {
  if (!src.startsWith('---\n')) return { meta: {}, body: src };
  const lines = src.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      const meta = {};
      for (let j = 1; j < i; j++) {
        const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[j]);
        if (m) meta[m[1]] = parseMetaValue(m[2]);
      }
      return { meta, body: lines.slice(i + 1).join('\n') };
    }
  }
  return { meta: {}, body: src }; // no closing fence -> not frontmatter
}

// ---------------------------------------------------------------------------
// Footnote definition extraction (fence-aware so `[^x]:` inside code stays)
// ---------------------------------------------------------------------------

function extractFootnotes(body) {
  const defs = new Map();
  const kept = [];
  const lines = body.split('\n');
  let fenceCh = null;
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fm) {
      if (!fenceCh) { fenceCh = fm[1][0]; fenceLen = fm[1].length; }
      else if (fm[1][0] === fenceCh && fm[1].length >= fenceLen) fenceCh = null;
      kept.push(line);
      continue;
    }
    if (fenceCh) { kept.push(line); continue; }
    const dm = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/.exec(line);
    if (dm) {
      const buf = [dm[2]];
      // Continuation lines: indented by 4+ spaces or a tab (blank lines only
      // count when followed by another indented line).
      while (i + 1 < lines.length) {
        const nx = lines[i + 1];
        if (/^(?: {4}|\t)/.test(nx)) { buf.push(nx.replace(/^(?: {4}|\t)/, '')); i++; }
        else if (isBlank(nx) && i + 2 < lines.length && /^(?: {4}|\t)/.test(lines[i + 2])) { buf.push(''); i++; }
        else break;
      }
      defs.set(dm[1], buf.join('\n').trim());
      continue;
    }
    kept.push(line);
  }
  return { lines: kept, defs };
}

// ---------------------------------------------------------------------------
// Slugs, plain text
// ---------------------------------------------------------------------------

/** Plain-text view of inline markup, for slugs / toc / alt attributes. */
function plainText(s) {
  return s
    .replace(RE_ESCAPABLE, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`]/g, '')
    .replace(/\$([^$\n]+)\$/g, '$1')
    .trim();
}

/** Slug: lowercase, trim, keep letters/digits/CJK/-_, spaces -> '-', strip punctuation. */
function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}\-_]/gu, '');
}

function dedupeSlug(slug, slugs) {
  const count = slugs.get(slug) || 0;
  slugs.set(slug, count + 1);
  return count === 0 ? slug : slug + '-' + count;
}

// ---------------------------------------------------------------------------
// Inline parsing helpers
// ---------------------------------------------------------------------------

/** Find the ']' matching the '[' just before `from`, honoring escapes/nesting. */
function findBracket(text, from) {
  let depth = 1;
  for (let j = from; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') { j++; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return j; }
  }
  return -1;
}

/**
 * Parse an inline link target starting at '(':
 * optional <dest> or bare dest, optional "title" / 'title' / (title), then ')'.
 * Returns { dest, title, end } or null when malformed.
 */
function parseLinkDest(text, i) {
  let j = i + 1;
  while (j < text.length && /\s/.test(text[j])) j++;
  let dest = '';
  if (text[j] === '<') {
    const gt = text.indexOf('>', j + 1);
    if (gt === -1) return null;
    dest = text.slice(j + 1, gt);
    j = gt + 1;
  } else {
    let depth = 0;
    const start = j;
    while (j < text.length) {
      const c = text[j];
      if (c === '\\') { j += 2; continue; }
      if (/\s/.test(c) && depth === 0) break;
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      j++;
    }
    dest = text.slice(start, j);
  }
  dest = dest.replace(RE_ESCAPABLE, '$1');
  while (j < text.length && /\s/.test(text[j])) j++;
  let title = null;
  const q = text[j];
  if (q === '"' || q === "'" || q === '(') {
    const closer = q === '(' ? ')' : q;
    const e = text.indexOf(closer, j + 1);
    if (e === -1) return null;
    title = text.slice(j + 1, e).replace(RE_ESCAPABLE, '$1');
    j = e + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
  }
  if (text[j] !== ')') return null;
  return { dest, title, end: j + 1 };
}

/** Block dangerous protocols; everything else passes through. */
function sanitizeUrl(url) {
  const compact = url.replace(/[\s\x00-\x1f]+/g, '');
  if (/^(javascript|vbscript|data):/i.test(compact)) return '#';
  return url;
}

/**
 * Find a closing emphasis run of `ch` (at least `need` chars) from index `from`.
 * Odd-length runs close from the right (so `**bold *em***` nests correctly);
 * even runs close from the left. For '_', the char after the run must not be
 * alphanumeric (no intra-word emphasis). Returns { start, end } or null.
 */
function findClose(text, from, ch, need) {
  const valid = (i, run) => {
    if (run < need || text[i - 1] === '\\') return false;
    const after = text[i + run] || '';
    return ch !== '_' || !/[A-Za-z0-9]/.test(after);
  };
  // need=1: prefer a run of exactly one (lets `*em **bold** text*` nest);
  // otherwise fall back to the first run, consuming its leftmost char.
  for (let pass = 0; pass < (need === 1 ? 2 : 1); pass++) {
    for (let i = from; i < text.length; i++) {
      if (text[i] !== ch) continue;
      let run = 1;
      while (text[i + run] === ch) run++;
      if (valid(i, run)) {
        if (need === 2) {
          const idx = run % 2 === 1 ? i + run - 2 : i; // odd runs close from the right
          return { start: idx, end: idx + 2 };
        }
        if (pass === 0 && run === 1) return { start: i, end: i + 1 };
        if (pass === 1) return { start: i, end: i + 1 };
      }
      i += run - 1;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inline renderer (recursive descent)
// ---------------------------------------------------------------------------

function renderInline(text, ctx) {
  let out = '';
  let plain = '';
  let i = 0;
  const n = text.length;
  const flush = () => { out += escapeHtml(plain); plain = ''; };

  while (i < n) {
    const ch = text[i];

    // Backslash escape of ASCII punctuation.
    if (ch === '\\' && i + 1 < n && ASCII_PUNCT.test(text[i + 1])) {
      plain += text[i + 1];
      i += 2;
      continue;
    }

    // Code span: a run of N backticks closes at the next run of exactly N.
    if (ch === '`') {
      let run = 1;
      while (text[i + run] === '`') run++;
      let j = i + run;
      let close = -1;
      while (j < n) {
        if (text[j] === '`') {
          let r2 = 1;
          while (text[j + r2] === '`') r2++;
          if (r2 === run) { close = j; break; }
          j += r2;
        } else j++;
      }
      if (close !== -1) {
        let content = text.slice(i + run, close).replace(/\n/g, ' ');
        if (/^ .+ $/.test(content) && /\S/.test(content)) content = content.slice(1, -1);
        flush();
        out += '<code>' + escapeHtml(content) + '</code>';
        i = close + run;
      } else {
        plain += text.slice(i, i + run);
        i += run;
      }
      continue;
    }

    // Image: ![alt](src "title")
    if (ch === '!' && text[i + 1] === '[') {
      const closeB = findBracket(text, i + 2);
      const link = closeB !== -1 && text[closeB + 1] === '(' ? parseLinkDest(text, closeB + 1) : null;
      if (link) {
        flush();
        out += '<img src="' + escapeAttr(sanitizeUrl(link.dest)) + '" alt="' +
          escapeAttr(plainText(text.slice(i + 2, closeB))) + '"' +
          (link.title != null ? ' title="' + escapeAttr(link.title) + '"' : '') + '>';
        i = link.end;
        continue;
      }
      plain += '!';
      i++;
      continue;
    }

    // Footnote reference or inline link.
    if (ch === '[') {
      const fm = /^\[\^([^\]\s]+)\]/.exec(text.slice(i));
      if (fm && ctx.defs.has(fm[1])) {
        const id = fm[1];
        let num = ctx.fnMap.get(id);
        if (!num) {
          num = ctx.fnOrder.length + 1;
          ctx.fnMap.set(id, num);
          ctx.fnOrder.push(id);
        }
        flush();
        out += '<sup class="footnote-ref" id="fnref-' + escapeAttr(id) + '"><a href="#fn-' +
          escapeAttr(id) + '">' + num + '</a></sup>';
        i += fm[0].length;
        continue;
      }
      const closeB = findBracket(text, i + 1);
      const link = closeB !== -1 && text[closeB + 1] === '(' ? parseLinkDest(text, closeB + 1) : null;
      if (link) {
        flush();
        out += '<a href="' + escapeAttr(sanitizeUrl(link.dest)) + '"' +
          (link.title != null ? ' title="' + escapeAttr(link.title) + '"' : '') + '>' +
          renderInline(text.slice(i + 1, closeB), ctx) + '</a>';
        i = link.end;
        continue;
      }
      plain += '[';
      i++;
      continue;
    }

    // Strong / emphasis. '*' may be intra-word; '_' may not.
    if (ch === '*' || ch === '_') {
      let run = 1;
      while (text[i + run] === ch) run++;
      const prevOk = ch === '*' || i === 0 || !/[A-Za-z0-9]/.test(text[i - 1]);
      let handled = false;
      if (prevOk) {
        if (run >= 2) {
          const close = findClose(text, i + 2, ch, 2);
          if (close && close.start > i + 2) {
            flush();
            out += '<strong>' + renderInline(text.slice(i + 2, close.start), ctx) + '</strong>';
            i = close.end;
            handled = true;
          }
        }
        if (!handled) {
          const close = findClose(text, i + 1, ch, 1);
          if (close && close.start > i + 1) {
            flush();
            out += '<em>' + renderInline(text.slice(i + 1, close.start), ctx) + '</em>';
            i = close.end;
            handled = true;
          }
        }
      }
      if (!handled) {
        plain += text.slice(i, i + run);
        i += run;
      }
      continue;
    }

    // Strikethrough.
    if (ch === '~' && text[i + 1] === '~') {
      const j = text.indexOf('~~', i + 2);
      if (j > i + 2) {
        flush();
        out += '<del>' + renderInline(text.slice(i + 2, j), ctx) + '</del>';
        i = j + 2;
        continue;
      }
    }

    // Inline math: $...$ (no newline, no edge spaces, close not before a digit).
    if (ch === '$') {
      if (text[i + 1] === '$') { plain += '$$'; i += 2; continue; }
      let j = i + 1;
      while (j < n && text[j] !== '$' && text[j] !== '\n') {
        if (text[j] === '\\') j++;
        j++;
      }
      if (j < n && text[j] === '$' && j > i + 1) {
        const content = text.slice(i + 1, j);
        const after = text[j + 1] || '';
        if (!/^\s|\s$/.test(content) && !/[0-9]/.test(after)) {
          flush();
          out += '<span class="math math-inline">\\(' + escapeHtml(content) + '\\)</span>';
          ctx.flags.math = true;
          i = j + 1;
          continue;
        }
      }
      plain += '$';
      i++;
      continue;
    }

    // Bare autolinks.
    if (ch === 'h' && (text.startsWith('https://', i) || text.startsWith('http://', i))) {
      if (i === 0 || /[\s('"<]/.test(text[i - 1])) {
        const m = /^https?:\/\/[^\s<>"']+/.exec(text.slice(i));
        if (m) {
          let url = m[0];
          while (/[.,;:!?'"*~_\]]$/.test(url)) url = url.slice(0, -1);
          while (url.endsWith(')') && url.split(')').length - 1 > url.split('(').length - 1) {
            url = url.slice(0, -1);
          }
          if (url) {
            flush();
            out += '<a href="' + escapeAttr(url) + '">' + escapeHtml(url) + '</a>';
            i += url.length;
            continue;
          }
        }
      }
    }

    plain += ch;
    i++;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Indentation helpers (column-based; tab = next multiple of 4)
// ---------------------------------------------------------------------------

function colWidth(s) {
  let c = 0;
  for (const ch of s) c += ch === '\t' ? 4 - (c % 4) : 1;
  return c;
}

function indentOf(line) {
  let c = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ' ') c++;
    else if (line[i] === '\t') c += 4 - (c % 4);
    else break;
  }
  return c;
}

/** Remove `cols` indentation columns from the start of a line. */
function stripIndent(line, cols) {
  let c = 0;
  let i = 0;
  while (i < line.length && c < cols) {
    c += line[i] === '\t' ? 4 - (c % 4) : 1;
    i++;
  }
  return line.slice(i);
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

const CALLOUT_TITLES = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' };

/** List item marker: `-` `*` `+` or `1.` / `1)` with indent <= 3 columns. */
function matchListItem(line) {
  const m = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]*)(.*)$/.exec(line);
  if (!m) return null;
  const indent = colWidth(m[1]);
  if (indent > 3) return null; // deeper nesting is handled via recursion
  const marker = m[2];
  const spaces = colWidth(m[3]);
  if (spaces === 0 && m[4].length > 0) return null; // "-foo" is not a list
  const gap = spaces === 0 ? 1 : (spaces > 4 ? 1 : spaces);
  return { indent, marker, ordered: /^\d/.test(marker), contentIndent: indent + marker.length + gap };
}

function trimBlankEdges(arr) {
  let a = 0;
  let b = arr.length;
  while (a < b && isBlank(arr[a])) a++;
  while (b > a && isBlank(arr[b - 1])) b--;
  return arr.slice(a, b);
}

/** Parse a fenced code block (``` or ~~~, closing fence >= opening length). */
function tryFence(lines, i, ctx) {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/.exec(lines[i]);
  if (!m) return null;
  const fence = m[1];
  const ch = fence[0];
  const info = m[2].trim();
  if (ch === '`' && info.includes('`')) return null; // CommonMark rule
  const content = [];
  let j = i + 1;
  while (j < lines.length) {
    const cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[j]);
    if (cm && cm[1][0] === ch && cm[1].length >= fence.length) break;
    content.push(lines[j]);
    j++;
  }
  const next = j < lines.length ? j + 1 : j; // unterminated fence eats to EOF
  const code = content.join('\n');
  const words = info.split(/\s+/).filter(Boolean);
  const lang = (words[0] || '').toLowerCase();

  if (lang === 'ai' && ctx.allowAi) {
    const id = ctx.aiBlocks.length;
    ctx.aiBlocks.push({ id, prompt: code.trim(), config: parseAiConfig(words.slice(1).join(' ')) });
    return { html: '<!--AI_BLOCK:' + id + '-->', next };
  }
  if (lang === 'mermaid') {
    ctx.flags.mermaid = true;
    return { html: '<pre class="mermaid">' + escapeHtml(code) + '</pre>', next };
  }
  const langAttr = words[0] ? ' data-lang="' + escapeAttr(words[0]) + '"' : '';
  return {
    html: '<pre class="codeblock"' + langAttr + '><code>' + highlight(code, words[0] || '') + '</code></pre>',
    next,
  };
}

/** key=value pairs from an ```ai info string; numeric values coerced. */
function parseAiConfig(rest) {
  const config = {};
  const re = /([A-Za-z_][\w-]*)=("[^"]*"|'[^']*'|\S+)/g;
  let m;
  while ((m = re.exec(rest))) {
    let v = m[2];
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
      v = v.slice(1, -1);
    } else if (/^-?\d+(\.\d+)?$/.test(v)) {
      v = Number(v);
    }
    config[m[1]] = v;
  }
  return config;
}

function tryHeading(lines, i, ctx) {
  const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(lines[i]);
  if (!m) return null;
  const level = m[1].length;
  const text = (m[2] || '').replace(/[ \t]+#+[ \t]*$/, '').trim();
  const plain = plainText(text);
  const slug = dedupeSlug(slugify(plain) || 'section', ctx.slugs);
  if (level === 1 && !('title' in ctx.meta)) ctx.meta.title = plain;
  if (level === 2 || level === 3) ctx.toc.push({ level, text: plain, id: slug });
  const html = '<h' + level + ' id="' + slug + '">' + renderInline(text, ctx) +
    '<a class="heading-anchor" href="#' + slug + '" aria-hidden="true">#</a></h' + level + '>';
  return { html, next: i + 1 };
}

function tryHr(lines, i) {
  // Contract: only after a blank line or at document start (no setext ambiguity).
  if (!/^ {0,3}([-*_])\1{2,}[ \t]*$/.test(lines[i])) return null;
  if (i !== 0 && !isBlank(lines[i - 1])) return null;
  return { html: '<hr>', next: i + 1 };
}

function tryBlockquote(lines, i, ctx) {
  if (!/^ {0,3}>/.test(lines[i])) return null;
  const inner = [];
  let j = i;
  while (j < lines.length && /^ {0,3}>/.test(lines[j])) {
    inner.push(lines[j].replace(/^ {0,3}>[ \t]?/, ''));
    j++;
  }
  const cm = /^\[!(note|tip|important|warning|caution)\][ \t]*(.*)$/i.exec(inner[0] || '');
  if (cm) {
    const type = cm[1].toLowerCase();
    const title = cm[2].trim();
    const body = parseBlocks(inner.slice(1), ctx);
    const titleHtml = title ? renderInline(title, ctx) : CALLOUT_TITLES[type];
    return {
      html: '<div class="callout callout-' + type + '"><p class="callout-title">' + titleHtml + '</p>' +
        (body ? '\n' + body : '') + '\n</div>',
      next: j,
    };
  }
  return { html: '<blockquote>\n' + parseBlocks(inner, ctx) + '\n</blockquote>', next: j };
}

/** Parse a (possibly nested, loose or tight) list starting at lines[i]. */
function parseList(lines, start, ctx) {
  const first = matchListItem(lines[start]);
  const baseIndent = first.indent;
  const ordered = first.ordered;
  const delim = first.marker.slice(-1); // '.' / ')' / bullet char
  const sameKind = (im) =>
    im.ordered === ordered && (ordered ? im.marker.slice(-1) === delim : im.marker === delim);

  const items = [];
  let loose = false;
  let cur = null;
  let curIndent = 0;
  let blankRun = 0;
  let j = start;

  while (j < lines.length) {
    const line = lines[j];
    if (isBlank(line)) {
      blankRun++;
      if (blankRun >= 2) break; // two blank lines end the list
      j++;
      continue;
    }
    const im = matchListItem(line);
    if (im && im.indent === baseIndent && sameKind(im)) {
      if (cur) { items.push(cur); if (blankRun > 0) loose = true; }
      cur = [stripIndent(line, im.contentIndent)];
      curIndent = im.contentIndent;
      blankRun = 0;
      j++;
      continue;
    }
    if (cur && indentOf(line) >= curIndent) {
      if (blankRun > 0) {
        for (let b = 0; b < blankRun; b++) cur.push('');
        loose = true;
      }
      cur.push(stripIndent(line, curIndent));
      blankRun = 0;
      j++;
      continue;
    }
    break; // dedented non-item line: list is over
  }
  if (cur) items.push(cur);

  let startAttr = '';
  if (ordered) {
    const n = parseInt(first.marker, 10);
    if (n !== 1) startAttr = ' start="' + n + '"';
  }
  const tag = ordered ? 'ol' : 'ul';
  const lis = items.map((itemLines) => {
    const t = trimBlankEdges(itemLines);
    let task = null;
    if (t.length) {
      const tm = /^\[( |x|X)\](?:[ \t]+([\s\S]*))?$/.exec(t[0]);
      if (tm) { task = tm[1] !== ' '; t[0] = tm[2] || ''; }
    }
    let inner = t.length ? parseBlocks(t, ctx) : '';
    // Tight list: unwrap the item's own leading paragraph (nested blocks keep theirs).
    if (!loose) inner = inner.replace(/^<p>([\s\S]*?)<\/p>(\n)?/, '$1$2');
    if (task !== null) {
      const box = '<input type="checkbox" disabled' + (task ? ' checked' : '') + '>';
      inner = inner ? box + ' ' + inner : box;
      return '<li class="task-list-item">' + inner + '</li>';
    }
    return '<li>' + inner + '</li>';
  });
  return { html: '<' + tag + startAttr + '>\n' + lis.join('\n') + '\n</' + tag + '>', next: j };
}

function tryList(lines, i, ctx) {
  if (!matchListItem(lines[i])) return null;
  return parseList(lines, i, ctx);
}

/** Split a table row on unescaped pipes, dropping the outer pipes. */
function splitRow(line) {
  let s = line.trim();
  if (s[0] === '|') s = s.slice(1);
  if (s[s.length - 1] === '|' && s[s.length - 2] !== '\\') s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim());
}

function delimAligns(line) {
  const cells = splitRow(line);
  if (!cells.length || !cells.every((c) => /^:?-+:?$/.test(c))) return null;
  return cells.map((c) =>
    c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null);
}

function tryTable(lines, i, ctx) {
  if (i + 1 >= lines.length || !lines[i].includes('|')) return null;
  const aligns = delimAligns(lines[i + 1]);
  if (!aligns) return null;
  const heads = splitRow(lines[i]);
  if (heads.length !== aligns.length) return null; // GFM: counts must match
  const rows = [];
  let j = i + 2;
  while (j < lines.length && !isBlank(lines[j]) && lines[j].includes('|')) {
    rows.push(splitRow(lines[j]));
    j++;
  }
  const cell = (tag, text, align) =>
    '<' + tag + (align ? ' style="text-align:' + align + '"' : '') + '>' + renderInline(text, ctx) + '</' + tag + '>';
  let html = '<div class="table-wrap"><table>\n<thead><tr>' +
    heads.map((h, k) => cell('th', h, aligns[k])).join('') + '</tr></thead>';
  if (rows.length) {
    html += '\n<tbody>\n' + rows.map((r) => {
      const cells = [];
      for (let k = 0; k < heads.length; k++) cells.push(cell('td', r[k] != null ? r[k] : '', aligns[k]));
      return '<tr>' + cells.join('') + '</tr>';
    }).join('\n') + '\n</tbody>';
  }
  html += '\n</table></div>';
  return { html, next: j };
}

/** Block math: $$...$$ on one line or spanning multiple lines. */
function tryMathBlock(lines, i, ctx) {
  const trimmed = lines[i].trim();
  if (!trimmed.startsWith('$$')) return null;
  const rest = trimmed.slice(2);
  const sameLine = rest.indexOf('$$');
  if (sameLine !== -1) {
    ctx.flags.math = true;
    return {
      html: '<div class="math math-display">\\[' + escapeHtml(rest.slice(0, sameLine).trim()) + '\\]</div>',
      next: i + 1,
    };
  }
  const buf = [lines[i].slice(lines[i].indexOf('$$') + 2)];
  let j = i + 1;
  while (j < lines.length) {
    const idx = lines[j].indexOf('$$');
    if (idx !== -1) { buf.push(lines[j].slice(0, idx)); break; }
    buf.push(lines[j]);
    j++;
  }
  ctx.flags.math = true;
  return {
    html: '<div class="math math-display">\\[' + escapeHtml(buf.join('\n').trim()) + '\\]</div>',
    next: j < lines.length ? j + 1 : j,
  };
}

/** Does lines[j] interrupt a paragraph? (HR intentionally excluded — see tryHr.) */
function startsBlock(lines, j) {
  const l = lines[j];
  if (/^ {0,3}(`{3,}|~{3,})/.test(l)) return true;
  if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(l)) return true;
  if (/^ {0,3}>/.test(l)) return true;
  if (matchListItem(l)) return true;
  if (l.trim().startsWith('$$')) return true;
  if (l.includes('|') && j + 1 < lines.length && delimAligns(lines[j + 1])) return true;
  return false;
}

function tryParagraph(lines, i, ctx) {
  const buf = [lines[i]];
  let j = i + 1;
  while (j < lines.length && !isBlank(lines[j]) && !startsBlock(lines, j)) {
    buf.push(lines[j]);
    j++;
  }
  let html = '';
  for (let k = 0; k < buf.length; k++) {
    const hard = / {2,}$/.test(buf[k]) && k < buf.length - 1;
    html += renderInline(buf[k].replace(/[ \t]+$/, ''), ctx);
    if (k < buf.length - 1) html += hard ? '<br>\n' : '\n';
  }
  // A paragraph holding only one image gets a marker class (contract choice).
  const cls = /^!\[[^\]]*\]\([^)]*\)$/.test(buf.join('\n').trim()) ? ' class="img-only"' : '';
  return { html: '<p' + cls + '>' + html + '</p>', next: j };
}

/** Parse an array of source lines into a block-level HTML fragment. */
function parseBlocks(lines, ctx) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (isBlank(lines[i])) { i++; continue; }
    const r =
      tryFence(lines, i, ctx) ||
      tryHeading(lines, i, ctx) ||
      tryHr(lines, i) ||
      tryBlockquote(lines, i, ctx) ||
      tryList(lines, i, ctx) ||
      tryTable(lines, i, ctx) ||
      tryMathBlock(lines, i, ctx) ||
      tryParagraph(lines, i, ctx);
    out.push(r.html);
    i = r.next;
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function parseMarkdown(src, options) {
  const allowAi = !options || options.allowAi !== false;
  const text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
  const { meta, body } = parseFrontmatter(text);
  const { lines, defs } = extractFootnotes(body);
  const ctx = {
    allowAi,
    meta,
    defs,
    toc: [],
    aiBlocks: [],
    flags: { mermaid: false, math: false },
    slugs: new Map(),
    fnOrder: [],
    fnMap: new Map(),
  };
  const parts = [];
  const html = parseBlocks(lines, ctx);
  if (html) parts.push(html);
  if (ctx.fnOrder.length) {
    const items = ctx.fnOrder.map((id) =>
      '<li id="fn-' + escapeAttr(id) + '">' + renderInline(defs.get(id) || '', ctx) +
      ' <a class="footnote-backref" href="#fnref-' + escapeAttr(id) + '">↩</a></li>');
    parts.push('<section class="footnotes"><hr><ol>' + items.join('') + '</ol></section>');
  }
  return {
    html: parts.join('\n'),
    toc: ctx.toc,
    meta,
    flags: ctx.flags,
    aiBlocks: ctx.aiBlocks,
  };
}

module.exports = { parseMarkdown };
