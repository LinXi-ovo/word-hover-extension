// Injected into the current page on demand (by the popup button).
(() => {
  if (window.__dshWordLoaded) return; // already injected: the existing listener handles 'start'
  window.__dshWordLoaded = true;

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'CODE', 'PRE', 'SVG', 'CANVAS', 'SELECT', 'BUTTON']);
  const memCache = new Map(); // word -> zh, for this page only
  const WORD_RE = /[A-Za-z][A-Za-z'’-]*/g;
  let lastKey = '';
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
    if (hasHL) CSS.highlights.delete('dsh-hover');
  }

  function setHL(range) {
    if (hasHL) CSS.highlights.set('dsh-hover', new Highlight(range));
  }

  document.addEventListener('mousemove', e => {
    mx = e.clientX;
    my = e.clientY;

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

  // Started by the popup after injection
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'start') {
      analyze().catch(err => showToast('分析出错：' + err.message, 6000));
      sendResponse({ ok: true });
    }
    return false;
  });
})();
