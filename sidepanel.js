/* Code Coach side panel */
(function () {
  'use strict';

  const $ = (s, el) => (el || document).querySelector(s);
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>'); // tiny inline-code renderer

  const DEFAULTS = {
    maxLineLength: 80,
    indentStyle: 'auto',
    indentSize: 'auto',
    braceStyle: 'auto',
    interval: 30,
    token: '',
    liveOn: false,
  };

  const state = {
    settings: Object.assign({}, DEFAULTS),
    tab: 'page',
    revealed: new Set(), // keys of hints / answers the user has opened
    lastHash: '',
    scanning: false,
    timer: null,
    pageTimeout: null,
    repoBusy: false,
  };

  /* ================= settings ================= */

  async function loadSettings() {
    const { cc_settings } = await chrome.storage.local.get('cc_settings');
    state.settings = Object.assign({}, DEFAULTS, cc_settings || {});
  }
  async function saveSettings() {
    await chrome.storage.local.set({ cc_settings: state.settings });
  }
  function analysisOpts(extra) {
    const s = state.settings;
    return Object.assign(
      {
        maxLineLength: Number(s.maxLineLength) || 80,
        indentStyle: s.indentStyle,
        indentSize: s.indentSize === 'auto' ? 'auto' : Number(s.indentSize),
        braceStyle: s.braceStyle,
      },
      extra || {}
    );
  }

  /* ================= rendering ================= */

  const ICONS = {
    search:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
    check:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/></svg>',
    alert:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>',
  };

  function emptyState(root, kind, title, body) {
    root._map = new Map();
    root.innerHTML = `<div class="empty ${kind === 'good' ? 'good' : kind === 'bad' ? 'bad' : ''}">
      ${kind === 'good' ? ICONS.check : kind === 'bad' ? ICONS.alert : ICONS.search}
      <p class="empty-title">${esc(title)}</p><p>${esc(body)}</p></div>`;
  }

  function sevLabel(s) {
    return { error: 'Error', warning: 'Warning', style: 'Style' }[s];
  }

  function snippetHTML(issue) {
    const off = issue._offset || 0;
    return issue.originalLines
      .map((txt, idx) => {
        const ln = issue.range[0] + idx + 1;
        const isFocus = ln === issue.line;
        let code;
        if (isFocus) {
          const start = Math.max(0, issue.col - 1);
          const len = Math.max(1, issue.len || 1);
          const before = txt.slice(0, start);
          const mid = txt.slice(start, start + len) || ' ';
          const after = txt.slice(start + len);
          code = `${esc(before)}<span class="sq">${esc(mid)}</span>${esc(after)}`;
        } else code = esc(txt);
        return `<div class="row${isFocus ? ' focus' : ''}"><span class="ln">${ln + off}</span><span class="code">${code || ' '}</span></div>`;
      })
      .join('');
  }

  function diffHTML(issue) {
    const del = issue.originalLines.map((l) => `<span class="d del" data-mark="-">${esc(l) || ' '}</span>`);
    const add = issue.fix.split('\n').map((l) => `<span class="d add" data-mark="+">${esc(l) || ' '}</span>`);
    return `<div class="diff">${del.join('')}${add.join('')}</div>`;
  }

  function cardHTML(issue, id) {
    const key = `${issue._scope || ''}|${issue.rule}|${issue.line}|${issue.col}`;
    const hintOpen = state.revealed.has(key + '|h');
    const ansOpen = state.revealed.has(key + '|a');
    const lineNo = issue.line + (issue._offset || 0);
    let loc;
    if (issue._href) loc = `<a class="loc" href="${esc(issue._href)}" target="_blank" rel="noreferrer">Line ${lineNo}</a>`;
    else if (issue._goto) loc = `<button class="loc" data-act="goto" title="Jump to this line">Line ${lineNo}</button>`;
    else loc = `<span class="loc">Line ${lineNo}</span>`;
    const canApply = issue._apply && issue.fix != null;
    return `<article class="issue sev-${issue.severity}" data-id="${id}" data-key="${esc(key)}">
      <div class="issue-head">
        <span class="pill">${sevLabel(issue.severity)}</span>
        <span class="rule">${esc(issue.rule)}</span>
        ${loc}
      </div>
      <p class="msg">${md(issue.message)}</p>
      <div class="snippet" role="img" aria-label="Code on line ${lineNo}">${snippetHTML(issue)}</div>
      <div class="actions">
        <button class="btn ghost" data-act="hint" aria-expanded="${hintOpen}">${hintOpen ? 'Hide hint' : 'Give me a hint'}</button>
        <button class="btn ghost" data-act="answer" aria-expanded="${ansOpen}">${ansOpen ? 'Hide answer' : 'Show the answer'}</button>
      </div>
      <div class="reveal hint" data-pane="hint" ${hintOpen ? '' : 'hidden'}>
        <span class="reveal-title">Hint</span>
        <p>${md(issue.hint)}</p>
      </div>
      <div class="reveal" data-pane="answer" ${ansOpen ? '' : 'hidden'}>
        <span class="reveal-title">Answer</span>
        <p>${md(issue.answer)}</p>
        ${issue.fix != null ? diffHTML(issue) : ''}
        ${canApply ? '<div class="actions"><button class="btn small" data-act="apply">Apply this fix</button></div>' : ''}
      </div>
    </article>`;
  }

  function summaryHTML(root, issues, metaText) {
    const counts = { error: 0, warning: 0, style: 0 };
    issues.forEach((i) => counts[i.severity]++);
    const hidden = new Set((root.dataset.hide || '').split(' ').filter(Boolean));
    const chip = (sev, label) =>
      `<button class="chip sev-${sev}" data-filter="${sev}" aria-pressed="${!hidden.has(sev)}" ${counts[sev] ? '' : 'disabled'}>
        <span>${counts[sev]}</span> ${label}${counts[sev] === 1 ? '' : 's'}</button>`;
    return `<div class="summary">${chip('error', 'error')}${chip('warning', 'warning')}${chip('style', 'style note')}
      ${metaText ? `<span class="meta-line">${esc(metaText)}</span>` : ''}</div>`;
  }

  function registerIssues(root, issues) {
    root._map = new Map();
    issues.forEach((it, idx) => root._map.set(String(idx), it));
  }

  function renderIssues(root, result, meta) {
    const issues = result.issues;
    if (!issues.length) {
      emptyState(
        root,
        'good',
        'No issues found',
        `Checked ${plural(result.lines, 'line')} of ${result.languageLabel}. Nice work. Keep it up!`
      );
      return;
    }
    registerIssues(root, issues);
    const cards = issues.map((it, idx) => cardHTML(it, idx)).join('');
    root.innerHTML =
      summaryHTML(root, issues, meta || `${result.languageLabel} · ${plural(result.lines, 'line')}`) +
      `<div class="list">${cards}</div>` +
      (result.truncated ? '<p class="note">Showing the first 400 issues.</p>' : '');
  }

  // one delegated click handler for every results container
  document.addEventListener('click', (e) => {
    const root = e.target.closest('.results');
    if (!root) return;
    const chip = e.target.closest('[data-filter]');
    if (chip) {
      const hidden = new Set((root.dataset.hide || '').split(' ').filter(Boolean));
      const sev = chip.dataset.filter;
      if (hidden.has(sev)) hidden.delete(sev);
      else hidden.add(sev);
      root.dataset.hide = [...hidden].join(' ');
      root.querySelectorAll(`[data-filter="${sev}"]`).forEach((c) => c.setAttribute('aria-pressed', String(!hidden.has(sev))));
      return;
    }
    const btn = e.target.closest('[data-act]');
    const card = e.target.closest('.issue');
    if (!btn || !card) return;
    const issue = root._map && root._map.get(card.dataset.id);
    if (!issue) return;
    const key = card.dataset.key;
    const act = btn.dataset.act;
    if (act === 'hint' || act === 'answer') {
      const pane = card.querySelector(`[data-pane="${act}"]`);
      const open = pane.hidden;
      pane.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      btn.textContent = act === 'hint' ? (open ? 'Hide hint' : 'Give me a hint') : open ? 'Hide answer' : 'Show the answer';
      const k = key + (act === 'hint' ? '|h' : '|a');
      if (open) state.revealed.add(k);
      else state.revealed.delete(k);
    } else if (act === 'goto' && issue._goto) issue._goto(issue);
    else if (act === 'apply' && issue._apply) issue._apply(issue);
  });

  /* ================= tabs ================= */

  function selectTab(name) {
    state.tab = name;
    document.querySelectorAll('.tab').forEach((t) => {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    });
    document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.id !== 'panel-' + name));
    if (name === 'page' && state.settings.liveOn) scanPage({ silent: true });
    if (name === 'repo') maybePrefillRepo();
  }
  document.querySelector('.tabs').addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (t) selectTab(t.dataset.tab);
  });
  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabs = [...document.querySelectorAll('.tab')];
    const i = tabs.findIndex((t) => t.dataset.tab === state.tab);
    const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    selectTab(n.dataset.tab);
    n.focus();
  });

  /* ================= PAGE (live) ================= */

  const pageRoot = $('#pageResults');
  const pageSource = $('#pageSource');
  const liveToggle = $('#liveToggle');

  // Runs inside the web page (MAIN world). Must be fully self-contained.
  function pageExtract() {
    const out = [];
    const push = (source, code, extra) => {
      if (typeof code === 'string' && code.trim().length > 0) out.push(Object.assign({ source, code }, extra || {}));
    };
    try {
      const mo = window.monaco && window.monaco.editor;
      if (mo) {
        const eds = mo.getEditors ? mo.getEditors() : [];
        const ed = eds.find((e) => e.hasTextFocus && e.hasTextFocus()) || eds[0];
        const model = ed && ed.getModel ? ed.getModel() : mo.getModels()[0];
        if (model) {
          push('Monaco editor', model.getValue(), {
            uri: String((model.uri && model.uri.path) || ''),
            focused: !!(ed && ed.hasTextFocus && ed.hasTextFocus()),
          });
        }
      }
    } catch (e) {}
    try {
      document.querySelectorAll('.CodeMirror').forEach((el) => {
        if (el.CodeMirror) push('CodeMirror', el.CodeMirror.getValue(), { focused: el.classList.contains('CodeMirror-focused') });
      });
    } catch (e) {}
    try {
      if (window.ace) {
        document.querySelectorAll('.ace_editor').forEach((el) => {
          const ed = window.ace.edit(el);
          push('Ace editor', ed.getValue(), { focused: el.classList.contains('ace_focus') });
        });
      }
    } catch (e) {}
    try {
      document.querySelectorAll('.cm-content').forEach((el) => {
        let code = null;
        try {
          const v = el.cmView && (el.cmView.view || (el.cmView.rootView && el.cmView.rootView.view));
          if (v && v.state) code = v.state.doc.toString();
        } catch (e) {}
        if (code == null) code = [...el.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\n');
        push('CodeMirror 6', code, { focused: el.contains(document.activeElement) });
      });
    } catch (e) {}
    try {
      document.querySelectorAll('.monaco-editor').forEach((ed) => {
        const rows = [...ed.querySelectorAll('.view-lines .view-line')];
        if (!rows.length) return;
        rows.sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top));
        const text = rows.map((r) => r.textContent.replace(/\u00a0/g, ' ')).join('\n');
        let first = 1;
        const ovs = [...ed.querySelectorAll('.margin-view-overlays > div')].sort(
          (a, b) => parseFloat(a.style.top) - parseFloat(b.style.top)
        );
        for (const ov of ovs) {
          const n = ov.querySelector('.line-numbers');
          if (n && /^\d+$/.test(n.textContent.trim())) {
            first = parseInt(n.textContent.trim(), 10);
            break;
          }
        }
        push('Monaco editor', text, { partial: true, lineOffset: first - 1, focused: ed.contains(document.activeElement) });
      });
    } catch (e) {}
    try {
      document.querySelectorAll('textarea').forEach((t) => {
        const gh = t.id === 'read-only-cursor-text-area';
        if (!t.value || t.value.length < 20) return;
        if (!gh && t.offsetParent === null) return;
        push(gh ? 'GitHub file view' : 'Text box', t.value, { focused: t === document.activeElement });
      });
    } catch (e) {}
    try {
      const gl = [...document.querySelectorAll('td.blob-code-inner, .js-file-line')];
      if (gl.length) push('GitHub file view', gl.map((l) => l.textContent).join('\n'));
    } catch (e) {}
    out.sort((a, b) => (b.focused ? 1e9 : 0) + b.code.length - ((a.focused ? 1e9 : 0) + a.code.length));
    return { candidates: out.slice(0, 3), title: document.title, url: location.href };
  }

  async function activeTab() {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return t;
  }

  function guessFilename(cand, tab) {
    const re = /([\w.\-]+\.(?:jsx?|mjs|cjs|tsx?|java|c|h|cpp|cc|cxx|hpp|cs|py))(?![\w])/i;
    const pool = [cand && cand.uri, cand && cand.url, tab && tab.title, tab && tab.url].filter(Boolean);
    for (const s of pool) {
      let d = s;
      try {
        d = decodeURIComponent(s);
      } catch (e) {}
      const m = re.exec(d.split(/[?#]/)[0]) || re.exec(d);
      if (m) return m[1];
    }
    return '';
  }

  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return String(h);
  }

  function setLiveStatus(text) {
    $('#liveStatus').textContent = text;
  }
  const clock = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

  function setBadge(result) {
    if (!state.settings.liveOn) return;
    const n = result ? result.counts.error + result.counts.warning + result.counts.style : 0;
    chrome.action.setBadgeText({ text: n ? String(n) : '' });
    chrome.action.setBadgeBackgroundColor({
      color: result && result.counts.error ? '#d62d4b' : result && result.counts.warning ? '#a96a00' : '#0b857a',
    });
  }

  async function scanPage(opts) {
    const silent = !!(opts && opts.silent);
    if (state.scanning) return;
    state.scanning = true;
    const btn = $('#scanNow');
    if (!silent) btn.disabled = true;
    try {
      const tab = await activeTab();
      if (!tab || !tab.id) throw new Error('no-tab');
      let frames;
      try {
        frames = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          world: 'MAIN',
          func: pageExtract,
        });
      } catch (err) {
        pageSource.hidden = true;
        emptyState(
          pageRoot,
          'plain',
          "Can't read this tab",
          "Browser pages and the Chrome Web Store are off limits to extensions. Switch to the tab with your code, or use the Paste code tab."
        );
        setLiveStatus(state.settings.liveOn ? `Watching, but this tab can't be read` : 'Not watching');
        return;
      }
      const cands = [];
      frames.forEach((f) => {
        if (f.result && f.result.candidates) f.result.candidates.forEach((c) => cands.push(Object.assign({ url: f.result.url }, c)));
      });
      cands.sort((a, b) => (b.focused ? 1e9 : 0) + b.code.length - ((a.focused ? 1e9 : 0) + a.code.length));
      const best = cands[0];
      if (!best) {
        pageSource.hidden = true;
        state.lastHash = '';
        emptyState(
          pageRoot,
          'plain',
          'No code found on this tab',
          'Open a web editor (github.dev, Codespaces, Replit, CodePen) or a file on GitHub. Using Eclipse or another desktop IDE? Paste your code in the Paste code tab.'
        );
        setLiveStatus(state.settings.liveOn ? `Watching · ${clock()} · no code on this tab` : 'Not watching');
        setBadge(null);
        return;
      }
      const filename = guessFilename(best, tab);
      const langSel = $('#pageLang').value;
      const opts2 = analysisOpts({ filename, language: langSel });
      const hash = hashStr(best.code + '|' + filename + '|' + langSel + '|' + JSON.stringify(opts2));
      if (silent && hash === state.lastHash) {
        setLiveStatus(`Watching · checked ${clock()} · no changes`);
        return;
      }
      state.lastHash = hash;
      const result = CodeCoach.analyze(best.code, opts2);
      const offset = best.lineOffset || 0;
      result.issues.forEach((it) => {
        it._scope = 'page:' + filename;
        it._offset = offset;
      });
      pageSource.hidden = false;
      $('#sourceName').textContent = filename || 'Untitled code';
      $('#sourceDetail').textContent = best.source + (best.partial ? ' · visible lines only' : '');
      if (langSel === 'auto') $('#pageLang').options[0].textContent = `Auto: ${result.languageLabel}`;
      renderIssues(pageRoot, result);
      if (best.partial) {
        pageRoot.insertAdjacentHTML(
          'afterbegin',
          '<p class="note">This editor only exposes the lines currently on screen, so only those were audited. Scroll and scan again, or audit the repo from the GitHub tab.</p>'
        );
      }
      setLiveStatus(state.settings.liveOn ? `Watching · checked ${clock()}` : `Scanned at ${clock()}`);
      setBadge(result);
    } catch (err) {
      setLiveStatus('Scan failed: ' + (err && err.message ? err.message : err));
    } finally {
      state.scanning = false;
      btn.disabled = false;
    }
  }

  function applyLiveUi() {
    const on = state.settings.liveOn;
    liveToggle.checked = on;
    $('.watch').classList.toggle('on', on);
    const sec = Number(state.settings.interval) || 30;
    const every = sec >= 60 ? plural(sec / 60, 'minute') : `${sec} seconds`;
    $('#liveHint').textContent = on ? `On. Re-checks every ${every} when your code changes.` : "Off. Scan whenever you're ready.";
    clearInterval(state.timer);
    state.timer = null;
    if (on) {
      state.timer = setInterval(() => {
        if (state.tab === 'page') scanPage({ silent: true });
      }, sec * 1000);
      setLiveStatus('Watching');
    } else {
      setLiveStatus('Not watching');
      chrome.action.setBadgeText({ text: '' });
    }
    $('#pasteStatus').textContent = on ? 'Live: re-checks as you type' : '';
  }

  liveToggle.addEventListener('change', async () => {
    state.settings.liveOn = liveToggle.checked;
    await saveSettings();
    applyLiveUi();
    if (state.settings.liveOn) {
      state.lastHash = '';
      if (state.tab === 'page') scanPage({ silent: true });
      else if ($('#pasteBox').value.trim()) runPaste();
    }
  });
  $('#scanNow').addEventListener('click', () => scanPage({ silent: false }));
  $('#pageLang').addEventListener('change', () => scanPage({ silent: false }));

  function nudgeScan() {
    if (!state.settings.liveOn || state.tab !== 'page') return;
    clearTimeout(state.pageTimeout);
    state.pageTimeout = setTimeout(() => scanPage({ silent: true }), 600);
  }
  chrome.tabs.onActivated.addListener(nudgeScan);
  chrome.tabs.onUpdated.addListener((_id, change) => {
    if (change.status === 'complete') nudgeScan();
  });

  /* ================= PASTE ================= */

  const pasteBox = $('#pasteBox');
  const pasteRoot = $('#pasteResults');
  let pasteDebounce = null;

  function runPaste() {
    const code = pasteBox.value;
    if (!code.trim()) {
      emptyState(pasteRoot, 'plain', 'Nothing to audit yet', 'Paste your code above, then run the audit.');
      return;
    }
    const result = CodeCoach.analyze(
      code,
      analysisOpts({ filename: $('#pasteName').value.trim(), language: $('#pasteLang').value })
    );
    result.issues.forEach((it) => {
      it._scope = 'paste';
      it._goto = gotoLine;
      it._apply = applyFix;
    });
    renderIssues(pasteRoot, result);
    if (state.settings.liveOn) {
      $('#pasteStatus').textContent = `Live · checked ${clock()}`;
    }
  }

  function gotoLine(issue) {
    const lines = pasteBox.value.replace(/\r\n?/g, '\n').split('\n');
    let start = 0;
    for (let i = 0; i < issue.line - 1; i++) start += lines[i].length + 1;
    pasteBox.focus();
    pasteBox.setSelectionRange(start, start + (lines[issue.line - 1] || '').length);
    pasteBox.scrollTop = Math.max(0, (issue.line - 4) * 19.4);
  }

  function applyFix(issue) {
    const lines = pasteBox.value.replace(/\r\n?/g, '\n').split('\n');
    const [a, b] = issue.range;
    const current = lines.slice(a, b + 1);
    if (current.join('\n') !== issue.originalLines.join('\n')) {
      $('#pasteStatus').textContent = 'Your code changed since this audit. Run it again first.';
      return;
    }
    lines.splice(a, b - a + 1, ...issue.fix.split('\n'));
    pasteBox.value = lines.join('\n');
    $('#pasteStatus').textContent = 'Fix applied';
    runPaste();
  }

  $('#pasteRun').addEventListener('click', runPaste);
  $('#pasteClear').addEventListener('click', () => {
    pasteBox.value = '';
    runPaste();
    pasteBox.focus();
  });
  pasteBox.addEventListener('input', () => {
    if (!state.settings.liveOn) return;
    clearTimeout(pasteDebounce);
    pasteDebounce = setTimeout(runPaste, 900);
  });
  $('#pasteLang').addEventListener('change', () => pasteBox.value.trim() && runPaste());

  /* ================= GITHUB ================= */

  const repoRoot = $('#repoResults');

  function parseRepo(input) {
    const s = (input || '').trim();
    if (!s) return null;
    let m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/?#]+))?(?:[/?#].*)?$/i.exec(s);
    if (m) return { owner: m[1], repo: m[2], branch: m[3] ? decodeURIComponent(m[3]) : '' };
    m = /^([\w.-]+)\/([\w.-]+)$/.exec(s);
    if (m) return { owner: m[1], repo: m[2], branch: '' };
    return null;
  }

  async function maybePrefillRepo() {
    if ($('#repoInput').value.trim()) return;
    try {
      const tab = await activeTab();
      const r = tab && /^https:\/\/github\.com\//.test(tab.url || '') ? parseRepo(tab.url) : null;
      if (r && !['settings', 'orgs', 'marketplace', 'topics', 'features'].includes(r.owner)) {
        $('#repoInput').value = `${r.owner}/${r.repo}`;
        if (r.branch) $('#repoBranch').value = r.branch;
      }
    } catch (e) {}
  }

  async function gh(path, raw) {
    const headers = {
      Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (state.settings.token) headers.Authorization = 'Bearer ' + state.settings.token;
    const res = await fetch(path.startsWith('http') ? path : 'https://api.github.com' + path, { headers });
    if (!res.ok) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      const reset = res.headers.get('x-ratelimit-reset');
      let msg;
      if (res.status === 404) msg = "Couldn't find that repository. If it's private, add a token in Settings.";
      else if (res.status === 401) msg = 'GitHub rejected your token. Check it in Settings.';
      else if ((res.status === 403 || res.status === 429) && remaining === '0') {
        const when = reset ? new Date(Number(reset) * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'later';
        msg = `GitHub's rate limit is used up until ${when}. A token in Settings raises the limit a lot.`;
      } else msg = `GitHub returned ${res.status}.`;
      throw new Error(msg);
    }
    return raw ? res.text() : res.json();
  }

  function addedLinesFromPatch(patch) {
    const set = new Set();
    let ln = null;
    for (const l of patch.split('\n')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m) {
        ln = Number(m[1]);
        continue;
      }
      if (ln == null) continue;
      if (l.startsWith('+')) {
        set.add(ln);
        ln++;
      } else if (l.startsWith('-') || l.startsWith('\\')) {
        /* removed line or "no newline" marker: new-file line number does not move */
      } else ln++;
    }
    return set;
  }

  function relTime(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  }

  function repoStatus(t) {
    $('#repoStatus').textContent = t;
  }

  async function auditRepo(target, count) {
    if (state.repoBusy) return;
    state.repoBusy = true;
    const runBtn = $('#repoRun');
    runBtn.disabled = true;
    repoRoot.dataset.hide = repoRoot.dataset.hide || '';
    try {
      const { owner, repo, branch } = target;
      repoStatus('Fetching commits...');
      const list = await gh(
        `/repos/${owner}/${repo}/commits?per_page=${count}` + (branch ? `&sha=${encodeURIComponent(branch)}` : '')
      );
      if (!list.length) {
        emptyState(repoRoot, 'plain', 'No commits found', 'That branch has no commits yet.');
        return;
      }
      const commits = [];
      const all = [];
      for (let ci = 0; ci < list.length; ci++) {
        const c = list[ci];
        repoStatus(`Reading commit ${ci + 1} of ${list.length}...`);
        const detail = await gh(`/repos/${owner}/${repo}/commits/${c.sha}`);
        const entry = {
          sha: c.sha,
          message: (c.commit.message || '').split('\n')[0],
          author: (c.commit.author && c.commit.author.name) || 'unknown',
          date: c.commit.author && c.commit.author.date,
          url: c.html_url,
          files: [],
          skipped: 0,
        };
        const files = (detail.files || []).filter((f) => f.status !== 'removed' && CodeCoach.langForFile(f.filename));
        const noPatch = files.filter((f) => !f.patch || f.additions > 2000).length;
        const usable = files.filter((f) => f.patch && f.additions <= 2000).slice(0, 12);
        entry.skipped = noPatch + Math.max(0, files.length - noPatch - usable.length);
        for (let fi = 0; fi < usable.length; fi++) {
          const f = usable[fi];
          repoStatus(`Commit ${ci + 1}/${list.length}: auditing ${f.filename}`);
          let text;
          try {
            text = await gh(f.contents_url, true);
          } catch (e) {
            if (/rate limit/i.test(e.message)) throw e;
            entry.skipped++;
            continue;
          }
          if (text.length > 300000) {
            entry.skipped++;
            continue;
          }
          const added = addedLinesFromPatch(f.patch);
          const result = CodeCoach.analyze(text, analysisOpts({ filename: f.filename, isFile: true }));
          const mine = result.issues.filter((it) => added.has(it.line) || it.rule === 'unbalanced-brackets');
          mine.forEach((it) => {
            it._scope = `${c.sha}|${f.filename}`;
            it._href = `https://github.com/${owner}/${repo}/blob/${c.sha}/${f.filename.split('/').map(encodeURIComponent).join('/')}#L${it.line}`;
          });
          entry.files.push({ name: f.filename, issues: mine, lines: result.lines });
          all.push(...mine);
        }
        commits.push(entry);
      }
      renderRepo(commits, all, `${owner}/${repo}`);
      repoStatus('');
    } catch (err) {
      repoStatus('');
      emptyState(repoRoot, 'bad', "Couldn't audit that repo", err.message || String(err));
    } finally {
      state.repoBusy = false;
      runBtn.disabled = false;
    }
  }

  function renderRepo(commits, all, name) {
    registerIssues(repoRoot, all);
    let idx = 0;
    const html = commits
      .map((c, n) => {
        const count = c.files.reduce((a, f) => a + f.issues.length, 0);
        const body = c.files.length
          ? c.files
              .map((f) => {
                const cards = f.issues.map((it) => cardHTML(it, idx++)).join('');
                return `<div class="file">
                  <div class="file-head"><span>${esc(f.name)}</span><span class="count">${f.issues.length ? plural(f.issues.length, 'issue') : ''}</span></div>
                  ${f.issues.length ? `<div class="list">${cards}</div>` : '<div class="file-clean">No issues in the changed lines.</div>'}
                </div>`;
              })
              .join('')
          : '<p class="note">No code files with readable changes in this commit.</p>';
        return `<details class="commit" ${n === 0 || count ? 'open' : ''}>
          <summary>
            <span class="commit-title">${esc(c.message || '(no message)')}</span>
            <span class="commit-meta">
              <a href="${esc(c.url)}" target="_blank" rel="noreferrer">${esc(c.sha.slice(0, 7))}</a>
              <span>${esc(c.author)}</span>${c.date ? `<span>${esc(relTime(c.date))}</span>` : ''}
              <span>${count ? plural(count, 'issue') : 'clean'}</span>
            </span>
          </summary>
          <div class="commit-body">${body}
            ${c.skipped ? `<p class="note">${plural(c.skipped, 'file')} skipped (too large, binary, or unreadable).</p>` : ''}
          </div>
        </details>`;
      })
      .join('');
    repoRoot.innerHTML =
      (all.length ? summaryHTML(repoRoot, all, `${name} · ${plural(commits.length, 'commit')}`) : '') +
      (all.length
        ? ''
        : `<div class="empty good">${ICONS.check}<p class="empty-title">Nothing to flag</p><p>The changed lines in ${plural(commits.length, 'commit')} look clean.</p></div>`) +
      html +
      '<p class="note">Only lines added or changed in each commit are reported, so old code does not bury new problems.</p>';
  }

  $('#repoRun').addEventListener('click', () => {
    const r = parseRepo($('#repoInput').value);
    if (!r) {
      repoStatus('Enter a repo like owner/repo or paste its GitHub link.');
      return;
    }
    const b = $('#repoBranch').value.trim();
    if (b) r.branch = b;
    auditRepo(r, Number($('#repoCount').value));
  });
  $('#repoInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#repoRun').click();
  });

  /* ----- watch list ----- */

  async function getWatch() {
    const { cc_watch } = await chrome.storage.local.get('cc_watch');
    return Array.isArray(cc_watch) ? cc_watch : [];
  }
  const sameRepo = (a, b) => a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase() && (a.branch || '') === (b.branch || '');

  async function renderWatch() {
    const list = await getWatch();
    const ul = $('#watchList');
    ul.innerHTML = list
      .map(
        (w, i) =>
          `<li><span>Watching ${esc(w.owner)}/${esc(w.repo)}${w.branch ? ' @ ' + esc(w.branch) : ''}</span><button data-rm="${i}">Stop</button></li>`
      )
      .join('');
    const cur = parseRepo($('#repoInput').value);
    if (cur) {
      cur.branch = $('#repoBranch').value.trim() || cur.branch;
      $('#repoWatch').checked = list.some((w) => sameRepo(w, cur));
    } else $('#repoWatch').checked = false;
  }

  $('#watchList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-rm]');
    if (!b) return;
    const list = await getWatch();
    list.splice(Number(b.dataset.rm), 1);
    await chrome.storage.local.set({ cc_watch: list });
    chrome.runtime.sendMessage({ type: 'CC_SYNC_WATCH' });
    renderWatch();
  });

  $('#repoWatch').addEventListener('change', async (e) => {
    const on = e.target.checked;
    const r = parseRepo($('#repoInput').value);
    if (!r) {
      e.target.checked = false;
      repoStatus('Enter a repo first, then switch this on.');
      return;
    }
    r.branch = $('#repoBranch').value.trim() || r.branch;
    let list = await getWatch();
    if (on) {
      try {
        const latest = await gh(`/repos/${r.owner}/${r.repo}/commits?per_page=1` + (r.branch ? `&sha=${encodeURIComponent(r.branch)}` : ''));
        if (!list.some((w) => sameRepo(w, r))) list.push(Object.assign({}, r, { lastSha: latest[0] ? latest[0].sha : '' }));
      } catch (err) {
        e.target.checked = false;
        repoStatus(err.message);
        return;
      }
    } else list = list.filter((w) => !sameRepo(w, r));
    await chrome.storage.local.set({ cc_watch: list });
    chrome.runtime.sendMessage({ type: 'CC_SYNC_WATCH' });
    renderWatch();
  });
  $('#repoInput').addEventListener('change', renderWatch);
  $('#repoBranch').addEventListener('change', renderWatch);

  /* ----- pending (new commit) banner ----- */

  async function showPending() {
    const { cc_pending } = await chrome.storage.local.get('cc_pending');
    const banner = $('#pendingBanner');
    if (!cc_pending) {
      banner.hidden = true;
      return;
    }
    $('#pendingTitle').textContent = `New commit in ${cc_pending.owner}/${cc_pending.repo}`;
    $('#pendingMsg').textContent = cc_pending.message;
    banner.hidden = false;
    $('#pendingGo').onclick = async () => {
      $('#repoInput').value = `${cc_pending.owner}/${cc_pending.repo}`;
      $('#repoBranch').value = cc_pending.branch || '';
      await chrome.storage.local.remove('cc_pending');
      chrome.action.setBadgeText({ text: '' });
      banner.hidden = true;
      selectTab('repo');
      auditRepo({ owner: cc_pending.owner, repo: cc_pending.repo, branch: cc_pending.branch || '' }, 1);
    };
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.cc_pending) showPending();
  });

  /* ================= settings dialog ================= */

  const dlg = $('#settings');
  $('#settingsBtn').addEventListener('click', () => {
    const s = state.settings;
    $('#setMax').value = s.maxLineLength;
    $('#setIndentStyle').value = s.indentStyle;
    $('#setIndentSize').value = String(s.indentSize);
    $('#setBrace').value = s.braceStyle;
    $('#setInterval').value = String(s.interval);
    $('#setToken').value = s.token || '';
    dlg.showModal();
  });
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue !== 'save') return;
    const s = state.settings;
    s.maxLineLength = Math.min(200, Math.max(40, Number($('#setMax').value) || 80));
    s.indentStyle = $('#setIndentStyle').value;
    s.indentSize = $('#setIndentSize').value;
    s.braceStyle = $('#setBrace').value;
    s.interval = Number($('#setInterval').value) || 30;
    s.token = $('#setToken').value.trim();
    await saveSettings();
    applyLiveUi();
    state.lastHash = '';
    if (state.tab === 'page' && !pageSource.hidden) scanPage({ silent: false });
    if (pasteBox.value.trim()) runPaste();
  });

  /* ================= boot ================= */

  async function boot() {
    await loadSettings();
    applyLiveUi();
    emptyState(
      pageRoot,
      'plain',
      'Ready when you are',
      'Open the page with your code and press Scan now, or switch on Watch while I code to get live feedback.'
    );
    emptyState(pasteRoot, 'plain', 'Nothing to audit yet', 'Paste your code above, then run the audit.');
    emptyState(repoRoot, 'plain', 'No audit yet', 'Enter a repository and choose how many recent commits to check.');
    await renderWatch();
    await showPending();
    const { cc_pending } = await chrome.storage.local.get('cc_pending');
    if (cc_pending) selectTab('repo');
    else if (state.settings.liveOn) scanPage({ silent: true });
  }
  boot();
})();
