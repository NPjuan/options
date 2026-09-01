/**
 * Vercel Serverless 函数 — 期权链代理
 *   GET /api/chain?symbol=AAPL
 *
 * 数据逻辑复用 lib/cboe.js，与本地 server.js 完全一致。
 *
 * 两个 serverless 特有的处理：
 *
 * 1) 必须 gzip 压缩响应。
 *    Vercel 单次响应体上限 4.5MB，而 SPX 精简后的 JSON 实测 5.38MB，
 *    直接返回会失败。gzip 后降到 1.15MB（压缩比约 4.7x），安全通过。
 *    本地 server.js 一直有 gzip，所以这个问题在本地不会暴露。
 *
 * 2) 依赖 CDN 缓存而非进程内存缓存。
 *    serverless 实例随时回收，模块级缓存只在同一热实例内有效。
 *    因此设置 s-maxage 让 Vercel 边缘节点承担主要缓存职责，
 *    把重复请求挡在 CBOE 之前。
 */

const zlib = require('zlib');
const cboe = require('../lib/cboe');

/** 客户端是否接受 gzip */
function acceptsGzip(req) {
  const ae = (req.headers && (req.headers['accept-encoding'] || '')) || '';
  return /\bgzip\b/.test(String(ae));
}

function send(req, res, status, payload, cacheControl) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cacheControl);
  res.statusCode = status;

  // 超过 1KB 且客户端支持时压缩。
  // 对 SPX 这类大标的这不是优化，而是能否返回成功的前提。
  if (body.length > 1024 && acceptsGzip(req)) {
    try {
      const gz = zlib.gzipSync(body);
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      return res.end(gz);
    } catch (e) {
      // 压缩失败则退回原文（小标的仍可正常返回）
    }
  }
  return res.end(body);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const symbol = (req.query && req.query.symbol) || 'AAPL';

  try {
    const data = await cboe.handleChain(symbol);
    // 上游本身有约 15 分钟延迟，边缘缓存 20 秒足够新鲜；
    // stale-while-revalidate 避免缓存过期瞬间出现空窗。
    return send(req, res, 200, data, 's-maxage=20, stale-while-revalidate=40');
  } catch (e) {
    return send(req, res, e.status || 502, {
      ok: false,
      error: e.message || '数据获取失败',
    }, 'no-store');
  }
};
