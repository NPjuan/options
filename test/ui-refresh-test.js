/**
 * 验证细粒度渲染的实际收益，而不是只看"没坏"。
 * 三个可观测指标：
 *   1. 下单后期权链表格是否被重建（DOM 身份是否改变）
 *   2. 下单后滚动位置是否保住
 *   3. 事件委托后，点击是否仍在重建后的元素上生效
 */
let chromium;
try {
  chromium = require('playwright-core').chromium;
} catch (e) {
  console.log('跳过 UI 测试：需要 playwright-core 与本机 Chrome。');
  console.log('安装：npm i -D playwright-core');
  process.exit(0);
}

// 本机 Chrome 路径，可用 CHROME_PATH 覆盖
const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.BASE_URL || 'http://localhost:8848';

(async () => {
  const b = await chromium.launch({
    executablePath: CHROME,
    headless: true,
  });
  const p = await b.newPage({ viewport: { width: 1680, height: 1000 } });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push(m.text()); });
  p.on('dialog', d => d.accept());

  let fail = 0;
  const ck = (n, c, extra) => { if (!c) fail++; console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (extra ? '  ' + extra : '')); };

  await p.goto(BASE + '/');
  await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForSelector('table.chain tbody tr.atm', { timeout: 40000 });

  // 用 SPX：行数多，最能体现差异
  await p.fill('#symInput', 'SPX');
  await p.keyboard.press('Enter');
  for (let i = 0; i < 40; i++) {
    await p.waitForTimeout(500);
    if (/已加载/.test(await p.locator('#statusText').textContent())) break;
  }
  await p.waitForTimeout(800);
  // 放宽范围，制造一张长表以便滚动
  await p.uncheck('#cbNearAtm');
  await p.waitForTimeout(1200);

  const rowCount = await p.locator('table.chain tbody tr').count();
  console.log('SPX 期权链行数: ' + rowCount);
  const cellCount = await p.locator('td.cell-c').count();
  console.log('可点击单元格数: ' + cellCount + '\n');

  console.log('=== 1. 下单后表格是否被重建 ===');
  // 给表格打标记，若被 innerHTML 重建则标记消失
  await p.evaluate(() => {
    document.querySelector('table.chain').dataset.probe = 'keep-me';
  });
  await p.locator('table.chain tbody tr.atm td.cell-c[data-side="buy"]').first().click();
  await p.waitForSelector('#btnBuy');
  await p.click('#btnBuy');
  await p.waitForTimeout(1000);
  const survived = await p.evaluate(() =>
    document.querySelector('table.chain')?.dataset.probe === 'keep-me');
  ck('表格未被重建（DOM 保留）', survived);

  console.log('\n=== 2. 下单后滚动位置是否保住 ===');
  // 合约已在上一步选中，下单按钮在侧边栏，不在滚动容器内。
  // 必须先滚动再点侧边栏按钮 —— 若点表格内的单元格，
  // Playwright 会自动把元素滚进视口，测出来的是工具行为而非应用行为。
  await p.evaluate(() => { document.getElementById('chainWrap').scrollTop = 600; });
  await p.waitForTimeout(300);
  const before = await p.evaluate(() => document.getElementById('chainWrap').scrollTop);
  await p.click('#btnBuy');
  await p.waitForTimeout(1000);
  const after = await p.evaluate(() => document.getElementById('chainWrap').scrollTop);
  console.log('   下单前 scrollTop=' + before + '  下单后=' + after);
  ck('滚动位置保持', before > 0 && Math.abs(after - before) < 5, `(${before} → ${after})`);

  console.log('\n=== 3. 持仓标记是否正确同步 ===');
  const marks = await p.evaluate(() => {
    const held = new Set(JSON.parse(localStorage.getItem('us-options-sim-v1')).positions.map(x => x.symbol));
    const marked = [...document.querySelectorAll('td.cell-c.has-pos')].map(td => td.dataset.sym);
    return { heldCount: held.size, markedCount: marked.length, allMatch: marked.every(s => held.has(s)) };
  });
  console.log('   持仓数=' + marks.heldCount + '  标记数=' + marks.markedCount);
  ck('标记与持仓一致', marks.markedCount === marks.heldCount && marks.allMatch);

  console.log('\n=== 4. 事件委托：切换到期日后点击仍生效 ===');
  await p.locator('.exp-chip').nth(3).click();
  await p.waitForTimeout(1200);
  await p.locator('table.chain tbody tr.atm td.cell-c[data-side="buy"]').first().click();
  await p.waitForTimeout(600);
  const panelOk = await p.locator('#btnBuy').count();
  ck('重建后单元格点击仍生效', panelOk === 1);
  const expActive = await p.locator('.exp-chip.active').getAttribute('data-i');
  ck('到期日切换生效', expActive === '3', `(active=${expActive})`);

  console.log('\n=== 5. 平仓按钮委托 ===');
  await p.click('.tab[data-pane="panePos"]');
  await p.waitForTimeout(600);
  const posBefore = await p.locator('#posTable tbody tr').count();
  await p.locator('#posTable [data-close]').first().click();
  await p.waitForTimeout(1200);
  const posAfter = await p.locator('#posTable tbody tr').count();
  console.log('   持仓 ' + posBefore + ' → ' + posAfter);
  ck('平仓按钮生效', posAfter === posBefore - 1);

  console.log('\n=== 6. 策略卡片委托 ===');
  await p.click('.tab[data-pane="paneStrat"]');
  await p.waitForTimeout(400);
  await p.locator('.strat-card[data-id="iron-condor"]').click();
  await p.waitForTimeout(900);
  const title = await p.locator('#stratTitle').textContent();
  ck('策略卡片点击生效', /铁鹰/.test(title), `(${title})`);
  const legs = await p.locator('#stratBody table.data tbody tr').count();
  ck('策略四腿正常', legs === 4, `(${legs} 腿)`);
  await p.click('#btnStratCancel');

  console.log('\n=== 7. 工具栏只重画期权链 ===');
  await p.click('.tab[data-pane="paneTrade"]');
  await p.waitForTimeout(300);
  await p.evaluate(() => { document.getElementById('posTable').dataset.probe = 'untouched'; });
  await p.uncheck('#cbGreeks');
  await p.waitForTimeout(900);
  const posUntouched = await p.evaluate(() =>
    document.getElementById('posTable').dataset.probe === 'untouched');
  ck('切换希腊字母列不影响持仓区块', posUntouched);

  console.log('\n控制台错误: ' + (errors.length || '无'));
  errors.slice(0, 6).forEach(e => console.log('  ERR: ' + e));
  if (errors.length) fail++;

  console.log(fail === 0 ? '\n*** 细粒度渲染验证全部通过 ***' : `\n*** ${fail} 项失败 ***`);
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常: ' + e.message + '\n' + e.stack); process.exit(1); });
