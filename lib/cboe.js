/**
 * CBOE 期权链数据层 — 抓取、解析、精简、缓存
 *
 * 本模块只做数据，不涉及 HTTP 服务形态，因此可同时被：
 *   - server.js        本地 Node 常驻服务
 *   - api/chain.js     Vercel Serverless 函数
 * 复用，避免两套部署形态各自维护一份逻辑而逐渐漂移。
 *
 * 数据源：CBOE 官方延迟报价（约 15 分钟延迟），含完整期权链、
 * 隐含波动率、全套希腊字母、理论价、未平仓量。
 * 该接口无 CORS 头，浏览器无法直连，必须服务端代理。
 */

const https = require('https');
const zlib = require('zlib');

/* ------------------------------------------------------------------ *
 * 指数类标的在 CBOE 的代码需要下划线前缀
 * ------------------------------------------------------------------ */
const INDEX_MAP = {
  SPX: '_SPX', VIX: '_VIX', NDX: '_NDX', RUT: '_RUT',
  DJX: '_DJX', XSP: '_XSP', OEX: '_OEX', VVIX: '_VVIX',
};

function cboeSymbol(raw) {
  const s = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9._]/g, '');
  if (!s) return null;
  if (s.startsWith('_')) return s;
  if (INDEX_MAP[s]) return INDEX_MAP[s];
  return s;
}

/* ------------------------------------------------------------------ *
 * 内存缓存：延迟数据无需高频拉取
 * ------------------------------------------------------------------ */
const cache = new Map();
const TTL = 20_000;

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL) { cache.delete(key); return null; }
  return hit.val;
}

function cacheSet(key, val) {
  cache.set(key, { at: Date.now(), val });
  if (cache.size > 40) {
    // 淘汰最旧条目
    let oldestKey = null, oldestAt = Infinity;
    for (const [k, v] of cache) if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
    if (oldestKey) cache.delete(oldestKey);
  }
}

/* ------------------------------------------------------------------ *
 * 带重试的 HTTPS 抓取（自动 gzip 解压）
 * ------------------------------------------------------------------ */
function fetchJSON(url, attempt = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: 25_000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept': 'application/json,text/plain,*/*',
        'Accept-Encoding': 'gzip, deflate',
        'Referer': 'https://www.cboe.com/',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchJSON(res.headers.location, attempt).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(Object.assign(new Error(`上游返回 HTTP ${res.statusCode}`), { status: res.statusCode }));
      }
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());

      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error('上游 JSON 解析失败')); }
      });
      stream.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('上游请求超时')));
    req.on('error', (err) => {
      if (attempt < 2) {
        setTimeout(() => fetchJSON(url, attempt + 1).then(resolve, reject), 400 * (attempt + 1));
      } else reject(err);
    });
  });
}

/* ------------------------------------------------------------------ *
 * OCC 合约代码解析
 *   AAPL260831C00205000
 *   └根  └YYMMDD └C/P └行权价×1000（8位）
 * ------------------------------------------------------------------ */
function parseOCC(occ) {
  const s = String(occ).trim().toUpperCase();
  if (s.length < 16) return null;
  const strikeRaw = s.slice(-8);
  const type = s.slice(-9, -8);
  const dateRaw = s.slice(-15, -9);
  const root = s.slice(0, -15);
  if (!/^\d{8}$/.test(strikeRaw) || !/^[CP]$/.test(type) || !/^\d{6}$/.test(dateRaw)) return null;

  const yy = Number(dateRaw.slice(0, 2));
  const mm = Number(dateRaw.slice(2, 4));
  const dd = Number(dateRaw.slice(4, 6));
  const year = 2000 + yy;
  const mmStr = String(mm).padStart(2, '0');
  const ddStr = String(dd).padStart(2, '0');

  return {
    root,
    expiry: `${year}-${mmStr}-${ddStr}`,
    type: type === 'C' ? 'call' : 'put',
    strike: Number(strikeRaw) / 1000,
  };
}

/* ------------------------------------------------------------------ *
 * 美东时间处理
 * 期权估值的时间基准必须与行情快照一致，不能用服务器墙上时间，
 * 否则周末与盘前会少算 2~3 天（实测 vega 偏低约 5%）。
 * ------------------------------------------------------------------ */

function isEDT(y, m, d) {
  if (m < 3 || m > 11) return false;
  if (m > 3 && m < 11) return true;
  if (m === 3) {
    const firstDow = new Date(Date.UTC(y, 2, 1)).getUTCDay();
    return d >= 1 + ((7 - firstDow) % 7) + 7;
  }
  const firstDowNov = new Date(Date.UTC(y, 10, 1)).getUTCDay();
  return d < 1 + ((7 - firstDowNov) % 7);
}

function etToUTC(y, m, d, hh, mm) {
  return Date.UTC(y, m - 1, d, hh + (isEDT(y, m, d) ? 4 : 5), mm || 0, 0);
}

/** 解析 CBOE 的美东本地时间戳（无时区后缀） */
function parseETStamp(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  return etToUTC(+m[1], +m[2], +m[3], +m[4], +m[5]);
}

function expiryMs(expiryISO) {
  const p = String(expiryISO).split('-').map(Number);
  return etToUTC(p[0], p[1], p[2], 16, 0);
}

/** 剩余年限，以行情快照时点为基准 */
function yearsToExpiry(expiryISO, asOfMs) {
  const ms = expiryMs(expiryISO) - asOfMs;
  return Math.max(ms / (365 * 24 * 3600 * 1000), 1 / (365 * 24 * 60));
}

function calendarDTE(expiryISO, asOfMs) {
  return Math.max(0, Math.round((expiryMs(expiryISO) - asOfMs) / 86400000));
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

/** 精简单腿字段，控制传输体积 */
function slimLeg(o) {
  return {
    sym: o.option,
    b: num(o.bid), a: num(o.ask),
    bs: num(o.bid_size), as: num(o.ask_size),
    l: num(o.last_trade_price),
    v: num(o.volume), oi: num(o.open_interest),
    iv: num(o.iv),
    d: num(o.delta), g: num(o.gamma), t: num(o.theta), ve: num(o.vega), rh: num(o.rho),
    th: num(o.theo),
    ch: num(o.change), chp: num(o.percent_change),
    pc: num(o.prev_day_close),
  };
}

/**
 * 把 CBOE 原始响应整理为：按到期日分组 → 按行权价配对 Call/Put
 */
function buildChain(raw, requested) {
  const d = raw && raw.data;
  if (!d || !Array.isArray(d.options)) throw new Error('上游数据结构异常');

  // 估值基准时点：优先用标的最后成交时间（美东），回退到数据时间戳
  const asOfMs = parseETStamp(d.last_trade_time) || parseETStamp(raw.timestamp) || Date.now();

  const underlying = {
    symbol: d.symbol || requested,
    type: d.security_type || 'stock',
    last: num(d.current_price),
    change: num(d.price_change),
    changePct: num(d.price_change_percent),
    bid: num(d.bid), ask: num(d.ask),
    open: num(d.open), high: num(d.high), low: num(d.low),
    prevClose: num(d.prev_day_close),
    volume: num(d.volume),
    iv30: num(d.iv30),
    iv30Change: num(d.iv30_change),
    lastTradeTime: d.last_trade_time || null,
  };

  const byExpiry = new Map();

  for (const o of d.options) {
    const p = parseOCC(o.option);
    if (!p) continue;
    if (!byExpiry.has(p.expiry)) byExpiry.set(p.expiry, new Map());
    const strikes = byExpiry.get(p.expiry);
    if (!strikes.has(p.strike)) strikes.set(p.strike, { strike: p.strike, call: null, put: null });
    strikes.get(p.strike)[p.type] = slimLeg(o);
  }

  const expiries = [...byExpiry.entries()]
    .map(([expiry, strikeMap]) => {
      const rows = [...strikeMap.values()].sort((a, b) => a.strike - b.strike);
      let callOI = 0, putOI = 0, callVol = 0, putVol = 0;
      for (const r of rows) {
        if (r.call) { callOI += r.call.oi; callVol += r.call.v; }
        if (r.put) { putOI += r.put.oi; putVol += r.put.v; }
      }
      return {
        expiry,
        dte: calendarDTE(expiry, asOfMs),
        t: yearsToExpiry(expiry, asOfMs),
        rows,
        stats: {
          callOI, putOI, callVol, putVol,
          pcRatioOI: callOI > 0 ? putOI / callOI : 0,
          strikes: rows.length,
        },
      };
    })
    .sort((a, b) => a.expiry.localeCompare(b.expiry));

  return {
    ok: true,
    symbol: underlying.symbol,
    requested,
    timestamp: raw.timestamp || null,
    asOf: new Date(asOfMs).toISOString(),
    fetchedAt: new Date().toISOString(),
    source: 'CBOE Delayed Quotes',
    underlying,
    expiries,
    contractCount: d.options.length,
  };
}

/* ------------------------------------------------------------------ *
 * 路由处理
 * ------------------------------------------------------------------ */
async function handleChain(reqSymbol) {
  const sym = cboeSymbol(reqSymbol);
  if (!sym) throw Object.assign(new Error('标的代码无效'), { status: 400 });

  const key = `chain:${sym}`;
  const hit = cacheGet(key);
  if (hit) return { ...hit, cached: true };

  const url = `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(sym)}.json`;
  let raw;
  try {
    raw = await fetchJSON(url);
  } catch (e) {
    if (e.status === 403 || e.status === 404) {
      throw Object.assign(new Error(`未找到标的 "${reqSymbol}" 的期权数据（该代码可能不存在或无期权上市）`), { status: 404 });
    }
    throw e;
  }
  const chain = buildChain(raw, String(reqSymbol).toUpperCase());
  cacheSet(key, chain);
  return chain;
}

module.exports = {
  handleChain,
  buildChain,
  cboeSymbol,
  parseOCC,
  parseETStamp,
  yearsToExpiry,
  calendarDTE,
  cacheSize: () => cache.size,
};
