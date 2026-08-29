'use strict';

/* ==========================================================================
   KMD Studio — single-page IDE frontend (vanilla JS, no dependencies).
   Talks to the local studio server API (see docs/studio-contract.md).
   All UI strings are Chinese; comments in English per project convention.
   ========================================================================== */

/* ------------------------------------------------------------ auth ------ */

// Read the session token from the launch URL once, then strip it so it does
// not linger in the visible URL / history.
const TOKEN = (() => {
  const params = new URLSearchParams(location.search);
  const k = params.get('k') || '';
  params.delete('k');
  const qs = params.toString();
  history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  return k;
})();

/* ------------------------------------------------------------ theme ----- */

function initTheme() {
  const saved = localStorage.getItem('kmd-studio-theme');
  const theme =
    saved === 'light' || saved === 'dark'
      ? saved
      : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('kmd-studio-theme', next);
  updateThemeIcon();
}

/* --------------------------------------------------------- DOM helper --- */

// Minimal hyperscript helper: h('div', { class: 'x', onclick: fn }, kids...)
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v; // trusted, constant SVG markup only
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

/* -------------------------------------------------------------- icons --- */

const svgWrap = (inner, vb = '0 0 16 16') =>
  `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

const ICONS = {
  folder: svgWrap('<path fill="currentColor" stroke="none" d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3l1.5 2H13a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5v-8z" opacity="0.9"/>'),
  doc: svgWrap('<path d="M4 1.5h5.5L12.5 4.5v10h-8.5z"/><path d="M9 1.5v3h3.5"/>'),
  chevron: svgWrap('<path d="M6 4l4 4-4 4"/>'),
  refresh: svgWrap('<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2v3h-3"/>'),
  drive: svgWrap('<rect x="1.5" y="4.5" width="13" height="7" rx="1.5"/><path d="M11 8.5h1"/>'),
  sun: svgWrap('<circle cx="8" cy="8" r="3.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"/>'),
  moon: svgWrap('<path d="M13.5 9.5A5.8 5.8 0 0 1 6.5 2.5a5.8 5.8 0 1 0 7 7z"/>'),
  image: svgWrap('<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><circle cx="5.5" cy="6.5" r="1.2"/><path d="M2 12l3.5-3.5 2.5 2.5 3-3L14 11"/>'),
};

// App logo mark — same artwork as favicon.svg (rounded-square gradient + ✦).
function logoSvg(size, gradId) {
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true">` +
    `<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#8b5cf6"/>` +
    `</linearGradient></defs>` +
    `<rect width="64" height="64" rx="14" fill="url(#${gradId})"/>` +
    `<path fill="#ffffff" d="M32 12l5.2 14.8L52 32l-14.8 5.2L32 52l-5.2-14.8L12 32l14.8-5.2z"/>` +
    `</svg>`
  );
}

/* ------------------------------------------------------- API transport --- */

// One helper for every /api/* call: JSON in/out, token header, uniform
// error handling. Throws on failure; network errors are toasted here once.
async function api(path, opts = {}) {
  const { method = 'GET', body, quiet = false } = opts;
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: {
        'X-KMD-Token': TOKEN,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    e.isNetwork = true;
    if (!quiet) toast('网络错误，无法连接服务器', 'error');
    throw e;
  }
  if (res.status === 401) {
    showFatal();
    throw new Error('会话失效');
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `请求失败（HTTP ${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Toast for API errors thrown by api(); network errors were already toasted.
function reportErr(e) {
  if (e && e.isNetwork) return;
  toast((e && e.message) || '操作失败', 'error');
}

/* -------------------------------------------------------------- toasts --- */

let elsToasts = null;

function toast(msg, type = 'info') {
  if (!elsToasts) return;
  const el = h('div', { class: `toast ${type}`, role: 'status' }, msg);
  elsToasts.append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 280);
  }, 3500);
}

/* ------------------------------------------------------- fatal overlay --- */

let fatalShown = false;
function showFatal() {
  if (fatalShown) return;
  fatalShown = true;
  els.fatalOverlay.classList.remove('hidden');
}

/* --------------------------------------------------- token count (copy) ---
   Client-side copy of the countTokens heuristic: CJK chars count 1 each,
   everything else counts ceil(n/4). */
const CJK_RE = /[㐀-鿿豈-﫿　-〿＀-￯]/;

function countTokens(text) {
  let cjk = 0;
  let rest = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++;
    else rest++;
  }
  return cjk + Math.ceil(rest / 4);
}

function fmtTokens(n) {
  return `${n.toLocaleString('en-US')} tokens`;
}

/* -------------------------------------------------------- global state --- */

const state = {
  provider: { hasKey: false, model: '', baseUrl: '' },
  project: null,            // { path, name } | null
  currentRel: null,         // rel path of the open document
  dirty: false,
  saveTimer: null,
  building: false,
  aiBusy: false,
  hasBuilt: false,          // a build succeeded in this session
  currentPreviewPath: null, // last preview pathname, e.g. /preview/guide.html
  lastGoodPreviewSrc: null, // last iframe src that loaded a real HTML page
  collapsed: new Set(),     // rel paths of collapsed tree dirs (per session)
};

const els = {}; // central registry of DOM refs, filled by buildDom()

/* ============================================================ DOM ======== */

function buildDom() {
  const app = document.getElementById('app');

  /* ------------------------------ home screen -------------------------- */
  els.aiChip = h('button', { class: 'chip off', id: 'ai-chip', onclick: onChipClick });
  els.recentsList = h('div', { id: 'recents-list' });
  els.screenHome = h(
    'section',
    { class: 'screen', id: 'screen-home' },
    h(
      'div',
      { class: 'home-card' },
      h('div', { class: 'home-logo', html: logoSvg(56, 'logo-grad-home') }),
      h('h1', { class: 'home-title' }, 'KMD Studio'),
      h('p', { class: 'tagline' }, 'AI 时代的 Markdown 工作台'),
      els.aiChip,
      h(
        'div',
        { class: 'home-actions' },
        h('button', { class: 'btn primary big', onclick: () => openFolderBrowser('open') }, '打开项目…'),
        h('button', { class: 'btn big', onclick: () => openFolderBrowser('create') }, '新建项目…')
      ),
      h('div', { class: 'recents' }, h('div', { class: 'recents-title' }, '最近项目'), els.recentsList)
    )
  );

  /* --------------------------- workspace screen ------------------------ */
  els.tbProject = h('span', { class: 'tb-project' });
  els.tbFile = h('div', { class: 'tb-file', id: 'tb-file' });
  els.tbTokens = h('span', { class: 'token-badge' }, fmtTokens(0));
  els.btnBuild = h(
    'button',
    { class: 'btn', title: '构建站点', onclick: () => runBuild(true) },
    '⟳ 构建'
  );
  els.btnAi = h('button', { class: 'btn', onclick: onAiButtonClick });
  els.aiMenu = h(
    'div',
    { class: 'menu hidden' },
    h('button', { class: 'menu-item', 'data-action': 'polish', onclick: () => onAiAction('polish') }, '润色'),
    h('button', { class: 'menu-item', 'data-action': 'continue', onclick: () => onAiAction('continue') }, '续写'),
    h('button', { class: 'menu-item', 'data-action': 'translate-en', onclick: () => onAiAction('translate-en') }, '翻译成英文'),
    h('button', { class: 'menu-item', 'data-action': 'summarize', onclick: () => onAiAction('summarize') }, '总结要点')
  );
  els.aiDropdown = h('div', { class: 'dropdown' }, els.btnAi, els.aiMenu);
  els.btnTheme = h('button', { class: 'btn icon', title: '切换主题', onclick: toggleTheme });

  els.treeBody = h('div', { id: 'tree-body' });
  els.saveStatus = h('span', { id: 'save-status' });
  els.editor = h('textarea', {
    id: 'editor',
    spellcheck: 'false',
    placeholder: '在此编写 Markdown…',
    'aria-label': 'Markdown 编辑器',
  });
  els.editorEmpty = h(
    'div',
    { class: 'editor-empty' },
    h('span', null, '在左侧选择文档开始编辑'),
    h('button', { class: 'btn', onclick: newDoc }, '新建文档')
  );
  els.preview = h('iframe', { id: 'preview', title: '预览', class: 'hidden' });
  els.previewPlaceholder = h(
    'div',
    { id: 'preview-placeholder' },
    h('span', { class: 'ph-icon', html: ICON_IMAGE_LARGE }),
    h('span', null, '还没有构建产物'),
    h('button', { class: 'btn primary', onclick: () => runBuild(true) }, '点击构建')
  );

  const toolbar = h(
    'div',
    { class: 'editor-toolbar' },
    EDITOR_TOOLS.map((t) =>
      h('button', { class: 'tb-btn', title: t.title, onclick: t.run }, t.label)
    ),
    h('span', { class: 'toolbar-spacer' }),
    els.saveStatus
  );

  els.splitDivider = h('div', { id: 'split-divider', role: 'separator', 'aria-orientation': 'vertical' });
  els.split = h(
    'div',
    { class: 'split', id: 'split' },
    h(
      'div',
      { class: 'pane editor-pane' },
      toolbar,
      h('div', { class: 'editor-wrap' }, els.editor, els.editorEmpty)
    ),
    els.splitDivider,
    h('div', { class: 'pane preview-pane' }, els.preview, els.previewPlaceholder)
  );

  els.screenWorkspace = h(
    'section',
    { class: 'screen hidden', id: 'screen-workspace' },
    h(
      'header',
      { id: 'topbar' },
      h(
        'div',
        { class: 'tb-brand' },
        h('span', { class: 'tb-logo', html: logoSvg(22, 'logo-grad-tb') }),
        els.tbProject
      ),
      els.tbFile,
      h('div', { class: 'tb-spacer' }),
      els.tbTokens,
      h('button', { class: 'btn', onclick: newDoc }, '新建文档'),
      els.btnBuild,
      els.aiDropdown,
      els.btnTheme,
      h('button', { class: 'btn danger', title: '退出 KMD Studio', onclick: quitApp }, '✕ 退出')
    ),
    h(
      'div',
      { class: 'ws-main' },
      h(
        'aside',
        { id: 'file-tree' },
        h(
          'div',
          { class: 'tree-header' },
          h('span', { class: 'tree-title' }, '文档'),
          h('button', { class: 'icon-btn', title: '刷新', html: ICONS.refresh, onclick: refreshTree })
        ),
        els.treeBody
      ),
      els.split
    )
  );

  /* ------------------------------ modals ------------------------------- */
  buildFolderBrowser();
  buildAiSetupModal();

  els.fatalOverlay = h(
    'div',
    { class: 'modal-overlay fatal-overlay hidden' },
    h(
      'div',
      { class: 'modal fatal-card' },
      h('div', { class: 'fatal-title' }, '会话失效'),
      h('p', null, '与 KMD Studio 服务器的连接已失效，请重新启动应用。')
    )
  );

  elsToasts = h('div', { id: 'toasts' });

  app.append(els.screenHome, els.screenWorkspace, els.fbModal, els.setupModal, els.fatalOverlay, elsToasts);

  wireGlobalEvents();
  initSplit();
  updateThemeIcon();
  renderAiControls();
}

const ICON_IMAGE_LARGE =
  '<svg width="44" height="44" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><circle cx="5.5" cy="6.5" r="1.2"/><path d="M2 12l3.5-3.5 2.5 2.5 3-3L14 11"/></svg>';

/* ------------------------------------------------------- global events --- */

function wireGlobalEvents() {
  // Editor behaviors: dirty tracking, Tab -> 2 spaces, Ctrl/Cmd+S -> save.
  els.editor.addEventListener('input', onEditorInput);
  els.editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      els.editor.setRangeText('  ', els.editor.selectionStart, els.editor.selectionEnd, 'end');
      onEditorInput();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveNow();
    }
  });

  // Close the AI dropdown when clicking anywhere else.
  document.addEventListener('click', (e) => {
    if (!els.aiDropdown.contains(e.target)) els.aiMenu.classList.add('hidden');
  });

  // Esc closes dropdown and dismissible modals.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    els.aiMenu.classList.add('hidden');
    closeModal(els.fbModal);
    closeModal(els.setupModal);
  });

  // Track the real preview location (user may follow links inside the
  // iframe) and guard against non-HTML responses (e.g. JSON 404 pages):
  // keep the last good page instead of replacing it with an error blob.
  els.preview.addEventListener('load', () => {
    const iframe = els.preview;
    let loc = null;
    let ct = null;
    try {
      loc = iframe.contentWindow && iframe.contentWindow.location;
      ct = iframe.contentDocument && iframe.contentDocument.contentType;
    } catch {
      return;
    }
    if (ct && ct.indexOf('text/html') !== 0) {
      if (state.lastGoodPreviewSrc && iframe.src !== state.lastGoodPreviewSrc) {
        iframe.src = state.lastGoodPreviewSrc;
      }
      return;
    }
    if (loc && loc.pathname && loc.pathname.indexOf('/preview/') === 0) {
      state.currentPreviewPath = loc.pathname;
    }
    state.lastGoodPreviewSrc = iframe.src;
  });
  els.preview.addEventListener('error', () => {
    if (state.lastGoodPreviewSrc && els.preview.src !== state.lastGoodPreviewSrc) {
      els.preview.src = state.lastGoodPreviewSrc;
    }
  });
}

/* --------------------------------------------------------- modals ------- */

function openModal(el) {
  el.classList.remove('hidden');
}
function closeModal(el) {
  el.classList.add('hidden');
}
// Click on the dimmed backdrop (not the dialog itself) closes the modal.
function backdropClose(el) {
  el.addEventListener('mousedown', (e) => {
    if (e.target === el) closeModal(el);
  });
}

/* ======================================================== HOME =========== */

function onChipClick() {
  if (!state.provider.hasKey) openModal(els.setupModal);
}

function renderProviderChip() {
  const p = state.provider;
  els.aiChip.classList.toggle('ok', !!p.hasKey);
  els.aiChip.classList.toggle('off', !p.hasKey);
  els.aiChip.innerHTML = '';
  els.aiChip.append(
    h('span', { class: 'chip-dot' }),
    h('span', null, p.hasKey ? `AI 已连接 · ${p.model}` : 'AI 未配置')
  );
  els.aiChip.title = p.hasKey ? p.baseUrl || '' : '点击了解如何配置 AI 服务';
}

function renderRecents(recents) {
  els.recentsList.innerHTML = '';
  if (!recents || !recents.length) {
    els.recentsList.append(h('div', { class: 'recents-empty' }, '暂无最近项目'));
    return;
  }
  for (const r of recents) {
    els.recentsList.append(
      h(
        'button',
        { class: 'recent-row', title: r.path, onclick: () => openProject(r.path) },
        h('span', { class: 'recent-name' }, r.name),
        h('span', { class: 'recent-path' }, r.path)
      )
    );
  }
}

async function openProject(path) {
  try {
    const data = await api('/api/project/open', { method: 'POST', body: { path } });
    enterWorkspace(data.project);
  } catch (e) {
    reportErr(e);
  }
}

/* ================================================== FOLDER BROWSER ======= */

const fb = { mode: 'open', path: null, seq: 0 };

function buildFolderBrowser() {
  els.fbTitle = h('div', { class: 'modal-title' });
  els.fbBreadcrumb = h('div', { class: 'breadcrumb' });
  els.fbRows = h('div', { class: 'fb-rows' });
  els.fbError = h('div', { class: 'modal-error' });
  els.fbPath = h('div', { class: 'fb-path' });
  els.fbName = h('input', { class: 'input hidden', placeholder: '项目名称', maxlength: '80' });
  els.fbSubmit = h('button', { class: 'btn primary', onclick: fbSubmit });
  els.fbModal = h(
    'div',
    { class: 'modal-overlay hidden' },
    h(
      'div',
      { class: 'modal fb-dialog' },
      els.fbTitle,
      els.fbBreadcrumb,
      els.fbRows,
      els.fbError,
      h(
        'div',
        { class: 'fb-footer' },
        els.fbPath,
        h(
          'div',
          { class: 'fb-actions' },
          els.fbName,
          h('button', { class: 'btn', onclick: () => closeModal(els.fbModal) }, '取消'),
          els.fbSubmit
        )
      )
    )
  );
  backdropClose(els.fbModal);
  els.fbName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') fbSubmit();
  });
}

function openFolderBrowser(mode) {
  fb.mode = mode;
  els.fbTitle.textContent = mode === 'open' ? '打开项目文件夹' : '新建项目';
  els.fbSubmit.textContent = mode === 'open' ? '选择此文件夹' : '在此新建';
  els.fbName.classList.toggle('hidden', mode !== 'create');
  els.fbName.value = '';
  openModal(els.fbModal);
  fbNavigate(null);
}

// Load roots (drives) when path is null, else the directory listing.
async function fbNavigate(path) {
  fb.path = path;
  fb.seq += 1;
  const seq = fb.seq;
  setFbError('');
  renderFbChrome();
  els.fbRows.innerHTML = '';
  els.fbRows.append(h('div', { class: 'fb-hint' }, '加载中…'));
  try {
    const data = await api('/api/fs/list' + (path ? `?path=${encodeURIComponent(path)}` : ''));
    if (seq !== fb.seq) return; // a newer navigation superseded this one
    els.fbRows.innerHTML = '';
    if (data.drives) {
      fb.path = null;
      for (const d of data.drives) {
        els.fbRows.append(
          h(
            'button',
            { class: 'fb-row', onclick: () => fbNavigate(d) },
            h('span', { class: 'fb-row-icon', html: ICONS.drive }),
            d
          )
        );
      }
      if (!data.drives.length) els.fbRows.append(h('div', { class: 'fb-hint' }, '未发现可用磁盘'));
    } else {
      fb.path = data.path;
      const dirs = data.dirs || [];
      if (!dirs.length) {
        els.fbRows.append(h('div', { class: 'fb-hint' }, '此文件夹没有子文件夹'));
      }
      for (const d of dirs) {
        els.fbRows.append(
          h(
            'button',
            { class: 'fb-row', title: d.path, onclick: () => fbNavigate(d.path) },
            h('span', { class: 'fb-row-icon', html: ICONS.folder }),
            d.name
          )
        );
      }
    }
  } catch (e) {
    if (seq !== fb.seq) return;
    els.fbRows.innerHTML = '';
    els.fbRows.append(h('div', { class: 'fb-hint' }, '无法读取此位置'));
    setFbError(e.message || '读取失败');
  }
  renderFbChrome();
}

// Breadcrumb + footer reflect fb.path (null = drive roots view).
function renderFbChrome() {
  els.fbBreadcrumb.innerHTML = '';
  els.fbBreadcrumb.append(
    h('button', { class: `crumb${fb.path ? '' : ' current'}`, onclick: () => fbNavigate(null) }, '此电脑')
  );
  if (fb.path) {
    const segs = fb.path.split(/[\\/]+/).filter(Boolean);
    segs.forEach((seg, i) => {
      const target = i === 0 ? `${seg}\\` : segs.slice(0, i + 1).join('\\');
      const isLast = i === segs.length - 1;
      els.fbBreadcrumb.append(
        h('span', { class: 'crumb-sep' }, '›'),
        h(
          'button',
          { class: `crumb${isLast ? ' current' : ''}`, onclick: () => fbNavigate(target) },
          i === 0 ? `${seg}\\` : seg
        )
      );
    });
  }
  els.fbPath.textContent = fb.path || '请选择磁盘';
  els.fbPath.title = fb.path || '';
  els.fbSubmit.disabled = !fb.path;
}

function setFbError(msg) {
  els.fbError.textContent = msg || '';
}

async function fbSubmit() {
  if (!fb.path) return;
  if (fb.mode === 'open') {
    try {
      const data = await api('/api/project/open', { method: 'POST', body: { path: fb.path } });
      closeModal(els.fbModal);
      enterWorkspace(data.project);
    } catch (e) {
      setFbError(e.message || '打开失败');
    }
    return;
  }
  // create mode
  const name = els.fbName.value.trim();
  if (!name) {
    setFbError('请输入项目名称');
    return;
  }
  if (/[\\/:*?"<>|]/.test(name)) {
    setFbError('项目名称不能包含 \\ / : * ? " < > | 字符');
    return;
  }
  const base = fb.path;
  const path = /[\\/]$/.test(base) ? base + name : `${base}\\${name}`;
  try {
    const data = await api('/api/project/create', { method: 'POST', body: { path } });
    closeModal(els.fbModal);
    enterWorkspace(data.project);
  } catch (e) {
    setFbError(e.message || '创建失败');
  }
}

/* ================================================== AI SETUP MODAL ======= */

const AI_COMMANDS = [
  {
    title: 'Windows cmd',
    cmd: 'set KMD_AI_API_KEY=sk-你的密钥\nset KMD_AI_BASE_URL=https://api.moonshot.cn/v1\nset KMD_AI_MODEL=kimi-k2-0905-preview',
  },
  {
    title: 'PowerShell',
    cmd: '$env:KMD_AI_API_KEY="sk-你的密钥"\n$env:KMD_AI_BASE_URL="https://api.moonshot.cn/v1"\n$env:KMD_AI_MODEL="kimi-k2-0905-preview"',
  },
  {
    title: 'bash',
    cmd: 'export KMD_AI_API_KEY=sk-你的密钥\nexport KMD_AI_BASE_URL=https://api.moonshot.cn/v1\nexport KMD_AI_MODEL=kimi-k2-0905-preview',
  },
];

function buildAiSetupModal() {
  els.setupModal = h(
    'div',
    { class: 'modal-overlay hidden' },
    h(
      'div',
      { class: 'modal' },
      h('div', { class: 'modal-title' }, '配置 AI 服务'),
      h(
        'p',
        { class: 'modal-desc' },
        'KMD 通过环境变量连接兼容 OpenAI 的接口。请在启动 KMD Studio 的终端中设置以下变量，然后重启应用：'
      ),
      h(
        'ul',
        { class: 'setup-list' },
        h('li', null, h('code', null, 'KMD_AI_API_KEY'), '（必填）API 密钥'),
        h('li', null, h('code', null, 'KMD_AI_BASE_URL'), '（可选）接口地址，默认 https://api.moonshot.cn/v1'),
        h('li', null, h('code', null, 'KMD_AI_MODEL'), '（可选）模型名，默认 kimi-k2-0905-preview')
      ),
      AI_COMMANDS.map((b) =>
        h(
          'div',
          { class: 'setup-block' },
          h(
            'div',
            { class: 'setup-cmd-head' },
            h('span', { class: 'setup-cmd-title' }, b.title),
            h('button', { class: 'copy-btn', onclick: () => copyText(b.cmd) }, '复制')
          ),
          h('pre', { class: 'cmd' }, b.cmd)
        )
      ),
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { class: 'btn primary', onclick: () => closeModal(els.setupModal) }, '知道了')
      )
    )
  );
  backdropClose(els.setupModal);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板', 'success');
  } catch {
    // Fallback for environments without the async clipboard API.
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }, text);
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast('已复制到剪贴板', 'success');
    } catch {
      toast('复制失败，请手动选择复制', 'error');
    }
    ta.remove();
  }
}

/* ===================================================== WORKSPACE ========= */

function enterWorkspace(project) {
  state.project = project;
  state.hasBuilt = false;
  state.currentPreviewPath = null;
  state.lastGoodPreviewSrc = null;
  els.tbProject.textContent = project.name;
  document.title = `${project.name} — KMD Studio`;
  closeEditor();
  els.preview.classList.add('hidden');
  els.preview.src = 'about:blank';
  els.previewPlaceholder.classList.remove('hidden');
  els.screenHome.classList.add('hidden');
  els.screenWorkspace.classList.remove('hidden');
  refreshTree();
  // Quiet build on entry so the preview is never stale.
  runBuild(false);
}

/* ------------------------------- file tree ------------------------------ */

async function refreshTree() {
  try {
    const data = await api('/api/files');
    renderTree(data.tree || []);
  } catch (e) {
    reportErr(e);
  }
}

function renderTree(nodes) {
  els.treeBody.innerHTML = '';
  if (!nodes.length) {
    els.treeBody.append(
      h(
        'div',
        { class: 'tree-empty' },
        h('div', null, '项目中还没有 Markdown 文档'),
        h('button', { class: 'btn', onclick: newDoc }, '新建文档')
      )
    );
    return;
  }
  for (const node of nodes) els.treeBody.append(renderTreeNode(node, 0));
}

function renderTreeNode(node, depth) {
  const wrap = h('div', null);
  if (node.type === 'dir') {
    const open = !state.collapsed.has(node.rel);
    const chevron = h('span', { class: `tree-chevron${open ? ' open' : ''}`, html: ICONS.chevron });
    const children = h('div', { class: `tree-children${open ? '' : ' collapsed'}` });
    const row = h(
      'button',
      {
        class: 'tree-row',
        style: `padding-left:${6 + depth * 14}px`,
        onclick: () => {
          if (state.collapsed.has(node.rel)) state.collapsed.delete(node.rel);
          else state.collapsed.add(node.rel);
          const nowOpen = !state.collapsed.has(node.rel);
          chevron.classList.toggle('open', nowOpen);
          children.classList.toggle('collapsed', !nowOpen);
        },
      },
      chevron,
      h('span', { class: 'tree-icon folder', html: ICONS.folder }),
      h('span', { class: 'tree-name' }, node.name)
    );
    wrap.append(row, children);
    for (const c of node.children || []) children.append(renderTreeNode(c, depth + 1));
    return wrap;
  }
  // file row: doc icon + name + hover rename/delete actions
  wrap.append(
    h(
      'button',
      {
        class: `tree-row${node.rel === state.currentRel ? ' active' : ''}`,
        style: `padding-left:${6 + depth * 14}px`,
        title: node.rel,
        onclick: () => openFile(node.rel),
      },
      h('span', { class: 'tree-chevron spacer', html: ICONS.chevron }),
      h('span', { class: 'tree-icon', html: ICONS.doc }),
      h('span', { class: 'tree-name' }, node.name),
      h(
        'span',
        { class: 'tree-actions' },
        h(
          'span',
          {
            class: 'tree-action',
            title: '重命名',
            onclick: (e) => {
              e.stopPropagation();
              renameFile(node);
            },
          },
          '✎'
        ),
        h(
          'span',
          {
            class: 'tree-action',
            title: '删除',
            onclick: (e) => {
              e.stopPropagation();
              deleteFile(node);
            },
          },
          '🗑'
        )
      )
    )
  );
  return wrap;
}

/* ------------------------------- documents ------------------------------ */

async function newDoc() {
  const input = prompt('新建文档（相对项目根目录的路径，以 .md 结尾）：', 'untitled.md');
  if (input == null) return;
  const rel = input.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel) return;
  if (!/\.md$/i.test(rel)) {
    toast('文档路径必须以 .md 结尾', 'error');
    return;
  }
  try {
    await api('/api/file/new', { method: 'POST', body: { path: rel } });
    await refreshTree();
    await openFile(rel);
    toast(`已创建 ${rel}`, 'success');
  } catch (e) {
    reportErr(e);
  }
}

/* ---------------------------- hash deep-linking ---------------------------
   Keep the URL hash pointing at the open doc (#/file/<rel>) so a refresh
   restores it. replaceState only — no navigation, no hashchange loop. */
function setFileHash(rel) {
  if (rel) {
    const encoded = rel.split('/').map(encodeURIComponent).join('/');
    history.replaceState(null, '', `#/file/${encoded}`);
  } else {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

function fileHashRel() {
  const m = location.hash.match(/^#\/file\/(.+)$/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

async function openFile(rel, opts = {}) {
  if (rel === state.currentRel) return true;
  if (state.dirty && state.currentRel) await saveNow(); // flush pending edits
  try {
    const data = await api(`/api/file?path=${encodeURIComponent(rel)}`);
    state.currentRel = rel;
    state.dirty = false;
    clearTimeout(state.saveTimer);
    els.editor.value = data.content;
    els.tbFile.textContent = rel;
    els.editorEmpty.classList.add('hidden');
    setSaveStatus('saved');
    updateTokenBadge();
    markTreeActive();
    setFileHash(rel);
    if (state.hasBuilt) setPreviewPath(`/preview/${rel.replace(/\.md$/, '.html')}`);
    els.editor.focus();
    return true;
  } catch (e) {
    if (!opts.silent) reportErr(e);
    return false;
  }
}

function closeEditor() {
  clearTimeout(state.saveTimer);
  state.currentRel = null;
  state.dirty = false;
  els.editor.value = '';
  els.tbFile.textContent = '';
  setSaveStatus('');
  updateTokenBadge();
  els.editorEmpty.classList.remove('hidden');
  markTreeActive();
  setFileHash(null);
}

function markTreeActive() {
  // File rows carry a title attr (their rel path); dir rows do not.
  els.treeBody.querySelectorAll('.tree-row[title]').forEach((row) => {
    row.classList.toggle('active', row.title === state.currentRel);
  });
}

async function renameFile(node) {
  const input = prompt('重命名为：', node.name);
  if (input == null) return;
  const name = input.trim();
  if (!name || name === node.name) return;
  if (/[\\/:*?"<>|]/.test(name) || !/\.md$/i.test(name)) {
    toast('名称无效：需以 .md 结尾，且不能包含 \\ / : * ? " < > |', 'error');
    return;
  }
  const idx = node.rel.lastIndexOf('/');
  const to = (idx >= 0 ? node.rel.slice(0, idx + 1) : '') + name;
  try {
    await api('/api/file/rename', { method: 'POST', body: { from: node.rel, to } });
    if (state.currentRel === node.rel) {
      state.currentRel = to;
      els.tbFile.textContent = to;
      setFileHash(to); // keep the deep link valid after a rename
    }
    toast('已重命名', 'success');
    refreshTree();
  } catch (e) {
    reportErr(e);
  }
}

async function deleteFile(node) {
  if (!confirm(`确定删除 ${node.rel} 吗？此操作不可撤销。`)) return;
  try {
    await api('/api/file/delete', { method: 'POST', body: { path: node.rel } });
    if (state.currentRel === node.rel) closeEditor();
    toast('已删除', 'success');
    refreshTree();
  } catch (e) {
    reportErr(e);
  }
}

/* --------------------------------- editor -------------------------------- */

function updateTokenBadge() {
  els.tbTokens.textContent = fmtTokens(countTokens(els.editor.value));
}

function setSaveStatus(kind) {
  const map = {
    '': ['', ''],
    dirty: ['未保存', 'dirty'],
    saving: ['保存中…', 'saving'],
    saved: ['已保存 ✓', 'saved'],
  };
  const [text, cls] = map[kind] || map[''];
  els.saveStatus.textContent = text;
  els.saveStatus.className = cls;
}

function onEditorInput() {
  if (!state.currentRel) return;
  state.dirty = true;
  updateTokenBadge();
  setSaveStatus('dirty');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNow, 800); // autosave debounce
}

async function saveNow() {
  if (!state.currentRel) return;
  clearTimeout(state.saveTimer);
  setSaveStatus('saving');
  try {
    await api('/api/file', {
      method: 'POST',
      body: { path: state.currentRel, content: els.editor.value },
    });
    state.dirty = false;
    setSaveStatus('saved');
    autoBuild();
  } catch (e) {
    setSaveStatus('dirty');
    reportErr(e);
  }
}

// Wrap the current textarea selection with before/after markers; when the
// selection is empty, insert the placeholder text and select it for quick
// overwrite. All toolbar formatting goes through this one helper.
function wrapSelection(before, after, placeholder) {
  if (!state.currentRel) {
    toast('请先打开或新建文档', 'info');
    return;
  }
  const ta = els.editor;
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  const sel = ta.value.substring(s, e) || placeholder;
  ta.setRangeText(before + sel + after, s, e, 'select');
  ta.setSelectionRange(s + before.length, s + before.length + sel.length);
  ta.focus();
  onEditorInput();
}

function insertTemplate(text) {
  if (!state.currentRel) {
    toast('请先打开或新建文档', 'info');
    return;
  }
  const ta = els.editor;
  ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
  ta.focus();
  onEditorInput();
}

function insertH2() {
  if (!state.currentRel) {
    toast('请先打开或新建文档', 'info');
    return;
  }
  const ta = els.editor;
  const lineStart = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
  ta.setRangeText('## ', lineStart, lineStart, 'end');
  ta.focus();
  onEditorInput();
}

const EDITOR_TOOLS = [
  { label: 'B', title: '粗体 **text**', run: () => wrapSelection('**', '**', '粗体文本') },
  { label: 'I', title: '斜体 *text*', run: () => wrapSelection('*', '*', '斜体文本') },
  { label: '🔗', title: '链接 [text](url)', run: () => wrapSelection('[', '](url)', '链接文字') },
  { label: '</>', title: '代码块', run: () => wrapSelection('\n```\n', '\n```\n', '代码') },
  { label: 'H2', title: '二级标题', run: insertH2 },
  {
    label: '表格',
    title: '插入表格',
    run: () => insertTemplate('\n| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n|  |  |  |\n'),
  },
  {
    label: '💡',
    title: 'Callout 提示块',
    run: () => insertTemplate('\n> [!note] 提示\n> 在这里填写内容\n'),
  },
  {
    label: '✦ AI 块',
    title: '插入 AI 生成块',
    run: () => insertTemplate('\n```ai\n用一句话描述要生成的内容\n```\n'),
  },
];

/* --------------------------------- build --------------------------------- */

async function runBuild(manual) {
  if (state.building) return;
  state.building = true;
  if (manual) {
    els.btnBuild.disabled = true;
    els.btnBuild.innerHTML = '';
    els.btnBuild.append(h('span', { class: 'spin' }), ' 构建中…');
  }
  try {
    const r = await api('/api/build', { method: 'POST', quiet: !manual });
    state.hasBuilt = true;
    if (manual) {
      let msg = `已构建 ${r.pages} 页 · ${r.ms}ms`;
      if (r.ai && r.ai.total > 0) msg += ` · AI 块 ${r.ai.ran + r.ai.cached}/${r.ai.total}`;
      toast(msg, 'success');
    }
    refreshPreviewAfterBuild(r.indexUrl);
  } catch (e) {
    if (manual) reportErr(e);
  } finally {
    state.building = false;
    if (manual) {
      els.btnBuild.disabled = false;
      els.btnBuild.textContent = '⟳ 构建';
    }
  }
}

// Quiet rebuild after each autosave: no toasts, just keep the preview fresh.
function autoBuild() {
  runBuild(false);
}

function setPreviewPath(p) {
  state.currentPreviewPath = p;
  els.previewPlaceholder.classList.add('hidden');
  els.preview.classList.remove('hidden');
  els.preview.src = `${p}${p.includes('?') ? '&' : '?'}t=${Date.now()}`;
}

function refreshPreviewAfterBuild(indexUrl) {
  if (!state.hasBuilt) return;
  // First successful build: the iframe is still blank/placeholder -> index.
  setPreviewPath(state.currentPreviewPath || indexUrl || '/preview/index.html');
}

/* ------------------------------- AI actions ------------------------------ */

function renderAiControls() {
  const locked = !state.provider.hasKey;
  els.btnAi.innerHTML = '';
  els.btnAi.append(locked ? 'AI 操作 🔒 ▾' : 'AI 操作 ▾');
  els.btnAi.title = locked ? '未配置 AI 服务，点击查看配置方法' : '对选中文本执行 AI 操作';
  els.aiMenu.querySelectorAll('.menu-item').forEach((item) => {
    const base = item.textContent.replace(/\s*🔒$/, '');
    item.textContent = locked ? `${base} 🔒` : base;
  });
}

function onAiButtonClick() {
  els.aiMenu.classList.toggle('hidden');
}

function onAiAction(action) {
  els.aiMenu.classList.add('hidden');
  if (!state.provider.hasKey) {
    openModal(els.setupModal);
    return;
  }
  if (!state.currentRel) {
    toast('请先打开或新建文档', 'info');
    return;
  }
  runAiAction(action);
}

const AI_LABELS = {
  polish: '润色',
  continue: '续写',
  'translate-en': '翻译成英文',
  summarize: '总结要点',
};

async function runAiAction(action) {
  const ta = els.editor;
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  const selection = ta.value.substring(s, e);
  if ((action === 'polish' || action === 'translate-en') && !selection) {
    toast(`请先选中要${AI_LABELS[action]}的文本`, 'info');
    return;
  }
  // 续写 (and 总结 without a selection) fall back to the whole document.
  const context = selection || ta.value;
  if (!context.trim()) {
    toast('文档内容为空', 'info');
    return;
  }
  if (state.aiBusy) return;
  state.aiBusy = true;
  els.btnAi.disabled = true;
  els.btnAi.textContent = '生成中…';
  try {
    const r = await api('/api/ai/complete', { method: 'POST', body: { action, context } });
    if (r.error) {
      if (r.error === 'no-api-key') openModal(els.setupModal);
      else toast(r.error, 'error');
      return;
    }
    applyAiResult(action, r.markdown, s, e);
    toast(`${AI_LABELS[action]}完成`, 'success');
  } catch (err) {
    reportErr(err);
  } finally {
    state.aiBusy = false;
    els.btnAi.disabled = false;
    renderAiControls();
  }
}

function applyAiResult(action, markdown, selStart, selEnd) {
  const ta = els.editor;
  if (action === 'polish' || action === 'translate-en') {
    // Replace the selection in place.
    ta.setRangeText(markdown, selStart, selEnd, 'end');
  } else if (action === 'continue') {
    // Insert right after the selection (or cursor), on a fresh paragraph.
    const before = ta.value.slice(0, selEnd);
    let insert = markdown;
    if (before && !before.endsWith('\n\n')) {
      insert = (before.endsWith('\n') ? '\n' : '\n\n') + markdown;
    }
    ta.setRangeText(insert, selEnd, selEnd, 'end');
  } else if (action === 'summarize') {
    // Insert at the cursor as a tip callout, one quoted line per result line.
    const callout = `> [!tip] 总结\n> ${markdown.split('\n').join('\n> ')}\n`;
    const before = ta.value.slice(0, selEnd);
    const prefix = before && !before.endsWith('\n') ? '\n' : '';
    ta.setRangeText(prefix + callout, selEnd, selEnd, 'end');
  }
  ta.focus();
  onEditorInput(); // mark dirty -> autosave kicks in
}

/* ------------------------------ split divider ---------------------------- */

function initSplit() {
  const saved = parseFloat(localStorage.getItem('kmd-split'));
  applySplit(Number.isFinite(saved) && saved > 0 && saved < 1 ? saved : 0.5);
  els.splitDivider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    document.body.classList.add('dragging-split');
    const onMove = (ev) => {
      const rect = els.split.getBoundingClientRect();
      const r = Math.min(0.8, Math.max(0.2, (ev.clientX - rect.left) / rect.width));
      applySplit(r);
      localStorage.setItem('kmd-split', String(r));
    };
    const onUp = () => {
      document.body.classList.remove('dragging-split');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function applySplit(r) {
  els.split.style.gridTemplateColumns = `minmax(0, ${r}fr) 4px minmax(0, ${1 - r}fr)`;
}

/* --------------------------------- theme ---------------------------------- */

function updateThemeIcon() {
  const dark = document.documentElement.dataset.theme === 'dark';
  els.btnTheme.innerHTML = dark ? ICONS.sun : ICONS.moon;
  els.btnTheme.title = dark ? '切换为浅色主题' : '切换为深色主题';
}

/* --------------------------------- quit ----------------------------------- */

async function quitApp() {
  if (!confirm('确定退出 KMD Studio 吗？')) return;
  try {
    await api('/api/shutdown', { method: 'POST', quiet: true });
  } catch {
    /* server may already be gone */
  }
  clearInterval(heartbeatTimer);
  document.body.innerHTML =
    '<div id="screen-exited"><div class="exited-card">' +
    '<div>已退出，可关闭窗口</div>' +
    '<div class="muted">KMD Studio 服务器已停止</div>' +
    '</div></div>';
}

/* -------------------------------- heartbeat -------------------------------- */

// Keep the server watchdog alive; fires even while the window is hidden.
const heartbeatTimer = setInterval(() => {
  api('/api/heartbeat', { method: 'POST', quiet: true }).catch(() => {});
}, 5000);

/* ----------------------------------- boot ---------------------------------- */

async function boot() {
  initTheme();
  buildDom();
  try {
    const status = await api('/api/status', { quiet: true });
    state.provider = status.provider || state.provider;
  } catch {
    /* chip stays in the unconfigured state */
  }
  renderProviderChip();
  renderAiControls();
  try {
    const cur = await api('/api/project/current');
    if (cur.project) {
      // Read the deep link first: enterWorkspace() -> closeEditor() clears it.
      const rel = fileHashRel();
      enterWorkspace(cur.project);
      if (rel) {
        // Restore the previously open doc; if it is gone, clear the hash and
        // stay in the workspace empty state (silent, no error toast).
        const ok = await openFile(rel, { silent: true });
        if (!ok) setFileHash(null);
      }
      return;
    }
    renderRecents(cur.recents || []);
  } catch (e) {
    reportErr(e);
    renderRecents([]);
  }
}

boot();
