/**
 * 模拟交易引擎
 * 账户资金、下单撮合（含滑点与佣金）、持仓管理、盈亏盯市、状态持久化
 */
(function (global) {
  'use strict';

  const M = global.OptionMath;
  const STORAGE_KEY = 'us-options-sim-v1';

  const DEFAULTS = {
    initialCash: 100000,
    commissionPerContract: 0.65,   // 每张合约佣金（接近 IBKR/盈透水平）
    commissionPerShare: 0.005,     // 股票每股佣金
    minCommission: 1.00,           // 单笔最低佣金
    slippageMode: 'mid',           // mid=中间价 | aggressive=吃对手价 | passive=挂单价
    riskFreeRate: 5.25,            // 年化百分数
  };

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function round2(v) { return Math.round(v * 100) / 100; }

  /* ------------------------------------------------------------------ *
   * 账户
   * ------------------------------------------------------------------ */
  class Account {
    constructor() {
      this.settings = Object.assign({}, DEFAULTS);
      this.cash = this.settings.initialCash;
      this.positions = [];   // 持仓
      this.trades = [];      // 成交流水
      this.equityCurve = []; // 净值曲线
      this.load();
    }

    /* ---------- 持久化 ---------- */
    save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          settings: this.settings,
          cash: this.cash,
          positions: this.positions,
          trades: this.trades.slice(-500),
          equityCurve: this.equityCurve.slice(-500),
        }));
      } catch (e) { /* 隐私模式或配额不足时静默失败 */ }
    }

    load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const s = JSON.parse(raw);
        if (s.settings) this.settings = Object.assign({}, DEFAULTS, s.settings);
        if (typeof s.cash === 'number') this.cash = s.cash;
        if (Array.isArray(s.positions)) this.positions = s.positions;
        if (Array.isArray(s.trades)) this.trades = s.trades;
        if (Array.isArray(s.equityCurve)) this.equityCurve = s.equityCurve;
      } catch (e) { /* 数据损坏则用默认值 */ }
    }

    reset(initialCash) {
      this.settings.initialCash = initialCash || this.settings.initialCash;
      this.cash = this.settings.initialCash;
      this.positions = [];
      this.trades = [];
      this.equityCurve = [];
      this.save();
    }

    /* ---------- 佣金 ---------- */
    commission(qty, kind) {
      const s = this.settings;
      const n = Math.abs(qty);
      const fee = kind === 'stock'
        ? n * s.commissionPerShare
        : n * s.commissionPerContract;
      return round2(Math.max(fee, s.minCommission));
    }

    /**
     * 成交价：按滑点模式在买卖价之间取值
     * @param {object} quote {b,a,l,th} 买价/卖价/最新价/理论价
     * @param {'buy'|'sell'} side
     */
    fillPrice(quote, side) {
      const bid = quote.b > 0 ? quote.b : 0;
      const ask = quote.a > 0 ? quote.a : 0;
      const mode = this.settings.slippageMode;

      // 无有效报价时退化到理论价或最新价
      if (!(bid > 0) && !(ask > 0)) {
        const fb = quote.th > 0 ? quote.th : (quote.l > 0 ? quote.l : 0);
        return { price: round2(fb), warn: '无买卖报价，按理论价成交' };
      }
      if (!(bid > 0)) return { price: round2(ask), warn: '仅有卖价' };
      if (!(ask > 0)) return { price: round2(bid), warn: '仅有买价' };

      const mid = (bid + ask) / 2;
      if (mode === 'aggressive') {
        // 主动成交：买单付卖价，卖单收买价（承担全部价差）
        return { price: round2(side === 'buy' ? ask : bid) };
      }
      if (mode === 'passive') {
        // 被动挂单：买单挂买价，卖单挂卖价（假设成交）
        return { price: round2(side === 'buy' ? bid : ask) };
      }
      return { price: round2(mid) }; // 中间价
    }

    /**
     * 下单
     * @param {object} o
     *   kind      'option' | 'stock'
     *   symbol    合约代码或股票代码
     *   side      'buy' | 'sell'
     *   qty       张数/股数（正数）
     *   quote     实时报价
     *   meta      {underlying,type,strike,expiry,iv,T,multiplier}
     */
    placeOrder(o) {
      const qty = Math.floor(Math.abs(Number(o.qty) || 0));
      if (qty <= 0) return { ok: false, error: '数量必须为正整数' };

      const kind = o.kind || 'option';
      const mult = kind === 'stock' ? 1 : (o.meta && o.meta.multiplier) || 100;
      const fill = this.fillPrice(o.quote || {}, o.side);
      if (!(fill.price > 0) && kind === 'option') {
        return { ok: false, error: '该合约无有效报价，无法成交' };
      }

      const fee = this.commission(qty, kind);
      const notional = fill.price * qty * mult;
      const signedQty = o.side === 'buy' ? qty : -qty;

      // 现有持仓（同一合约）
      const existing = this.positions.find(p => p.symbol === o.symbol);
      // 方向相反即包含平仓成分
      const isClosing = !!existing && Math.sign(existing.qty) !== Math.sign(signedQty);

      /* --- 资金检查 --- */
      if (!isClosing) {
        if (o.side === 'buy') {
          // 买入：支付权利金 + 佣金
          if (notional + fee > this.cash) {
            return { ok: false, error: `资金不足：需 $${(notional + fee).toFixed(2)}，可用 $${this.cash.toFixed(2)}` };
          }
        } else {
          // 卖出开仓：需缴保证金（简化模型）
          const margin = this.marginRequirement(kind, fill.price, qty, mult, o.meta);
          if (margin + fee > this.cash) {
            return { ok: false, error: `保证金不足：需 $${(margin + fee).toFixed(2)}，可用 $${this.cash.toFixed(2)}` };
          }
        }
      }

      /* --- 资金变动 --- */
      if (o.side === 'buy') this.cash -= notional;
      else this.cash += notional;
      this.cash -= fee;

      /* --- 更新持仓 --- */
      let realized = 0;
      if (existing) {
        const oldQty = existing.qty;
        const newQty = oldQty + signedQty;

        if (isClosing) {
          // 平掉的张数（不超过原持仓）
          const closed = Math.min(qty, Math.abs(oldQty));
          const dir = Math.sign(oldQty);
          realized = (fill.price - existing.avgPrice) * closed * mult * dir;
          existing.realizedPnl = (existing.realizedPnl || 0) + realized;

          // 若反向超量（如持多 1 张却卖出 3 张），剩余部分为反向新开仓，
          // 均价必须重置为本次成交价，否则后续盈亏计算会错。
          if (Math.sign(newQty) !== 0 && Math.sign(newQty) !== dir) {
            existing.avgPrice = fill.price;
            existing.entryIv = (o.meta && o.meta.iv) || existing.entryIv;
            existing.openedAt = new Date().toISOString();
          }
        } else {
          // 同向加仓：按张数加权重算均价
          const totalCost = existing.avgPrice * Math.abs(oldQty) + fill.price * qty;
          existing.avgPrice = totalCost / (Math.abs(oldQty) + qty);
        }

        existing.qty = newQty;
        existing.fees = (existing.fees || 0) + fee;
        if (newQty === 0) {
          this.positions = this.positions.filter(p => p !== existing);
        }
      } else {
        this.positions.push({
          id: uid(),
          kind,
          symbol: o.symbol,
          underlying: (o.meta && o.meta.underlying) || o.symbol,
          type: o.meta && o.meta.type,
          strike: o.meta && o.meta.strike,
          expiry: o.meta && o.meta.expiry,
          qty: signedQty,
          avgPrice: fill.price,
          multiplier: mult,
          openedAt: new Date().toISOString(),
          entryIv: (o.meta && o.meta.iv) || 0,
          fees: fee,
          realizedPnl: 0,
        });
      }

      /* --- 记录流水 --- */
      const trade = {
        id: uid(),
        time: new Date().toISOString(),
        kind,
        symbol: o.symbol,
        underlying: (o.meta && o.meta.underlying) || o.symbol,
        type: o.meta && o.meta.type,
        strike: o.meta && o.meta.strike,
        expiry: o.meta && o.meta.expiry,
        side: o.side,
        qty,
        price: fill.price,
        multiplier: mult,
        notional: round2(notional),
        fee,
        realized: round2(realized),
        action: isClosing ? '平仓' : '开仓',
        note: fill.warn || '',
      };
      this.trades.unshift(trade);
      if (this.trades.length > 500) this.trades.length = 500;

      this.save();
      return { ok: true, trade, fillPrice: fill.price, fee, realized: round2(realized), warn: fill.warn };
    }

    /**
     * 卖方保证金（简化模型）
     * 裸卖期权按「权利金 + 20% 标的市值」粗略估算；
     * 真实券商规则更复杂，此处仅用于模拟约束。
     */
    marginRequirement(kind, price, qty, mult, meta) {
      if (kind === 'stock') return price * qty * 0.5; // 股票按 50% 初始保证金
      const underlyingPx = (meta && meta.underlyingPrice) || (meta && meta.strike) || price;
      const premium = price * qty * mult;
      const notional = underlyingPx * qty * mult;
      return premium + notional * 0.20;
    }

    /** 当前持仓占用的总保证金 */
    totalMargin(quoteMap, spotMap) {
      let m = 0;
      for (const p of this.positions) {
        if (p.qty >= 0) continue; // 只有空头需要保证金
        const spot = (spotMap && spotMap[p.underlying]) || p.strike || 0;
        m += this.marginRequirement(p.kind, p.avgPrice, Math.abs(p.qty), p.multiplier, {
          underlyingPrice: spot, strike: p.strike,
        });
      }
      return m;
    }

    /**
     * 盯市估值
     * @param {function} priceLookup (position) => {mark, iv, T, spot} 或 null
     */
    markToMarket(priceLookup) {
      let unrealized = 0, marketValue = 0;
      const rows = [];

      for (const p of this.positions) {
        const info = priceLookup(p) || {};
        const mark = typeof info.mark === 'number' ? info.mark : p.avgPrice;
        const value = mark * p.qty * p.multiplier;
        const pnl = (mark - p.avgPrice) * p.qty * p.multiplier;
        unrealized += pnl;
        marketValue += value;
        rows.push({
          pos: p, mark, value, pnl,
          pnlPct: p.avgPrice > 0 ? (pnl / (p.avgPrice * Math.abs(p.qty) * p.multiplier)) * 100 : 0,
          iv: info.iv, T: info.T, spot: info.spot, stale: info.stale,
        });
      }

      const realizedTotal = this.trades.reduce((s, t) => s + (t.realized || 0), 0);
      const feesTotal = this.trades.reduce((s, t) => s + (t.fee || 0), 0);

      return {
        rows,
        cash: this.cash,
        marketValue,
        unrealized,
        realizedTotal,
        feesTotal,
        equity: this.cash + marketValue,
        totalPnl: this.cash + marketValue - this.settings.initialCash,
        totalPnlPct: ((this.cash + marketValue) / this.settings.initialCash - 1) * 100,
      };
    }

    /** 记录净值快照（用于资金曲线） */
    snapshot(equity) {
      const last = this.equityCurve[this.equityCurve.length - 1];
      const now = Date.now();
      // 至少间隔 20 秒或净值变化超过 1 美元才记录，避免曲线膨胀
      if (last && now - last.t < 20000 && Math.abs(last.e - equity) < 1) return;
      this.equityCurve.push({ t: now, e: round2(equity) });
      if (this.equityCurve.length > 500) this.equityCurve.shift();
      this.save();
    }

    /** 到期结算：把已到期持仓按内在价值平仓 */
    settleExpired(spotMap) {
      const todayET = new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10);
      const expired = this.positions.filter(p =>
        p.kind === 'option' && p.expiry && p.expiry < todayET);
      if (!expired.length) return { count: 0 };

      let total = 0;
      for (const p of expired) {
        const spot = (spotMap && spotMap[p.underlying]) || 0;
        const intrinsic = spot > 0
          ? (p.type === 'call' ? Math.max(0, spot - p.strike) : Math.max(0, p.strike - spot))
          : 0;
        const pnl = (intrinsic - p.avgPrice) * p.qty * p.multiplier;
        this.cash += intrinsic * p.qty * p.multiplier;
        total += pnl;

        this.trades.unshift({
          id: uid(),
          time: new Date().toISOString(),
          kind: 'option',
          symbol: p.symbol,
          underlying: p.underlying,
          type: p.type, strike: p.strike, expiry: p.expiry,
          side: p.qty > 0 ? 'sell' : 'buy',
          qty: Math.abs(p.qty),
          price: round2(intrinsic),
          multiplier: p.multiplier,
          notional: round2(intrinsic * Math.abs(p.qty) * p.multiplier),
          fee: 0,
          realized: round2(pnl),
          action: '到期结算',
          note: intrinsic > 0 ? '价内自动行权' : '价外作废',
        });
      }
      this.positions = this.positions.filter(p => expired.indexOf(p) === -1);
      this.save();
      return { count: expired.length, pnl: round2(total) };
    }

    /** 把持仓转换为定价引擎所需的 legs 结构 */
    toLegs(underlyingFilter, priceLookup) {
      return this.positions
        .filter(p => !underlyingFilter || p.underlying === underlyingFilter)
        .map(p => {
          const info = priceLookup ? (priceLookup(p) || {}) : {};
          return {
            kind: p.kind,
            type: p.type,
            strike: p.strike,
            qty: p.qty,
            entryPrice: p.avgPrice,
            multiplier: p.multiplier,
            iv: info.iv || p.entryIv || 0.3,
            T: typeof info.T === 'number' ? info.T : (p.expiry ? M.yearsToExpiry(p.expiry) : 0),
            symbol: p.symbol,
            expiry: p.expiry,
          };
        });
    }

    /** 交易统计 */
    stats() {
      // 用 action 判定是否为平仓，而不是用 realized !== 0。
      // 以中间价开仓后立刻平仓时，已实现盈亏恰好为 0，
      // 若按盈亏是否为零来筛，这类真实平仓会被漏掉（实测 8 笔平仓统计成 0 笔）。
      const closed = this.trades.filter(t => t.action === '平仓' || t.action === '到期结算');
      const wins = closed.filter(t => t.realized > 0);
      const losses = closed.filter(t => t.realized < 0);
      const flats = closed.filter(t => t.realized === 0);
      const sum = (a) => a.reduce((s, t) => s + (t.realized || 0), 0);
      const grossWin = sum(wins), grossLoss = Math.abs(sum(losses));
      // 胜率以有盈亏的平仓为分母，平局不计入
      const decided = wins.length + losses.length;

      return {
        totalTrades: this.trades.length,
        closedTrades: closed.length,
        wins: wins.length,
        losses: losses.length,
        flats: flats.length,
        winRate: decided ? (wins.length / decided) * 100 : 0,
        avgWin: wins.length ? grossWin / wins.length : 0,
        avgLoss: losses.length ? grossLoss / losses.length : 0,
        profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
        netRealized: sum(closed),
        totalFees: this.trades.reduce((s, t) => s + (t.fee || 0), 0),
      };
    }
  }

  global.SimAccount = Account;
  global.SIM_DEFAULTS = DEFAULTS;
})(window);
