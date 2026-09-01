// 用桩对象模拟 Vercel 的 req/res，验证 serverless 函数行为
const zlib = require('zlib');
const chain = require(__dirname + '/../api/chain.js');
const health = require(__dirname + '/../api/health.js');

function mkRes() {
  const r = {
    statusCode: 0, headers: {}, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b) { this.body = b; this._done = true; return this; },
  };
  return r;
}
function mkReq(symbol, gzip = true, method = 'GET') {
  return {
    method,
    query: symbol === undefined ? {} : { symbol },
    headers: gzip ? { 'accept-encoding': 'gzip, deflate' } : {},
  };
}

let fail = 0;
const ck = (n, c, extra) => {
  if (!c) fail++;
  console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (extra ? '  ' + extra : ''));
};

(async () => {
  console.log('=== 1. 大标的 SPX：必须 gzip 且在 4.5MB 以内 ===');
  let res = mkRes();
  await chain(mkReq('SPX'), res);
  const gzLen = res.body.length;
  const inflated = zlib.gunzipSync(res.body);
  const d = JSON.parse(inflated.toString());
  console.log('   状态码: ' + res.statusCode);
  console.log('   Content-Encoding: ' + res.headers['content-encoding']);
  console.log('   压缩后: ' + (gzLen / 1048576).toFixed(2) + 'MB  解压后: ' + (inflated.length / 1048576).toFixed(2) + 'MB');
  console.log('   Cache-Control: ' + res.headers['cache-control']);
  ck('SPX 返回 200', res.statusCode === 200);
  ck('已启用 gzip', res.headers['content-encoding'] === 'gzip');
  ck('压缩后 < 4.5MB（Vercel 上限）', gzLen < 4.5 * 1048576, '(' + (gzLen / 1048576).toFixed(2) + 'MB)');
  ck('解压后原始 > 4.5MB（证明必须压缩）', inflated.length > 4.5 * 1048576, '(' + (inflated.length / 1048576).toFixed(2) + 'MB)');
  ck('设置了 Vary 头', res.headers['vary'] === 'Accept-Encoding');
  ck('数据完整 ok=true', d.ok === true);
  ck('SPX 合约数 > 20000', d.contractCount > 20000, '(' + d.contractCount + ')');
  ck('含 CDN 缓存头', /s-maxage/.test(res.headers['cache-control'] || ''));

  console.log('\n=== 2. 不支持 gzip 的客户端（小标的应正常）===');
  res = mkRes();
  await chain(mkReq('AAPL', false), res);
  ck('AAPL 无 gzip 返回 200', res.statusCode === 200);
  ck('未设置 Content-Encoding', !res.headers['content-encoding']);
  const plain = JSON.parse(res.body.toString());
  ck('数据可直接解析', plain.ok === true && plain.symbol === 'AAPL');
  console.log('   体积: ' + (res.body.length / 1048576).toFixed(2) + 'MB');

  console.log('\n=== 3. 默认标的（不传 symbol）===');
  res = mkRes();
  await chain(mkReq(undefined), res);
  const dflt = JSON.parse(zlib.gunzipSync(res.body).toString());
  ck('默认回落到 AAPL', dflt.symbol === 'AAPL', '(' + dflt.symbol + ')');

  console.log('\n=== 4. 指数标的下划线映射 ===');
  res = mkRes();
  await chain(mkReq('VIX'), res);
  const vix = JSON.parse(res.headers['content-encoding'] ? zlib.gunzipSync(res.body).toString() : res.body.toString());
  ck('VIX 正确解析', res.statusCode === 200 && vix.ok === true, '(symbol=' + vix.symbol + ')');

  console.log('\n=== 5. 无效标的错误处理 ===');
  res = mkRes();
  await chain(mkReq('ZZZZNOTREAL'), res);
  const err = JSON.parse(res.body.toString());
  console.log('   状态码: ' + res.statusCode);
  console.log('   错误信息: ' + err.error);
  ck('返回 404', res.statusCode === 404);
  ck('ok=false', err.ok === false);
  ck('错误响应不缓存', res.headers['cache-control'] === 'no-store');

  console.log('\n=== 6. OPTIONS 预检 ===');
  res = mkRes();
  await chain(mkReq('AAPL', true, 'OPTIONS'), res);
  ck('返回 204', res.statusCode === 204);
  ck('含 CORS 头', res.headers['access-control-allow-origin'] === '*');

  console.log('\n=== 7. 健康检查 ===');
  res = mkRes();
  health(mkReq(undefined), res);
  const h = JSON.parse(res.body);
  console.log('   ' + JSON.stringify(h));
  ck('health 返回 200', res.statusCode === 200);
  ck('标记为 serverless 模式', h.mode === 'serverless');

  console.log('\n=== 8. 本地与 serverless 数据一致性 ===');
  const cboe = require(__dirname + '/../lib/cboe.js');
  const direct = await cboe.handleChain('AAPL');
  res = mkRes();
  await chain(mkReq('AAPL'), res);
  const viaFn = JSON.parse(zlib.gunzipSync(res.body).toString());
  ck('两条路径合约数一致', direct.contractCount === viaFn.contractCount,
    '(' + direct.contractCount + ' vs ' + viaFn.contractCount + ')');
  ck('两条路径到期日数一致', direct.expiries.length === viaFn.expiries.length);
  ck('共用同一数据层（缓存命中）', viaFn.cached === true || direct.cached === true);

  console.log(fail === 0 ? '\n*** Serverless 函数全部通过 ***' : '\n*** ' + fail + ' 项失败 ***');
  process.exit(fail ? 1 : 0);
})();
