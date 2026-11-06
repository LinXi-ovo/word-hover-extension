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
  let lastHover = null;
  let sentKey = '';
  let chunkKey = ''; // Ctrl mode: word|context currently being shown
  let renderedChunkKey = '';
  let reqId = 0;
  let modelEpoch = 0;
  let mx = 0, my = 0;
  let anchorRect = null;

  // User switches (popup). Both default to on; changes apply live via storage.onChanged.
  // dbgSentence / dbgChunk: show sentence meaning / constituent on hover without holding Shift / Ctrl (debug).
  // hoverScope: 'word' = words and annotated phrases; 'phrase' = annotated phrases only.
  const SWITCHES = ['hoverEnabled', 'shiftEnabled', 'ctrlEnabled', 'dbgSentence', 'dbgChunk', 'hoverScope'];
  const DEFAULT_SETTINGS = { hoverEnabled: true, shiftEnabled: true, ctrlEnabled: true, dbgSentence: false, dbgChunk: false, hoverScope: 'word' };
  const settings = { ...DEFAULT_SETTINGS };
  chrome.storage.local.get(DEFAULT_SETTINGS).then(s => Object.assign(settings, s));
  // Only switch changes affect the hover state. Cache writes (sentence/chunk results) also fire this
  // event, and hiding the tip on them would clear the in-flight key and drop the answer as "stale".
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (['apiKey', 'endpoint', 'model', 'activePresetId'].some(k => k in changes)) {
      modelEpoch++;
      reqId++;
      memCache.clear();
      sentCache.clear();
      segCache.clear();
      hideTip();
      for (const term of document.querySelectorAll('span.dsh-term[data-zh]')) {
        term.replaceWith(...Array.from(term.childNodes));
      }
    }
    const switched = SWITCHES.filter(k => k in changes);
    if (!switched.length) return;
    switched.forEach(k => { settings[k] = changes[k].newValue; });
    hideTip();
  });

  const tip = document.createElement('div');
  tip.id = 'dsh-tip';
  const toast = document.createElement('div');
  toast.id = 'dsh-toast';
  document.documentElement.append(tip, toast);

  const hasHL = typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight !== 'undefined';

  // ---------- helpers ----------
  // A newer message cancels the auto-hide of an older one, so phase-2 status is not hidden by phase-1 timers
  let toastTimer = null;
  function showToast(msg, ms = 0) {
    toast.textContent = msg;
    toast.style.display = 'block';
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => { toast.style.display = 'none'; }, ms);
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

  async function analyze(force = false) {
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
      const res = await chrome.runtime.sendMessage({ type: 'annotate', text: todo[i], force });
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
    // Phase 1 is done and rendered. Phase 2 (constituents for the whole article) runs after it.
    segmentArticle(`已标注 ${marked} 个词条${note}。悬停任意单词查看释义。`, force);
  }

  // Sentences of the page, split the same way sentenceAt() splits them, so cache keys line up with Ctrl lookups
  function collectSentences() {
    const groups = new Map(); // block element -> its text nodes, in order
    for (const n of textNodes()) {
      const b = blockOf(n);
      if (!groups.has(b)) groups.set(b, []);
      groups.get(b).push(n);
    }
    const seen = new Set();
    const out = [];
    const push = (full, a, b) => {
      let s = full.slice(a, b);
      s = s.replace(/^\s+/, '').replace(/\s+$/, '');
      if (s.length < 3 || !/[A-Za-z]{2,}/.test(s) || seen.has(s)) return;
      seen.add(s);
      out.push(s.slice(0, 1200));
    };
    for (const nodes of groups.values()) {
      let full = '';
      for (const n of nodes) full += n.nodeValue;
      let a = 0;
      for (let i = 0; i < full.length; i++) {
        const be = boundaryEnd(full, i);
        if (be >= 0) { push(full, a, be); a = be; }
      }
      push(full, a, full.length);
    }
    return out;
  }

  // Phase 2: send the article's sentences to the background once; it splits them into constituents and caches
  // each sentence, so Ctrl hovering needs no per-sentence request afterwards.
  const MAX_DOC_SENTENCES = 240;
  // prefix: phase-1 result, kept on screen together with the phase-2 status
  function segmentArticle(prefix = '', force = false) {
    const epoch = modelEpoch;
    const sents = collectSentences().slice(0, MAX_DOC_SENTENCES);
    if (!sents.length) { showToast(prefix, 8000); return; }
    showToast(`${prefix}成分分析中（${sents.length} 句，后台进行）…`);
    askBg({ type: 'segmentDoc', sentences: sents, force }, res => {
      if (epoch !== modelEpoch) return;
      if (res.error) { showToast(`${prefix}成分分析失败：${res.error}`, 8000); return; }
      let refreshCurrent = false;
      for (const [sentence, segments] of Object.entries(res.segmentsBySentence || {})) {
        segCache.set(sentence, segments);
        if (chunkKey.startsWith(sentence + '#')) refreshCurrent = true;
      }
      if (refreshCurrent) { renderedChunkKey = ''; chunkMode(mx, my); }
      const miss = res.total - res.done;
      showToast(`${prefix}成分已就绪：${res.done}/${res.total} 句${miss ? `（${miss} 句未成功，悬停时会单独重试）` : ''}。按住 Ctrl 悬停查看。`, 8000);
    });
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
    const a = anchorRect || { right: mx, bottom: my, left: mx, top: my };
    let left = a.right + pad;
    let top = a.bottom + 4;
    if (left + r.width > innerWidth - 8) left = innerWidth - r.width - 8;
    if (top + r.height > innerHeight - 8) top = a.top - r.height - pad;
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
    lastHover = null;
    lastTerm = null;
    sentKey = '';
    chunkKey = '';
    renderedChunkKey = '';
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
    const epoch = modelEpoch;
    try {
      askBg({ type: 'sentence', text: key }, res => {
        if (epoch !== modelEpoch || id !== reqId || sentKey !== key) return; // stale response
        if (res.error) {
          // Usually: the extension was reloaded and this page needs a refresh
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

  // Ctrl mode: meaning of the phrase/collocation containing the word under the pointer
  // DOM range for character offsets [from, to) of a base range's text (offsets count like Range.toString())
  function rangeFromOffsets(base, from, to) {
    if (!base.startContainer || base.startContainer.nodeType !== Node.TEXT_NODE) return null;
    const walker = document.createTreeWalker(base.commonAncestorContainer, NodeFilter.SHOW_TEXT);
    walker.currentNode = base.startContainer;
    let pos = 0, node = base.startContainer, sNode = null, sOff = 0, eNode = null, eOff = 0;
    while (node) {
      const from0 = node === base.startContainer ? base.startOffset : 0;
      const len = node.nodeValue.length - from0;
      if (!sNode && from < pos + len) { sNode = node; sOff = from0 + (from - pos); }
      if (sNode && to <= pos + len) { eNode = node; eOff = from0 + (to - pos); break; }
      pos += len;
      node = walker.nextNode();
    }
    if (!sNode || !eNode) return null;
    const r = document.createRange();
    r.setStart(sNode, sOff);
    r.setEnd(eNode, eOff);
    return r;
  }

  // Whole paragraph text around the word. Analysis wraps phrases in <span>, which splits text nodes,
  // so a single text node may hold only a fragment of the sentence.
  function paragraphContext(node) {
    return blockOf(node).textContent.replace(/\s+/g, ' ').trim().slice(0, 800);
  }

  // The sentence the word belongs to (the same split as Shift/Ctrl). Falls back to the paragraph text.
  function sentenceOfWord(w, x, y) {
    const s = sentenceAt(x, y);
    return s ? s.text : paragraphContext(w.range.startContainer);
  }

  // Ctrl mode: split the hovered sentence into constituents (one request per sentence, cached), then show the
  // meaning of the constituent that contains the word under the pointer. Every word in a constituent shares it.
  const segCache = new Map(); // sentence -> segments (page-level), or 'pending' promise
  function chunkMode(x, y) {
    const s = sentenceAt(x, y);
    const w = wordAt(x, y);
    if (!s || !w) { chunkKey = ''; hideTip(); return; }

    // Offset of the word inside the sentence text (both measured in raw DOM text)
    const pre = document.createRange();
    pre.setStart(s.range.startContainer, s.range.startOffset);
    pre.setEnd(w.range.startContainer, w.range.startOffset);
    const wordOffset = pre.toString().length;
    if (wordOffset < 0 || wordOffset >= s.text.length) { hideTip(); return; }

    const key = s.text;
    const nextChunkKey = key + '#' + wordOffset;
    if (renderedChunkKey === nextChunkKey && tip.style.display === 'block') return;
    chunkKey = nextChunkKey;

    const show = segments => {
      const seg = segments.find(g => wordOffset >= g.start && wordOffset < g.end);
      if (!seg) { showTip(w.word, '未找到所在成分', false); return; }
      const r = rangeFromOffsets(s.range, seg.start, seg.end);
      if (r) setHL(r);
      else if (hasHL) CSS.highlights.delete('dsh-hover');
      showTip(seg.text.length > 60 ? seg.text.slice(0, 60) + '…' : seg.text, seg.zh, true);
      renderedChunkKey = nextChunkKey;
    };

    if (segCache.has(key) && Array.isArray(segCache.get(key))) {
      show(segCache.get(key));
      return;
    }
    anchorRect = w.range.getBoundingClientRect();
    if (hasHL) CSS.highlights.delete('dsh-hover');
    showTip(w.word, '分析成分中…', false);
    if (segCache.get(key) === 'pending') return; // the reply will show the tip for the current pointer

    segCache.set(key, 'pending');
    const epoch = modelEpoch;
    askBg({ type: 'segment', sentence: key }, res => {
      if (epoch !== modelEpoch) return;
      if (res.error) {
        segCache.delete(key);
        if (chunkKey.startsWith(key + '#')) showTip(w.word, '失败：' + res.error, false);
        return;
      }
      segCache.set(key, res.segments);
      // Show whatever word the pointer is on now, not the one that triggered the request
      const cur = chunkKey;
      if (cur.startsWith(key + '#')) {
        const off = Number(cur.slice(key.length + 1));
        const seg = res.segments.find(g => off >= g.start && off < g.end);
        if (seg) {
          const r = rangeFromOffsets(s.range, seg.start, seg.end);
          if (r) setHL(r);
          else if (hasHL) CSS.highlights.delete('dsh-hover');
          showTip(seg.text.length > 60 ? seg.text.slice(0, 60) + '…' : seg.text, seg.zh, true);
          renderedChunkKey = cur;
        }
      }
    });
  }

  // Requests to the background. If the background queued the job for a later retry (provider limit),
  // the answer arrives later as a 'result' message with the same id; cb is called once in either case.
  const pendingJobs = new Map(); // job id -> callback
  function askBg(msg, cb) {
    chrome.runtime.sendMessage(msg, res => {
      if (chrome.runtime.lastError) return cb({ error: chrome.runtime.lastError.message });
      if (res && res.queued) { pendingJobs.set(res.id, cb); return; }
      cb(res || { error: '后台无响应' });
    });
  }
  chrome.runtime.onMessage.addListener(msg => {
    if (msg && msg.type === 'result' && pendingJobs.has(msg.id)) {
      const cb = pendingJobs.get(msg.id);
      pendingJobs.delete(msg.id);
      cb(msg.ok ? msg.data : { error: msg.error });
    }
    return false;
  });

  function setHL(range) {
    if (range) anchorRect = range.getBoundingClientRect();
    if (hasHL) CSS.highlights.set('dsh-hover', new Highlight(range));
  }

  document.addEventListener('mousemove', e => {
    mx = e.clientX;
    my = e.clientY;
    // Sentence meaning: holding Shift, or the debug switch "直接显示句意"
    if (settings.shiftEnabled && (e.shiftKey || settings.dbgSentence)) { lastHover = null; sentenceMode(mx, my); return; }
    sentKey = '';

    // Constituent meaning: holding Ctrl, or the debug switch "直接显示成分"
    if (settings.ctrlEnabled && (e.ctrlKey || settings.dbgChunk)) { lastHover = null; chunkMode(mx, my); return; }
    chunkKey = '';

    if (!settings.hoverEnabled) { hideTip(); return; }

    const term = phraseAt(mx, my);
    if (term) {
      lastKey = '';
      lastHover = null;
      // Same phrase still under the pointer: do not rewrite the highlight or the tip on every mouse move
      if (term !== lastTerm) {
        lastTerm = term;
        const r = document.createRange();
        r.selectNodeContents(term);
        setHL(r);
        showTip(term.textContent, term.dataset.zh, true);
      }
      return;
    }
    lastTerm = null;

    // Scope "phrase": annotated phrases only, no single-word hover
    if (settings.hoverScope === 'phrase') { lastKey = ''; hideTip(); return; }

    const w = wordAt(mx, my);
    if (!w) {
      hideTip();
      return;
    }

    // A mouse move within the same word needs no sentence scan or redraw.
    const hover = { node: w.range.startContainer, offset: w.range.startOffset, word: w.word };
    if (lastHover && lastHover.node === hover.node && lastHover.offset === hover.offset && lastHover.word === hover.word) return;
    lastHover = hover;

    // Cache key is word + its sentence. The cache is shared across the whole page, so the same word in
    // the same sentence is looked up once, while the same word in another sentence gets its own meaning.
    w.context = sentenceOfWord(w, mx, my);
    const key = w.word.toLowerCase() + '|' + w.context;
    // Same word still under the pointer: do nothing, so the tip is not rewritten on every mouse move
    if (key === lastKey) { setHL(w.range); place(); return; }
    lastKey = key;
    setHL(w.range);

    // Update the visible word immediately; the network response arrives asynchronously.
    if (memCache.has(key)) { showTip(w.word, memCache.get(key), false); return; }
    showWordMeaning(w, key, false);
  });

  let lastTerm = null; // phrase element currently shown, so repeated mouse moves over it do not repaint

  // Word meaning in context. force=true ignores the cache (used by middle-click refresh).
  function showWordMeaning(w, key, force) {
    if (!force && memCache.has(key)) {
      showTip(w.word, memCache.get(key), false);
      return;
    }
    showTip(w.word, '查询中…', false);
    const id = ++reqId;
    const epoch = modelEpoch;
    askBg({ type: 'lookup', word: w.word, context: w.context, force: !!force }, res => {
      if (epoch !== modelEpoch) return;
      if (id !== reqId || lastKey !== key) return; // stale response
      if (res.error) {
        showTip(w.word, '错误：' + res.error, false);
      } else {
        memCache.set(key, res.zh);
        showTip(w.word, res.zh, false);
      }
    });
  }

  // Middle-click a word: drop its cached meaning for this sentence and query again
  function refreshWordAt(x, y) {
    const w = wordAt(x, y);
    if (!w) return false;
    mx = x; my = y;
    w.context = sentenceOfWord(w, x, y);
    const key = w.word.toLowerCase() + '|' + w.context;
    memCache.delete(key);
    lastKey = key;
    setHL(w.range);
    showWordMeaning(w, key, true);
    return true;
  }
  // preventDefault stops the browser's middle-click auto-scroll and link-opening on words
  document.addEventListener('mousedown', e => {
    if (e.button === 1 && refreshWordAt(e.clientX, e.clientY)) e.preventDefault();
  }, true);
  document.addEventListener('auxclick', e => {
    if (e.button === 1 && wordAt(e.clientX, e.clientY)) e.preventDefault();
  }, true);

  document.addEventListener('scroll', hideTip, true);

  // Pressing Shift switches to sentence mode immediately; releasing returns to word mode
  document.addEventListener('keydown', e => {
    if (e.key === 'Shift' && !e.repeat && settings.shiftEnabled) sentenceMode(mx, my);
    if (e.key === 'Control' && !e.repeat && settings.ctrlEnabled) chunkMode(mx, my);
  });
  document.addEventListener('keyup', e => {
    if (e.key === 'Shift' || e.key === 'Control') hideTip();
  });
  window.addEventListener('blur', hideTip);

  // Started by the popup after injection
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'start') {
      analyze(!!msg.force).catch(err => showToast('分析出错：' + err.message, 6000));
      sendResponse({ ok: true });
    }
    return false;
  });
})();
