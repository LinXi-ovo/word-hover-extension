const $ = id => document.getElementById(id);
const DEFAULTS = { apiKey: '', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat' };

// Current form values (may not be saved yet)
function formCfg() {
  return {
    apiKey: $('apiKey').value.trim(),
    endpoint: $('endpoint').value.trim() || DEFAULTS.endpoint,
    model: $('model').value.trim() || DEFAULTS.model
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
  if (!cfg.apiKey) throw new Error('未填写 API Key');
}

async function listModels(cfg) {
  const r = await timedFetch(baseUrl(cfg.endpoint) + '/models', {
    headers: { Authorization: 'Bearer ' + cfg.apiKey }
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}：${r.text.slice(0, 160)}`);
  let data;
  try { data = JSON.parse(r.text); } catch (_) { throw new Error('模型列表不是 JSON，该接口可能不支持 /models'); }
  const models = Array.isArray(data.data) ? data.data.map(m => m.id).filter(Boolean) : [];
  return { models, ms: r.ms };
}

// One minimal chat request
async function chatPing(cfg) {
  const r = await timedFetch(chatUrl(cfg.endpoint), {
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

(async () => {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  $('apiKey').value = cfg.apiKey;
  $('endpoint').value = cfg.endpoint;
  $('model').value = cfg.model;
  $('status').textContent = `Word Hover 释义助手 ${chrome.runtime.getManifest().version}`;
  const sw = await chrome.storage.local.get({
    hoverEnabled: true, shiftEnabled: true, ctrlEnabled: true,
    dbgSentence: false, dbgChunk: false, hoverScope: 'word'
  });
  $('hoverEnabled').checked = sw.hoverEnabled;
  $('shiftEnabled').checked = sw.shiftEnabled;
  $('ctrlEnabled').checked = sw.ctrlEnabled;
  $('dbgSentence').checked = sw.dbgSentence;
  $('dbgChunk').checked = sw.dbgChunk;
  $('hoverPhraseOnly').checked = sw.hoverScope === 'phrase';
})();

// Feature switches save immediately; content scripts pick them up through storage.onChanged
const SWITCH_NAMES = {
  hoverEnabled: '单词悬停', shiftEnabled: 'Shift 句意', ctrlEnabled: 'Ctrl 成分含义',
  dbgSentence: '直接显示句意', dbgChunk: '直接显示成分'
};
Object.keys(SWITCH_NAMES).forEach(id => {
  $(id).addEventListener('change', async () => {
    await chrome.storage.local.set({ [id]: $(id).checked });
    $('status').textContent = `${SWITCH_NAMES[id]}已${$(id).checked ? '开启' : '关闭'}`;
  });
});
$('hoverPhraseOnly').addEventListener('change', async () => {
  await chrome.storage.local.set({ hoverScope: $('hoverPhraseOnly').checked ? 'phrase' : 'word' });
  $('status').textContent = $('hoverPhraseOnly').checked ? '已改为只悬停词组' : '已恢复单词悬停';
});

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    apiKey: $('apiKey').value.trim(),
    endpoint: $('endpoint').value.trim() || DEFAULTS.endpoint,
    model: $('model').value.trim() || DEFAULTS.model
  });
  $('status').textContent = '设置已保存';
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

$('run').addEventListener('click', async () => {
  const { apiKey } = await chrome.storage.local.get({ apiKey: '' });
  if (!apiKey) {
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
