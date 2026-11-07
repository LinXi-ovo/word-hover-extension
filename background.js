// Service worker: the only place that talks to the LLM API (keeps the API key out of page scripts).
const DEFAULTS = { endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat' };
const isLocal = url => {
  try { return ['localhost', '127.0.0.1'].includes(new URL(url).hostname); }
  catch (_) { return false; }
};
const authHeaders = cfg => cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {};
async function cacheScope() {
  const cfg = await chrome.storage.local.get({ endpoint: DEFAULTS.endpoint, model: DEFAULTS.model });
  return hashKey(normalizeEndpoint(cfg.endpoint) + '|' + cfg.model);
}

// Short, stable cache key for long context text (FNV-1a, 32-bit)
function hashKey(s) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
  return (x >>> 0).toString(36);
}

// ---------- cache: lifetime grows with how many times the AI confirmed the same value ----------
// Entry: { v: value, count: times the AI returned this same value, at: last AI confirmation time }.
// One confirmation lives 12 h; each extra confirmation doubles that, capped at 60 days.
// A different answer from the AI replaces the value and resets count to 1.
const HOUR = 3600000;
function cacheLife(count) {
  return Math.min(60 * 24 * HOUR, 12 * HOUR * 2 ** Math.min(Math.max(count, 1) - 1, 8));
}
function isFresh(entry) {
  return !!entry && typeof entry === 'object' && 'v' in entry && Date.now() - entry.at <= cacheLife(entry.count);
}
async function cacheGetRaw(key) {
  return (await chrome.storage.local.get(key))[key] || null;
}
async function cacheSave(key, value, prev) {
  const same = !!prev && typeof prev === 'object' && 'v' in prev && JSON.stringify(prev.v) === JSON.stringify(value);
  await chrome.storage.local.set({ [key]: { v: value, count: same ? prev.count + 1 : 1, at: Date.now() } });
}

// ---------- retry queue: jobs that still hit a provider limit are retried later and pushed back to the tab ----------
const MAX_RETRY = 6;
const MAX_QUEUE = 200;
let queuedJobs = 0;

function isLimited(err) {
  return /tier_limit_exceeded|concurrency limit|rate.?limit|\b429\b|返回空内容|没有 choices|finish_reason=undefined/i.test(String(err && err.message));
}

async function runKind(kind, payload, tries) {
  if (kind === 'lookup') return lookupCore(payload, tries);
  if (kind === 'sentence') return sentenceCore(payload, tries);
  if (kind === 'segment') return segmentCore(payload, tries);
  throw new Error('未知任务类型 ' + kind);
}

// Run now; if a limit error still happens and the request came from a tab, queue it for later retry
async function dispatch(kind, payload, sender) {
  try {
    return await runKind(kind, payload, 2);
  } catch (err) {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (!isLimited(err) || tabId == null) throw err;
    if (queuedJobs >= MAX_QUEUE) throw new Error('重试队列已满，请稍后再试');
    const job = { id: 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), kind, payload, tabId, attempts: 0 };
    queuedJobs++;
    scheduleRetry(job);
    return { queued: true, id: job.id };
  }
}

function scheduleRetry(job) {
  job.attempts++;
  const delay = Math.min(120000, 3000 * 2 ** (job.attempts - 1)); // 3s, 6s, 12s, 24s, 48s, 96s
  setTimeout(async () => {
    try {
      const data = await runKind(job.kind, job.payload, 1);
      finishJob(job, { ok: true, data });
    } catch (err) {
      if (isLimited(err) && job.attempts < MAX_RETRY) scheduleRetry(job);
      else finishJob(job, { ok: false, error: err.message });
    }
  }, delay);
}

function finishJob(job, body) {
  if (job.kind) queuedJobs--;
  chrome.tabs.sendMessage(job.tabId, { type: 'result', id: job.id, ...body }).catch(() => {});
}

// ---------- batched segmentation: one request per block of sentences, streamed back block by block ----------
const SEG_BLOCK = 15;      // sentences per request
const SEG_BLOCK_RETRY = 2; // a failed block is retried this many times before it is reported as failed

// Split a block of sentences in one request. Returns { [sentence]: segments } for the sentences that aligned.
async function segmentBlock(sentences, tries) {
  const numbered = sentences.map((s, i) => `[${i}] ${s}`).join('\n');
  const out = await callJSON(
    'Split each numbered English sentence below into consecutive constituents that together cover every word, ' +
    'in order, without overlap. A constituent is a grammatical unit larger than a phrase and smaller than the sentence: ' +
    'a noun phrase with its modifiers, a coordinated structure, a subordinate clause, a prepositional or with-phrase adverbial, ' +
    'or a verb phrase with its object or complement. ' +
    'Each "text" must be copied exactly from that sentence. Each "zh" is a short Chinese gloss of the unit, at most 25 characters. ' +
    'Return JSON {"sentences":[{"i":0,"units":[{"text":"...","zh":"..."}]}]} covering every input sentence.\n\nSENTENCES:\n' + numbered,
    32768, SYS_SEG, tries
  );
  const map = {};
  const list = Array.isArray(out.sentences) ? out.sentences : [];
  for (const item of list) {
    const idx = Number(item && item.i);
    if (!Number.isInteger(idx) || idx < 0 || idx >= sentences.length) continue;
    const sentence = sentences[idx];
    const segs = alignSegments(sentence, item && item.units);
    if (segs) map[sentence] = segs;
  }
  return map;
}

// One block with cache lookups; only sentences not already cached go to the model
async function segmentBlockCached(sentences, force, tries) {
  const scope = await cacheScope();
  const result = {};
  const need = [];
  for (const s of sentences) {
    const key = 'seg3:' + scope + ':' + s.length + '.' + hashKey(s);
    const prev = await cacheGetRaw(key);
    if (!force && isFresh(prev)) { result[s] = prev.v; continue; }
    need.push({ s, key, prev });
  }
  if (need.length) {
    const got = await segmentBlock(need.map(n => n.s), tries);
    for (const n of need) {
      const segs = got[n.s];
      if (!segs) continue;
      await cacheSave(n.key, segs, n.prev);
      result[n.s] = segs;
    }
  }
  return result;
}

// Whole-article segmentation, streamed: each successful block is pushed to the tab immediately; a block that still
// fails after its retries is queued for a later pass (added to the end) instead of blocking the rest.
async function segmentDocJob(sentences, job) {
  const blocks = [];
  for (let i = 0; i < sentences.length; i += SEG_BLOCK) blocks.push(sentences.slice(i, i + SEG_BLOCK));
  let done = 0;
  let next = 0;
  const deferred = []; // failed blocks, retried after the first pass
  const total = sentences.length;

  const send = data => {
    chrome.tabs.sendMessage(job.tabId, {
      type: 'part', id: job.id,
      segmentsBySentence: Object.fromEntries(Object.entries(data).map(([s, segs]) => [s, segs])),
      done, total
    }).catch(() => {});
  };

  const worker = async pool => {
    while (next < pool.length) {
      const block = pool[next++];
      let got = null;
      for (let attempt = 1; attempt <= SEG_BLOCK_RETRY && !got; attempt++) {
        try {
          got = await segmentBlockCached(block, !!job.force, 1);
        } catch (err) {
          if (attempt === SEG_BLOCK_RETRY) { deferred.push(block); break; }
          await sleep(1500 * attempt);
        }
      }
      if (got && Object.keys(got).length) {
        done += Object.keys(got).length;
        send(got); // stream this block to the page now
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, blocks.length) }, () => worker(blocks)));

  // Second pass: blocks that failed are retried at the end, one attempt each
  if (deferred.length) {
    for (const block of deferred) {
      try {
        const got = await segmentBlockCached(block, false, 1);
        if (got && Object.keys(got).length) {
          done += Object.keys(got).length;
          send(got);
        }
      } catch (_) { /* still failing: leave for a later Ctrl hover */ }
    }
  }
  return { done, total };
}

function startSegmentDoc(msg, sender) {
  const sentences = (Array.isArray(msg.sentences) ? msg.sentences : []).map(s => String(s || '').trim()).filter(Boolean);
  const tabId = sender && sender.tab ? sender.tab.id : null;
  if (!sentences.length) return Promise.resolve({ done: 0, total: 0 });
  if (tabId == null) return Promise.reject(new Error('缺少标签页信息'));
  const job = { id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), tabId, force: !!msg.force };
  segmentDocJob(sentences, job).then(data => finishJob(job, { ok: true, data }))
    .catch(err => finishJob(job, { ok: false, error: err.message }));
  return Promise.resolve({ queued: true, id: job.id, total: sentences.length });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  let task = null;
  if (msg.type === 'lookup') task = dispatch('lookup', msg, sender);
  if (msg.type === 'annotate') task = annotateCached(msg);
  if (msg.type === 'sentence') task = dispatch('sentence', msg, sender);
  if (msg.type === 'segment') task = dispatch('segment', msg, sender);
  if (msg.type === 'segmentDoc') task = startSegmentDoc(msg, sender);
  if (msg.type === 'fillWords') task = startFillWords(msg, sender);
  // Settings-page tools: they use the form values passed in msg.cfg (not yet saved)
  if (msg.type === 'listModels') task = listModels(msg);
  if (msg.type === 'testConnection') task = testConnection(msg);
  if (msg.type === 'pingOnce') task = pingOnce(msg); // one short request per message (speed test loops in the popup)
  if (msg.type === 'version') task = Promise.resolve({ version: chrome.runtime.getManifest().version });
  if (!task) {
    // Unknown message: always answer, otherwise the popup sees "message port closed"
    sendResponse({ error: '后台不认识消息类型 "' + msg.type + '"，请到 chrome://extensions 重新加载扩展' });
    return false;
  }
  task.then(sendResponse).catch(err => sendResponse({ error: err.message }));
  return true; // keep the channel open for the async response
});

// Accept either a base URL (e.g. https://host/v1) or a full chat-completions URL.
function normalizeEndpoint(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) return DEFAULTS.endpoint;
  if (/\/chat\/completions$/.test(u)) return u;
  return u + '/chat/completions';
}

// One system prompt per job, so word, sentence, constituent and annotation requests do not interfere
const SYS_DEFAULT = 'You are a precise English-to-Chinese assistant. Reply with a single JSON object.';
const SYS_WORD = 'You are an English dictionary for learners. Give the Chinese meaning of a word exactly as it is used in the given sentence. Reply with one JSON object.';
const SYS_SENT = 'You are a professional English-to-Chinese translator. Translate faithfully and naturally. Reply with one JSON object.';
const SYS_CHUNK = 'You are an English grammar analyst. You identify phrases and constituents, copy them exactly from the text, and explain their Chinese meaning in context. Reply with one JSON object.';
const SYS_ANNOT = 'You are an English vocabulary teacher choosing items worth learning from a text. Copy items exactly from the text. Reply with one JSON object.';

// Concurrency gate: hover, sentence, constituent and analysis requests can fire together and exceed the
// provider's concurrent-request limit (HTTP 400 tier_limit_exceeded). Keep at most MAX_CONCURRENT in flight.
const MAX_CONCURRENT = 3;
let inFlight = 0;
const waiting = [];
function acquire() {
  if (inFlight < MAX_CONCURRENT) { inFlight++; return Promise.resolve(); }
  return new Promise(resolve => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next(); else inFlight--;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Retry limit errors a few times inline (releasing the concurrency slot while backing off);
// longer waits are handled by the retry queue in dispatch()
// tries: inline attempts. Hover requests use 2; queued retries use 1 so one job does not multiply into many calls.
async function callJSON(prompt, maxTokens = 4096, system = SYS_DEFAULT, tries = 2) {
  for (let attempt = 1; ; attempt++) {
    await acquire();
    try {
      return await requestJSON(prompt, maxTokens, system);
    } catch (err) {
      if (!isLimited(err) || attempt >= tries) throw err;
    } finally {
      release();
    }
    await sleep(1000 * attempt * attempt); // 1s, 4s, 9s
  }
}

async function requestJSON(prompt, maxTokens, system) {
  const cfg = await chrome.storage.local.get({ apiKey: '', endpoint: DEFAULTS.endpoint, model: DEFAULTS.model });
  if (!cfg.apiKey && !isLocal(cfg.endpoint)) throw new Error('未设置 API Key，请点击扩展图标填写');
  const res = await fetch(normalizeEndpoint(cfg.endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(cfg) },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: maxTokens // reasoning models consume output budget; leave room for the JSON answer
    })
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  const choice = data.choices && data.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (!content) throw new Error('模型返回空内容（finish_reason=' + (choice && choice.finish_reason) + '）');
  return JSON.parse(content);
}

// Single word lookup in its context. The cache is keyed by word AND context, so the same word
// in another sentence gets its own meaning. force=true skips the cache (middle-click refresh).
// Keyed by word + the sentence it appears in, so one page reuses the answer for the same word in the same sentence.
// force=true (middle-click refresh) asks the AI again; the cache is then updated by cacheSave().
async function lookupCore({ word, sentence: sent0, context, force }, tries = 2) {
  const sent = String(sent0 || context || '');
  const key = 'w3:' + await cacheScope() + ':' + word.toLowerCase() + '|' + hashKey(sent);
  const prev = await cacheGetRaw(key);
  if (!force && isFresh(prev)) return { zh: prev.v };
  const out = await callJSON(
    `Give a concise Chinese meaning (at most 15 Chinese characters) of the English word "${word}" ` +
    `as it is used in the sentence that contains it, in this text: """${context || sent}""". Return JSON {"zh": "..."}.`,
    4096, SYS_WORD, tries
  );
  const zh = String(out.zh || '').trim() || '暂无释义';
  await cacheSave(key, zh, prev);
  return { zh };
}

// ---------- settings tools: models, connectivity, speed ----------

// Base URL without /chat/completions, e.g. https://host/v1
function baseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '') || 'https://api.deepseek.com';
}

// Merge form values (msg.cfg) over stored settings; form values win when non-empty
async function getCfg(override) {
  const cfg = await chrome.storage.local.get({ apiKey: '', endpoint: DEFAULTS.endpoint, model: DEFAULTS.model });
  if (override) {
    if (override.apiKey) cfg.apiKey = override.apiKey;
    if (override.endpoint) cfg.endpoint = override.endpoint;
    if (override.model) cfg.model = override.model;
  }
  if (!cfg.apiKey && !isLocal(cfg.endpoint)) throw new Error('未填写 API Key');
  return cfg;
}

// fetch with wall-clock timing; reads the body so the timing covers the full response
async function timedFetch(url, init) {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000); // never let one request hang the worker
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('请求超时（60 秒无响应）');
    throw new Error('网络请求失败：' + err.message + '（检查地址是否可访问，或证书/代理问题）');
  } finally {
    clearTimeout(timer);
  }
}

// GET {base}/models
async function listModels(msg) {
  const cfg = await getCfg(msg.cfg);
  const url = baseUrl(cfg.endpoint) + '/models';
  const r = await timedFetch(url, { headers: authHeaders(cfg) });
  if (!r.ok) throw new Error(`获取模型失败 HTTP ${r.status}：${r.text.slice(0, 160)}`);
  let data;
  try { data = JSON.parse(r.text); } catch (_) { throw new Error('模型列表不是 JSON，该接口可能不支持 /models'); }
  const models = Array.isArray(data.data) ? data.data.map(m => m.id).filter(Boolean) : [];
  return { models, ms: r.ms };
}

// One minimal chat request; returns timing and the reply info
async function chatPing(cfg) {
  const r = await timedFetch(normalizeEndpoint(cfg.endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(cfg) },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      max_tokens: 256,
      temperature: 0
    })
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}：${r.text.slice(0, 160)}`);
  let data;
  try { data = JSON.parse(r.text); } catch (_) { throw new Error('响应不是 JSON'); }
  const choice = data.choices && data.choices[0];
  if (!choice) throw new Error('响应中没有 choices，接口格式可能不兼容');
  const reply = (choice.message && choice.message.content) || '';
  return { ms: r.ms, finish: choice.finish_reason, reply, model: data.model || cfg.model };
}

// Connectivity: one request must get a valid chat response
async function testConnection(msg) {
  const cfg = await getCfg(msg.cfg);
  const p = await chatPing(cfg);
  return { ms: p.ms, model: p.model, finish: p.finish, hasText: !!p.reply.trim() };
}

// Speed: a single timed request; the popup repeats this three times
async function pingOnce(msg) {
  const cfg = await getCfg(msg.cfg);
  const p = await chatPing(cfg);
  return { ms: p.ms };
}

// Translate one sentence into natural Chinese, cached in chrome.storage.local
async function sentenceCore({ text }, tries = 2) {
  const key = 's3:' + await cacheScope() + ':' + String(text).length + '.' + hashKey(text);
  const prev = await cacheGetRaw(key);
  if (isFresh(prev)) return { zh: prev.v };
  const out = await callJSON(
    'Translate the English sentence below into natural, accurate Chinese. ' +
    'Return JSON {"zh": "..."}.\n\nSENTENCE:\n"""' + text + '"""',
    4096, SYS_SENT, tries
  );
  const zh = String(out.zh || '').trim() || '暂无译文';
  await cacheSave(key, zh, prev);
  return { zh };
}

// ---------- Ctrl mode: constituent segmentation ----------
// The whole sentence is split ONCE into consecutive constituents (units larger than a phrase, smaller than the
// sentence), each with an overall Chinese gloss. Any word inside a constituent then shows that constituent's meaning.
const SYS_SEG = 'You are an English grammar analyst. You split sentences into consecutive grammatical constituents and give the meaning of each constituent as a whole. Reply with one JSON object.';

async function segmentCore({ sentence: sent }, tries = 2) {
  const text = String(sent || '').trim();
  if (!text) throw new Error('句子为空');
  const key = 'seg3:' + await cacheScope() + ':' + text.length + '.' + hashKey(text);
  const prev = await cacheGetRaw(key);
  if (isFresh(prev)) return { segments: prev.v };

  let segs = null;
  for (let attempt = 1; attempt <= 2 && !segs; attempt++) {
    const out = await callJSON(
      'Split the sentence below into consecutive constituents that together cover every word, in order, without overlap. ' +
      'A constituent is a grammatical unit larger than a phrase and smaller than the sentence, for example: ' +
      'a noun phrase with its modifiers (even a long one), a coordinated structure (A, B and C), a subordinate clause, ' +
      'a prepositional or with-phrase used as an adverbial, or a verb phrase with its object or complement. ' +
      'Each "text" must be copied exactly from the sentence. ' +
      'Each "zh" is a short Chinese gloss of the whole unit in this sentence, at most 25 Chinese characters. ' +
      'Return JSON {"units":[{"text":"...","zh":"..."}]}.\n\nSENTENCE:\n"""' + text + '"""',
      8192, SYS_SEG, tries
    );
    segs = alignSegments(text, out.units);
  }
  if (!segs) throw new Error('成分切分失败：模型结果无法对齐到原句');
  await cacheSave(key, segs, prev);
  return { segments: segs };
}

// Map the model's units onto the sentence in order. Segments tile the sentence: each one runs from the previous
// segment's end to its own end, so words the model skipped are absorbed by the next unit and no word is left out.
// Units that are not verbatim or out of order are skipped.
function alignSegments(sent, units) {
  if (!Array.isArray(units)) return null;
  const segs = [];
  let cursor = 0;
  for (const u of units) {
    const t = String((u && u.text) || '').trim();
    if (!t) continue;
    const idx = sent.indexOf(t, cursor);
    if (idx < 0) continue;
    const end = idx + t.length;
    segs.push({ start: cursor, end, zh: String((u && u.zh) || '').trim() || '暂无释义' });
    cursor = end;
  }
  if (!segs.length) return null;
  segs[segs.length - 1].end = sent.length; // the tail after the last unit belongs to it
  segs.forEach(s => {
    while (s.start < s.end && /\s/.test(sent[s.start])) s.start++;
    s.text = sent.slice(s.start, s.end).trim();
  });
  return segs.filter(s => s.text);
}

// ---------- bulk vocabulary fill: translate the remaining words of a page ----------
// Only closed-class grammar words are skipped: articles/determiners, pronouns, prepositions, conjunctions and the
// core auxiliary/copula verbs. Content words (authorities, remarkable, significant, ...) are always translated.
// The list may grow; keep it to words with no useful standalone meaning.
const STOP_WORDS = new Set((
  'a an the this that these those some any each every no other another such both all either neither ' +
  'my your his her its our their whose what which ' +
  'i me we us you he him she her it they them myself yourself himself herself itself ourselves yourselves themselves ' +
  'who whom whoever whatever nobody somebody anybody everyone someone anyone something anything nothing ' +
  'of in on at to for from by with about into onto upon within without through throughout during before after ' +
  'above below under over between among against across along around behind beside beyond near off past since till ' +
  'toward towards until via per than as like despite except ' +
  'and or but if then because while although though unless whether so yet nor ' +
  'be am is are was were been being have has had having do does did doing ' +
  'will would shall should can could may might must ' +
  "it's i'm you're he's she's they're we're that's there's isn't aren't wasn't weren't don't doesn't didn't " +
  "can't couldn't won't wouldn't shouldn't s t re ve ll d m"
).split(/\s+/).filter(Boolean));

function isFunctionWord(w) {
  return STOP_WORDS.has(w.toLowerCase());
}

function isMissing(err) {
  return /404|405|not found|not support/i.test(String(err && err.message));
}

// One batch of words -> meanings, from the AI or from the free-translation endpoint.
// entries: [{ word, sentence }] where sentence is the sentence the word first appeared in. The AI gets each
// word together with its sentence, so polysemous words get the meaning used in this article, not a generic one.
async function translateBatch(entries, source, topic) {
  const words = entries.map(e => e.word);
  if (source === 'free') return freeTranslate(words);
  const lines = entries.map(e => `- "${e.word}"${e.sentence ? `  ← «${e.sentence}»` : ''}`).join('\n');
  const out = await callJSON(
    'Translate each English word below into a concise Chinese meaning (at most 15 Chinese characters each). ' +
    'Each word is shown with the sentence it comes from: give the meaning it has IN THAT SENTENCE, not a generic dictionary sense. ' +
    (topic ? `The text is about: ${topic}. ` : '') +
    'Return JSON {"items":[{"word":"...","zh":"..."}]} with one item per input word, in the same order.\n\nWORDS WITH CONTEXT:\n' + lines,
    16384, SYS_WORD
  );
  const items = Array.isArray(out.items) ? out.items : [];
  const map = {};
  for (const it of items) {
    const w = String((it && it.word) || '').trim().toLowerCase();
    const zh = String((it && it.zh) || '').trim();
    if (w && zh) map[w] = zh;
  }
  return map;
}

// Free dictionary/translation endpoint (no key): expects { endpoint: 'https://host/', word: '...' } and returns
// a Chinese gloss; accepts the common JSON shapes used by LibreTranslate-like services and Google's free endpoint.
async function freeTranslateOne(word, cfg) {
  const base = String(cfg.freeEndpoint || '').trim();
  if (!base) throw new Error('未填写免费翻译接口地址');
  const isGoogleLt = /translate\.googleapis\.com/.test(base);
  let url, init;
  if (isGoogleLt) {
    const u = new URL(base);
    u.searchParams.set('q', word);
    if (!u.searchParams.get('target')) u.searchParams.set('target', 'zh-CN');
    url = u.toString();
    init = { method: 'GET' };
  } else {
    url = base.replace(/\/+$/, '') + '/translate';
    init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: word, source: 'en', target: 'zh', format: 'text' })
    };
  }
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`免费接口 HTTP ${r.status}`);
  const data = await r.json();
  const text =
    (data && data.translatedText) ||
    (data && data.translation) ||
    (data && data.result) ||
    (Array.isArray(data && data.sentences) ? data.sentences.map(s => s.trans).join('') : '') ||
    '';
  const zh = String(text).trim();
  if (!zh) throw new Error('免费接口没有返回译文');
  return zh;
}

async function freeTranslate(words) {
  const cfg = await chrome.storage.local.get({ freeEndpoint: '' });
  const map = {};
  for (const w of words) {
    try { map[w.toLowerCase()] = await freeTranslateOne(w, cfg); } catch (_) { /* leave it for next time */ }
  }
  return map;
}

// Fill meanings for every word of the page that is neither function word, nor already translated, nor cached.
// Words are sent in batches with their sentences (context) and streamed back to the page batch by batch.
async function fillWords({ words, sentenceOf, topic, source }, job) {
  const list = Array.isArray(words) ? [...new Set(words.map(w => String(w || '').trim()).filter(Boolean))] : [];
  const wanted = list.filter(w => !isFunctionWord(w));
  const scope = await cacheScope();
  const result = {};
  const missing = [];
  for (const w of wanted) {
    const key = 'bw:' + scope + ':' + w.toLowerCase();
    const prev = await cacheGetRaw(key);
    if (isFresh(prev)) { result[w] = prev.v; continue; }
    missing.push(w);
  }
  // AI: small batches return fast and stream early; the free endpoint does one word per HTTP call.
  const BATCH = source === 'free' ? 5 : 20;
  const batches = [];
  for (let i = 0; i < missing.length; i += BATCH) {
    batches.push(missing.slice(i, i + BATCH).map(w => ({
      word: w,
      sentence: sentenceOf && sentenceOf[w] ? String(sentenceOf[w]).slice(0, 400) : ''
    })));
  }
  let done = Object.keys(result).length;
  const total = wanted.length;
  const push = data => {
    chrome.tabs.sendMessage(job.tabId, {
      type: 'fillpart', id: job.id, translations: data, done, total, batches: batches.length
    }).catch(() => {});
  };
  if (done) push({}); // already-cached words are reported at once

  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      try {
        const got = await translateBatch(batch, source, topic);
        const fresh = {};
        const saves = [];
        for (const [w, zh] of Object.entries(got)) {
          if (!zh) continue;
          result[w] = zh;
          fresh[w] = zh;
          // cache writes are independent: issue them together instead of awaiting each one
          saves.push(cacheGetRaw('bw:' + scope + ':' + w)
            .then(prev => cacheSave('bw:' + scope + ':' + w, zh, prev)));
        }
        done = Object.keys(result).length;
        // Stream this batch to the page before the cache writes finish, so the bar moves immediately
        if (Object.keys(fresh).length) push(fresh);
        await Promise.all(saves);
      } catch (err) {
        if (source !== 'free' && isMissing(err)) throw new Error('当前接口不支持批量补词');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, Math.max(1, batches.length)) }, worker));
  done = Object.keys(result).length;
  return { total, done, missing: total - done };
}

// Standalone fill: answered immediately, batches stream back as 'fillpart' messages, final counts as 'result'
function startFillWords(msg, sender) {
  const tabId = sender && sender.tab ? sender.tab.id : null;
  if (tabId == null) return Promise.reject(new Error('缺少标签页信息'));
  const job = { id: 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), tabId };
  const first = msg.sentences && msg.sentences[0] ? String(msg.sentences[0]).slice(0, 120) : '';
  fillWords({ words: msg.words, sentenceOf: msg.sentenceOf || {}, topic: first, source: msg.source }, job)
    .then(data => finishJob(job, { ok: true, data }))
    .catch(err => finishJob(job, { ok: false, error: err.message }));
  return Promise.resolve({ queued: true, id: job.id });
}

// Pick learnable words/phrases in a chunk of page text
async function annotate({ text }) {
  const out = await callJSON(
    'From the English text below, pick up to 12 words or phrases worth learning. ' +
    'Each "text" must be copied verbatim from the input (same spelling and case). ' +
    'Each "zh" is a short Chinese meaning in this context. ' +
    'Return JSON {"items":[{"text":"...","zh":"..."}]}.\n\nTEXT:\n"""' + text + '"""',
    16000, SYS_ANNOT // annotation is the heaviest call; a reasoning model needs a much larger budget
  );
  const items = Array.isArray(out.items)
    ? out.items.filter(i => i && typeof i.text === 'string' && typeof i.zh === 'string')
    : [];
  return { items };
}

// Article annotations are also reusable after a reload. Key by the exact chunk text.
async function annotateCached({ text }) {
  const source = String(text || '');
  const key = 'a2:' + await cacheScope() + ':' + source.length + '.' + hashKey(source);
  const prev = await cacheGetRaw(key);
  if (isFresh(prev)) return { items: prev.v };
  const result = await annotate({ text: source });
  await cacheSave(key, result.items, prev);
  return result;
}
