const $ = id => document.getElementById(id);
const DEFAULTS = { apiKey: '', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat' };
let presets = [];
let activePresetId = '';
const isLocal = url => {
  try { return ['localhost', '127.0.0.1'].includes(new URL(url).hostname); }
  catch (_) { return false; }
};
const authHeaders = cfg => cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {};

function renderPresets() {
  const select = $('presetSelect');
  select.textContent = '';
  for (const preset of presets) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.name;
    select.appendChild(option);
  }
  select.value = activePresetId;
}

function showPreset(preset) {
  $('presetName').value = preset.name;
  $('apiKey').value = preset.apiKey;
  $('endpoint').value = preset.endpoint;
  $('model').value = preset.model;
  $('modelList').textContent = '';
}

async function activatePreset(preset) {
  activePresetId = preset.id;
  showPreset(preset);
  renderPresets();
  await chrome.storage.local.set({ activePresetId, apiKey: preset.apiKey, endpoint: preset.endpoint, model: preset.model });
}

// Current form values (may not be saved yet)
function formCfg() {
  return {
    apiKey: $('apiKey').value.trim(),
    endpoint: $('endpoint').value.trim() || DEFAULTS.endpoint,
    model: $('model').value.trim()
  };
}

// Base URL without /chat/completions, e.g. https://host/v1
function baseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '') || 'https://api.deepseek.com';
}

// Full chat-completions URL from either a base URL or a full URL
function chatUrl(url) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  return /\/chat\/completions$/.test(u) ? u : u + '/chat/completions';
}

function setDiag(text, kind) {
  const d = $('diag');
  d.textContent = text;
  d.className = kind || '';
}

// Run an action with the buttons disabled, so repeated clicks don't stack requests
async function busy(fn) {
  const ids = ['fetchModels', 'testConn', 'speedTest'];
  ids.forEach(id => { $(id).disabled = true; });
  try {
    await fn();
  } finally {
    ids.forEach(id => { $(id).disabled = false; });
  }
}

// Direct fetch from the popup page (host_permissions cover https://*/*), with timing and a 60 s timeout
async function timedFetch(url, init) {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('请求超时（60 秒无响应）');
    throw new Error('网络请求失败：' + err.message);
  } finally {
    clearTimeout(timer);
  }
}

function requireKey(cfg) {
  if (!cfg.apiKey && !isLocal(cfg.endpoint)) throw new Error('未填写 API Key');
}

async function listModels(cfg) {
  const r = await timedFetch(baseUrl(cfg.endpoint) + '/models', {
    headers: authHeaders(cfg)
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}：${r.text.slice(0, 160)}`);
  let data;
  try { data = JSON.parse(r.text); } catch (_) { throw new Error('模型列表不是 JSON，该接口可能不支持 /models'); }
  const models = Array.isArray(data.data) ? data.data.map(m => m.id).filter(Boolean) : [];
  return { models, ms: r.ms };
}

// One minimal chat request
async function chatPing(cfg) {
  if (!cfg.model) throw new Error('请先选择模型名');
  const r = await timedFetch(chatUrl(cfg.endpoint), {
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

// Live progress mirrored from the content script of the active tab
const STAGE_LABEL = { words: '词语·词组·句意', chunks: '成分', fill: '补充' };
const STAGE_ORDER = ['words', 'chunks', 'fill'];
const progressState = { stage: null, detail: '', pct: 0 };

function renderProgress() {
  const { stage, detail, pct } = progressState;
  $('miniStage').textContent = stage ? STAGE_LABEL[stage] : '未开始分析';
  const idx = stage ? STAGE_ORDER.indexOf(stage) : -1;
  document.querySelectorAll('.mini-stop').forEach(stop => {
    const i = STAGE_ORDER.indexOf(stop.dataset.key);
    stop.classList.toggle('active', i === idx);
    stop.classList.toggle('done', idx >= 0 && i < idx);
  });
  $('miniBarFill').style.width = Math.max(0, Math.min(100, pct)) + '%';
  $('miniDetail').textContent = detail || (stage ? '' : '打开网页后点“分析本页”开始');
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg && msg.type === 'progress') {
    progressState.stage = msg.stage || null;
    progressState.detail = msg.detail || '';
    progressState.pct = Number(msg.pct) || 0;
    renderProgress();
  }
  return false;
});

// On open, pull the latest state from the active tab so reopening the popup shows where it is now
(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'progressState' });
    if (res && res.stage) {
      progressState.stage = res.stage;
      progressState.detail = res.detail || '';
      progressState.pct = Number(res.pct) || 0;
      renderProgress();
    }
  } catch (_) { /* no content script on this page */ }
})();

// Tab bar: one panel shown at a time
document.getElementById('tabs').addEventListener('click', e => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  const key = tab.dataset.tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.dataset.panel === key));
});

(async () => {
  const cfg = await chrome.storage.local.get({ ...DEFAULTS, presets: [], activePresetId: '' });
  presets = Array.isArray(cfg.presets) ? cfg.presets : [];
  if (!presets.length) {
    presets = [{ id: crypto.randomUUID(), name: '默认预设', apiKey: cfg.apiKey, endpoint: cfg.endpoint, model: cfg.model }];
    await chrome.storage.local.set({ presets, activePresetId: presets[0].id });
  }
  const active = presets.find(p => p.id === cfg.activePresetId) || presets[0];
  await activatePreset(active);
  $('status').textContent = `Word Hover 释义助手 ${chrome.runtime.getManifest().version}`;
  const sw = await chrome.storage.local.get({
    hoverEnabled: true, shiftEnabled: true, ctrlEnabled: true,
    dbgSentence: false, dbgChunk: false, hoverScope: 'word',
    fillAll: false, fillSource: 'ai', freeEndpoint: ''
  });
  $('hoverEnabled').checked = sw.hoverEnabled;
  $('shiftEnabled').checked = sw.shiftEnabled;
  $('ctrlEnabled').checked = sw.ctrlEnabled;
  $('dbgSentence').checked = sw.dbgSentence;
  $('dbgChunk').checked = sw.dbgChunk;
  $('hoverPhraseOnly').checked = sw.hoverScope === 'phrase';
  $('fillAll').checked = sw.fillAll;
  $('fillSource').value = sw.fillSource === 'free' ? '1' : '0';
  $('fillSourceLabel').textContent = sw.fillSource === 'free' ? '免费翻译接口（词典义）' : 'AI 语境义';
  $('freeEndpoint').value = sw.freeEndpoint || '';
})();

// Bulk vocabulary fill: switch + source slider + free endpoint address
$('fillAll').addEventListener('change', async () => {
  await chrome.storage.local.set({ fillAll: $('fillAll').checked });
  $('status').textContent = $('fillAll').checked ? '补充全部词汇已开启（下次分析本页生效）' : '补充全部词汇已关闭';
});
$('fillSource').addEventListener('input', () => {
  $('fillSourceLabel').textContent = $('fillSource').value === '1' ? '免费翻译接口（词典义）' : 'AI 语境义';
});
$('fillSource').addEventListener('change', async () => {
  const source = $('fillSource').value === '1' ? 'free' : 'ai';
  await chrome.storage.local.set({ fillSource: source });
  $('status').textContent = `补充词义来源：${source === 'free' ? '免费翻译接口' : 'AI 语境义'}`;
});
$('freeEndpoint').addEventListener('change', async () => {
  await chrome.storage.local.set({ freeEndpoint: $('freeEndpoint').value.trim() });
  $('status').textContent = $('freeEndpoint').value.trim() ? '免费翻译接口已保存' : '免费翻译接口已清空';
});

// Feature switches save immediately; content scripts pick them up through storage.onChanged
const SWITCH_NAMES = {
  hoverEnabled: '单词悬停', shiftEnabled: 'Shift 句意', ctrlEnabled: 'Ctrl 成分含义',
  dbgSentence: '直接显示句意', dbgChunk: '直接显示成分'
};
Object.keys(SWITCH_NAMES).forEach(id => {
  $(id).addEventListener('change', async () => {
    const changes = { [id]: $(id).checked };
    if ($(id).checked && id === 'dbgChunk') { changes.dbgSentence = false; $('dbgSentence').checked = false; }
    if ($(id).checked && id === 'dbgSentence') { changes.dbgChunk = false; $('dbgChunk').checked = false; }
    await chrome.storage.local.set(changes);
    $('status').textContent = `${SWITCH_NAMES[id]}已${$(id).checked ? '开启' : '关闭'}`;
  });
});
$('hoverPhraseOnly').addEventListener('change', async () => {
  await chrome.storage.local.set({ hoverScope: $('hoverPhraseOnly').checked ? 'phrase' : 'word' });
  $('status').textContent = $('hoverPhraseOnly').checked ? '已改为只悬停词组' : '已恢复单词悬停';
});

$('save').addEventListener('click', async () => {
  const values = formCfg();
  if (!values.model) { $('status').textContent = '请先填写或获取模型名'; return; }
  const preset = presets.find(p => p.id === activePresetId);
  Object.assign(preset, values, { name: $('presetName').value.trim() || preset.name });
  await chrome.storage.local.set({ presets });
  await activatePreset(preset);
  $('status').textContent = `已保存并启用「${preset.name}」`;
});

$('presetSelect').addEventListener('change', async () => {
  const preset = presets.find(p => p.id === $('presetSelect').value);
  if (!preset) return;
  await activatePreset(preset);
  $('status').textContent = `已切换到「${preset.name}」`;
});

$('newPreset').addEventListener('click', async () => {
  const preset = { id: crypto.randomUUID(), name: `新预设 ${presets.length + 1}`, ...formCfg() };
  presets.push(preset);
  await chrome.storage.local.set({ presets });
  await activatePreset(preset);
  $('presetName').focus();
  $('presetName').select();
  $('status').textContent = '新预设已建立；修改名称和配置后点击“保存设置”';
});

$('ollamaPreset').addEventListener('click', async () => {
  const preset = { id: crypto.randomUUID(), name: '本机 Ollama', apiKey: '', endpoint: 'http://localhost:11434/v1', model: '' };
  presets.push(preset);
  await chrome.storage.local.set({ presets });
  await activatePreset(preset);
  $('status').textContent = '已建立本机 Ollama 预设；获取模型后选择模型并保存';
});

$('deletePreset').addEventListener('click', async () => {
  if (presets.length < 2) { $('status').textContent = '至少保留一个预设'; return; }
  presets = presets.filter(p => p.id !== activePresetId);
  await chrome.storage.local.set({ presets });
  await activatePreset(presets[0]);
  $('status').textContent = '预设已删除';
});

// 1) Fetch model list into the model-name suggestions
$('fetchModels').addEventListener('click', () => busy(async () => {
  setDiag('正在获取模型列表…');
  try {
    const cfg = formCfg();
    requireKey(cfg);
    const res = await listModels(cfg);
    const list = $('modelList');
    list.textContent = '';
    res.models.forEach(id => {
      const opt = document.createElement('option');
      opt.value = id;
      list.appendChild(opt);
    });
    setDiag(`获取到 ${res.models.length} 个模型（耗时 ${res.ms} ms）。点击模型名输入框可选择。`, 'ok');
  } catch (err) {
    setDiag('获取模型失败：' + err.message, 'err');
  }
}));

// 2) Connectivity: one real chat request must succeed
$('testConn').addEventListener('click', () => busy(async () => {
  setDiag('正在测试连通性…');
  try {
    const cfg = formCfg();
    requireKey(cfg);
    const res = await chatPing(cfg);
    const hasText = !!res.reply.trim();
    setDiag([
      '连通性：通过 ✓',
      `耗时：${res.ms} ms`,
      `模型：${res.model}`,
      `结束原因：${res.finish}`,
      hasText ? '返回了文本内容' : '警告：返回内容为空（推理模型可能用完输出额度）'
    ].join('\n'), hasText ? 'ok' : 'err');
  } catch (err) {
    setDiag('连通性：失败 ✗\n' + err.message, 'err');
  }
}));

// 3) Speed: three sequential requests, then stats
$('speedTest').addEventListener('click', () => busy(async () => {
  const runs = [];
  let step = 1;
  try {
    const cfg = formCfg();
    requireKey(cfg);
    for (; step <= 3; step++) {
      setDiag(`速度测试：第 ${step}/3 次请求中…`);
      const res = await chatPing(cfg);
      runs.push(res.ms);
    }
    const avg = Math.round(runs.reduce((a, b) => a + b, 0) / runs.length);
    setDiag([
      '速度测试完成',
      `第 1/2/3 次：${runs.map(ms => ms + ' ms').join('  ')}`,
      `最快 ${Math.min(...runs)} ms · 最慢 ${Math.max(...runs)} ms · 平均 ${avg} ms`
    ].join('\n'), 'ok');
  } catch (err) {
    setDiag(`速度测试在第 ${step}/3 次失败：` + err.message, 'err');
  }
}));

// ---------- cache management ----------
// Cache entries are the ones the background writes: word/sentence/segment/bulk word keys.
const CACHE_PREFIXES = ['w2:', 'w3:', 's2:', 's3:', 'seg2:', 'seg3:', 'c2:', 'c3:', 'bw:'];
const isCacheKey = k => CACHE_PREFIXES.some(p => k.startsWith(p));

async function cacheStats() {
  const all = await chrome.storage.local.get(null);
  let entries = 0;
  for (const [k, v] of Object.entries(all)) {
    if (isCacheKey(k)) entries++;
  }
  const bytes = new Blob([JSON.stringify(all)]).size;
  return { entries, bytes };
}

$('cacheInfo').addEventListener('click', async () => {
  const { entries, bytes } = await cacheStats();
  $('cacheNote').textContent = `缓存条目：${entries} 条，约 ${(bytes / 1024).toFixed(1)} KB。`;
});

$('clearCache').addEventListener('click', async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(isCacheKey);
  if (!keys.length) { $('cacheNote').textContent = '缓存已经是空的。'; return; }
  await chrome.storage.local.remove(keys);
  $('cacheNote').textContent = `已清空 ${keys.length} 条缓存（设置和预设不受影响）。`;
});

// Standalone fill (with retry): inject the script if needed, then run only the vocabulary fill phase
$('fillNow').addEventListener('click', async () => {
  const { apiKey, model } = await chrome.storage.local.get({ apiKey: '', model: '' });
  const { endpoint } = await chrome.storage.local.get({ endpoint: DEFAULTS.endpoint });
  if (!model) { $('status').textContent = '请先选择并保存模型名'; return; }
  if (!apiKey && !isLocal(endpoint)) { $('status').textContent = '请先填写并保存 API Key'; return; }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) { $('status').textContent = '找不到当前标签页'; return; }
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'fill' });
    $('status').textContent = '已开始补充词义，结果显示在页面右下角';
  } catch (err) {
    $('status').textContent = '无法在此页面运行：' + err.message;
  }
});

$('run').addEventListener('click', async () => {
  const { apiKey, model } = await chrome.storage.local.get({ apiKey: '', model: '' });
  const { endpoint } = await chrome.storage.local.get({ endpoint: DEFAULTS.endpoint });
  if (!model) { $('status').textContent = '请先选择并保存模型名'; return; }
  if (!apiKey && !isLocal(endpoint)) {
    $('status').textContent = '请先填写并保存 API Key';
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    $('status').textContent = '找不到当前标签页';
    return;
  }
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'start' });
    $('status').textContent = '已开始分析，结果会显示在页面右下角';
  } catch (err) {
    $('status').textContent = '无法在此页面运行：' + err.message;
  }
});
