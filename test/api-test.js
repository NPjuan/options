/**
 * 服务层测试：启动真实 HTTP 服务，验证路由、压缩与错误处理。
 *
 * 重点覆盖 gzip：SPX 精简后的 JSON 实测约 5.4MB，
 * 而多数托管平台对单次响应体有 4.5MB 上限，必须压缩后才能返回。
 * 不显式断言的话，这个问题在本地开发时完全不会暴露。
 */

const http = require('http');
const zlib = require('zlib');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 8877;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');

let fail = 0;
function ck(name, cond, extra) {
  if (!cond) fail++;
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : ''));
}

/** 发起请求，返回 {status, headers, buf} */
function req(pathname, gzip = true) {
  return new Promise((resolve, reject) => {
    const r = http.get(BASE + pathname, {
      headers: gzip ? { 'Accept-Encoding': 'gzip' } : {},
      timeout: 40000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        buf: Buffer.concat(chunks),
      }));
    });
    r.on('timeout', () => r.destroy(new Error('请求超时')));
    r.on('error', reject);
  });
}

/** 按 Content-Encoding 解出 JSON */
function parse(r) {
  const body = r.headers['content-encoding'] === 'gzip'
    ? zlib.gunzipSync(r.buf)
    : r.buf;
  return JSON.parse(body.toString('utf8'));
}

function waitReady(proc) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 20000;
    const tick = () => {
      if (Date.now() > deadline) return reject(new Error('服务启动超时'));
      http.get(BASE + '/api/health', (res) => {
        res.resume();
        res.statusCode === 200 ? resolve() : setTimeout(tick, 300);
      }).on('error', () => setTimeout(tick, 300));
    };
    proc.on('exit', (code) => reject(new Error('服务进程退出，code=' + code)));
    tick();
  });
}

(async () => {
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  try {
    await waitReady(server);

    console.log('=== 1. 静态资源 ===');
    for (const [p, kw] of [['/', '<title>'], ['/index.html', '<title>'],
                           ['/style.css', ':root'], ['/js/app.js', 'OptionMath']]) {
      const r = await req(p);
      const text = (r.headers['content-encoding'] === 'gzip'
        ? zlib.gunzipSync(r.buf) : r.buf).toString('utf8');
      ck(`${p} 返回 200 且内容正确`, r.status === 200 && text.includes(kw), `(${r.status})`);
    }

    console.log('\n=== 2. 大标的 SPX：必须 gzip 且控制在 4.5MB 内 ===');
    let r = await req('/api/chain?symbol=SPX');
    const gz = r.buf.length;
    const raw = zlib.gunzipSync(r.buf);
    const spx = JSON.parse(raw.toString('utf8'));
    console.log(`   压缩后 ${(gz / 1048576).toFixed(2)}MB  解压后 ${(raw.length / 1048576).toFixed(2)}MB`);
    ck('SPX 返回 200', r.status === 200);
    ck('已启用 gzip', r.headers['content-encoding'] === 'gzip');
    ck('压缩后 < 4.5MB', gz < 4.5 * 1048576, `(${(gz / 1048576).toFixed(2)}MB)`);
    ck('解压后 > 4.5MB（证明必须压缩）', raw.length > 4.5 * 1048576,
      `(${(raw.length / 1048576).toFixed(2)}MB)`);
    ck('合约数 > 20000', spx.contractCount > 20000, `(${spx.contractCount})`);

    console.log('\n=== 3. 不支持 gzip 的客户端 ===');
    r = await req('/api/chain?symbol=AAPL', false);
    ck('返回 200', r.status === 200);
    ck('未设置 Content-Encoding', !r.headers['content-encoding']);
    ck('可直接解析', JSON.parse(r.buf.toString()).ok === true);

    console.log('\n=== 4. 默认标的与指数映射 ===');
    ck('不传 symbol 回落 AAPL', parse(await req('/api/chain')).symbol === 'AAPL');
    const vix = parse(await req('/api/chain?symbol=VIX'));
    ck('VIX 正确解析', vix.ok === true, `(symbol=${vix.symbol})`);

    console.log('\n=== 5. 无效标的 ===');
    r = await req('/api/chain?symbol=ZZZZNOTREAL');
    const err = parse(r);
    ck('返回 404', r.status === 404, `(${r.status})`);
    ck('ok=false 且有错误信息', err.ok === false && !!err.error);

    console.log('\n=== 6. 健康检查与未知路径 ===');
    const h = parse(await req('/api/health'));
    ck('health ok', h.ok === true, JSON.stringify(h));
    ck('未知路径返回 404', (await req('/nope.txt')).status === 404);

    console.log(fail === 0 ? '\n*** 服务层全部通过 ***' : `\n*** ${fail} 项失败 ***`);
  } catch (e) {
    fail++;
    console.error('测试异常: ' + e.message);
  } finally {
    server.kill('SIGKILL');
  }
  process.exit(fail ? 1 : 0);
})();
