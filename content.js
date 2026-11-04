// Injected into the current page on demand (by the popup button).
(() => {
  if (window.__dshWordLoaded) return; // already injected: the existing listener handles 'start'
  window.__dshWordLoaded = true;

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'CODE', 'PRE', 'SVG', 'CANVAS', 'SELECT', 'BUTTON']);
  const memCache = new Map(); // word -> zh, for this page only
  const WORD_RE = /[A-Za-z][A-Za-z'’-]*/g;
  const sentCache = new Map(); // sentence -> zh, for this page only
  const BLOCK_TAGS = new Set(['P', 'LI', 'DD', 'DT', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'BLOCKQUOTE', 'FIGCAPTION', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'ASIDE', 'MAIN', 'LABEL', 'SUMMARY', 'FIGURE']);
  // Abbreviations whose trailing period does not end a sentence
  const ABBR = new Set(['e.g', 'i.e', 'vs', 'etc', 'dr', 'mr', 'mrs', 'ms', 'st', 'no', 'fig', 'approx', 'u.s', 'u.k', 'a.m', 'p.m']);
  const CLOSERS = '"\'”’)]）】';
  let lastKey = '';
  let sentKey = '';
  let reqId = 0;
  let mx = 0, my = 0;

  const tip = document.createElement('div');
  tip.id = 'dsh-tip';
  const toast = document.createElement('div');
  toast.id = 'dsh-toast';
  document.documentElement.append(tip, toast);

  const hasHL = typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight !== 'undefined';

  // ---------- helpers ----------
  function showToast(msg, ms = 0) {
    toast.textContent = msg;
    toast.style.display = 'block';
    if (ms) setTimeout(() => { toast.style.display = 'none'; }, ms);
  }

  function isInsideOurUI(el) {
    return el === tip || el === toast;
  }

  // Collect visible English text nodes, skipping code, inputs, scripts, etc.
  function textNodes() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        for (let el = p; el; el = el.parentElement) {
          if (SKIP_TAGS.has(el.tagName) || el.isContentEditable || isInsideOurUI(el)) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const out = [];
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  // ---------- analysis (click) ----------
  function wrapFirst(term, zh) {
    const lower = term.toLowerCase();
    for (const node of textNodes()) {
      if (node.parentElement.closest('.dsh-term')) continue;
      const idx = node.nodeValue.toLowerCase().indexOf(lower);
      if (idx < 0) continue;
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + term.length);
      const span = document.createElement('span');
      span.className = 'dsh-term';
      span.dataset.zh = zh;
      try {
        range.surroundContents(span);
        return true;
      } catch (_) {
        return false; // phrase crosses inline elements; skip it
      }
    }
    return false;
  }

  async function analyze() {
    const nodes = textNodes().filter(n => /[A-Za-z]{3,}/.test(n.nodeValue));
    const chunks = [];
    let cur = '';
    for (const n of nodes) {
      const t = n.nodeValue.trim();
      if (cur && cur.length + t.length > 4000) { chunks.push(cur); cur = ''; }
      cur += t + '\n';
    }
    if (cur) chunks.push(cur);

    const MAX_CHUNKS = 8; // cost limit per click
    const todo = chunks.slice(0, MAX_CHUNKS);
    let marked = 0;
    for (let i = 0; i < todo.length; i++) {
      showToast(`分析中 ${i + 1}/${todo.length}…`);
      const res = await chrome.runtime.sendMessage({ type: 'annotate', text: todo[i] });
      if (!res || res.error) {
        showToast('分析失败：' + (res && res.error ? res.error : '无响应'), 6000);
        return;
      }
      for (const it of res.items) {
        const term = it.text.trim();
        if (term && it.zh && wrapFirst(term, it.zh.trim())) marked++;
      }
    }
    const note = chunks.length > MAX_CHUNKS ? `（仅分析前 ${MAX_CHUNKS} 段）` : '';
    showToast(`完成：已标注 ${marked} 个词条${note}。悬停任意单词查看释义。`, 6000);
  }

  // ---------- hover ----------
  function caretAt(x, y) {
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      return p ? { node: p.offsetNode, offset: p.offset } : null;
    }
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      return r ? { node: r.startContainer, offset: r.startOffset } : null;
    }
    return null;
  }

  // Annotated phrase under the pointer (from analysis)
  function phraseAt(x, y) {
    const c = caretAt(x, y);
    if (!c) return null;
    const base = c.node.nodeType === Node.ELEMENT_NODE ? c.node : c.node.parentElement;
    const el = base && base.closest('.dsh-term');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom ? el : null;
  }

  // Any English word under the pointer
  function wordAt(x, y) {
    const c = caretAt(x, y);
    if (!c || c.node.nodeType !== Node.TEXT_NODE) return null;
    const text = c.node.nodeValue;
    WORD_RE.lastIndex = 0;
    let m;
    while ((m = WORD_RE.exec(text))) {
      const s = m.index;
      const e = s + m[0].length;
      if (c.offset < s || c.offset > e) continue;
      const word = m[0].replace(/[-'’]+$/, '');
      if (!word) return null;
      const range = document.createRange();
      range.setStart(c.node, s);
      range.setEnd(c.node, s + word.length);
      const r = range.getBoundingClientRect();
      if (x < r.left - 2 || x > r.right + 2 || y < r.top - 2 || y > r.bottom + 2) return null;
      return { word, range, context: text.trim().slice(0, 240) };
    }
    return null;
  }

  // Nearest block-level ancestor: sentences are split within it, so they can span inline tags
  function blockOf(node) {
    let el = node.parentElement;
    while (el && el !== document.body && !BLOCK_TAGS.has(el.tagName)) el = el.parentElement;
    return el || document.body;
  }

  function textNodesIn(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        for (let el = p; el; el = el.parentElement) {
          if (SKIP_TAGS.has(el.tagName) || el.isContentEditable || isInsideOurUI(el)) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const out = [];
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  // If position i in s is the end of a sentence, return the index just after it (including closing quotes); else -1
  function boundaryEnd(s, i) {
    const ch = s[i];
    if (!/[.!?。！？]/.test(ch)) return -1;
    let j = i + 1;
    while (j < s.length && CLOSERS.includes(s[j])) j++;
    if (/[。！？]/.test(ch)) return j;
    // Must be followed by whitespace or end of block: rules out decimals like "2.2" and "U.S.A"
    if (j < s.length && !/\s/.test(s[j])) return -1;
    if (ch === '.') {
      const before = /([A-Za-z.]+)$/.exec(s.slice(0, i));
      if (before) {
        const w = before[1];
        if (w.length === 1 || ABBR.has(w.toLowerCase())) return -1; // "J. Smith", "e.g.", "Dr."
      }
    }
    return j;
  }

  // Sentence under the pointer, using the whole block's text so sentences can cross inline tags
  function sentenceAt(x, y) {
    const c = caretAt(x, y);
    if (!c || c.node.nodeType !== Node.TEXT_NODE) return null;
    const nodes = textNodesIn(blockOf(c.node));
    const k = nodes.indexOf(c.node);
    if (k < 0) return null;

    const starts = [];
    let full = '';
    for (const n of nodes) { starts.push(full.length); full += n.nodeValue; }
    const p = starts[k] + Math.min(c.offset, c.node.nodeValue.length);

    // Start: after the last sentence boundary before the caret
    let a = 0;
    for (let i = p - 1; i >= 0; i--) {
      const be = boundaryEnd(full, i);
      if (be >= 0) { a = be; break; }
    }
    // End: after the first sentence boundary at or after the caret
    let b = full.length;
    for (let i = p; i < full.length; i++) {
      const be = boundaryEnd(full, i);
      if (be >= 0) { b = be; break; }
    }
    while (a < b && /\s/.test(full[a])) a++;
    while (b > a && /\s/.test(full[b - 1])) b--;
    const sentence = full.slice(a, b);
    if (!sentence || !/[A-Za-z]{2,}/.test(sentence)) return null;

    // Map global offsets back to DOM positions
    const locate = (pos, isEnd) => {
      for (let idx = 0; idx < nodes.length; idx++) {
        const s0 = starts[idx];
        const len = nodes[idx].nodeValue.length;
        if (pos < s0 + len || (isEnd && pos === s0 + len)) return { node: nodes[idx], offset: pos - s0 };
      }
      return null;
    };
    const from = locate(a, false);
    const to = locate(b, true);
    if (!from || !to) return null;
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);

    // Only treat it as hovered if the pointer is actually over the sentence's text
    const over = Array.from(range.getClientRects()).some(r =>
      x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2);
    if (!over) return null;
    return { text: sentence.slice(0, 1200), range };
  }

  function place() {
    const pad = 14;
    const r = tip.getBoundingClientRect();
    let left = mx + pad;
    let top = my + pad + 4;
    if (left + r.width > innerWidth - 8) left = innerWidth - r.width - 8;
    if (top + r.height > innerHeight - 8) top = my - r.height - pad;
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = Math.max(8, top) + 'px';
  }

  function showTip(title, body, isPhrase) {
    tip.textContent = '';
    const b = document.createElement('b');
    b.textContent = title;
    const s = document.createElement('span');
    s.textContent = body;
    tip.append(b, s);
    tip.classList.toggle('phrase', !!isPhrase);
    tip.style.display = 'block';
    place();
  }

  function hideTip() {
    tip.style.display = 'none';
    lastKey = '';
    sentKey = '';
    if (hasHL) CSS.highlights.delete('dsh-hover');
  }

  // Shift mode: show the Chinese translation of the sentence under the pointer
  function sentenceMode(x, y) {
    const s = sentenceAt(x, y);
    if (!s) { hideTip(); return; }
    const key = s.text;
    setHL(s.range);
    if (key === sentKey) { place(); return; }
    sentKey = key;
    lastKey = '';
    if (sentCache.has(key)) {
      showTip('句意', sentCache.get(key), false);
      return;
    }
    showTip('句意', '翻译中…', false);
    const id = ++reqId;
    try {
      chrome.runtime.sendMessage({ type: 'sentence', text: key }, res => {
        if (id !== reqId || sentKey !== key) return; // stale response
        if (chrome.runtime.lastError) {
          // Usually: the extension was reloaded and this page needs a refresh
          showTip('句意', '失败：' + chrome.runtime.lastError.message, false);
        } else if (!res) {
          showTip('句意', '失败：后台无响应', false);
        } else if (res.error) {
          showTip('句意', '失败：' + res.error, false);
        } else {
          sentCache.set(key, res.zh);
          showTip('句意', res.zh, false);
        }
      });
    } catch (err) {
      // Thrown when this content script is orphaned by an extension reload
      showTip('句意', '失败：请刷新页面后重试（' + err.message + '）', false);
    }
  }

  function setHL(range) {
    if (hasHL) CSS.highlights.set('dsh-hover', new Highlight(range));
  }

  document.addEventListener('mousemove', e => {
    mx = e.clientX;
    my = e.clientY;

    // Hold Shift: sentence meaning mode
    if (e.shiftKey) { sentenceMode(mx, my); return; }
    sentKey = '';

    const term = phraseAt(mx, my);
    if (term) {
      lastKey = '';
      const r = document.createRange();
      r.selectNodeContents(term);
      setHL(r);
      showTip(term.textContent, term.dataset.zh, true);
      return;
    }

    const w = wordAt(mx, my);
    if (!w) { hideTip(); return; }

    const key = w.word.toLowerCase();
    if (key === lastKey) { place(); return; }
    lastKey = key;
    setHL(w.range);

    if (memCache.has(key)) {
      showTip(w.word, memCache.get(key), false);
      return;
    }
    showTip(w.word, '查询中…', false);
    const id = ++reqId;
    chrome.runtime.sendMessage({ type: 'lookup', word: w.word, context: w.context }, res => {
      if (id !== reqId || lastKey !== key) return; // stale response
      if (chrome.runtime.lastError || !res) {
        showTip(w.word, '查询失败', false);
      } else if (res.error) {
        showTip(w.word, '错误：' + res.error, false);
      } else {
        memCache.set(key, res.zh);
        showTip(w.word, res.zh, false);
      }
    });
  });

  document.addEventListener('scroll', hideTip, true);

  // Pressing Shift switches to sentence mode immediately; releasing returns to word mode
  document.addEventListener('keydown', e => {
    if (e.key === 'Shift' && !e.repeat) sentenceMode(mx, my);
  });
  document.addEventListener('keyup', e => {
    if (e.key === 'Shift') hideTip();
  });
  window.addEventListener('blur', hideTip);

  // Started by the popup after injection
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'start') {
      analyze().catch(err => showToast('分析出错：' + err.message, 6000));
      sendResponse({ ok: true });
    }
    return false;
  });
})();
