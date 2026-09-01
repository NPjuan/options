// 交易引擎测试：用内存 localStorage 打桩
const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
global.window = global;
require(__dirname + '/../js/optionmath.js');
require(__dirname + '/../js/account.js');

let fail = 0;
function ck(name, got, want, tol) {
  tol = tol || 1e-9;
  const ok = Math.abs(got - want) <= tol;
  if (!ok) fail++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + ': got=' + got.toFixed(4) + ' want=' + want.toFixed(4));
}
function ckTrue(name, cond) {
  if (!cond) fail++;
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
}

const A = new global.SimAccount();
A.reset(100000);
A.settings.slippageMode = 'mid';
const Q = { b: 5.00, a: 5.20, l: 5.10, th: 5.10 };
const META = { underlying: 'AAPL', type: 'call', strike: 320, expiry: '2026-12-18', iv: 0.25, T: 0.3, multiplier: 100 };

console.log('=== 1. 买入开仓 2 张 @ 中间价 5.10 ===');
let r = A.placeOrder({ kind: 'option', symbol: 'AAPL261218C00320000', side: 'buy', qty: 2, quote: Q, meta: META });
console.log('  成交价=' + r.fillPrice + ' 佣金=' + r.fee);
ck('成交价=中间价', r.fillPrice, 5.10);
ck('佣金 2张*0.65=1.30', r.fee, 1.30);
ck('现金 = 100000 - 1020 - 1.30', A.cash, 100000 - 1020 - 1.30, 1e-6);
ck('持仓张数', A.positions[0].qty, 2);
ck('持仓均价', A.positions[0].avgPrice, 5.10);

console.log('\n=== 2. 同向加仓 3 张 @ 6.00，验证加权均价 ===');
r = A.placeOrder({ kind: 'option', symbol: 'AAPL261218C00320000', side: 'buy', qty: 3, quote: { b: 5.9, a: 6.1, l: 6, th: 6 }, meta: META });
ck('加仓后张数', A.positions[0].qty, 5);
ck('加权均价 (2*5.1+3*6)/5', A.positions[0].avgPrice, (2 * 5.10 + 3 * 6.00) / 5, 1e-9);

console.log('\n=== 3. 部分平仓 2 张 @ 7.00 ===');
const cashBefore = A.cash;
r = A.placeOrder({ kind: 'option', symbol: 'AAPL261218C00320000', side: 'sell', qty: 2, quote: { b: 6.9, a: 7.1, l: 7, th: 7 }, meta: META });
const avg = (2 * 5.10 + 3 * 6.00) / 5;
ck('已实现盈亏 (7-均价)*2*100', r.realized, (7 - avg) * 2 * 100, 0.01);
ck('剩余张数', A.positions[0].qty, 3);
ck('均价不变(部分平仓)', A.positions[0].avgPrice, avg, 1e-9);
ck('现金增加 1400-1.3', A.cash - cashBefore, 1400 - 1.30, 1e-6);
ckTrue('流水标记为平仓', A.trades[0].action === '平仓');

console.log('\n=== 4. 反向超量：持多 3 张，卖出 5 张 → 应变为空 2 张且均价重置 ===');
r = A.placeOrder({ kind: 'option', symbol: 'AAPL261218C00320000', side: 'sell', qty: 5, quote: { b: 7.9, a: 8.1, l: 8, th: 8 }, meta: META });
ck('平掉 3 张的已实现盈亏', r.realized, (8 - avg) * 3 * 100, 0.01);
ck('反向后张数 = -2', A.positions[0].qty, -2);
ck('均价重置为 8.00', A.positions[0].avgPrice, 8.00, 1e-9);

console.log('\n=== 5. 全部平仓，持仓应清空 ===');
r = A.placeOrder({ kind: 'option', symbol: 'AAPL261218C00320000', side: 'buy', qty: 2, quote: { b: 7.4, a: 7.6, l: 7.5, th: 7.5 }, meta: META });
ck('空头平仓盈亏 (7.5-8)*2*100*(-1)', r.realized, (7.5 - 8) * 2 * 100 * -1, 0.01);
ckTrue('持仓已清空', A.positions.length === 0);

console.log('\n=== 6. 现金守恒校验 ===');
// 手工累加所有现金流
let expectCash = 100000;
A.trades.forEach(function (t) {
  if (t.action === '到期结算') { expectCash += t.price * t.qty * t.multiplier * (t.side === 'sell' ? 1 : -1); return; }
  expectCash += (t.side === 'buy' ? -1 : 1) * t.price * t.qty * t.multiplier;
  expectCash -= t.fee;
});
ck('现金与流水一致', A.cash, expectCash, 1e-6);
const st = A.stats();
console.log('  统计: 总交易=' + st.totalTrades + ' 平仓=' + st.closedTrades + ' 胜率=' + st.winRate.toFixed(1) + '%'
  + ' 净已实现=' + st.netRealized.toFixed(2) + ' 总佣金=' + st.totalFees.toFixed(2));
ck('净值 = 现金(无持仓)', A.markToMarket(function () { return {}; }).equity, A.cash, 1e-9);

console.log('\n=== 7. 滑点模式 ===');
A.settings.slippageMode = 'aggressive';
ck('主动买单吃卖价', A.fillPrice(Q, 'buy').price, 5.20);
ck('主动卖单吃买价', A.fillPrice(Q, 'sell').price, 5.00);
A.settings.slippageMode = 'passive';
ck('被动买单挂买价', A.fillPrice(Q, 'buy').price, 5.00);
A.settings.slippageMode = 'mid';
ck('中间价', A.fillPrice(Q, 'buy').price, 5.10);
const noQuote = A.fillPrice({ b: 0, a: 0, l: 0, th: 3.33 }, 'buy');
ck('无报价回退理论价', noQuote.price, 3.33);
ckTrue('无报价有告警', !!noQuote.warn);

console.log('\n=== 8. 资金不足与保证金拦截 ===');
const B = new global.SimAccount();
B.reset(1000);
let bad = B.placeOrder({ kind: 'option', symbol: 'X261218C00100000', side: 'buy', qty: 50, quote: { b: 9.9, a: 10.1, l: 10, th: 10 }, meta: META });
ckTrue('买入资金不足被拦截: ' + bad.error, !bad.ok);
bad = B.placeOrder({ kind: 'option', symbol: 'X261218C00100000', side: 'sell', qty: 10, quote: { b: 9.9, a: 10.1, l: 10, th: 10 }, meta: { underlying: 'X', type: 'call', strike: 100, expiry: '2026-12-18', multiplier: 100, underlyingPrice: 100 } });
ckTrue('卖出保证金不足被拦截: ' + bad.error, !bad.ok);
bad = B.placeOrder({ kind: 'option', symbol: 'X', side: 'buy', qty: 0, quote: Q, meta: META });
ckTrue('零数量被拦截', !bad.ok);
ck('拦截后现金未变', B.cash, 1000, 1e-9);

console.log('\n=== 9. 到期结算 ===');
const C = new global.SimAccount();
C.reset(50000);
C.placeOrder({ kind: 'option', symbol: 'AAPL250101C00300000', side: 'buy', qty: 2, quote: { b: 4.9, a: 5.1, l: 5, th: 5 }, meta: { underlying: 'AAPL', type: 'call', strike: 300, expiry: '2025-01-01', iv: 0.3, T: 0.01, multiplier: 100 } });
const before = C.cash;
const res = C.settleExpired({ AAPL: 330 });
console.log('  结算 ' + res.count + ' 个持仓, 盈亏=' + res.pnl);
ck('价内 30 点 * 2 张 * 100 入账', C.cash - before, 30 * 2 * 100, 1e-6);
ck('结算盈亏 (30-5)*2*100', res.pnl, (30 - 5) * 2 * 100, 0.01);
ckTrue('到期持仓已移除', C.positions.length === 0);
ckTrue('流水记录到期结算', C.trades[0].action === '到期结算');

console.log('\n=== 10. 持久化 ===');
C.save();
const D = new global.SimAccount();
ck('恢复现金', D.cash, C.cash, 1e-9);
ckTrue('恢复流水条数', D.trades.length === C.trades.length);

console.log('\n=== 11. toLegs 与组合希腊字母 ===');
const E = new global.SimAccount();
E.reset(100000);
E.placeOrder({ kind: 'option', symbol: 'AAPL261218C00320000', side: 'buy', qty: 1, quote: Q, meta: META });
E.placeOrder({ kind: 'option', symbol: 'AAPL261218P00320000', side: 'buy', qty: 1, quote: { b: 4, a: 4.2, l: 4.1, th: 4.1 }, meta: Object.assign({}, META, { type: 'put' }) });
const legs = E.toLegs('AAPL', function () { return { iv: 0.25, T: 0.3 }; });
ckTrue('legs 数量=2', legs.length === 2);
const pg = global.OptionMath.portfolioGreeks(legs, 320, { r: 0.0525 });
console.log('  跨式组合: delta=' + pg.delta.toFixed(2) + ' gamma=' + pg.gamma.toFixed(4) + ' vega=' + pg.vega.toFixed(2) + ' theta=' + pg.theta.toFixed(2));
ckTrue('跨式 vega>0 且 theta<0', pg.vega > 0 && pg.theta < 0);
const curve = global.OptionMath.payoffCurve(legs, 320, 0.3, 121, { r: 0.0525 });
console.log('  盈亏平衡点: ' + curve.breakevens.map(function (x) { return x.toFixed(2); }).join(', '));
ckTrue('跨式应有 2 个盈亏平衡点', curve.breakevens.length === 2);

console.log(fail === 0 ? '\n*** 交易引擎全部通过 ***' : '\n*** ' + fail + ' 项失败 ***');
