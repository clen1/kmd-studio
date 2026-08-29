'use strict';

/**
 * src/highlight.js — zero-dependency syntax highlighter.
 *
 * highlight(code, lang) -> fully HTML-escaped string with token spans
 * (<span class="tk-kw"> etc.). Unknown languages return escaped plain
 * text with no spans. All tokenizer regexes are linear-time (no nested
 * quantifiers), so adversarial input cannot trigger catastrophic
 * backtracking.
 */

/** Escape the four characters required in element content. */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function span(cls, text) {
  return '<span class="' + cls + '">' + escapeHtml(text) + '</span>';
}

/** Build a sticky regex: always anchored at re.lastIndex. */
function rx(src, flags) {
  return new RegExp(src, 'y' + (flags || ''));
}

/**
 * Scanner: at every position, try each pattern in order; the first hit wins.
 * Gaps between tokens are emitted as escaped plain text.
 * A pattern is { re, cls, group? } — when `group` is set, only that capture
 * group is wrapped in the span (the rest of the match stays plain).
 */
function tokenize(code, patterns) {
  let out = '';
  let plain = '';
  let pos = 0;
  const n = code.length;
  while (pos < n) {
    let hit = null;
    for (let k = 0; k < patterns.length; k++) {
      const p = patterns[k];
      p.re.lastIndex = pos;
      const m = p.re.exec(code);
      if (m && m[0].length > 0) { hit = { p, m }; break; }
    }
    if (!hit) { plain += code[pos]; pos++; continue; }
    out += escapeHtml(plain);
    plain = '';
    const { p, m } = hit;
    if (p.group && m[p.group] != null) {
      const gi = m[0].indexOf(m[p.group]);
      out += escapeHtml(m[0].slice(0, gi));
      out += span(p.cls, m[p.group]);
      out += escapeHtml(m[0].slice(gi + m[p.group].length));
    } else {
      out += span(p.cls, m[0]);
    }
    pos += m[0].length;
  }
  out += escapeHtml(plain);
  return out;
}

/** Build a keyword alternation, longest words first so e.g. `in` never eats `instanceof`. */
function kwPattern(words) {
  const sorted = words.slice().sort((a, b) => b.length - a.length);
  return '\\b(?:' + sorted.join('|') + ')\\b';
}

// Shared token sources (linear-time only: disjoint first chars, no nested quantifiers).
const STR_DQ = String.raw`"(?:[^"\\\n]|\\.)*"`;
const STR_SQ = String.raw`'(?:[^'\\\n]|\\.)*'`;
const STR_BT = String.raw`\x60(?:[^\x60\\]|\\[\s\S])*\x60`;
const NUM = String.raw`\b(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b`;
const FN_CALL = String.raw`[A-Za-z_$][\w$]*(?=[ \t]*\()`;
const OP = String.raw`[+\-*/%=<>!&|^~?]+`;

// ---------------------------------------------------------------------------
// C-family languages (js/ts/java/c/go/rust/...): comments, strings, numbers,
// keywords, function-call names, operators.
// ---------------------------------------------------------------------------

const JS_KW = ('await async break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield get set true false null undefined').split(' ');
const TS_KW = JS_KW.concat('interface type enum namespace abstract readonly implements private public protected declare keyof infer never unknown any string number boolean'.split(' '));
const JAVA_KW = ('abstract boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public record return sealed short static strictfp super switch synchronized this throw throws transient try var void volatile while yield true false null').split(' ');
const C_KW = ('auto bool break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while NULL true false').split(' ');
const CPP_KW = C_KW.concat('class constexpr namespace template typename using new delete this private public protected virtual friend operator noexcept nullptr override final concept requires co_await co_return co_yield'.split(' '));
const GO_KW = ('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil iota').split(' ');
const RUST_KW = ('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while Some None Ok Err i8 i16 i32 i64 u8 u16 u32 u64 f32 f64 bool str String Vec').split(' ');

function cLike(keywords, opts) {
  const strings = opts && opts.backtick ? STR_SQ + '|' + STR_DQ + '|' + STR_BT : STR_SQ + '|' + STR_DQ;
  const patterns = [
    { re: rx(String.raw`//[^\n]*|/\*[\s\S]*?\*/`), cls: 'tk-com' },
    { re: rx(strings), cls: 'tk-str' },
    { re: rx(NUM), cls: 'tk-num' },
    { re: rx(kwPattern(keywords)), cls: 'tk-kw' },
    { re: rx(FN_CALL), cls: 'tk-fn' },
    { re: rx(OP), cls: 'tk-op' },
  ];
  return (code) => tokenize(code, patterns);
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

const JSON_PATTERNS = [
  { re: rx(String.raw`"(?:[^"\\\n]|\\.)*"(?=[ \t]*:)`), cls: 'tk-key' },
  { re: rx(STR_DQ), cls: 'tk-str' },
  { re: rx(String.raw`-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`), cls: 'tk-num' },
  { re: rx(String.raw`\b(?:true|false|null)\b`), cls: 'tk-kw' },
  { re: rx(String.raw`[{}\[\],:]`), cls: 'tk-op' },
];

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const PY_KW = ('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None').split(' ');
const PY_STR = String.raw`[rRbBuUfF]{0,2}(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')`;
const PY_PATTERNS = [
  { re: rx(String.raw`#[^\n]*`), cls: 'tk-com' },
  { re: rx(PY_STR), cls: 'tk-str' },
  { re: rx(NUM), cls: 'tk-num' },
  { re: rx(kwPattern(PY_KW)), cls: 'tk-kw' },
  { re: rx(String.raw`@[A-Za-z_][\w.]*`), cls: 'tk-kw' },
  { re: rx(String.raw`[A-Za-z_][\w]*(?=[ \t]*\()`), cls: 'tk-fn' },
  { re: rx(OP), cls: 'tk-op' },
];

// ---------------------------------------------------------------------------
// Bash
// ---------------------------------------------------------------------------

const BASH_KW = ('if then elif else fi for while until do done case esac in function select return exit local export readonly declare source alias eval exec set unset shift break continue true false echo printf read cd test').split(' ');
const BASH_PATTERNS = [
  { re: rx(String.raw`#[^\n]*`), cls: 'tk-com' },
  { re: rx(STR_SQ + '|' + STR_DQ), cls: 'tk-str' },
  { re: rx(String.raw`\b\d+\b`), cls: 'tk-num' },
  { re: rx(kwPattern(BASH_KW)), cls: 'tk-kw' },
  { re: rx(String.raw`[A-Za-z_][\w.-]*(?=[ \t]*\()`), cls: 'tk-fn' },
  { re: rx(String.raw`[;|&<>]+`), cls: 'tk-op' },
];

// ---------------------------------------------------------------------------
// SQL (case-insensitive keywords)
// ---------------------------------------------------------------------------

const SQL_KW = ('select insert update delete from where join left right inner outer full cross on group by order having limit offset as and or not null in is like between exists union all distinct into values set create table alter drop index view primary key foreign references default unique check constraint add column if else case when then end begin commit rollback transaction asc desc').split(' ');
const SQL_PATTERNS = [
  { re: rx(String.raw`--[^\n]*|/\*[\s\S]*?\*/`), cls: 'tk-com' },
  { re: rx(String.raw`'(?:[^']|'')*'`), cls: 'tk-str' },
  { re: rx(NUM), cls: 'tk-num' },
  { re: rx(kwPattern(SQL_KW), 'i'), cls: 'tk-kw' },
  { re: rx(String.raw`[A-Za-z_][\w]*(?=[ \t]*\()`), cls: 'tk-fn' },
  { re: rx(String.raw`[+\-*/%=<>!();,.]+`), cls: 'tk-op' },
];

// ---------------------------------------------------------------------------
// YAML — line-anchored keys, comments, scalars
// ---------------------------------------------------------------------------

const YAML_PATTERNS = [
  { re: rx(String.raw`#[^\n]*`), cls: 'tk-com' },
  { re: rx(String.raw`^[ \t]*(?:-[ \t]+)?([A-Za-z0-9_.\-]+)(?=[ \t]*:)`, 'm'), cls: 'tk-key', group: 1 },
  { re: rx(STR_DQ + '|' + STR_SQ), cls: 'tk-str' },
  { re: rx(String.raw`\b-?\d+(?:\.\d+)?\b`), cls: 'tk-num' },
  { re: rx(String.raw`\b(?:true|false|null|yes|no|on|off)\b`), cls: 'tk-kw' },
];

// ---------------------------------------------------------------------------
// Markdown — headings, fences, inline code, links, list markers
// ---------------------------------------------------------------------------

const MD_PATTERNS = [
  { re: rx(String.raw`^#{1,6}[^\n]*`, 'm'), cls: 'tk-kw' },
  { re: rx(String.raw`^(?:\x60{3,}|~{3,})[^\n]*`, 'm'), cls: 'tk-com' },
  { re: rx(String.raw`\x60[^\x60\n]+\x60`), cls: 'tk-str' },
  { re: rx(String.raw`!?\[[^\]\n]*\]\([^)\n]*\)`), cls: 'tk-str' },
  { re: rx(String.raw`^[ \t]*(?:[-*+]|\d+\.)`, 'm'), cls: 'tk-op' },
];

// ---------------------------------------------------------------------------
// CSS — split at braces: selectors outside, declarations inside
// ---------------------------------------------------------------------------

const CSS_COMMON = [
  { re: rx(String.raw`/\*[\s\S]*?\*/`), cls: 'tk-com' },
  { re: rx(STR_DQ + '|' + STR_SQ), cls: 'tk-str' },
  { re: rx(String.raw`#[0-9a-fA-F]{3,8}\b`), cls: 'tk-num' },
  { re: rx(String.raw`-?\d+(?:\.\d+)?(?:[a-zA-Z%]+)?`), cls: 'tk-num' },
  { re: rx(String.raw`@[a-zA-Z-]+`), cls: 'tk-kw' },
];
const CSS_SEL = CSS_COMMON.concat([
  { re: rx(String.raw`[.#][\w-]+`), cls: 'tk-tag' },
  { re: rx(String.raw`:[a-zA-Z-]+`), cls: 'tk-attr' },
  { re: rx(String.raw`[>+~*,=]+`), cls: 'tk-op' },
]);
const CSS_DECL = CSS_COMMON.concat([
  { re: rx(String.raw`!important\b`), cls: 'tk-kw' },
  { re: rx(String.raw`[a-zA-Z-]+(?=[ \t]*:)`), cls: 'tk-attr' },
  { re: rx(String.raw`[:;(),]+`), cls: 'tk-op' },
]);

function highlightCss(code) {
  const parts = code.split(/([{}])/);
  let depth = 0;
  let out = '';
  for (const part of parts) {
    if (part === '{') { out += span('tk-op', '{'); depth++; }
    else if (part === '}') { out += span('tk-op', '}'); if (depth > 0) depth--; }
    else out += tokenize(part, depth > 0 ? CSS_DECL : CSS_SEL);
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTML / XML — small state machine over tags
// ---------------------------------------------------------------------------

function highlightTag(tag) {
  // Doctype, comments-without-close, processing instructions.
  if (/^<[?!]/.test(tag)) return span('tk-com', tag);
  let out = '';
  let i = 0;
  const m = /^<\/?[A-Za-z][\w:.-]*/.exec(tag);
  if (m) { out += span('tk-tag', m[0]); i = m[0].length; }
  let expectValue = false;
  while (i < tag.length) {
    const rest = tag.slice(i);
    let t;
    if ((t = /^\/?>/.exec(rest))) { out += span('tk-tag', t[0]); i += t[0].length; expectValue = false; }
    else if ((t = /^\s+/.exec(rest))) { out += escapeHtml(t[0]); i += t[0].length; }
    else if ((t = /^=/.exec(rest))) { out += span('tk-op', '='); i += 1; expectValue = true; }
    else if ((t = /^"[^"]*"|^'[^']*'/.exec(rest))) { out += span('tk-val', t[0]); i += t[0].length; expectValue = false; }
    else if (expectValue && (t = /^[^\s>]+/.exec(rest))) { out += span('tk-val', t[0]); i += t[0].length; expectValue = false; }
    else if ((t = /^[^\s>=]+/.exec(rest))) { out += span('tk-attr', t[0]); i += t[0].length; }
  }
  return out;
}

function highlightMarkup(code) {
  let out = '';
  let pos = 0;
  const n = code.length;
  while (pos < n) {
    const lt = code.indexOf('<', pos);
    if (lt === -1) { out += escapeHtml(code.slice(pos)); break; }
    out += escapeHtml(code.slice(pos, lt));
    // A '<' not starting a tag name is plain text.
    if (!/[A-Za-z!?/]/.test(code[lt + 1] || '')) { out += escapeHtml('<'); pos = lt + 1; continue; }
    if (code.startsWith('<!--', lt)) {
      const end = code.indexOf('-->', lt + 4);
      const stop = end === -1 ? n : end + 3;
      out += span('tk-com', code.slice(lt, stop));
      pos = stop;
      continue;
    }
    // Find the closing '>' while skipping quoted attribute values.
    let i = lt + 1;
    let q = null;
    let gt = -1;
    while (i < n) {
      const ch = code[i];
      if (q) { if (ch === q) q = null; }
      else if (ch === '"' || ch === "'") q = ch;
      else if (ch === '>') { gt = i; break; }
      i++;
    }
    if (gt === -1) { out += escapeHtml(code.slice(lt)); break; }
    out += highlightTag(code.slice(lt, gt + 1));
    pos = gt + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Diff — whole-line classes
// ---------------------------------------------------------------------------

function highlightDiff(code) {
  return code.split('\n').map((line) => {
    let cls = null;
    if (/^@@/.test(line)) cls = 'tk-fn';
    else if (/^(diff |index |--- |\+\+\+ )/.test(line)) cls = 'tk-com';
    else if (line[0] === '+') cls = 'tk-add';
    else if (line[0] === '-') cls = 'tk-del';
    return cls ? span(cls, line) : escapeHtml(line);
  }).join('\n');
}

// ---------------------------------------------------------------------------
// Language registry (aliases share one implementation)
// ---------------------------------------------------------------------------

const jsImpl = cLike(JS_KW, { backtick: true });
const tsImpl = cLike(TS_KW, { backtick: true });
const bashImpl = (code) => tokenize(code, BASH_PATTERNS);
const pyImpl = (code) => tokenize(code, PY_PATTERNS);
const yamlImpl = (code) => tokenize(code, YAML_PATTERNS);

const LANGS = {
  js: jsImpl, jsx: jsImpl,
  ts: tsImpl, tsx: tsImpl,
  json: (code) => tokenize(code, JSON_PATTERNS),
  bash: bashImpl, sh: bashImpl,
  python: pyImpl, py: pyImpl,
  html: highlightMarkup, xml: highlightMarkup,
  css: highlightCss,
  yaml: yamlImpl, yml: yamlImpl,
  md: (code) => tokenize(code, MD_PATTERNS),
  sql: (code) => tokenize(code, SQL_PATTERNS),
  go: cLike(GO_KW, { backtick: true }),
  rust: cLike(RUST_KW),
  c: cLike(C_KW),
  cpp: cLike(CPP_KW),
  java: cLike(JAVA_KW),
  diff: highlightDiff,
};

/**
 * highlight(code, lang) -> HTML string, fully escaped.
 * Unknown / missing language -> escaped plain text, no spans.
 */
function highlight(code, lang) {
  code = String(code == null ? '' : code);
  const key = String(lang || '').toLowerCase().trim();
  const impl = LANGS[key];
  if (!impl) return escapeHtml(code);
  try {
    return impl(code);
  } catch {
    // Never throw on rendering paths — degrade to plain escaped text.
    return escapeHtml(code);
  }
}

module.exports = { highlight };
