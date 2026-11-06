// Service worker: the only place that talks to the LLM API (keeps the API key out of page scripts).
const DEFAULTS = { endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat' };

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

// Whole-article segmentation: runs in the background after the tab gets an immediate "queued" reply, and the
// final counts are pushed back as a 'result' message. Each sentence goes through segmentCore, so its result
// is cached per sentence; later Ctrl hovers read the cache. Failed sentences are simply left for a later hover.
async function segmentDocJob(sentences, job) {
  let done = 0;
  const total = sentences.length;
  const segmentsBySentence = {};
  let next = 0;
  const worker = async () => {
    while (next < total) {
      const s = sentences[next++];
      try {
        const result = await segmentCore({ sentence: s, force: !!job.force }, 2);
        segmentsBySentence[s] = result.segments;
        done++;
      } catch (_) { /* leave it; hover will retry this sentence */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, total) }, worker));
  return { done, total, segmentsBySentence };
}

function startSegmentDoc(msg, sender) {
  const sentences = (Array.isArray(msg.sentences) ? msg.sentences : []).map(s => String(s || '').trim()).filter(Boolean);
  const tabId = sender && sender.tab ? sender.tab.id : null;
  if (!sentences.length) return Promise.resolve({ done: 0, total: 0 });
  if (tabId == null) return Promise.reject(new Error('缺少标签页信息'));
  const job = { id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), tabId, force: !!msg.force };
  segmentDocJob(sentences, job).then(data => finishJob(job, { ok: true, data }))
    .catch(err => finishJob(job, { ok: false, error: err.message }));
  return Promise.resolve({ queued: true, id: job.id });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  let task = null;
  if (msg.type === 'lookup') task = dispatch('lookup', msg, sender);
  if (msg.type === 'annotate') task = annotateCached(msg);
  if (msg.type === 'sentence') task = dispatch('sentence', msg, sender);
  if (msg.type === 'segment') task = dispatch('segment', msg, sender);
  if (msg.type === 'segmentDoc') task = startSegmentDoc(msg, sender);
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
  if (!cfg.apiKey) throw new Error('未设置 API Key，请点击扩展图标填写');
  const res = await fetch(normalizeEndpoint(cfg.endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
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
  const key = 'w2:' + word.toLowerCase() + '|' + hashKey(sent);
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
  if (!cfg.apiKey) throw new Error('未填写 API Key');
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
  const r = await timedFetch(url, { headers: { Authorization: 'Bearer ' + cfg.apiKey } });
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
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
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
  const key = 's2:' + String(text).length + '.' + hashKey(text);
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
  const key = 'seg2:' + text.length + '.' + hashKey(text);
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
  const key = 'a1:' + source.length + '.' + hashKey(source);
  const prev = await cacheGetRaw(key);
  if (isFresh(prev)) return { items: prev.v };
  const result = await annotate({ text: source });
  await cacheSave(key, result.items, prev);
  return result;
}
