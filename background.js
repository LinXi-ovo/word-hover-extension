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

async function callJSON(prompt, maxTokens = 4096) {
  const cfg = await chrome.storage.local.get({ apiKey: '', endpoint: DEFAULTS.endpoint, model: DEFAULTS.model });
  if (!cfg.apiKey) throw new Error('未设置 API Key，请点击扩展图标填写');
  const res = await fetch(normalizeEndpoint(cfg.endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: 'You are a precise English-to-Chinese vocabulary assistant. Always reply with a single JSON object.' },
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
    `as it is used in the sentence that contains it, in this text: """${context}""". Return JSON {"zh": "..."}.`
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
    'Return JSON {"zh": "..."}.\n\nSENTENCE:\n"""' + text + '"""'
  );
  const zh = String(out.zh || '').trim() || '暂无译文';
  await chrome.storage.local.set({ [key]: zh });
  return { zh };
}

// Ctrl mode: the smallest meaningful unit containing the word (phrasal verb, collocation, phrase).
// Longer than one word, shorter than the sentence. Cached in chrome.storage.local.
async function chunk({ word, context }) {
  const key = 'c:' + word.toLowerCase() + '|' + hashKey(context);
  const cached = (await chrome.storage.local.get(key))[key];
  if (cached) return cached;
  // Step 1: ask for ALL multi-word units in the text (a list is more reliable than asking about one word)
  const out = await callJSON(
    'List the meaningful multi-word units in the English text below: phrasal verbs, verb + object/complement, ' +
    'fixed collocations, and noun or adjective phrases. Each unit has 2 to 6 words and is copied verbatim from the text. ' +
    'For each unit give a short Chinese meaning in this context. ' +
    'Return JSON {"units":[{"text":"...","zh":"..."}]}.\n\nTEXT:\n"""' + context + '"""',
    8192
  );
  const units = (Array.isArray(out.units) ? out.units : [])
    .map(u => ({ text: String((u && u.text) || '').trim(), zh: String((u && u.zh) || '').trim() }))
    .filter(u => u.text && u.zh);

  // Step 2: locally pick the shortest unit that contains the word as a whole word,
  // restricted to the sentence that contains the word (never across sentence boundaries)
  const wordRe = new RegExp('(^|[^A-Za-z])' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Za-z]|$)', 'i');
  const sentences = String(context).split(/(?<=[.!?])\s+/);
  const ownSentence = sentences.find(s => wordRe.test(s)) || String(context);
  const hits = units
    .filter(u => /\s/.test(u.text) && wordRe.test(u.text) && ownSentence.includes(u.text))
    .sort((a, b) => a.text.split(/\s+/).length - b.text.split(/\s+/).length);

  const result = hits.length
    ? { chunk: hits[0].text, zh: hits[0].zh }
    : { chunk: word, zh: '这个词前后没有可识别的多词短语' };
  // Cache only successful unit matches; a miss may be a model hiccup and should be retried later
  if (hits.length) await chrome.storage.local.set({ [key]: result });
  return result;
}

// Pick learnable words/phrases in a chunk of page text
async function annotate({ text }) {
  const out = await callJSON(
    'From the English text below, pick up to 12 words or phrases worth learning. ' +
    'Each "text" must be copied verbatim from the input (same spelling and case). ' +
    'Each "zh" is a short Chinese meaning in this context. ' +
    'Return JSON {"items":[{"text":"...","zh":"..."}]}.\n\nTEXT:\n"""' + text + '"""',
    16000 // annotation is the heaviest call; a reasoning model needs a much larger budget
  );
  const items = Array.isArray(out.items)
    ? out.items.filter(i => i && typeof i.text === 'string' && typeof i.zh === 'string')
    : [];
  return { items };
}
