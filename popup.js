const $ = id => document.getElementById(id);
const DEFAULTS = { apiKey: '', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat' };

// Current form values (may not be saved yet); used by the settings tools
function formCfg() {
  return {
    apiKey: $('apiKey').value.trim(),
    endpoint: $('endpoint').value.trim(),
    model: $('model').value.trim()
  };
}

function setDiag(text, kind) {
  const d = $('diag');
  d.textContent = text;
  d.className = kind || '';
}

// Run an async action with the buttons disabled, so repeated clicks don't stack requests
async function busy(btnIds, fn) {
  btnIds.forEach(id => { $(id).disabled = true; });
  try {
    await fn();
  } finally {
    btnIds.forEach(id => { $(id).disabled = false; });
  }
}

function sendBg(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, res => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message +
          '。后台可能是旧版本，请到 chrome://extensions 点击“重新加载”，然后关闭并重新打开弹窗'));
      }
      if (!res) return reject(new Error('后台无响应，请重新加载扩展'));
      if (res.error) return reject(new Error(res.error));
      resolve(res);
    });
  });
}

// Show the popup version next to the background version, so stale installs are obvious
(async () => {
  const popupVersion = chrome.runtime.getManifest().version;
  try {
    const { version } = await sendBg({ type: 'version' });
    $('status').textContent = version === popupVersion
      ? `版本 ${version}（后台已同步）`
      : `版本不一致：弹窗 ${popupVersion}，后台 ${version}。请重新加载扩展`;
  } catch (err) {
    $('status').textContent = '后台未连接：' + err.message;
  }
})();

(async () => {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  $('apiKey').value = cfg.apiKey;
  $('endpoint').value = cfg.endpoint;
  $('model').value = cfg.model;
})();

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    apiKey: $('apiKey').value.trim(),
    endpoint: $('endpoint').value.trim() || DEFAULTS.endpoint,
    model: $('model').value.trim() || DEFAULTS.model
  });
  $('status').textContent = '设置已保存';
});

// 1) Fetch model list into the model-name suggestions
$('fetchModels').addEventListener('click', () => busy(['fetchModels', 'testConn', 'speedTest'], async () => {
  setDiag('正在获取模型列表…');
  try {
    const res = await sendBg({ type: 'listModels', cfg: formCfg() });
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
$('testConn').addEventListener('click', () => busy(['fetchModels', 'testConn', 'speedTest'], async () => {
  setDiag('正在测试连通性…');
  try {
    const res = await sendBg({ type: 'testConnection', cfg: formCfg() });
    const lines = [
      '连通性：通过 ✓',
      `耗时：${res.ms} ms`,
      `模型：${res.model}`,
      `结束原因：${res.finish}`,
      res.hasText ? '返回了文本内容' : '警告：返回内容为空（推理模型可能用完输出额度）'
    ];
    setDiag(lines.join('\n'), res.hasText ? 'ok' : 'err');
  } catch (err) {
    setDiag('连通性：失败 ✗\n' + err.message, 'err');
  }
}));

// 3) Speed: three separate short requests (each its own message), then stats
$('speedTest').addEventListener('click', () => busy(['fetchModels', 'testConn', 'speedTest'], async () => {
  const runs = [];
  try {
    for (let i = 1; i <= 3; i++) {
      setDiag(`速度测试：第 ${i}/3 次请求中…`);
      const res = await sendBg({ type: 'pingOnce', cfg: formCfg() });
      runs.push(res.ms);
    }
    const avg = Math.round(runs.reduce((a, b) => a + b, 0) / runs.length);
    setDiag([
      '速度测试完成',
      `第 1/2/3 次：${runs.map(ms => ms + ' ms').join('  ')}`,
      `最快 ${Math.min(...runs)} ms · 最慢 ${Math.max(...runs)} ms · 平均 ${avg} ms`
    ].join('\n'), 'ok');
  } catch (err) {
    setDiag(`速度测试在第 ${runs.length + 1}/3 次失败：` + err.message, 'err');
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
