/**
 * 期权定价与风险引擎
 * Black-Scholes-Merton 模型、希腊字母、隐含波动率反解、损益计算
 */
(function (global) {
  'use strict';

  /* ---------------- 数学工具 ---------------- */

  /** 标准正态分布概率密度 */
  function pdf(x) {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  }

  /**
   * 标准正态累积分布函数
   * 采用 Hart (1968) / West 双精度有理逼近，精度约 1e-15，
   * 远优于常见的 A&S 7.1.26 近似（1e-7）。
   * 期权 delta 直接等于 N(d1)，精度不足会污染整个风险面板，故此处不妥协。
   */
  function cdf(x) {
    if (!isFinite(x)) return x > 0 ? 1 : 0;
    const xa = Math.abs(x);
    if (xa > 37) return x > 0 ? 1 : 0;

    const e = Math.exp(-xa * xa / 2);
    let c;

    if (xa < 7.07106781186547) {
      let b = 3.52624965998911e-02 * xa + 0.700383064443688;
      b = b * xa + 6.37396220353165;
      b = b * xa + 33.912866078383;
      b = b * xa + 112.079291497871;
      b = b * xa + 221.213596169931;
      b = b * xa + 220.206867912376;

      let d = 8.83883476483184e-02 * xa + 1.75566716318264;
      d = d * xa + 16.064177579207;
      d = d * xa + 86.7807322029461;
      d = d * xa + 296.564248779674;
      d = d * xa + 637.333633378831;
      d = d * xa + 793.826512519948;
      d = d * xa + 440.413735824752;

      c = e * b / d;
    } else {
      let f = xa + 0.65;
      f = xa + 4 / f;
      f = xa + 3 / f;
      f = xa + 2 / f;
      f = xa + 1 / f;
      c = e / (f * 2.506628274631);
    }

    return x > 0 ? 1 - c : c;
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /* ---------------- Black-Scholes 定价 ---------------- */

  /**
   * @param {'call'|'put'} type
   * @param {number} S 标的价格
   * @param {number} K 行权价
   * @param {number} T 剩余年限
   * @param {number} v 年化波动率（小数）
   * @param {number} r 无风险利率（小数）
   * @param {number} q 连续股息率（小数）
   */
  function price(type, S, K, T, v, r, q) {
    r = r || 0; q = q || 0;
    // 到期或零波动率 → 退化为内在价值（按贴现处理）
    if (T <= 0 || v <= 0) {
      const fwd = S * Math.exp(-q * T);
      const kd = K * Math.exp(-r * T);
      return Math.max(0, type === 'call' ? fwd - kd : kd - fwd);
    }
    const sq = v * Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r - q + 0.5 * v * v) * T) / sq;
    const d2 = d1 - sq;
    const dfR = Math.exp(-r * T);
    const dfQ = Math.exp(-q * T);
    return type === 'call'
      ? S * dfQ * cdf(d1) - K * dfR * cdf(d2)
      : K * dfR * cdf(-d2) - S * dfQ * cdf(-d1);
  }

  /**
   * 全套希腊字母
   * delta / gamma 为每 1 单位标的变动
   * theta 为每日衰减（已除 365）
   * vega 为 IV 每变动 1 个百分点
   * rho 为利率每变动 1 个百分点
   */
  function greeks(type, S, K, T, v, r, q) {
    r = r || 0; q = q || 0;
    const out = { price: 0, delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0, d1: 0, d2: 0 };

    if (T <= 0) {
      const itm = type === 'call' ? S > K : S < K;
      out.price = Math.max(0, type === 'call' ? S - K : K - S);
      out.delta = itm ? (type === 'call' ? 1 : -1) : 0;
      return out;
    }
    if (v <= 0) {
      out.price = price(type, S, K, T, v, r, q);
      const itm = type === 'call' ? S > K : S < K;
      out.delta = itm ? (type === 'call' ? 1 : -1) : 0;
      return out;
    }

    const sqT = Math.sqrt(T);
    const sq = v * sqT;
    const d1 = (Math.log(S / K) + (r - q + 0.5 * v * v) * T) / sq;
    const d2 = d1 - sq;
    const dfR = Math.exp(-r * T);
    const dfQ = Math.exp(-q * T);
    const nd1 = pdf(d1);

    out.d1 = d1; out.d2 = d2;
    out.price = price(type, S, K, T, v, r, q);
    out.gamma = (dfQ * nd1) / (S * sq);
    out.vega = (S * dfQ * nd1 * sqT) / 100;

    if (type === 'call') {
      out.delta = dfQ * cdf(d1);
      out.theta = (-(S * dfQ * nd1 * v) / (2 * sqT)
        - r * K * dfR * cdf(d2)
        + q * S * dfQ * cdf(d1)) / 365;
      out.rho = (K * T * dfR * cdf(d2)) / 100;
    } else {
      out.delta = -dfQ * cdf(-d1);
      out.theta = (-(S * dfQ * nd1 * v) / (2 * sqT)
        + r * K * dfR * cdf(-d2)
        - q * S * dfQ * cdf(-d1)) / 365;
      out.rho = (-K * T * dfR * cdf(-d2)) / 100;
    }
    return out;
  }

  /**
   * 隐含波动率反解：Newton-Raphson 为主，失败时回退二分法
   */
  function impliedVol(type, mktPrice, S, K, T, r, q) {
    r = r || 0; q = q || 0;
    if (!(mktPrice > 0) || T <= 0) return 0;

    const intrinsic = Math.max(0, type === 'call'
      ? S * Math.exp(-q * T) - K * Math.exp(-r * T)
      : K * Math.exp(-r * T) - S * Math.exp(-q * T));
    if (mktPrice <= intrinsic) return 0; // 低于内在价值，无解

    // Brenner-Subrahmanyam 初值猜测
    let v = clamp(Math.sqrt(2 * Math.PI / T) * (mktPrice / S), 0.02, 3);

    for (let i = 0; i < 60; i++) {
      const g = greeks(type, S, K, T, v, r, q);
      const diff = g.price - mktPrice;
      if (Math.abs(diff) < 1e-7) return v;
      const vegaRaw = g.vega * 100; // 还原为对 v 的导数
      if (!isFinite(vegaRaw) || vegaRaw < 1e-9) break;
      const next = v - diff / vegaRaw;
      if (!isFinite(next) || next <= 0 || next > 8) break;
      if (Math.abs(next - v) < 1e-9) return next;
      v = next;
    }

    // 二分法兜底
    let lo = 1e-4, hi = 8;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      const p = price(type, S, K, T, mid, r, q);
      if (Math.abs(p - mktPrice) < 1e-7) return mid;
      if (p > mktPrice) hi = mid; else lo = mid;
    }
    const res = (lo + hi) / 2;
    return res > 7.9 || res < 2e-4 ? 0 : res;
  }

  /* ---------------- 合约与仓位工具 ---------------- */

  /** 解析 OCC 合约代码 */
  function parseOCC(occ) {
    const s = String(occ || '').trim().toUpperCase();
    if (s.length < 16) return null;
    const strikeRaw = s.slice(-8);
    const t = s.slice(-9, -8);
    const dateRaw = s.slice(-15, -9);
    if (!/^\d{8}$/.test(strikeRaw) || !/^[CP]$/.test(t) || !/^\d{6}$/.test(dateRaw)) return null;
    return {
      root: s.slice(0, -15),
      expiry: `20${dateRaw.slice(0, 2)}-${dateRaw.slice(2, 4)}-${dateRaw.slice(4, 6)}`,
      type: t === 'C' ? 'call' : 'put',
      strike: Number(strikeRaw) / 1000,
    };
  }

  /* ---------------- 美东时间与到期时点 ---------------- */

  /** 判断某日期是否处于美东夏令时（3月第二个周日 ~ 11月第一个周日） */
  function isEDT(y, m, d) {
    if (m < 3 || m > 11) return false;
    if (m > 3 && m < 11) return true;
    if (m === 3) {
      const firstDow = new Date(Date.UTC(y, 2, 1)).getUTCDay();
      const secondSunday = 1 + ((7 - firstDow) % 7) + 7;
      return d >= secondSunday;
    }
    const firstDowNov = new Date(Date.UTC(y, 10, 1)).getUTCDay();
    const firstSunday = 1 + ((7 - firstDowNov) % 7);
    return d < firstSunday;
  }

  /** 美东本地时间 → UTC 毫秒 */
  function etToUTC(y, m, d, hh, mm) {
    const offset = isEDT(y, m, d) ? 4 : 5;
    return Date.UTC(y, m - 1, d, hh + offset, mm || 0, 0);
  }

  /** 到期日的结算时点（美东 16:00 收盘）对应的 UTC 毫秒 */
  function expiryMs(expiryISO) {
    const p = String(expiryISO).split('-').map(Number);
    return etToUTC(p[0], p[1], p[2], 16, 0);
  }

  /**
   * 剩余年限。
   *
   * 关键：估值基准时点必须与行情快照一致，而非「当前墙上时间」。
   * CBOE 的希腊字母是按最近一个交易时点计算的；若用本地当前时间，
   * 周末/盘前会凭空少算 2~3 天，实测导致 vega 偏低约 5%、
   * 反解 IV 偏高约 1.4 个百分点。
   *
   * @param {string} expiryISO 到期日 YYYY-MM-DD
   * @param {number} [asOfMs]  估值基准时点（UTC 毫秒），缺省用当前时间
   */
  function yearsToExpiry(expiryISO, asOfMs) {
    const base = (typeof asOfMs === 'number' && isFinite(asOfMs)) ? asOfMs : Date.now();
    const ms = expiryMs(expiryISO) - base;
    return Math.max(ms / (365 * 24 * 3600 * 1000), 1 / (365 * 24 * 60));
  }

  function daysToExpiry(expiryISO, asOfMs) {
    const base = (typeof asOfMs === 'number' && isFinite(asOfMs)) ? asOfMs : Date.now();
    return Math.max(0, Math.round((expiryMs(expiryISO) - base) / 86400000));
  }

  /**
   * 解析 CBOE 的 last_trade_time（美东本地、无时区后缀）为 UTC 毫秒。
   * 形如 "2026-08-28T16:00:00"
   */
  function parseETStamp(s) {
    const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (!m) return null;
    return etToUTC(+m[1], +m[2], +m[3], +m[4], +m[5]);
  }

  /**
   * 由看跌看涨平价关系反解市场隐含远期价。
   *   C - P = e^{-rT}(F - K)   →   F = K + (C-P)·e^{rT}
   *
   * 对每个平值附近的行权价各算一个 F，取中位数（抗离群值，优于最小二乘，
   * 因为个别宽价差合约会严重拖偏回归线）。
   *
   * 实测：同一到期日各行权价反解出的 F 高度一致（偏差 < 0.05%），
   * 说明该方法稳健可用。
   */
  function impliedForward(rows, spot, T, r) {
    const all = [];
    const tight = [];

    for (const row of rows) {
      const c = row.call, p = row.put;
      if (!c || !p) continue;
      if (!(c.b > 0 && c.a > 0 && p.b > 0 && p.a > 0)) continue;
      // 只用平值附近：流动性最好、买卖价差最窄
      if (Math.abs(row.strike - spot) / spot > 0.10) continue;

      const cm = (c.b + c.a) / 2, pm = (p.b + p.a) / 2;
      if (!(cm > 0 && pm > 0)) continue;
      const f = row.strike + (cm - pm) * Math.exp((r || 0) * T);
      all.push(f);
      // 记录买卖价差较窄的样本，优先使用
      const worst = Math.max((c.a - c.b) / cm, (p.a - p.b) / pm);
      if (worst < 0.06) tight.push(f);
    }

    const pick = tight.length >= 3 ? tight : all;
    if (pick.length < 3) return null;

    pick.sort((a, b) => a - b);
    const mid = Math.floor(pick.length / 2);
    const forward = pick.length % 2 ? pick[mid] : (pick[mid - 1] + pick[mid]) / 2;

    if (!(forward > spot * 0.8 && forward < spot * 1.25)) return null;
    return { forward, samples: pick.length, filtered: tight.length >= 3 };
  }

  /**
   * 校准定价用的市场参数。
   *
   * 背景：CBOE 返回的标的现价与期权报价往往不是同一时刻的快照
   * （实测 NVDA 期权链隐含的标的价比 current_price 低 0.53%）。
   * 若把这个缺口当成股息率去年化，21 天的 0.53% 会放大成 14.5% 的
   * 荒谬股息（NVDA 实际股息率约 0.03%）。
   *
   * 因此这里不再反解股息率，而是直接采用市场隐含远期价 F，
   * 并折算出「等效现价」effSpot = F·e^{-rT}，再以零股息的 BS 定价。
   * 这等价于 Black-76 远期定价，能自动吸收股息、借券成本与快照错配，
   * 且严格满足看跌看涨平价关系。
   *
   * @returns {{r,q,forward,effSpot,carry,calibrated}}
   *   carry 为等效持有成本（年化），仅用于展示，不参与定价。
   */
  function calibrateRates(rows, spot, T, r) {
    const rr = (typeof r === 'number' && isFinite(r)) ? r : 0.0525;
    const fallback = { r: rr, q: 0, forward: spot, effSpot: spot, carry: 0, calibrated: false };
    if (T <= 0) return fallback;

    const f = impliedForward(rows, spot, T, rr);
    if (!f) return fallback;

    const effSpot = f.forward * Math.exp(-rr * T);
    // 等效持有成本：仅作信息展示，反映远期相对现价的偏离
    const carry = rr - Math.log(f.forward / spot) / T;

    return {
      r: rr,
      q: 0,                 // 定价用零股息 + 等效现价，不用 q
      forward: f.forward,
      effSpot,
      carry,
      samples: f.samples,
      calibrated: true,
    };
  }

  /**
   * 单腿到期时的每股价值（不含成本）
   */
  function legIntrinsic(leg, S) {
    if (leg.kind === 'stock') return S;
    return leg.type === 'call'
      ? Math.max(0, S - leg.strike)
      : Math.max(0, leg.strike - S);
  }

  /**
   * 组合到期损益。
   *
   * 关键：多腿到期日可能不同（如日历价差）。此时「到期」应理解为
   * **最近一条腿到期的时刻**；届时更远月的腿仍有剩余时间价值，
   * 必须按 BS 重新定价，不能一律取内在价值 —— 否则日历价差的损益曲线
   * 会退化成一条水平线（实测最大盈利与最大亏损相等，明显错误）。
   *
   * @param {Array} legs 每腿 {kind,type,strike,qty,entryPrice,multiplier,T,iv}
   *                     qty > 0 为多头，< 0 为空头
   * @param {object} [opts] {r,q,spotScale}
   */
  function payoffAtExpiry(legs, S, opts) {
    opts = opts || {};
    const r = opts.r || 0, q = opts.q || 0;
    const scale = opts.spotScale > 0 ? opts.spotScale : 1;

    // 最近到期时刻作为损益观察点
    let horizon = Infinity;
    for (const leg of legs) {
      if (leg.kind === 'stock') continue;
      const t = typeof leg.T === 'number' ? leg.T : 0;
      if (t < horizon) horizon = t;
    }
    if (!isFinite(horizon)) horizon = 0;

    let pnl = 0;
    for (const leg of legs) {
      const mult = leg.multiplier || (leg.kind === 'stock' ? 1 : 100);
      let val;
      if (leg.kind === 'stock') {
        val = S;
      } else {
        const remain = (typeof leg.T === 'number' ? leg.T : 0) - horizon;
        if (remain <= 1e-9) {
          val = legIntrinsic(leg, S);
        } else {
          // 该腿尚未到期，仍含时间价值
          const v = Math.max(0.0001, leg.iv || 0.3);
          val = price(leg.type, S * scale, leg.strike, remain, v, r, q);
        }
      }
      pnl += (val - leg.entryPrice) * leg.qty * mult;
    }
    return pnl;
  }

  /**
   * 组合当前理论损益（按 BS 重新定价，可叠加时间推移与 IV 冲击）
   * @param {object} opts {daysForward, ivShiftPct, r, q, spotScale}
   *   spotScale: 定价现价 / 横轴现价 的比值。
   *     损益图横轴要显示真实价格，但重定价须用平价关系隐含的等效现价
   *     （两者可相差约 0.5%）。用此系数保持定价自洽，缺省 1。
   */
  function payoffTheoretical(legs, S, opts) {
    opts = opts || {};
    const dayShift = opts.daysForward || 0;
    const ivShift = (opts.ivShiftPct || 0) / 100;
    const r = opts.r || 0, q = opts.q || 0;
    const scale = opts.spotScale > 0 ? opts.spotScale : 1;
    let pnl = 0;

    for (const leg of legs) {
      const mult = leg.multiplier || (leg.kind === 'stock' ? 1 : 100);
      if (leg.kind === 'stock') {
        pnl += (S - leg.entryPrice) * leg.qty * mult;
        continue;
      }
      const T = Math.max(leg.T - dayShift / 365, 0);
      const v = Math.max(0.0001, (leg.iv || 0.3) + ivShift);
      const val = T <= 0
        ? legIntrinsic(leg, S)
        : price(leg.type, S * scale, leg.strike, T, v, r, q);
      pnl += (val - leg.entryPrice) * leg.qty * mult;
    }
    return pnl;
  }

  /**
   * 组合希腊字母汇总（已乘合约乘数与张数）
   */
  function portfolioGreeks(legs, S, opts) {
    opts = opts || {};
    const r = opts.r || 0, q = opts.q || 0;
    const agg = { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0, value: 0 };

    for (const leg of legs) {
      const mult = leg.multiplier || (leg.kind === 'stock' ? 1 : 100);
      if (leg.kind === 'stock') {
        agg.delta += leg.qty * mult;
        agg.value += S * leg.qty * mult;
        continue;
      }
      const T = Math.max(leg.T, 0);
      const v = Math.max(0.0001, leg.iv || 0.3);
      const g = greeks(leg.type, S, leg.strike, T, v, r, q);
      const scale = leg.qty * mult;
      agg.delta += g.delta * scale;
      agg.gamma += g.gamma * scale;
      agg.theta += g.theta * scale;
      agg.vega += g.vega * scale;
      agg.rho += g.rho * scale;
      agg.value += g.price * scale;
    }
    return agg;
  }

  /**
   * 扫描到期损益曲线，返回曲线点与关键指标。
   * expiry 为「最近腿到期时刻」的损益，theo 为当前理论损益。
   */
  function payoffCurve(legs, S, range, steps, opts) {
    range = range || 0.35;
    steps = steps || 121;
    const lo = Math.max(0.01, S * (1 - range));
    const hi = S * (1 + range);
    const step = (hi - lo) / (steps - 1);
    const pts = [];

    for (let i = 0; i < steps; i++) {
      const s = lo + step * i;
      pts.push({
        s,
        expiry: payoffAtExpiry(legs, s, opts),
        theo: payoffTheoretical(legs, s, opts),
      });
    }

    let maxProfit = -Infinity, maxLoss = Infinity;
    for (const p of pts) {
      if (p.expiry > maxProfit) maxProfit = p.expiry;
      if (p.expiry < maxLoss) maxLoss = p.expiry;
    }

    // 线性插值求盈亏平衡点
    const breakevens = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if ((a.expiry <= 0 && b.expiry > 0) || (a.expiry >= 0 && b.expiry < 0)) {
        const t = Math.abs(a.expiry) / (Math.abs(a.expiry) + Math.abs(b.expiry));
        breakevens.push(a.s + (b.s - a.s) * t);
      }
    }

    return { pts, maxProfit, maxLoss, breakevens, lo, hi };
  }

  /** 最大痛点：使全部期权持有方总内在价值最小的行权价 */
  function maxPain(rows) {
    let best = null, bestVal = Infinity;
    for (const probe of rows) {
      const S = probe.strike;
      let total = 0;
      for (const r of rows) {
        if (r.call) total += Math.max(0, S - r.strike) * r.call.oi * 100;
        if (r.put) total += Math.max(0, r.strike - S) * r.put.oi * 100;
      }
      if (total < bestVal) { bestVal = total; best = S; }
    }
    return { strike: best, value: bestVal };
  }

  global.OptionMath = {
    pdf, cdf, price, greeks, impliedVol,
    parseOCC, yearsToExpiry, daysToExpiry, parseETStamp, expiryMs, etToUTC, isEDT,
    impliedForward, calibrateRates,
    payoffAtExpiry, payoffTheoretical, portfolioGreeks, payoffCurve,
    legIntrinsic, maxPain, clamp,
  };
})(window);
