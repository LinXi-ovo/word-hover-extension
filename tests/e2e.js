// End-to-end test: load the real extension into Chromium and exercise it.
// Secrets come from environment variables only; nothing sensitive is written to disk.
const path = require('path');
const http = require('http');
const os = require('os');
const fs = require('fs');
const { chromium } = require('playwright');

// Test copy of the extension: the real manifest only grants https://*/*, so for the local http test page
// we add http://localhost/* to a temporary copy. The real extension is never modified by the test.
const SRC_EXT = process.env.EXT_DIR;
const EXT_DIR = path.join(os.tmpdir(), 'dsh-ext-under-test');
fs.rmSync(EXT_DIR, { recursive: true, force: true });
fs.cpSync(SRC_EXT, EXT_DIR, { recursive: true, filter: s => !s.includes('.git') });
{
  const mf = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
  mf.host_permissions.push('http://localhost/*');
  fs.writeFileSync(path.join(EXT_DIR, 'manifest.json'), JSON.stringify(mf, null, 2));
}
const KEY = process.env.TEST_KEY;
const EP = process.env.TEST_EP;
const MODEL = process.env.TEST_MODEL;
const PORT = 8765;

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>t</title></head><body>
<h1>The road to health</h1>
<p id="p1">In today's interconnected world, it is imperative that countries work together to tackle global health challenges.</p>
<p id="p2">China made its COVID-19 vaccines <a href="#x">available globally</a>, supplying more than 2.2 billion doses to more than 120 countries.</p>
<p id="p3">Thanks to strong political commitment, no new indigenous malaria cases have been reported since 2017. This striking result is a testament to China's success.</p>
</body></html>`;

function log(...a) { console.log(...a); }

(async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); });
  await new Promise(r => server.listen(PORT, r));

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-prof-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: process.env.CHROME_PATH || undefined,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-first-run'],
  });

  // 1) Service worker + extension id
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = sw.url().split('/')[2];
  log('extension id:', extId);
  log('service worker up, url ok:', sw.url().startsWith('chrome-extension://'));

  // 2) Popup: fill form and run the three tools
  const pop = await context.newPage();
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  // Wait for the popup's own init (it loads saved values) so it cannot overwrite what we fill in
  await pop.waitForFunction(() => /0\.1\.\d/.test(document.getElementById('status').textContent));
  await pop.fill('#apiKey', KEY);
  await pop.fill('#endpoint', EP);
  await pop.fill('#model', MODEL);
  await pop.click('#save'); // the background reads the key from storage, so it must be saved first
  log('popup status line:', await pop.textContent('#status'));

  async function runTool(btn, label, timeoutMs) {
    await pop.click(`#${btn}`);
    // wait until the button is re-enabled (busy() finished)
    await pop.waitForFunction(id => !document.getElementById(id).disabled, btn, { timeout: timeoutMs });
    await pop.waitForTimeout(150);
    const txt = (await pop.textContent('#diag')).trim();
    const ok = /✓|完成|获取到/.test(txt) && !/失败|✗/.test(txt);
    log(`[${ok ? 'PASS' : 'FAIL'}] ${label}:\n    ${txt.replace(/\n/g, '\n    ')}`);
    return ok;
  }
  const r1 = await runTool('fetchModels', '获取模型', 90000);
  const r2 = await runTool('testConn', '连通性测试', 90000);
  const r3 = await runTool('speedTest', '速度测试', 120000);

  // 3) Test page: run analysis via the service worker (same path as the popup's button)
  const page = await context.newPage();
  await page.goto(`http://localhost:${PORT}/`);
  // Without the "tabs" permission, query() omits URLs, so take the newest tab (the test page was opened last)
  const tabId = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return Math.max(...tabs.map(t => t.id));
  });
  await sw.evaluate(async id => {
    await chrome.scripting.insertCSS({ target: { tabId: id }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId: id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(id, { type: 'start' });
  }, tabId);
  await page.bringToFront();
  await page.waitForFunction(() => /完成|失败|出错/.test(document.getElementById('dsh-toast')?.textContent || ''), null, { timeout: 180000 });
  const toast = await page.textContent('#dsh-toast');
  const r4 = /完成/.test(toast);
  log(`[${r4 ? 'PASS' : 'FAIL'}] 分析本页: ${toast}`);
  log('  marked phrases:', await page.locator('.dsh-term').count());

  // 4) Word hover: move over the word "interconnected"
  const box = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.getElementById('p1'), NodeFilter.SHOW_TEXT);
    let tn = null, i = -1;
    while (walker.nextNode()) { i = walker.currentNode.nodeValue.indexOf('interconnected'); if (i >= 0) { tn = walker.currentNode; break; } }
    const r = document.createRange(); r.setStart(tn, i); r.setEnd(tn, i + 'interconnected'.length);
    const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await page.mouse.move(box.x - 5, box.y); await page.mouse.move(box.x, box.y);
  await page.waitForFunction(() => getComputedStyle(document.getElementById('dsh-tip')).display === 'block', null, { timeout: 30000 });
  await page.waitForTimeout(4000);
  const wordTip = (await page.textContent('#dsh-tip')).trim();
  const r5 = !/失败|查询中|错误|未设置/.test(wordTip) && wordTip.length > 'interconnected'.length;
  log(`[${r5 ? 'PASS' : 'FAIL'}] 单词悬停 "interconnected": ${wordTip}`);

  // 5) Shift sentence mode over paragraph 2 (sentence crosses an <a> tag)
  const sb = await page.evaluate(() => {
    const el = document.querySelector('#p2 a');
    const b = el.getBoundingClientRect(); return { x: b.left + 4, y: b.top + b.height / 2 };
  });
  await page.mouse.move(sb.x, sb.y);
  await page.keyboard.down('Shift');
  await page.mouse.move(sb.x + 1, sb.y);
  await page.waitForFunction(() => /句意/.test(document.getElementById('dsh-tip')?.textContent || '') && !/翻译中/.test(document.getElementById('dsh-tip')?.textContent || ''), null, { timeout: 60000 }).catch(() => {});
  const sentTip = (await page.textContent('#dsh-tip')).trim();
  await page.keyboard.up('Shift');
  const r6 = /句意/.test(sentTip) && !/失败|错误|未设置/.test(sentTip) && !/翻译中/.test(sentTip);
  log(`[${r6 ? 'PASS' : 'FAIL'}] Shift 句意: ${sentTip}`);

  // 6) Switch off word hover in the popup: hovering a word must no longer show a tip
  await pop.bringToFront();
  await pop.uncheck('#hoverEnabled');
  await pop.waitForTimeout(300);
  await page.bringToFront();
  await page.mouse.move(box.x - 30, box.y - 30);
  await page.mouse.move(box.x, box.y);
  await page.waitForTimeout(1500);
  const hiddenWhenOff = await page.evaluate(() => getComputedStyle(document.getElementById('dsh-tip')).display === 'none');
  log(`[${hiddenWhenOff ? 'PASS' : 'FAIL'}] 关闭单词悬浮后不显示提示`);

  // 7) Word hover back on, Shift sentence mode off: holding Shift must no longer show 句意
  await pop.bringToFront();
  await pop.check('#hoverEnabled');
  await pop.uncheck('#shiftEnabled');
  await pop.waitForTimeout(300);
  await page.bringToFront();
  await page.mouse.move(sb.x, sb.y);
  await page.keyboard.down('Shift');
  await page.mouse.move(sb.x + 2, sb.y);
  await page.waitForTimeout(1500);
  const shiftTip = (await page.textContent('#dsh-tip')).trim();
  await page.keyboard.up('Shift');
  const hiddenShiftOff = !/句意/.test(shiftTip);
  log(`[${hiddenShiftOff ? 'PASS' : 'FAIL'}] 关闭 Shift 句意后不显示句意`);
  const r7 = hiddenWhenOff && hiddenShiftOff;

  // 8) Ctrl phrase mode: switch word hover and Shift back on, Ctrl on; hover "tackle" in p1
  await pop.bringToFront();
  await pop.check('#hoverEnabled');
  await pop.check('#shiftEnabled');
  await pop.check('#ctrlEnabled');
  await pop.waitForTimeout(300);
  await page.bringToFront();
  const tb = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.getElementById('p1'), NodeFilter.SHOW_TEXT);
    let tn = null, i = -1;
    while (walker.nextNode()) { i = walker.currentNode.nodeValue.indexOf('tackle'); if (i >= 0) { tn = walker.currentNode; break; } }
    const r = document.createRange(); r.setStart(tn, i); r.setEnd(tn, i + 'tackle'.length);
    const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await page.mouse.move(tb.x - 5, tb.y);
  await page.keyboard.down('Control');
  await page.mouse.move(tb.x, tb.y);
  // Diagnostic: sample the tip every 1s for 20s so we can see whether the multi-word result ever arrives
  const seen = [];
  for (let t = 0; t < 20; t++) {
    await page.waitForTimeout(1000);
    const s = (await page.textContent('#dsh-tip').catch(() => '')).trim();
    if (!seen.length || seen[seen.length - 1] !== s) seen.push(s);
  }
  log('  [diag] ctrl tip sequence:', JSON.stringify(seen));
  const ctrlTip = seen[seen.length - 1] || '';
  await page.keyboard.up('Control');
  // Must be a multi-word unit (e.g. "tackle global health challenges"), not just the single word
  const chunkTitle = ctrlTip.split(/[\u4e00-\u9fff]/)[0].trim();
  const r8 = /tackle/i.test(chunkTitle) && /\s/.test(chunkTitle) && !/失败|错误|未设置/.test(ctrlTip);
  log(`[${r8 ? 'PASS' : 'FAIL'}] Ctrl 短语含义: ${ctrlTip}`);

  await context.close();
  server.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  const all = [r1, r2, r3, r4, r5, r6, r7, r8];
  log(`\nSUMMARY: ${all.filter(Boolean).length}/${all.length} passed`);
  process.exit(all.every(Boolean) ? 0 : 1);
})().catch(err => { console.error('E2E ERROR:', err.message); process.exit(2); });
