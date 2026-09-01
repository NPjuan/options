/**
 * Vercel Serverless 函数 — 健康检查
 *   GET /api/health
 */

const cboe = require('../lib/cboe');

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 200;
  res.end(JSON.stringify({
    ok: true,
    mode: 'serverless',
    region: process.env.VERCEL_REGION || null,
    cached: cboe.cacheSize(),
    time: new Date().toISOString(),
  }));
};
