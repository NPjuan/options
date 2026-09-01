global.window = global;
require(__dirname + '/../js/optionmath.js');
const M = global.OptionMath;

let fail = 0;
const ck = (n, c) => { if (!c) fail++; console.log((c ? 'PASS' : 'FAIL') + '  ' + n); };

console.log('=== 1. 单一到期日策略不受影响（回归）===');
const bull = [
  { kind: 'option', type: 'call', strike: 100, qty: 1, entryPrice: 5, iv: 0.3, T: 0.25, multiplier: 100 },
  { kind: 'option', type: 'call', strike: 110, qty: -1, entryPrice: 2, iv: 0.3, T: 0.25, multiplier: 100 },
];
console.log('  S=90 :', M.payoffAtExpiry(bull, 90).toFixed(2), '(应 -300)');
console.log('  S=120:', M.payoffAtExpiry(bull, 120).toFixed(2), '(应 +700)');
ck('牛市价差最大亏损仍为 -300', Math.abs(M.payoffAtExpiry(bull, 90) + 300) < 1e-9);
ck('牛市价差最大盈利仍为 +700', Math.abs(M.payoffAtExpiry(bull, 120) - 700) < 1e-9);

console.log('\n=== 2. 日历价差：卖近月 + 买远月（同行权价 100）===');
// 近月 30 天，远月 90 天
const cal = [
  { kind: 'option', type: 'call', strike: 100, qty: -1, entryPrice: 3.0, iv: 0.30, T: 30 / 365, multiplier: 100 },
  { kind: 'option', type: 'call', strike: 100, qty: 1, entryPrice: 5.5, iv: 0.30, T: 90 / 365, multiplier: 100 },
];
console.log('  净支出 = (5.5 - 3.0) * 100 = $250');
const pts = [70, 85, 95, 100, 105, 115, 130].map(s => ({ s, p: M.payoffAtExpiry(cal, s, { r: 0.0525 }) }));
pts.forEach(x => console.log('  S=' + String(x.s).padStart(4) + '  损益=' + x.p.toFixed(2).padStart(9)));

const atK = M.payoffAtExpiry(cal, 100, { r: 0.0525 });
const far = M.payoffAtExpiry(cal, 70, { r: 0.0525 });
const farUp = M.payoffAtExpiry(cal, 130, { r: 0.0525 });
ck('行权价附近为最大盈利（帐篷形）', atK > far && atK > farUp);
ck('两端为亏损', far < 0 && farUp < 0);
ck('最大盈利为正', atK > 0);

const curve = M.payoffCurve(cal, 100, 0.35, 161, { r: 0.0525 });
console.log('\n  曲线扫描: 最大盈利=' + curve.maxProfit.toFixed(2)
  + '  最大亏损=' + curve.maxLoss.toFixed(2));
console.log('  盈亏平衡点: ' + curve.breakevens.map(x => x.toFixed(2)).join(', '));
ck('最大盈利 != 最大亏损（修复前两者相等）', Math.abs(curve.maxProfit - curve.maxLoss) > 1);
ck('日历价差应有 2 个盈亏平衡点', curve.breakevens.length === 2);
ck('最大亏损接近净支出 -250', curve.maxLoss > -260 && curve.maxLoss < -180);

console.log('\n=== 3. 两端极值应趋近净支出（远月也变价外/深度价内）===');
console.log('  S=40 :', M.payoffAtExpiry(cal, 40, { r: 0.0525 }).toFixed(2), '(深度价外，两腿都近乎0 → 约 -250)');
console.log('  S=300:', M.payoffAtExpiry(cal, 300, { r: 0.0525 }).toFixed(2), '(深度价内，内在价值抵消 → 约 -250)');

console.log('\n=== 4. 相同到期日时新旧行为一致 ===');
const same = [
  { kind: 'option', type: 'call', strike: 100, qty: 1, entryPrice: 5, iv: 0.3, T: 0.25, multiplier: 100 },
  { kind: 'option', type: 'put', strike: 100, qty: 1, entryPrice: 4, iv: 0.3, T: 0.25, multiplier: 100 },
];
// 跨式：到期时两腿都到期，应为标准 V 形
[80, 91, 100, 109, 120].forEach(s => {
  const got = M.payoffAtExpiry(same, s, { r: 0.05 });
  const want = (Math.max(0, s - 100) - 5) * 100 + (Math.max(0, 100 - s) - 4) * 100;
  const ok = Math.abs(got - want) < 1e-9;
  if (!ok) fail++;
  console.log('  S=' + String(s).padStart(4) + '  got=' + got.toFixed(2).padStart(8)
    + '  want=' + want.toFixed(2).padStart(8) + '  ' + (ok ? 'PASS' : 'FAIL'));
});

console.log('\n=== 5. 无 opts 时不崩（向后兼容）===');
try {
  const v = M.payoffAtExpiry(cal, 100);
  console.log('  无 opts 调用结果: ' + v.toFixed(2));
  ck('无 opts 不抛异常', isFinite(v));
} catch (e) { fail++; console.log('FAIL 抛出异常: ' + e.message); }

console.log(fail === 0 ? '\n*** 全部通过 ***' : '\n*** ' + fail + ' 项失败 ***');
