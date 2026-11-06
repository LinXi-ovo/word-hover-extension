// Service worker: the only place that talks to the LLM API (keeps the API key out of page scripts).
const DEFAULTS = { endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat' };

// Short, stable cache key for long context text (FNV-1a, 32-bit)
function hashKey(s) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
  return (x >>> 0).toString(36);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  let task = null;
  if (msg.type === 'lookup') task = lookup(msg);
  if (msg.type === 'annotate') task = annotate(msg);
  if (msg.type === 'sentence') task = sentence(msg);
  if (msg.type === 'chunk') task = chunk(msg);
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

async function callJSON(prompt, maxTokens = 4096, system = SYS_DEFAULT) {
  await acquire();
  try {
    return await callJSONOnce(prompt, maxTokens, system);
  } finally {
    release();
  }
}

// Retry on rate/concurrency limits with growing backoff; other errors are raised at once
async function callJSONOnce(prompt, maxTokens, system) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await requestJSON(prompt, maxTokens, system);
    } catch (err) {
      const limited = /tier_limit_exceeded|concurrency limit|rate.?limit|\b429\b/i.test(err.message);
      if (!limited || attempt >= 4) throw err;
      await sleep(1000 * attempt * attempt); // 1s, 4s, 9s
    }
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
async function lookup({ word, context, force }) {
  const key = 'w:' + word.toLowerCase() + '|' + hashKey(context || '');
  if (!force) {
    const cached = (await chrome.storage.local.get(key))[key];
    if (cached) return { zh: cached };
  }
  const out = await callJSON(
    `Give a concise Chinese meaning (at most 15 Chinese characters) of the English word "${word}" ` +
    `as it is used in the sentence that contains it, in this text: """${context}""". Return JSON {"zh": "..."}.`,
    4096, SYS_WORD
  );
  const zh = String(out.zh || '').trim() || '暂无释义';
  await chrome.storage.local.set({ [key]: zh });
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
async function sentence({ text }) {
  const key = 's:' + text;
  const cached = (await chrome.storage.local.get(key))[key];
  if (cached) return { zh: cached };
  const out = await callJSON(
    'Translate the English sentence below into natural, accurate Chinese. ' +
    'Return JSON {"zh": "..."}.\n\nSENTENCE:\n"""' + text + '"""',
    4096, SYS_SENT
  );
  const zh = String(out.zh || '').trim() || '暂无译文';
  await chrome.storage.local.set({ [key]: zh });
  return { zh };
}

// Regex that matches the word as a whole word (case-insensitive)
function wordPattern(word) {
  return new RegExp('(^|[^A-Za-z])' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Za-z]|$)', 'i');
}

// The sentence in the paragraph that contains the word; used when the page did not pass the hovered sentence
function sentenceOf(context, word) {
  const re = wordPattern(word);
  const sentences = String(context).split(/(?<=[.!?])\s+/);
  return sentences.find(s => re.test(s)) || String(context);
}

// Ctrl mode: the complete constituent that contains the word, inside the hovered sentence.
// Step 1 asks for that constituent directly; step 2 lists the sentence's units and picks the shortest valid one.
// Only a valid multi-word constituent is cached; a miss is returned uncached so it can be retried.
async function chunk({ word, context, sentence }) {
  const sent = sentence || sentenceOf(context, word);
  const key = 'c2:' + word.toLowerCase() + '|' + hashKey(sent);
  const cached = (await chrome.storage.local.get(key))[key];
  if (cached) return cached;

  const wordRe = wordPattern(word);
  const valid = c => /\s/.test(c) && wordRe.test(c) && sent.includes(c);

  // Step 1: the constituent containing the word, as one grammatical unit
  let found = null;
  const direct = await callJSON(
    `Sentence: """${sent}"""\nTarget word: "${word}"\n` +
    'Find the smallest complete constituent that contains the target word and works as one grammatical unit: ' +
    'a verb with its object or complement, a noun phrase with its modifiers, a prepositional phrase, or a fixed collocation or phrasal verb. ' +
    'It must have 2 to 8 words, be copied verbatim from the sentence, contain the target word, and must not be the whole clause or sentence. ' +
    'Give its short Chinese meaning in this sentence. Return JSON {"chunk":"...","zh":"..."}.',
    2048, SYS_CHUNK
  );
  const dc = String(direct.chunk || '').trim();
  if (valid(dc)) found = { chunk: dc, zh: String(direct.zh || '').trim() || '暂无释义' };

  // Step 2 (fallback): list the sentence's multi-word units and pick the shortest valid one
  if (!found) {
    const out = await callJSON(
      'List the multi-word constituents in the sentence below: phrasal verbs, verb + object/complement, ' +
      'noun and adjective phrases, prepositional phrases. Each has 2 to 8 words and is copied verbatim. ' +
      'Give a short Chinese meaning for each in this sentence. Return JSON {"units":[{"text":"...","zh":"..."}]}.\n\nSENTENCE:\n"""' + sent + '"""',
      4096, SYS_CHUNK
    );
    const units = (Array.isArray(out.units) ? out.units : [])
      .map(u => ({ text: String((u && u.text) || '').trim(), zh: String((u && u.zh) || '').trim() }))
      .filter(u => u.text && u.zh && valid(u.text))
      .sort((a, b) => a.text.split(/\s+/).length - b.text.split(/\s+/).length);
    if (units.length) found = { chunk: units[0].text, zh: units[0].zh };
  }

  if (!found) return { chunk: word, zh: '未找到多词成分' };
  await chrome.storage.local.set({ [key]: found });
  return found;
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
