global.window = global;
require(__dirname + '/../js/optionmath.js');
const M = global.OptionMath;
let fail = 0;
function ck(name, got, want, tol) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) fail++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + ': got=' + got.toFixed(6) + ' want=' + want.toFixed(6));
}

console.log('=== 1. Hull 教科书基准 (S=42,K=40,T=0.5,v=0.2,r=0.1) ===');
ck('call price', M.price('call', 42, 40, 0.5, 0.2, 0.1, 0), 4.759422, 1e-3);
ck('put  price', M.price('put', 42, 40, 0.5, 0.2, 0.1, 0), 0.808599, 1e-3);

console.log('\n=== 2. Put-Call Parity ===');
const S = 100, K = 105, T = 0.75, v = 0.28, r = 0.045, q = 0.015;
const c = M.price('call', S, K, T, v, r, q), p = M.price('put', S, K, T, v, r, q);
ck('parity', c - p, S * Math.exp(-q * T) - K * Math.exp(-r * T), 1e-8);

console.log('\n=== 3. CDF 精度 ===');
ck('cdf(0)', M.cdf(0), 0.5, 1e-9);
ck('cdf(1.96)', M.cdf(1.96), 0.975002, 1e-6);
// 注意：0.005 是教科书四舍五入值，真值为 0.0049975323157350204
ck('cdf(-2.576)', M.cdf(-2.576), 0.0049975323157350204, 1e-15);

console.log('\n=== 4. 希腊字母 vs 数值微分 ===');
const g = M.greeks('call', S, K, T, v, r, q);
const h = 0.001;
const numDelta = (M.price('call', S + h, K, T, v, r, q) - M.price('call', S - h, K, T, v, r, q)) / (2 * h);
const numGamma = (M.price('call', S + h, K, T, v, r, q) - 2 * M.price('call', S, K, T, v, r, q) + M.price('call', S - h, K, T, v, r, q)) / (h * h);
const numVega = (M.price('call', S, K, T, v + 1e-5, r, q) - M.price('call', S, K, T, v - 1e-5, r, q)) / (2e-5) / 100;
const numTheta = (M.price('call', S, K, T - 1 / 365, v, r, q) - M.price('call', S, K, T, v, r, q));
const numRho = (M.price('call', S, K, T, v, r + 1e-6, q) - M.price('call', S, K, T, v, r - 1e-6, q)) / (2e-6) / 100;
ck('delta', g.delta, numDelta, 1e-6);
ck('gamma', g.gamma, numGamma, 1e-5);
ck('vega ', g.vega, numVega, 1e-8);
ck('theta', g.theta, numTheta, 1e-4);
ck('rho  ', g.rho, numRho, 1e-6);

console.log('\n=== 5. 隐含波动率往返测试 ===');
[[0.09, '深度低波'], [0.25, '常规'], [0.85, '高波'], [2.2, '极端高波']].forEach(function (pair) {
  const tv = pair[0], label = pair[1];
  const px = M.price('call', S, K, T, tv, r, q);
  ck('IV反解 ' + label + ' v=' + tv, M.impliedVol('call', px, S, K, T, r, q), tv, 1e-5);
});
const pxp = M.price('put', 100, 150, 0.4, 0.55, r, q);
ck('IV反解 深度价内put', M.impliedVol('put', pxp, 100, 150, 0.4, r, q), 0.55, 1e-5);

console.log('\n=== 6. OCC 解析 ===');
const o = M.parseOCC('AAPL260831C00205000');
console.log('  ' + JSON.stringify(o));
const ok6 = o.root === 'AAPL' && o.expiry === '2026-08-31' && o.type === 'call' && o.strike === 205;
console.log('  ' + (ok6 ? 'PASS' : 'FAIL'));
if (!ok6) fail++;
const o2 = M.parseOCC('SPXW261218P06000000');
console.log('  ' + JSON.stringify(o2) + ' ' + (o2.strike === 6000 ? 'PASS' : 'FAIL'));
if (o2.strike !== 6000) fail++;

console.log('\n=== 7. 牛市看涨价差损益 ===');
const legs = [
  { kind: 'option', type: 'call', strike: 100, qty: 1, entryPrice: 5, iv: 0.3, T: 0.25, multiplier: 100 },
  { kind: 'option', type: 'call', strike: 110, qty: -1, entryPrice: 2, iv: 0.3, T: 0.25, multiplier: 100 },
];
ck('S=90  最大亏损', M.payoffAtExpiry(legs, 90), -300, 1e-9);
ck('S=103 中间', M.payoffAtExpiry(legs, 103), 0, 1e-9);
ck('S=120 最大盈利', M.payoffAtExpiry(legs, 120), 700, 1e-9);
const cur = M.payoffCurve(legs, 100, 0.35, 241);
console.log('  breakeven: ' + cur.breakevens.map(function (x) { return x.toFixed(2); }).join(',') + ' (应≈103)');
console.log('  maxProfit: ' + cur.maxProfit.toFixed(2) + ' maxLoss: ' + cur.maxLoss.toFixed(2));

console.log('\n=== 8. 组合希腊字母：跨式 ===');
const strad = [
  { kind: 'option', type: 'call', strike: 100, qty: 1, entryPrice: 6, iv: 0.3, T: 0.25, multiplier: 100 },
  { kind: 'option', type: 'put', strike: 100, qty: 1, entryPrice: 5, iv: 0.3, T: 0.25, multiplier: 100 },
];
const pg = M.portfolioGreeks(strad, 100, { r: 0.04 });
console.log('  delta=' + pg.delta.toFixed(3) + ' gamma=' + pg.gamma.toFixed(4) + ' vega=' + pg.vega.toFixed(3) + ' theta=' + pg.theta.toFixed(3));
console.log('  跨式 delta 接近0: ' + (Math.abs(pg.delta) < 12 ? 'PASS' : 'FAIL'));
console.log('  跨式 vega 为正: ' + (pg.vega > 0 ? 'PASS' : 'FAIL'));
console.log('  跨式 theta 为负: ' + (pg.theta < 0 ? 'PASS' : 'FAIL'));

console.log('\n=== 9. 边界条件 ===');
console.log('  T=0 价内call: ' + M.price('call', 110, 100, 0, 0.3, 0.05, 0) + ' (应=10)');
console.log('  T=0 价外put : ' + M.price('put', 110, 100, 0, 0.3, 0.05, 0) + ' (应=0)');
console.log('  v=0: ' + M.price('call', 110, 100, 0.5, 0, 0, 0).toFixed(4) + ' (应=10)');
console.log('  低于内在价值的IV: ' + M.impliedVol('call', 0.5, 110, 100, 0.5, 0, 0) + ' (应=0)');
const gz = M.greeks('call', 100, 100, 0, 0.3, 0.05, 0);
console.log('  T=0 希腊字母无NaN: ' + ([gz.price, gz.delta, gz.gamma, gz.theta].every(isFinite) ? 'PASS' : 'FAIL'));

console.log(fail === 0 ? '\n\n*** 全部通过 ***' : '\n\n*** ' + fail + ' 项失败 ***');
