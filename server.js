/**
 * 美股期权模拟器 — 本地开发服务
 *
 * 数据逻辑全部委托给 lib/cboe.js（与 Vercel 函数共用同一份实现），
 * 本文件只负责本地开发所需的两件事：
 *   1. 静态文件托管（Vercel 上由平台自身处理）
 *   2. 把 /api/* 路由转到共享数据层
 *
 * 生产环境（Vercel）不会执行本文件 —— serverless 没有常驻进程，
 * 请求由 api/ 目录下的函数处理，PORT 概念也不存在。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');

const cboe = require('./lib/cboe');

const PORT = Number(process.env.PORT || 8848);
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJSON(res, status, obj, acceptEncoding = '') {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  };
  if (/\bgzip\b/.test(acceptEncoding) && body.length > 1024) {
    zlib.gzip(body, (err, gz) => {
      if (err) { res.writeHead(status, headers); return res.end(body); }
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(status, headers);
      res.end(gz);
    });
  } else {
    res.writeHead(status, headers);
    res.end(body);
  }
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }

  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
    const ae = req.headers['accept-encoding'] || '';
    if (/\bgzip\b/.test(ae) && buf.length > 1024 && /text|javascript|json|svg/.test(type)) {
      zlib.gzip(buf, (e, gz) => {
        if (e) { res.writeHead(200, headers); return res.end(buf); }
        headers['Content-Encoding'] = 'gzip';
        res.writeHead(200, headers);
        res.end(gz);
      });
    } else {
      res.writeHead(200, headers);
      res.end(buf);
    }
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const ae = req.headers['accept-encoding'] || '';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (u.pathname === '/api/chain') {
    try {
      const data = await cboe.handleChain(u.searchParams.get('symbol') || 'AAPL');
      return sendJSON(res, 200, data, ae);
    } catch (e) {
      return sendJSON(res, e.status || 502, { ok: false, error: e.message || '数据获取失败' }, ae);
    }
  }

  if (u.pathname === '/api/health') {
    return sendJSON(res, 200, {
      ok: true,
      mode: 'local',
      port: PORT,
      cached: cboe.cacheSize(),
      time: new Date().toISOString(),
    }, ae);
  }

  return serveStatic(req, res, u.pathname);
});

/**
 * 监听地址按环境区分：
 *   - 线上（Vercel）：必须监听 0.0.0.0，否则平台无法把流量转进来
 *   - 本地开发：只绑回环地址，避免把服务暴露到局域网
 */
const IS_HOSTED = Boolean(process.env.VERCEL || process.env.NOW_REGION);
const HOST = IS_HOSTED ? '0.0.0.0' : '127.0.0.1';

server.listen(PORT, HOST, () => {
  if (IS_HOSTED) {
    console.log(`options-sim listening on ${HOST}:${PORT}`);
    return;
  }
  console.log(`\n  美股期权模拟器已启动`);
  console.log(`  ➜  http://localhost:${PORT}\n`);
  console.log(`  数据源：CBOE 官方延迟报价（约 15 分钟延迟）`);
  console.log(`  按 Ctrl+C 停止服务\n`);
});
