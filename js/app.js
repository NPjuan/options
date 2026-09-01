/**
 * 美股期权模拟器 — 主应用（界面层）
 *
 * ── 文件地图 ────────────────────────────────────────────────────
 *   状态 S              单一状态源：期权链快照、选中合约、账户、情景参数
 *   工具函数            格式化、tpl 模板、定价参数校准
 *   数据加载            loadChain()：拉取并写入 S
 *   渲染 render*        8 个区块，各自只读 S、只写自己那块 DOM
 *   刷新调度 refresh    按「变化源」决定重画哪些区块（见该处注释）
 *   事件委托            initDelegatedEvents()：容器上绑一次
 *   策略模板 STRATEGIES 声明式配置，新增策略只改这个数组
 *
 * ── 三条约定（改动时请遵守）────────────────────────────────────
 *   1. 渲染函数只读 S，不改 S。状态变更走事件处理器，改完调 refresh.*
 *   2. 不要退回 renderAll() 式的全量重画。新增区块挂到对应的
 *      refresh 入口下 —— 全量重画会丢滚动位置，也会浪费图表重绘。
 *   3. 反复重建的容器内，点击一律走事件委托，不要逐元素绑 onclick，
 *      否则重建后极易出现「点击静默失效」。
 *
 * ── 关于框架 ──────────────────────────────────────────────────
 *   本层刻意保持零依赖：定价、账务、图表都在独立模块中且有测试覆盖，
 *   与界面实现无关。若将来要迁到 Preact/Vue，替换范围仅限本文件的
 *   render* 部分，S 与 refresh 的分层可直接映射为组件 props 与状态。
 */
(function () {
  'use strict';

  const M = window.OptionMath;
  const CH = window.Charts;
  const $ = (id) => document.getElementById(id);

  /* ================================================================== *
   * 状态
   * ================================================================== */
  const S = {
    symbol: 'AAPL',
    chain: null,          // 服务端返回的期权链
    expiryIdx: 0,
    selected: null,       // 当前选中合约 {symbol,type,strike,expiry,quote,T,iv}
    account: new window.SimAccount(),
    loading: false,
    lastError: null,
    refreshTimer: null,
    rates: {},            // 每个到期日校准出的 r/q
    scenario: { days: 0, ivShift: 0 },
  };

  const POPULAR = [
    ['AAPL', '苹果'], ['NVDA', '英伟达'], ['TSLA', '特斯拉'], ['MSFT', '微软'],
    ['AMZN', '亚马逊'], ['GOOGL', '谷歌'], ['META', 'Meta'], ['AMD', 'AMD'],
    ['SPY', '标普500 ETF'], ['QQQ', '纳指100 ETF'], ['IWM', '罗素2000 ETF'],
    ['SPX', '标普500 指数'], ['VIX', '恐慌指数'], ['NDX', '纳指100 指数'],
    ['DELL', '戴尔'], ['MU', '美光'], ['INTC', '英特尔'], ['COIN', 'Coinbase'],
    ['MSTR', 'MicroStrategy'], ['PLTR', 'Palantir'], ['BABA', '阿里巴巴'],
    ['GLD', '黄金 ETF'], ['TLT', '20年美债 ETF'], ['SMH', '半导体 ETF'],
  ];

  /* ================================================================== *
   * 工具
   * ================================================================== */
  const fmt = (v, d) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d === undefined ? 2 : d) : '—');
  const money = (v, d) => (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(d === undefined ? 2 : d);
  const pct = (v, d) => (v >= 0 ? '+' : '') + fmt(v, d === undefined ? 2 : d) + '%';
  const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'dim');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /**
   * HTML 模板标签函数 —— 插值默认转义。
   *
   *   tpl`<div title="${name}">${count} 张</div>`
   *
   * 相比手工 '…' + esc(x) + '…' 拼接，好处是转义不会漏写，
   * 且模板字符串可以多行书写，结构一眼能看出来。
   *
   * 命名说明：叫 tpl 而不是社区惯例的 html，是因为本文件多数
   * render 函数内部都有局部变量 `html` 用于累积字符串，
   * 同名会被遮蔽，留下难以察觉的陷阱。
   *
   * 若某处确实要插入已构造好的 HTML 片段（例如子模板的返回值），
   * 用 raw() 包一层显式表明「我知道这是 HTML，不要转义」。
   */
  function tpl(strings, ...values) {
    return strings.reduce((out, str, i) => {
      if (i === 0) return str;
      const v = values[i - 1];
      let piece;
      if (v == null || v === false) piece = '';          // 便于写 ${cond && ...}
      else if (v && v.__raw) piece = v.value;            // 显式标记的原始 HTML
      else if (Array.isArray(v)) piece = v.join('');     // 子片段数组，逐项已自行处理
      else piece = esc(v);
      return out + piece + str;
    }, '');
  }

  /** 标记一段字符串为「已是安全 HTML」，跳过转义 */
  const raw = (value) => ({ __raw: true, value });

  function bigNum(v) {
    if (!v) return '0';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    return String(Math.round(v));
  }

  function toast(msg, type) {
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = msg;
    $('toast-wrap').appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 320);
    }, type === 'err' ? 4200 : 2600);
  }

  function setStatus(text, kind) {
    $('statusText').textContent = text;
    const d = $('statusDot');
    d.className = 'dot' + (kind ? ' ' + kind : '');
  }

  /** 当前到期日对象 */
  function curExp() {
    if (!S.chain || !S.chain.expiries.length) return null;
    return S.chain.expiries[Math.min(S.expiryIdx, S.chain.expiries.length - 1)];
  }

  /** 取某到期日的定价参数（带缓存） */
  function ratesFor(exp) {
    if (!exp) return { r: S.account.settings.riskFreeRate / 100, q: 0, effSpot: 0, carry: 0 };
    if (S.rates[exp.expiry]) return S.rates[exp.expiry];
    const r = S.account.settings.riskFreeRate / 100;
    const cal = M.calibrateRates(exp.rows, S.chain.underlying.last, exp.t, r);
    S.rates[exp.expiry] = cal;
    return cal;
  }

  /**
   * 定价用的「等效现价」。
   *
   * CBOE 的标的现价与期权报价常非同一快照（实测偏离可达 0.5%），
   * 直接用 current_price 会让平价关系不成立、希腊字母系统性偏移。
   * 改用平价关系隐含的远期价折现得到的等效现价，可自动吸收股息、
   * 借券成本与快照错配。
   */
  function pricingSpot(exp) {
    const cal = ratesFor(exp);
    return cal.effSpot > 0 ? cal.effSpot : S.chain.underlying.last;
  }

  /** 合约的中间价 */
  function midOf(o) {
    if (!o) return 0;
    if (o.b > 0 && o.a > 0) return (o.b + o.a) / 2;
    if (o.l > 0) return o.l;
    return o.th || 0;
  }

  /** 在期权链中查找合约 */
  function findContract(symbol) {
    if (!S.chain) return null;
    for (const exp of S.chain.expiries) {
      for (const row of exp.rows) {
        if (row.call && row.call.sym === symbol) return { o: row.call, exp, row, type: 'call' };
        if (row.put && row.put.sym === symbol) return { o: row.put, exp, row, type: 'put' };
      }
    }
    return null;
  }

  /** 持仓定价查询：供盯市与希腊字母使用 */
  function priceLookup(p) {
    if (p.kind === 'stock') {
      if (S.chain && p.underlying === S.chain.symbol) {
        return { mark: S.chain.underlying.last, spot: S.chain.underlying.last };
      }
      return { mark: p.avgPrice, stale: true };
    }
    const f = findContract(p.symbol);
    if (!f) {
      // 期权链中找不到（不同标的或已切换），用理论价估算
      return { mark: p.avgPrice, stale: true, iv: p.entryIv, T: p.expiry ? M.yearsToExpiry(p.expiry) : 0 };
    }
    const rate = ratesFor(f.exp);
    return {
      mark: midOf(f.o),
      iv: f.o.iv || 0,
      T: f.exp.t,
      spot: S.chain.underlying.last,
      pSpot: pricingSpot(f.exp),
      r: rate.r, q: rate.q,
    };
  }

  /* ================================================================== *
   * 数据加载
   * ================================================================== */
  async function loadChain(sym, keepExpiry) {
    if (S.loading) return;
    S.loading = true;
    S.lastError = null;
    setStatus('加载 ' + sym + ' 期权链…', 'stale');
    if (!keepExpiry) {
      $('chainWrap').innerHTML = '<div class="loading"><div class="spinner"></div><div>正在加载 '
        + esc(sym) + ' 期权链…</div></div>';
    }

    try {
      const res = await fetch('/api/chain?symbol=' + encodeURIComponent(sym));
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || '数据获取失败');
      if (!data.expiries.length) throw new Error(sym + ' 无可用期权合约');

      S.chain = data;
      S.symbol = data.symbol;
      S.rates = {};
      if (!keepExpiry) {
        // 默认选中 20~45 天的到期日（流动性与时间价值较均衡）
        let idx = data.expiries.findIndex(e => e.dte >= 20 && e.dte <= 45);
        if (idx < 0) idx = data.expiries.findIndex(e => e.dte >= 7);
        S.expiryIdx = idx < 0 ? 0 : idx;
        S.selected = null;
      }
      $('symInput').value = '';
      refresh.all();
      setStatus('已加载 ' + data.contractCount + ' 个合约');
      $('statusAsOf').textContent = '行情时点：' + (data.underlying.lastTradeTime || data.timestamp || '—') + ' (美东)';
    } catch (e) {
      S.lastError = e.message;
      setStatus('加载失败：' + e.message, 'err');
      if (!keepExpiry) {
        $('chainWrap').innerHTML = '<div class="empty"><b style="color:var(--up)">加载失败</b><br><br>'
          + esc(e.message) + '<br><br>请确认代码正确（如 AAPL、SPY、SPX），且该标的有期权上市。</div>';
      }
      toast('加载失败：' + e.message, 'err');
    } finally {
      S.loading = false;
    }
  }

  /* ================================================================== *
   * 渲染：顶部行情
   * ================================================================== */
  function renderQuote() {
    if (!S.chain) { $('quoteStrip').innerHTML = ''; return; }
    const u = S.chain.underlying;
    const c = cls(u.change);
    const isIdx = u.type === 'index';

    $('quoteStrip').innerHTML =
      '<div class="q-item"><span class="q-sym">' + esc(u.symbol) + '</span>'
      + '<span class="lbl">' + (isIdx ? '指数' : '股票') + '</span></div>'
      + '<div class="q-item"><span class="q-price ' + c + '">' + fmt(u.last) + '</span>'
      + '<span class="lbl">最新价</span></div>'
      + '<div class="q-item"><span class="q-chg ' + c + '">' + (u.change >= 0 ? '+' : '') + fmt(u.change)
      + ' (' + pct(u.changePct) + ')</span><span class="lbl">涨跌</span></div>'
      + '<div class="q-item hide-sm"><span class="val">' + fmt(u.bid) + ' / ' + fmt(u.ask) + '</span>'
      + '<span class="lbl">买/卖</span></div>'
      + '<div class="q-item hide-sm"><span class="val">' + fmt(u.low) + ' - ' + fmt(u.high) + '</span>'
      + '<span class="lbl">日内区间</span></div>'
      + '<div class="q-item hide-sm"><span class="val">' + bigNum(u.volume) + '</span>'
      + '<span class="lbl">成交量</span></div>'
      + '<div class="q-item"><span class="val ' + cls(u.iv30Change) + '">' + fmt(u.iv30, 1) + '%</span>'
      + '<span class="lbl">30日 IV</span></div>';
  }

  /* ================================================================== *
   * 渲染：到期日选择条
   * ================================================================== */
  function renderExpiries() {
    if (!S.chain) return;
    $('expiryBar').innerHTML = S.chain.expiries.map((e, i) => {
      const d = new Date(e.expiry + 'T00:00:00');
      const dow = d.getUTCDay();
      // 标准月度期权为每月第三个周五
      const isMonthly = dow === 5 && d.getUTCDate() >= 15 && d.getUTCDate() <= 21;
      return '<button class="exp-chip' + (i === S.expiryIdx ? ' active' : '')
        + (isMonthly ? '' : ' weekly') + '" data-i="' + i + '">'
        + e.expiry.slice(5) + '<span class="dte">' + e.dte + 'd</span></button>';
    }).join('');
    // 点击同样走 initDelegatedEvents() 的统一委托，见文件末尾。
  }

  /* ================================================================== *
   * 渲染：期权链表格
   * ================================================================== */
  function renderChain() {
    const exp = curExp();
    if (!exp) return;
    const u = S.chain.underlying;
    const spot = u.last;
    const showGreeks = $('cbGreeks').checked;
    const showOi = $('cbOi').checked;
    const nearOnly = $('cbNearAtm').checked;
    const range = Math.max(2, Math.min(60, +$('atmRange').value || 15)) / 100;
    const useMine = $('ivSource').value === 'mine';
    const rate = ratesFor(exp);
    const pSpot = pricingSpot(exp);   // 定价用等效现价

    let rows = exp.rows;
    if (nearOnly) rows = rows.filter(r => Math.abs(r.strike - spot) / spot <= range);
    if (!rows.length) rows = exp.rows;

    // 找最接近现价的行权价
    let atmStrike = rows[0].strike, best = Infinity;
    rows.forEach(r => {
      const d = Math.abs(r.strike - spot);
      if (d < best) { best = d; atmStrike = r.strike; }
    });

    let maxOi = 0;
    rows.forEach(r => {
      if (r.call) maxOi = Math.max(maxOi, r.call.oi);
      if (r.put) maxOi = Math.max(maxOi, r.put.oi);
    });

    const posSymbols = {};
    S.account.positions.forEach(p => { posSymbols[p.symbol] = p.qty; });

    /* --- 表头 --- */
    const gcols = showGreeks ? 5 : 0;
    const ocols = showOi ? 2 : 0;
    const nCall = 3 + gcols + ocols;

    let html = '<table class="chain"><thead>'
      + '<tr class="grp"><th class="grp-call" colspan="' + nCall + '">认购 CALL</th>'
      + '<th class="grp-strike">行权价</th>'
      + '<th class="grp-put" colspan="' + nCall + '">认沽 PUT</th></tr>'
      + '<tr class="cols">';

    const callCols = [];
    if (showOi) callCols.push('量', '仓');
    if (showGreeks) callCols.push('Δ', 'Γ', 'Θ', 'ν', 'IV');
    callCols.push('买价', '卖价', '涨跌');
    callCols.forEach(c => { html += '<th>' + c + '</th>'; });
    html += '<th class="grp-strike">STRIKE</th>';
    const putCols = ['买价', '卖价', '涨跌'];
    if (showGreeks) putCols.push('IV', 'ν', 'Θ', 'Γ', 'Δ');
    if (showOi) putCols.push('仓', '量');
    putCols.forEach(c => { html += '<th>' + c + '</th>'; });
    html += '</tr></thead><tbody>';

    /* --- 数据行 --- */
    rows.forEach(r => {
      const isAtm = r.strike === atmStrike;
      const callItm = r.strike < spot;
      const putItm = r.strike > spot;
      html += '<tr' + (isAtm ? ' class="atm"' : '') + '>';

      // 计算希腊字母（可选用自算 IV）
      // 定价一律用等效现价 pSpot，保证与市场报价自洽
      function gk(o, type) {
        if (!o) return null;
        let iv = o.iv;
        if (useMine) {
          const mid = midOf(o);
          const solved = M.impliedVol(type, mid, pSpot, r.strike, exp.t, rate.r, rate.q);
          if (solved > 0) iv = solved;
        }
        if (!(iv > 0)) return null;
        const g = M.greeks(type, pSpot, r.strike, exp.t, iv, rate.r, rate.q);
        g.ivUsed = iv;
        return g;
      }

      const gc = showGreeks ? gk(r.call, 'call') : null;
      const gp = showGreeks ? gk(r.put, 'put') : null;

      /* 认购侧 */
      const cItm = callItm ? ' itm' : '';
      if (showOi) {
        html += '<td class="' + cItm + '">' + (r.call ? bigNum(r.call.v) : '—') + '</td>';
        html += '<td class="' + cItm + '">' + (r.call ? bigNum(r.call.oi)
          + (maxOi > 0 ? '<span class="oi-bar" style="width:' + (r.call.oi / maxOi * 100).toFixed(0) + '%"></span>' : '')
          : '—') + '</td>';
      }
      if (showGreeks) {
        html += '<td class="dim' + cItm + '">' + (gc ? fmt(gc.delta, 3) : '—') + '</td>';
        html += '<td class="dim' + cItm + '">' + (gc ? fmt(gc.gamma, 4) : '—') + '</td>';
        html += '<td class="dim' + cItm + '">' + (gc ? fmt(gc.theta, 3) : '—') + '</td>';
        html += '<td class="dim' + cItm + '">' + (gc ? fmt(gc.vega, 3) : '—') + '</td>';
        html += '<td class="dim' + cItm + '">' + (gc ? fmt(gc.ivUsed * 100, 1) : '—') + '</td>';
      }
      const cHasPos = r.call && posSymbols[r.call.sym];
      html += '<td class="cell-c' + cItm + (cHasPos ? ' has-pos' : '') + '" data-sym="'
        + (r.call ? r.call.sym : '') + '" data-side="buy">' + (r.call ? fmt(r.call.b) : '—') + '</td>';
      html += '<td class="cell-c' + cItm + '" data-sym="' + (r.call ? r.call.sym : '')
        + '" data-side="sell">' + (r.call ? fmt(r.call.a) : '—') + '</td>';
      html += '<td class="' + (r.call ? cls(r.call.ch) : 'dim') + cItm + '">'
        + (r.call && r.call.ch ? (r.call.ch > 0 ? '+' : '') + fmt(r.call.ch) : '—') + '</td>';

      /* 行权价 */
      html += '<td class="strike">' + fmt(r.strike, r.strike % 1 === 0 ? 0 : 1) + '</td>';

      /* 认沽侧 */
      const pItm = putItm ? ' itm' : '';
      const pHasPos = r.put && posSymbols[r.put.sym];
      html += '<td class="cell-c' + pItm + (pHasPos ? ' has-pos' : '') + '" data-sym="'
        + (r.put ? r.put.sym : '') + '" data-side="buy">' + (r.put ? fmt(r.put.b) : '—') + '</td>';
      html += '<td class="cell-c' + pItm + '" data-sym="' + (r.put ? r.put.sym : '')
        + '" data-side="sell">' + (r.put ? fmt(r.put.a) : '—') + '</td>';
      html += '<td class="' + (r.put ? cls(r.put.ch) : 'dim') + pItm + '">'
        + (r.put && r.put.ch ? (r.put.ch > 0 ? '+' : '') + fmt(r.put.ch) : '—') + '</td>';
      if (showGreeks) {
        html += '<td class="dim' + pItm + '">' + (gp ? fmt(gp.ivUsed * 100, 1) : '—') + '</td>';
        html += '<td class="dim' + pItm + '">' + (gp ? fmt(gp.vega, 3) : '—') + '</td>';
        html += '<td class="dim' + pItm + '">' + (gp ? fmt(gp.theta, 3) : '—') + '</td>';
        html += '<td class="dim' + pItm + '">' + (gp ? fmt(gp.gamma, 4) : '—') + '</td>';
        html += '<td class="dim' + pItm + '">' + (gp ? fmt(gp.delta, 3) : '—') + '</td>';
      }
      if (showOi) {
        html += '<td class="' + pItm + '">' + (r.put ? bigNum(r.put.oi)
          + (maxOi > 0 ? '<span class="oi-bar" style="width:' + (r.put.oi / maxOi * 100).toFixed(0) + '%"></span>' : '')
          : '—') + '</td>';
        html += '<td class="' + pItm + '">' + (r.put ? bigNum(r.put.v) : '—') + '</td>';
      }
      html += '</tr>';
    });

    html += '</tbody></table>';
    $('chainWrap').innerHTML = html;
    // 单元格点击由 initDelegatedEvents() 统一委托到 #chainWrap，
    // 这里不再逐个绑定（SPX 一次重绘会有 200+ 个单元格）。

    $('chainMeta').textContent = rows.length + ' 档行权价 · '
      + '认购持仓 ' + bigNum(exp.stats.callOI) + ' · 认沽持仓 ' + bigNum(exp.stats.putOI)
      + ' · P/C ' + fmt(exp.stats.pcRatioOI);
    $('statusRates').textContent = rate.calibrated
      ? 'r=' + fmt(rate.r * 100, 2) + '% · 隐含远期 ' + fmt(rate.forward)
        + ' · 定价现价 ' + fmt(pSpot) + ' (平价校准 ' + rate.samples + ' 样本)'
      : 'r=' + fmt(rate.r * 100, 2) + '% · 定价现价 ' + fmt(pSpot) + ' (未校准)';
  }

  /* ================================================================== *
   * 选择合约并渲染下单面板
   * ================================================================== */
  function selectContract(symbol, side) {
    const f = findContract(symbol);
    if (!f) return;
    const p = M.parseOCC(symbol);
    S.selected = {
      symbol,
      type: f.type,
      strike: p.strike,
      expiry: p.expiry,
      exp: f.exp,
      o: f.o,
      side: side || 'buy',
      qty: (S.selected && S.selected.symbol === symbol) ? S.selected.qty : 1,
    };
    // 切到下单页
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.pane === 'paneTrade'));
    document.querySelectorAll('.pane').forEach(p2 => p2.classList.toggle('active', p2.id === 'paneTrade'));
    renderOrder();
  }

  function renderOrder() {
    const sel = S.selected;
    if (!sel) {
      $('orderArea').innerHTML = '<div class="empty">点击左侧期权链中的<br><b>买价 / 卖价</b>单元格<br>即可选择合约下单</div>';
      return;
    }
    const o = sel.o;
    const exp = sel.exp;
    const spot = S.chain.underlying.last;
    const rate = ratesFor(exp);
    const pSpot = pricingSpot(exp);
    const acct = S.account;

    const iv = o.iv > 0 ? o.iv : M.impliedVol(sel.type, midOf(o), pSpot, sel.strike, exp.t, rate.r, rate.q);
    const g = iv > 0 ? M.greeks(sel.type, pSpot, sel.strike, exp.t, iv, rate.r, rate.q) : null;

    const fill = acct.fillPrice(o, sel.side);
    const qty = Math.max(1, sel.qty || 1);
    const mult = 100;
    const notional = fill.price * qty * mult;
    const fee = acct.commission(qty, 'option');
    const isBuy = sel.side === 'buy';

    const existing = acct.positions.find(p => p.symbol === sel.symbol);
    const margin = !isBuy ? acct.marginRequirement('option', fill.price, qty, mult,
      { underlyingPrice: spot, strike: sel.strike }) : 0;

    const moneyness = sel.type === 'call'
      ? (spot > sel.strike ? '价内' : spot < sel.strike ? '价外' : '平值')
      : (spot < sel.strike ? '价内' : spot > sel.strike ? '价外' : '平值');
    const intrinsic = sel.type === 'call' ? Math.max(0, spot - sel.strike) : Math.max(0, sel.strike - spot);
    const timeValue = midOf(o) - intrinsic;
    const spread = o.a > 0 && o.b > 0 ? o.a - o.b : 0;
    const spreadPct = midOf(o) > 0 ? (spread / midOf(o)) * 100 : 0;
    const breakeven = sel.type === 'call' ? sel.strike + fill.price : sel.strike - fill.price;

    let html = '<div class="order-panel">'
      + '<div class="order-head"><div>'
      + '<div class="order-title">' + esc(S.symbol) + ' ' + fmt(sel.strike, sel.strike % 1 ? 1 : 0)
      + ' <span class="tag tag-' + sel.type + '">' + (sel.type === 'call' ? 'CALL' : 'PUT') + '</span></div>'
      + '<div class="order-sub">' + sel.expiry + ' · 剩余 ' + exp.dte + ' 天 · ' + moneyness
      + (existing ? ' · <span style="color:var(--warn)">已持 ' + existing.qty + ' 张</span>' : '') + '</div>'
      + '</div></div>';

    /* 报价 */
    html += '<div class="order-quote">'
      + '<div class="oq"><div class="lbl">买价</div><div class="val">' + fmt(o.b) + '</div></div>'
      + '<div class="oq"><div class="lbl">卖价</div><div class="val">' + fmt(o.a) + '</div></div>'
      + '<div class="oq"><div class="lbl">中间价</div><div class="val">' + fmt(midOf(o)) + '</div></div>'
      + '<div class="oq"><div class="lbl">IV</div><div class="val">' + fmt(iv * 100, 1) + '%</div></div>'
      + '</div>';

    /* 希腊字母 */
    if (g) {
      html += '<div class="order-greeks">'
        + '<div class="og"><div class="lbl">Delta</div><div class="val">' + fmt(g.delta, 3) + '</div></div>'
        + '<div class="og"><div class="lbl">Gamma</div><div class="val">' + fmt(g.gamma, 4) + '</div></div>'
        + '<div class="og"><div class="lbl">Theta</div><div class="val">' + fmt(g.theta, 3) + '</div></div>'
        + '<div class="og"><div class="lbl">Vega</div><div class="val">' + fmt(g.vega, 3) + '</div></div>'
        + '<div class="og"><div class="lbl">Rho</div><div class="val">' + fmt(g.rho, 3) + '</div></div>'
        + '</div>';
    }

    /* 方向与数量 */
    html += '<div class="order-grid">'
      + '<div class="fld"><label>方向</label><select id="ordSide">'
      + '<option value="buy"' + (isBuy ? ' selected' : '') + '>买入 (做多)</option>'
      + '<option value="sell"' + (!isBuy ? ' selected' : '') + '>卖出 (做空)</option>'
      + '</select></div>'
      + '<div class="fld"><label>张数 (每张 100 股)</label>'
      + '<input type="number" id="ordQty" min="1" step="1" value="' + qty + '"></div>'
      + '</div>';

    /* 成本与指标（随张数变化的部分，单独容器以便局部刷新） */
    html += '<div id="ordCalc"></div>';

    html += '<div class="order-btns">'
      + '<button class="btn-buy" id="btnBuy">买入开仓</button>'
      + '<button class="btn-sell" id="btnSell">卖出开仓</button>'
      + '</div>';

    if (spreadPct > 15) {
      html += '<div class="hint" style="color:var(--warn)">⚠ 买卖价差达 ' + fmt(spreadPct, 1)
        + '%，流动性较差。实盘中此类合约成交成本很高。</div>';
    }
    if (o.oi < 10) {
      html += '<div class="hint" style="color:var(--warn)">⚠ 持仓量仅 ' + o.oi + '，几乎无人交易，实盘可能难以成交或平仓。</div>';
    }
    html += '<div class="hint">数据为 CBOE 延迟报价（约 15 分钟）。模拟成交假设按上述价格立即全部成交，不考虑冲击成本。</div>';
    html += '</div>';

    /* 损益预览 */
    html += '<div class="sec-title"><span>本单到期损益</span></div>'
      + '<div class="chart-box"><canvas id="ordChart"></canvas></div>';

    $('orderArea').innerHTML = html;

    /**
     * 局部刷新成本明细与损益图。
     * 只重绘 #ordCalc 与画布，不动输入框，
     * 这样连续输入张数时不会丢失焦点或光标位置。
     */
    function updateCalc() {
      const q = Math.max(1, Math.floor(+($('ordQty') || {}).value || 1));
      S.selected.qty = q;
      const side = ($('ordSide') || {}).value || sel.side;
      S.selected.side = side;
      const buying = side === 'buy';

      const f2 = acct.fillPrice(o, side);
      const notional2 = f2.price * q * mult;
      const fee2 = acct.commission(q, 'option');
      const margin2 = !buying ? acct.marginRequirement('option', f2.price, q, mult,
        { underlyingPrice: spot, strike: sel.strike }) : 0;
      const be2 = sel.type === 'call' ? sel.strike + f2.price : sel.strike - f2.price;

      let h = '<div class="order-cost">'
        + '<div class="row"><span class="dim">成交价（' + slipLabel(acct.settings.slippageMode) + '）</span>'
        + '<span class="num">' + fmt(f2.price) + '</span></div>'
        + '<div class="row"><span class="dim">名义金额 ' + q + ' × 100 × ' + fmt(f2.price) + '</span>'
        + '<span class="num">' + money(notional2) + '</span></div>'
        + '<div class="row"><span class="dim">佣金</span><span class="num">' + money(fee2) + '</span></div>';
      if (!buying) {
        h += '<div class="row"><span class="dim">预估保证金</span><span class="num" style="color:var(--warn)">'
          + money(margin2) + '</span></div>';
      }
      h += '<div class="row total"><span>' + (buying ? '总支出' : '净收入') + '</span>'
        + '<span class="num ' + (buying ? 'down' : 'up') + '">'
        + (buying ? '-' : '+') + money(buying ? notional2 + fee2 : notional2 - fee2) + '</span></div>'
        + '</div>';

      h += '<div class="order-cost">'
        + '<div class="row"><span class="dim">内在价值 / 时间价值</span><span class="num">'
        + fmt(intrinsic) + ' / ' + fmt(timeValue) + '</span></div>'
        + '<div class="row"><span class="dim">买卖价差</span><span class="num'
        + (spreadPct > 10 ? ' up' : '') + '">' + fmt(spread) + ' (' + fmt(spreadPct, 1) + '%)</span></div>'
        + '<div class="row"><span class="dim">' + (buying ? '到期盈亏平衡' : '被行权临界') + '</span>'
        + '<span class="num">' + fmt(be2) + '</span></div>'
        + '<div class="row"><span class="dim">持仓量 / 成交量</span><span class="num">'
        + bigNum(o.oi) + ' / ' + bigNum(o.v) + '</span></div>'
        + '</div>';

      $('ordCalc').innerHTML = h;

      const legs2 = [{
        kind: 'option', type: sel.type, strike: sel.strike,
        qty: buying ? q : -q, entryPrice: f2.price,
        multiplier: mult, iv: iv, T: exp.t,
      }];
      const cur2 = M.payoffCurve(legs2, pSpot, 0.3, 121, { r: rate.r, q: rate.q });
      CH.payoffChart($('ordChart'), {
        pts: cur2.pts, spot, breakevens: cur2.breakevens,
        strikes: [sel.strike], height: 210,
      });
    }

    /* 事件 */
    $('ordSide').onchange = updateCalc;
    $('ordQty').oninput = updateCalc;
    $('btnBuy').onclick = () => submitOrder('buy');
    $('btnSell').onclick = () => submitOrder('sell');

    updateCalc();
  }

  function slipLabel(m) {
    return m === 'mid' ? '中间价' : m === 'aggressive' ? '吃对手价' : '挂单价';
  }

  function submitOrder(side) {
    const sel = S.selected;
    if (!sel) return;
    const qty = Math.max(1, Math.floor(+($('ordQty') || {}).value || 1));
    const exp = sel.exp;
    const rate = ratesFor(exp);
    const iv = sel.o.iv > 0 ? sel.o.iv
      : M.impliedVol(sel.type, midOf(sel.o), pricingSpot(exp), sel.strike, exp.t, rate.r, rate.q);

    const res = S.account.placeOrder({
      kind: 'option',
      symbol: sel.symbol,
      side,
      qty,
      quote: sel.o,
      meta: {
        underlying: S.symbol,
        type: sel.type,
        strike: sel.strike,
        expiry: sel.expiry,
        iv,
        T: exp.t,
        multiplier: 100,
        underlyingPrice: S.chain.underlying.last,
      },
    });

    if (!res.ok) { toast(res.error, 'err'); return; }
    const verb = res.trade.action;
    toast(verb + '成功：' + (side === 'buy' ? '买入' : '卖出') + ' ' + qty + ' 张 @ '
      + fmt(res.fillPrice) + (res.realized ? '，已实现盈亏 ' + money(res.realized) : ''), 'ok');
    if (res.warn) toast(res.warn, 'warn');
    refresh.account();
  }

  /* ================================================================== *
   * 渲染：期权链统计（下单页底部）
   * ================================================================== */
  function renderChainStats() {
    const exp = curExp();
    if (!exp) { $('chainStats').innerHTML = ''; return; }
    const spot = S.chain.underlying.last;
    const mp = M.maxPain(exp.rows);

    $('chainStats').innerHTML =
      '<div class="sec-title"><span>隐含波动率微笑 · ' + exp.expiry + '</span></div>'
      + '<div class="chart-box"><canvas id="ivChart"></canvas></div>'
      + '<div class="sec-title"><span>未平仓量分布</span>'
      + '<span class="faint num">最大痛点 ' + fmt(mp.strike, 0) + '</span></div>'
      + '<div class="chart-box"><canvas id="oiChart2"></canvas></div>';

    const near = exp.rows.filter(r => Math.abs(r.strike - spot) / spot <= 0.25);
    CH.ivSmileChart($('ivChart'), { rows: near.length > 3 ? near : exp.rows, spot, height: 165 });
    CH.oiChart($('oiChart2'), {
      rows: near.length > 3 ? near : exp.rows,
      spot, field: 'oi', maxPain: mp.strike, height: 230,
    });
  }

  /* ================================================================== *
   * 渲染：持仓
   * ================================================================== */
  function renderPositions() {
    const acct = S.account;
    const mtm = acct.markToMarket(priceLookup);
    acct.snapshot(mtm.equity);

    /* 顶部账户摘要 */
    $('hdrEquity').textContent = money(mtm.equity, 0);
    const pnlEl = $('hdrPnl');
    pnlEl.textContent = (mtm.totalPnl >= 0 ? '+' : '') + money(mtm.totalPnl, 0)
      + ' (' + pct(mtm.totalPnlPct, 1) + ')';
    pnlEl.className = 'val num ' + cls(mtm.totalPnl);
    $('hdrCash').textContent = money(mtm.cash, 0);

    const badge = $('posCount');
    if (acct.positions.length) { badge.style.display = ''; badge.textContent = acct.positions.length; }
    else badge.style.display = 'none';

    /* 摘要卡片 */
    const spotMap = {}; if (S.chain) spotMap[S.chain.symbol] = S.chain.underlying.last;
    const marginUsed = acct.totalMargin(null, spotMap);

    $('posSummary').innerHTML = '<div class="risk-grid">'
      + card('总权益', money(mtm.equity, 0), '现金 ' + money(mtm.cash, 0))
      + card('浮动盈亏', (mtm.unrealized >= 0 ? '+' : '') + money(mtm.unrealized, 0),
        '持仓市值 ' + money(mtm.marketValue, 0), cls(mtm.unrealized))
      + card('已实现盈亏', (mtm.realizedTotal >= 0 ? '+' : '') + money(mtm.realizedTotal, 0),
        '累计佣金 ' + money(mtm.feesTotal), cls(mtm.realizedTotal))
      + '</div>'
      + (marginUsed > 0 ? '<div class="hint" style="padding:0 12px 8px">空头持仓预估占用保证金 '
        + money(marginUsed, 0) + '（简化模型，真实券商规则更严格）</div>' : '');

    /* 持仓表 */
    if (!mtm.rows.length) {
      $('posTable').innerHTML = '<div class="empty">当前无持仓<br><br>在期权链中点击买价或卖价即可开仓</div>';
      return;
    }

    let html = '<table class="data"><thead><tr>'
      + '<th>合约</th><th>张数</th><th>均价</th><th>现价</th><th>市值</th><th>浮动盈亏</th><th>Δ</th><th>操作</th>'
      + '</tr></thead><tbody>';

    mtm.rows.forEach(row => {
      const p = row.pos;
      const isOpt = p.kind === 'option';
      const dte = isOpt && p.expiry ? M.daysToExpiry(p.expiry) : null;
      let delta = 0;
      if (isOpt && row.iv > 0 && typeof row.T === 'number') {
        const rate = row.r !== undefined ? { r: row.r, q: row.q } : { r: acct.settings.riskFreeRate / 100, q: 0 };
        const g = M.greeks(p.type, row.pSpot || row.spot || p.strike, p.strike, row.T, row.iv, rate.r, rate.q);
        delta = g.delta * p.qty * p.multiplier;
      } else if (!isOpt) delta = p.qty;

      html += '<tr>'
        + '<td><div class="sym">' + esc(p.underlying) + ' ' + (isOpt ? fmt(p.strike, p.strike % 1 ? 1 : 0)
          + ' <span class="tag tag-' + p.type + '">' + (p.type === 'call' ? 'C' : 'P') + '</span>' : '<span class="tag tag-stock">股票</span>')
        + '</div><div class="sub">' + (isOpt ? p.expiry + ' · ' + dte + 'd' : '') + '</div></td>'
        + '<td><span class="tag ' + (p.qty > 0 ? 'tag-long' : 'tag-short') + '">'
        + (p.qty > 0 ? '+' : '') + p.qty + '</span></td>'
        + '<td>' + fmt(p.avgPrice) + '</td>'
        + '<td>' + fmt(row.mark) + (row.stale ? '<span class="faint">*</span>' : '') + '</td>'
        + '<td>' + money(row.value, 0) + '</td>'
        + '<td class="' + cls(row.pnl) + '">' + (row.pnl >= 0 ? '+' : '') + money(row.pnl, 0)
        + '<div class="sub ' + cls(row.pnl) + '">' + pct(row.pnlPct, 1) + '</div></td>'
        + '<td class="dim">' + fmt(delta, 0) + '</td>'
        + '<td><button class="btn btn-sm" data-close="' + esc(p.symbol) + '">平仓</button></td>'
        + '</tr>';
    });
    html += '</tbody></table>';
    if (mtm.rows.some(r => r.stale)) {
      html += '<div class="hint" style="padding:6px 12px">* 该合约不在当前显示的期权链中，按开仓价估值。切换到对应标的可获取实时价格。</div>';
    }
    $('posTable').innerHTML = html;
    // 平仓按钮的点击由 initDelegatedEvents() 委托处理
  }

  function card(lbl, val, sub, klass) {
    return '<div class="risk-card"><div class="lbl">' + lbl + '</div>'
      + '<div class="val ' + (klass || '') + '">' + val + '</div>'
      + (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>';
  }

  function closePosition(symbol) {
    const p = S.account.positions.find(x => x.symbol === symbol);
    if (!p) return;
    const f = findContract(symbol);
    if (!f && p.kind === 'option') {
      toast('该合约不在当前期权链中，请先切换到 ' + p.underlying + ' 再平仓', 'err');
      return;
    }
    const res = S.account.placeOrder({
      kind: p.kind,
      symbol,
      side: p.qty > 0 ? 'sell' : 'buy',
      qty: Math.abs(p.qty),
      quote: f ? f.o : { b: p.avgPrice, a: p.avgPrice, l: p.avgPrice, th: p.avgPrice },
      meta: {
        underlying: p.underlying, type: p.type, strike: p.strike,
        expiry: p.expiry, multiplier: p.multiplier,
        underlyingPrice: S.chain ? S.chain.underlying.last : p.strike,
      },
    });
    if (!res.ok) { toast(res.error, 'err'); return; }
    toast('平仓成功 @ ' + fmt(res.fillPrice) + '，已实现盈亏 ' + money(res.realized),
      res.realized >= 0 ? 'ok' : 'err');
    refresh.account();
  }

  /* ================================================================== *
   * 渲染：风险面板
   * ================================================================== */
  function renderRisk() {
    const acct = S.account;
    if (!acct.positions.length) {
      $('riskArea').innerHTML = '<div class="empty">暂无持仓<br><br>建仓后这里会显示组合希腊字母、'
        + '到期损益图与情景压力测试</div>';
      return;
    }
    if (!S.chain) return;

    const spot = S.chain.underlying.last;
    const legs = acct.toLegs(S.symbol, priceLookup);
    const rate = ratesFor(curExp());
    const pSpot = pricingSpot(curExp());
    // 横轴用真实现价，定价用等效现价，用比例系数衔接
    const opts = { r: rate.r, q: rate.q, spotScale: spot > 0 ? pSpot / spot : 1 };

    const pg = legs.length ? M.portfolioGreeks(legs, pSpot, opts) : null;
    const mtm = acct.markToMarket(priceLookup);

    let html = '';

    /* 组合希腊字母 */
    if (pg && legs.length) {
      html += '<div class="sec-title"><span>组合希腊字母 · ' + esc(S.symbol) + '</span>'
        + '<span class="faint">' + legs.length + ' 条腿</span></div>'
        + '<div class="risk-grid">'
        + card('Delta', fmt(pg.delta, 0), '标的涨 $1 → ' + money(pg.delta, 0), cls(pg.delta))
        + card('Gamma', fmt(pg.gamma, 2), '涨 $1 后 Δ 变 ' + fmt(pg.gamma, 1))
        + card('Theta', fmt(pg.theta, 1), '每日时间损耗', cls(pg.theta))
        + card('Vega', fmt(pg.vega, 1), 'IV 涨 1% → ' + money(pg.vega, 0), cls(pg.vega))
        + card('Rho', fmt(pg.rho, 1), '利率涨 1%')
        + card('净市值', money(pg.value, 0), '按理论价')
        + '</div>';

      /* 等效标的暴露 */
      const equiv = pg.delta;
      const equivPct = mtm.equity > 0 ? (equiv * spot / mtm.equity) * 100 : 0;
      html += '<div class="hint" style="padding:0 12px 8px">'
        + '当前 Delta 相当于持有 <b>' + fmt(equiv, 0) + ' 股</b> ' + esc(S.symbol)
        + '（约 ' + money(Math.abs(equiv) * spot, 0) + '，占权益 ' + fmt(Math.abs(equivPct), 0) + '%）。'
        + (Math.abs(equivPct) > 100 ? '<span style="color:var(--warn)"> 杠杆已超过 1 倍，注意方向性风险。</span>' : '')
        + '</div>';

      /* 组合损益图 */
      html += '<div class="sec-title"><span>组合损益</span>'
        + '<span class="faint">虚线=当前理论值</span></div>'
        + '<div class="chain-toolbar" style="border:none;padding:2px 12px 6px">'
        + '<label>时间推移 <input type="range" id="scDays" min="0" max="60" value="' + S.scenario.days
        + '" style="width:80px"> <span class="num" id="scDaysV">' + S.scenario.days + 'd</span></label>'
        + '<label>IV 冲击 <input type="range" id="scIv" min="-50" max="50" value="' + S.scenario.ivShift
        + '" style="width:80px"> <span class="num" id="scIvV">' + (S.scenario.ivShift >= 0 ? '+' : '')
        + S.scenario.ivShift + '%</span></label>'
        + '</div>'
        + '<div class="chart-box"><canvas id="riskChart"></canvas></div>';

      /* 关键点位 */
      const cur = M.payoffCurve(legs, spot, 0.35, 161,
        Object.assign({}, opts, { daysForward: S.scenario.days, ivShiftPct: S.scenario.ivShift }));
      // 多到期日组合（如日历价差）的损益是在「最近腿到期」时刻观察的
      const multiExp = new Set(legs.filter(l => l.expiry).map(l => l.expiry)).size > 1;
      const expiryLabel = multiExp ? '近月到期时' : '到期';
      html += '<div class="order-cost" style="margin:0 12px 10px">'
        + '<div class="row"><span class="dim">' + expiryLabel + '最大盈利</span><span class="num up">'
        + (isFinite(cur.maxProfit) ? money(cur.maxProfit, 0) : '无上限') + '</span></div>'
        + '<div class="row"><span class="dim">' + expiryLabel + '最大亏损</span><span class="num down">'
        + (isFinite(cur.maxLoss) ? money(cur.maxLoss, 0) : '无下限') + '</span></div>'
        + '<div class="row"><span class="dim">盈亏平衡点</span><span class="num">'
        + (cur.breakevens.length ? cur.breakevens.map(x => fmt(x)).join(' / ') : '—') + '</span></div>'
        + '</div>';

      /* 情景矩阵 */
      html += '<div class="sec-title"><span>情景压力测试</span><span class="faint">行=价格 列=天数</span></div>'
        + renderScenarioMatrix(legs, spot, opts);
    }

    /* 资金曲线 */
    html += '<div class="sec-title"><span>资金曲线</span></div>'
      + '<div class="chart-box"><canvas id="eqChart"></canvas></div>';

    $('riskArea').innerHTML = html;

    /* 绘图 */
    if (pg && legs.length) {
      const cur = M.payoffCurve(legs, spot, 0.35, 161,
        Object.assign({}, opts, { daysForward: S.scenario.days, ivShiftPct: S.scenario.ivShift }));
      CH.payoffChart($('riskChart'), {
        pts: cur.pts, spot, breakevens: cur.breakevens,
        strikes: legs.filter(l => l.strike).map(l => l.strike), height: 250,
      });

      const dEl = $('scDays'), iEl = $('scIv');
      if (dEl) dEl.oninput = (e) => {
        S.scenario.days = +e.target.value;
        $('scDaysV').textContent = S.scenario.days + 'd';
        redrawRiskChart(legs, spot, opts);
      };
      if (iEl) iEl.oninput = (e) => {
        S.scenario.ivShift = +e.target.value;
        $('scIvV').textContent = (S.scenario.ivShift >= 0 ? '+' : '') + S.scenario.ivShift + '%';
        redrawRiskChart(legs, spot, opts);
      };
    }

    CH.equityChart($('eqChart'), {
      points: acct.equityCurve,
      initial: acct.settings.initialCash,
      height: 130,
    });
  }

  function redrawRiskChart(legs, spot, opts) {
    const cur = M.payoffCurve(legs, spot, 0.35, 161,
      Object.assign({}, opts, { daysForward: S.scenario.days, ivShiftPct: S.scenario.ivShift }));
    CH.payoffChart($('riskChart'), {
      pts: cur.pts, spot, breakevens: cur.breakevens,
      strikes: legs.filter(l => l.strike).map(l => l.strike), height: 250,
    });
  }

  function renderScenarioMatrix(legs, spot, opts) {
    const priceShifts = [-15, -10, -5, -2, 0, 2, 5, 10, 15];
    const dayShifts = [0, 3, 7, 14, 30];

    let html = '<div style="padding:0 12px 12px"><table class="matrix"><thead><tr><th>价格</th>';
    dayShifts.forEach(d => { html += '<th>+' + d + 'd</th>'; });
    html += '</tr></thead><tbody>';

    // 找出最大绝对值用于着色
    let maxAbs = 1;
    priceShifts.forEach(ps => dayShifts.forEach(ds => {
      const v = M.payoffTheoretical(legs, spot * (1 + ps / 100),
        Object.assign({}, opts, { daysForward: ds }));
      maxAbs = Math.max(maxAbs, Math.abs(v));
    }));

    priceShifts.forEach(ps => {
      const s = spot * (1 + ps / 100);
      html += '<tr><td class="hdr">' + (ps > 0 ? '+' : '') + ps + '%<br><span class="faint">'
        + fmt(s, 0) + '</span></td>';
      dayShifts.forEach(ds => {
        const v = M.payoffTheoretical(legs, s, Object.assign({}, opts, { daysForward: ds }));
        const alpha = Math.min(0.42, Math.abs(v) / maxAbs * 0.42);
        const bg = v >= 0 ? 'rgba(255,77,79,' + alpha + ')' : 'rgba(0,200,83,' + alpha + ')';
        html += '<td style="background:' + bg + '" class="' + cls(v) + '">'
          + (v >= 0 ? '+' : '') + (Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0))
          + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    html += '<div class="hint">单元格为组合理论盈亏（美元）。假设 IV 不变，仅价格与时间变化。红=盈利，绿=亏损。</div></div>';
    return html;
  }

  /* ================================================================== *
   * 渲染：策略模板
   * ================================================================== */
  const STRATEGIES = [
    {
      id: 'long-call', name: '买入认购 Long Call', bias: 'bull', biasLabel: '看涨',
      desc: '支付权利金看涨，亏损以权利金为限，盈利理论无上限。',
      legs: () => [{ type: 'call', off: 0, qty: 1 }],
    },
    {
      id: 'long-put', name: '买入认沽 Long Put', bias: 'bear', biasLabel: '看跌',
      desc: '支付权利金看跌，也可为持股做保险（保护性认沽）。',
      legs: () => [{ type: 'put', off: 0, qty: 1 }],
    },
    {
      id: 'bull-call', name: '牛市认购价差 Bull Call Spread', bias: 'bull', biasLabel: '温和看涨',
      desc: '买低行权价认购 + 卖高行权价认购。降低成本，但盈利有上限。',
      legs: (w) => [{ type: 'call', off: 0, qty: 1 }, { type: 'call', off: w, qty: -1 }],
    },
    {
      id: 'bear-put', name: '熊市认沽价差 Bear Put Spread', bias: 'bear', biasLabel: '温和看跌',
      desc: '买高行权价认沽 + 卖低行权价认沽。成本可控的看跌工具。',
      legs: (w) => [{ type: 'put', off: 0, qty: 1 }, { type: 'put', off: -w, qty: -1 }],
    },
    {
      id: 'bull-put', name: '牛市认沽价差 Bull Put Spread', bias: 'bull', biasLabel: '收权利金',
      desc: '卖平值认沽 + 买更低认沽。开仓即收权利金，赌标的不跌破。',
      legs: (w) => [{ type: 'put', off: 0, qty: -1 }, { type: 'put', off: -w, qty: 1 }],
    },
    {
      id: 'straddle', name: '跨式 Long Straddle', bias: 'vol', biasLabel: '做多波动',
      desc: '同时买入同行权价认购与认沽。赌大幅波动，方向无所谓。',
      legs: () => [{ type: 'call', off: 0, qty: 1 }, { type: 'put', off: 0, qty: 1 }],
    },
    {
      id: 'strangle', name: '宽跨式 Long Strangle', bias: 'vol', biasLabel: '做多波动',
      desc: '买入价外认购与价外认沽。比跨式便宜，但需要更大波动才回本。',
      legs: (w) => [{ type: 'call', off: w, qty: 1 }, { type: 'put', off: -w, qty: 1 }],
    },
    {
      id: 'short-strangle', name: '卖出宽跨式 Short Strangle', bias: 'neutral', biasLabel: '做空波动',
      desc: '卖出价外认购与认沽，收双份权利金。赌区间震荡，但亏损无上限。',
      legs: (w) => [{ type: 'call', off: w, qty: -1 }, { type: 'put', off: -w, qty: -1 }],
    },
    {
      id: 'iron-condor', name: '铁鹰 Iron Condor', bias: 'neutral', biasLabel: '区间震荡',
      desc: '卖出宽跨式 + 买入更远两翼保护。风险有限的收权利金策略。',
      legs: (w) => [
        { type: 'put', off: -w * 2, qty: 1 }, { type: 'put', off: -w, qty: -1 },
        { type: 'call', off: w, qty: -1 }, { type: 'call', off: w * 2, qty: 1 },
      ],
    },
    {
      id: 'butterfly', name: '蝶式 Long Butterfly', bias: 'neutral', biasLabel: '钉住现价',
      desc: '买1低 + 卖2中 + 买1高（认购）。赌到期时贴近中间行权价。',
      legs: (w) => [
        { type: 'call', off: -w, qty: 1 }, { type: 'call', off: 0, qty: -2 },
        { type: 'call', off: w, qty: 1 },
      ],
    },
    {
      id: 'calendar', name: '日历价差 Calendar Spread', bias: 'neutral', biasLabel: '赚时间价值',
      desc: '卖近月 + 买远月（同行权价）。赚近月更快的时间衰减。',
      legs: () => [{ type: 'call', off: 0, qty: -1, expOff: 0 }, { type: 'call', off: 0, qty: 1, expOff: 2 }],
    },
    {
      id: 'ratio', name: '认购比率价差 Call Ratio Spread', bias: 'bull', biasLabel: '进阶',
      desc: '买1平值认购 + 卖2价外认购。低成本甚至零成本，但上方风险敞开。',
      legs: (w) => [{ type: 'call', off: 0, qty: 1 }, { type: 'call', off: w, qty: -2 }],
    },
  ];

  /**
   * 策略卡片列表。
   * 这里用 tpl 模板函数示范推荐写法：结构直观、插值自动转义。
   * 卡片点击由 initDelegatedEvents() 委托，靠 data-id 识别。
   */
  function renderStrategies() {
    $('stratList').innerHTML = STRATEGIES.map(s => tpl`
      <div class="strat-card" data-id="${s.id}">
        <div class="nm">${s.name}<span class="bias bias-${s.bias}">${s.biasLabel}</span></div>
        <div class="ds">${s.desc}</div>
      </div>`).join('');
  }

  let stratState = null;

  function openStrategy(id) {
    const strat = STRATEGIES.find(s => s.id === id);
    const exp = curExp();
    if (!strat || !exp || !S.chain) return;

    const spot = S.chain.underlying.last;
    // 推断行权价间距
    const strikes = exp.rows.map(r => r.strike).sort((a, b) => a - b);
    let gaps = [];
    for (let i = 1; i < strikes.length; i++) gaps.push(strikes[i] - strikes[i - 1]);
    gaps = gaps.filter(g => g > 0).sort((a, b) => a - b);
    const gap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 5;

    stratState = { strat, width: gap, qty: 1, expiryIdx: S.expiryIdx };
    $('stratTitle').textContent = strat.name;
    renderStrategyBody();
    $('stratModal').classList.add('show');
  }

  function renderStrategyBody() {
    const st = stratState;
    if (!st) return;
    const exp = S.chain.expiries[st.expiryIdx];
    const spot = S.chain.underlying.last;
    const rate = ratesFor(exp);
    const pSpotStrat = pricingSpot(exp);   // 定价用等效现价

    // 平值行权价
    let atm = exp.rows[0].strike, best = Infinity;
    exp.rows.forEach(r => {
      const d = Math.abs(r.strike - spot);
      if (d < best) { best = d; atm = r.strike; }
    });

    const specs = st.strat.legs(st.width);
    const resolved = [];
    let missing = false;
    let snapped = false;   // 是否发生了大幅偏移（请求的行权价超出链范围）
    const usedKeys = {};
    let duplicated = false;

    specs.forEach(sp => {
      const targetExp = sp.expOff
        ? S.chain.expiries[Math.min(st.expiryIdx + sp.expOff, S.chain.expiries.length - 1)]
        : exp;
      const k = atm + sp.off;
      // 找最接近的行权价
      let row = null, bd = Infinity;
      targetExp.rows.forEach(r => {
        const d = Math.abs(r.strike - k);
        if (d < bd) { bd = d; row = r; }
      });
      const o = row && row[sp.type];
      if (!o) { missing = true; return; }

      // 若实际取到的行权价与目标相差超过间距的一半，说明目标已超出可用范围，
      // 此时结构会被"压扁"成与设计不符的形态，必须提示用户而不是静默成交。
      if (st.width > 0 && Math.abs(row.strike - k) > Math.max(st.width * 0.5, 0.01)) snapped = true;

      // 检测不同腿落到同一合约（间距过小时会发生，导致结构失效）
      const key = targetExp.expiry + '|' + sp.type + '|' + row.strike;
      if (usedKeys[key] !== undefined && sp.off !== specs[usedKeys[key]].off) duplicated = true;
      usedKeys[key] = specs.indexOf(sp);

      resolved.push({
        type: sp.type, strike: row.strike, qty: sp.qty * st.qty,
        o, exp: targetExp, symbol: o.sym,
      });
    });

    if (missing || !resolved.length) {
      $('stratBody').innerHTML = '<div class="empty">当前到期日缺少所需行权价，请调整间距或换到期日</div>';
      return;
    }

    // 计算成本与损益
    const acct = S.account;
    let netCost = 0, totalFee = 0;
    const legs = resolved.map(l => {
      const side = l.qty > 0 ? 'buy' : 'sell';
      const fill = acct.fillPrice(l.o, side);
      const n = fill.price * Math.abs(l.qty) * 100;
      netCost += l.qty > 0 ? n : -n;
      totalFee += acct.commission(Math.abs(l.qty), 'option');
      const rr = ratesFor(l.exp);
      const iv = l.o.iv > 0 ? l.o.iv
        : M.impliedVol(l.type, midOf(l.o), pricingSpot(l.exp), l.strike, l.exp.t, rr.r, rr.q);
      return {
        kind: 'option', type: l.type, strike: l.strike, qty: l.qty,
        entryPrice: fill.price, multiplier: 100, iv: iv || 0.3, T: l.exp.t,
        symbol: l.symbol, expiry: l.exp.expiry, o: l.o,
      };
    });

    const sScale = spot > 0 ? pSpotStrat / spot : 1;
    const cur = M.payoffCurve(legs, spot, 0.32, 141,
      { r: rate.r, q: rate.q, spotScale: sScale });
    const pg = M.portfolioGreeks(legs, pSpotStrat, { r: rate.r, q: rate.q });
    stratState.legs = legs;

    let html = '<div class="hint" style="margin-bottom:10px">' + esc(st.strat.desc) + '</div>';

    // 行权价间距的合理上限：取「链宽的 1/6」与「现价的 25%」中较小者，
    // 避免用户设出 180/320/460 这类名义上仍是蝶式、实际已失去意义的结构。
    const kAll = exp.rows.map(r => r.strike);
    const chainSpan = Math.max.apply(null, kAll) - Math.min.apply(null, kAll);
    const maxWidth = Math.max(1, Math.round(Math.min(chainSpan / 6, spot * 0.25)));

    html += '<div class="order-grid" style="grid-template-columns:1fr 1fr 1fr">'
      + '<div class="fld"><label>张数倍数</label><input type="number" id="stQty" min="1" max="500" value="' + st.qty + '"></div>'
      + '<div class="fld"><label>行权价间距</label><input type="number" id="stWidth" min="0.5" max="'
      + maxWidth + '" step="0.5" value="' + st.width + '"></div>'
      + '<div class="fld"><label>到期日</label><select id="stExp">'
      + S.chain.expiries.map((e, i) => '<option value="' + i + '"' + (i === st.expiryIdx ? ' selected' : '') + '>'
        + e.expiry + ' (' + e.dte + 'd)</option>').join('')
      + '</select></div></div>';

    /* 结构异常告警 */
    if (snapped) {
      html += '<div class="hint" style="color:var(--warn);margin-bottom:8px">'
        + '⚠ 所选间距超出该到期日的行权价范围，部分腿已被就近替换，实际结构与策略设计不符。'
        + '建议将间距降到 ' + maxWidth + ' 以内。</div>';
    }
    if (duplicated) {
      html += '<div class="hint" style="color:var(--warn);margin-bottom:8px">'
        + '⚠ 间距过小导致多条腿落在同一行权价，策略结构已失效，请增大间距。</div>';
    }
    // 翼展过宽时，两翼已是深度价外的"废纸"，结构退化为近似单腿裸卖/裸买
    if (!snapped && specs.length > 1) {
      const offs = specs.map(s => Math.abs(s.off)).filter(x => x > 0);
      const maxOff = offs.length ? Math.max.apply(null, offs) : 0;
      if (maxOff > spot * 0.18) {
        html += '<div class="hint" style="color:var(--warn);margin-bottom:8px">'
          + '⚠ 翼展已达现价的 ' + fmt(maxOff / spot * 100, 0) + '%，两翼期权接近零价值，'
          + '该结构的风险收益特征已偏离典型形态，请谨慎评估。</div>';
      }
    }

    /* 腿明细 */
    html += '<table class="data" style="margin-bottom:10px"><thead><tr>'
      + '<th>腿</th><th>行权价</th><th>到期</th><th>张数</th><th>成交价</th><th>金额</th></tr></thead><tbody>';
    legs.forEach(l => {
      html += '<tr><td><span class="tag tag-' + l.type + '">'
        + (l.type === 'call' ? 'CALL' : 'PUT') + '</span></td>'
        + '<td>' + fmt(l.strike, l.strike % 1 ? 1 : 0) + '</td>'
        + '<td class="sub">' + l.expiry.slice(5) + '</td>'
        + '<td><span class="tag ' + (l.qty > 0 ? 'tag-long' : 'tag-short') + '">'
        + (l.qty > 0 ? '+' : '') + l.qty + '</span></td>'
        + '<td>' + fmt(l.entryPrice) + '</td>'
        + '<td class="' + (l.qty > 0 ? 'down' : 'up') + '">'
        + (l.qty > 0 ? '-' : '+') + money(Math.abs(l.qty) * l.entryPrice * 100, 0) + '</td></tr>';
    });
    html += '</tbody></table>';

    // 多到期日组合（如日历价差）的损益在「最近腿到期」时刻观察
    const multiExpStrat = new Set(legs.map(l => l.expiry)).size > 1;
    const expiryLabel = multiExpStrat ? '近月到期时' : '到期';

    html += '<div class="order-cost">'
      + '<div class="row"><span class="dim">' + (netCost >= 0 ? '净支出（借记）' : '净收入（贷记）') + '</span>'
      + '<span class="num ' + (netCost >= 0 ? 'down' : 'up') + '">' + money(Math.abs(netCost)) + '</span></div>'
      + '<div class="row"><span class="dim">佣金合计</span><span class="num">' + money(totalFee) + '</span></div>'
      + '<div class="row"><span class="dim">' + expiryLabel + '最大盈利</span><span class="num up">'
      + (isFinite(cur.maxProfit) ? money(cur.maxProfit, 0) : '无上限') + '</span></div>'
      + '<div class="row"><span class="dim">' + expiryLabel + '最大亏损</span><span class="num '
      + (cur.maxLoss >= 0 ? 'up' : 'down') + '">'
      + (isFinite(cur.maxLoss) ? money(cur.maxLoss, 0) : '无下限') + '</span></div>'
      + '<div class="row"><span class="dim">盈亏平衡点</span><span class="num">'
      + (cur.breakevens.length ? cur.breakevens.map(x => fmt(x)).join(' / ') : '—') + '</span></div>'
      + '<div class="row total"><span>需要资金</span><span class="num">'
      + money(Math.max(0, netCost) + totalFee) + '</span></div>'
      + '</div>';

    /**
     * 「最大亏损为正」意味着无风险套利，现实中不存在。
     * 这几乎总是中间价成交假设造成的假象：多腿策略每条腿都白拿半个买卖价差，
     * 累加后就凭空生出利润。切到「吃对手价」即会回归正常。
     */
    if (cur.maxLoss >= 0 && S.account.settings.slippageMode === 'mid') {
      html += '<div class="hint" style="color:var(--warn);margin-bottom:8px">'
        + '⚠ 该结构显示「最大亏损为正」，即无风险套利 —— 这是<b>中间价成交假设</b>的假象：'
        + '每条腿都白拿了半个买卖价差。请在设置中改为「吃对手价」查看真实成本。</div>';
    }

    html += '<div class="order-greeks" style="margin-bottom:10px">'
      + '<div class="og"><div class="lbl">Delta</div><div class="val">' + fmt(pg.delta, 0) + '</div></div>'
      + '<div class="og"><div class="lbl">Gamma</div><div class="val">' + fmt(pg.gamma, 2) + '</div></div>'
      + '<div class="og"><div class="lbl">Theta</div><div class="val">' + fmt(pg.theta, 1) + '</div></div>'
      + '<div class="og"><div class="lbl">Vega</div><div class="val">' + fmt(pg.vega, 1) + '</div></div>'
      + '<div class="og"><div class="lbl">Rho</div><div class="val">' + fmt(pg.rho, 1) + '</div></div>'
      + '</div>';

    html += '<canvas id="stratChart"></canvas>';
    $('stratBody').innerHTML = html;

    CH.payoffChart($('stratChart'), {
      pts: cur.pts, spot, breakevens: cur.breakevens,
      strikes: legs.map(l => l.strike), height: 210,
    });

    $('stQty').onchange = (e) => {
      stratState.qty = Math.max(1, Math.min(500, Math.floor(+e.target.value || 1)));
      renderStrategyBody();
    };
    $('stWidth').onchange = (e) => {
      stratState.width = Math.max(0.5, Math.min(maxWidth, +e.target.value || 1));
      renderStrategyBody();
    };
    $('stExp').onchange = (e) => {
      stratState.expiryIdx = +e.target.value;
      renderStrategyBody();
    };
  }

  function execStrategy() {
    const st = stratState;
    if (!st || !st.legs) return;
    let okCount = 0, errMsg = null;

    for (const l of st.legs) {
      const res = S.account.placeOrder({
        kind: 'option',
        symbol: l.symbol,
        side: l.qty > 0 ? 'buy' : 'sell',
        qty: Math.abs(l.qty),
        quote: l.o,
        meta: {
          underlying: S.symbol, type: l.type, strike: l.strike,
          expiry: l.expiry, iv: l.iv, T: l.T, multiplier: 100,
          underlyingPrice: S.chain.underlying.last,
        },
      });
      if (res.ok) okCount++;
      else { errMsg = res.error; break; }
    }

    $('stratModal').classList.remove('show');
    if (errMsg) toast('建仓中断（已成交 ' + okCount + ' 腿）：' + errMsg, 'err');
    else toast(st.strat.name + ' 建仓成功，共 ' + okCount + ' 条腿', 'ok');
    refresh.account();
  }

  /* ================================================================== *
   * 渲染：流水与统计
   * ================================================================== */
  function renderLog() {
    const acct = S.account;
    const st = acct.stats();

    $('statsArea').innerHTML = '<div class="risk-grid">'
      + card('平仓交易', st.closedTrades + ' 笔', '总下单 ' + st.totalTrades + ' 笔')
      + card('胜率', st.wins + st.losses ? fmt(st.winRate, 1) + '%' : '—',
        st.wins + ' 胜 / ' + st.losses + ' 负' + (st.flats ? ' / ' + st.flats + ' 平' : ''),
        st.wins + st.losses ? (st.winRate >= 50 ? 'up' : 'down') : 'dim')
      + card('盈亏比', st.profitFactor === Infinity ? '∞' : fmt(st.profitFactor, 2),
        '均盈 ' + money(st.avgWin, 0) + ' / 均亏 ' + money(st.avgLoss, 0))
      + card('净已实现', (st.netRealized >= 0 ? '+' : '') + money(st.netRealized, 0),
        '佣金 ' + money(st.totalFees), cls(st.netRealized))
      + '</div>';

    if (!acct.trades.length) {
      $('logTable').innerHTML = '<div class="empty">暂无成交记录</div>';
      return;
    }

    let html = '<table class="data"><thead><tr>'
      + '<th>时间</th><th>合约</th><th>操作</th><th>张数</th><th>价格</th><th>金额</th><th>已实现</th>'
      + '</tr></thead><tbody>';

    acct.trades.slice(0, 120).forEach(t => {
      const d = new Date(t.time);
      const tm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
        + ':' + String(d.getSeconds()).padStart(2, '0');
      const dstr = (d.getMonth() + 1) + '/' + d.getDate();
      html += '<tr>'
        + '<td><div>' + tm + '</div><div class="sub">' + dstr + '</div></td>'
        + '<td><div class="sym">' + esc(t.underlying) + ' ' + (t.strike ? fmt(t.strike, t.strike % 1 ? 1 : 0) : '')
        + (t.type ? ' <span class="tag tag-' + t.type + '">' + (t.type === 'call' ? 'C' : 'P') + '</span>' : '')
        + '</div><div class="sub">' + (t.expiry || '') + '</div></td>'
        + '<td><span class="tag ' + (t.side === 'buy' ? 'tag-long' : 'tag-short') + '">'
        + (t.side === 'buy' ? '买' : '卖') + '</span><div class="sub">' + t.action + '</div></td>'
        + '<td>' + t.qty + '</td>'
        + '<td>' + fmt(t.price) + '</td>'
        + '<td>' + money(t.notional, 0) + '<div class="sub faint">费 ' + fmt(t.fee) + '</div></td>'
        + '<td class="' + cls(t.realized) + '">' + (t.realized ? (t.realized >= 0 ? '+' : '') + money(t.realized, 0) : '—') + '</td>'
        + '</tr>';
    });
    html += '</tbody></table>';
    $('logTable').innerHTML = html;
  }

  /* ================================================================== *
   * 刷新调度
   *
   * 界面由 8 个相互独立的区块组成，各自的数据来源并不相同：
   *
   *   区块            依赖
   *   ─────────────────────────────────────────────
   *   quote          期权链快照
   *   expiries       期权链快照
   *   chain          期权链快照 + 定价参数 + 持仓标记
   *   order          选中合约 + 报价 + 持仓（显示"已持 N 张"）
   *   chainStats     当前到期日（IV 微笑、OI 分布）
   *   positions      账户
   *   risk           账户 + 期权链（盯市要用最新报价）
   *   log            账户
   *
   * 早先的做法是任何变化都调 renderAll() 全量重画。代价有两处：
   *   1. 性能 —— SPX 有 116 行 × 17 列，加上 5 个 Canvas 图表，
   *      一次下单要重建整张表并重绘全部图表
   *   2. 体感 —— 重建 chainWrap 的 innerHTML 会让表格滚动位置归零，
   *      下单后视图跳回顶部
   *
   * 因此按「变化源」拆成下面几个入口，各自只碰必要的区块。
   * 新增区块时，把它挂到对应的变化源下即可，不要再退回全量刷新。
   * ================================================================== */
  const refresh = {
    /**
     * 期权链数据或定价参数变化：换标的、切到期日、改设置。
     * 此时所有区块的输入都可能变了，只能全刷。
     */
    all() {
      if (!S.chain) return;
      renderQuote();
      renderExpiries();
      renderChain();
      renderOrder();
      renderChainStats();
      renderPositions();
      renderRisk();
      renderLog();
    },

    /**
     * 账户变化：下单、平仓、策略建仓、到期结算。
     *
     * 期权链的报价没变，只有「哪些合约有持仓」这一点变了，
     * 因此不重建表格，只同步标记 —— 顺带保住了滚动位置。
     */
    account() {
      if (!S.chain) return;
      syncChainPositionMarks();
      renderOrder();      // 面板顶部要显示"已持 N 张"
      renderPositions();
      renderRisk();
      renderLog();
    },

    /**
     * 只有期权链表格需要重画：切换希腊字母列、平值范围、IV 来源。
     * 账户与图表不受影响。
     */
    chainOnly() {
      if (!S.chain) return;
      renderChain();
    },

    /**
     * 窗口尺寸变化。
     * Canvas 的像素尺寸取自容器宽度，必须重绘；DOM 结构无需重建，
     * 但图表绘制逻辑目前内嵌在各 render 函数中，因此重跑这几个区块。
     */
    charts() {
      if (!S.chain) return;
      renderOrder();
      renderChainStats();
      renderRisk();
    },
  };

  /**
   * 同步期权链上的持仓标记（右上角小圆点）。
   *
   * 只增删 class，不触碰 innerHTML —— 这是保住滚动位置的关键。
   * 标记打在买价单元格上，与 renderChain 中的渲染逻辑保持一致。
   */
  function syncChainPositionMarks() {
    const held = new Set(S.account.positions.map(p => p.symbol));
    $('chainWrap')
      .querySelectorAll('td.cell-c[data-side="buy"]')
      .forEach(td => {
        const sym = td.dataset.sym;
        td.classList.toggle('has-pos', Boolean(sym) && held.has(sym));
      });
  }

  /* ================================================================== *
   * 搜索联想
   * ================================================================== */
  function initSearch() {
    const inp = $('symInput');
    const box = $('suggest');
    let idx = -1;

    function hide() { box.style.display = 'none'; idx = -1; }

    function show(list) {
      if (!list.length) return hide();
      box.innerHTML = list.map((it, i) =>
        '<div data-sym="' + it[0] + '"' + (i === idx ? ' class="active"' : '') + '>'
        + '<span class="num">' + it[0] + '</span><span class="sg-name">' + esc(it[1]) + '</span></div>').join('');
      box.style.display = '';
      box.querySelectorAll('div').forEach(d => {
        d.onclick = () => { hide(); loadChain(d.dataset.sym); };
      });
    }

    inp.oninput = () => {
      const v = inp.value.trim().toUpperCase();
      if (!v) return hide();
      const list = POPULAR.filter(p => p[0].indexOf(v) === 0 || p[1].indexOf(v) >= 0).slice(0, 8);
      idx = -1;
      show(list);
    };

    inp.onkeydown = (e) => {
      const items = box.querySelectorAll('div');
      if (e.key === 'ArrowDown') {
        e.preventDefault(); idx = Math.min(idx + 1, items.length - 1);
        items.forEach((d, i) => d.classList.toggle('active', i === idx));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); idx = Math.max(idx - 1, 0);
        items.forEach((d, i) => d.classList.toggle('active', i === idx));
      } else if (e.key === 'Enter') {
        const sym = idx >= 0 && items[idx] ? items[idx].dataset.sym : inp.value.trim().toUpperCase();
        if (sym) { hide(); loadChain(sym); }
      } else if (e.key === 'Escape') hide();
    };

    inp.onfocus = () => { if (!inp.value) show(POPULAR.slice(0, 8)); };
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search-box')) hide();
    });
  }

  /* ================================================================== *
   * 事件委托
   *
   * 期权链与到期日条的内容会被反复重建（SPX 一次重绘 200+ 个单元格）。
   * 若在每次渲染后逐元素绑定 onclick，不仅有开销，更容易出现
   * 「重建后忘记重绑 → 点击静默失效」这类难查的问题。
   *
   * 改为在稳定的父容器上各绑一次，靠 closest() 找到被点的目标。
   * 新增可点击元素时，只要带上约定的 data-* 属性即可，无需再动绑定代码。
   * ================================================================== */
  function initDelegatedEvents() {
    // 期权链：点击买价/卖价单元格选中合约
    $('chainWrap').addEventListener('click', (e) => {
      const td = e.target.closest('td.cell-c');
      if (!td || !td.dataset.sym) return;
      selectContract(td.dataset.sym, td.dataset.side);
    });

    // 到期日选择条
    $('expiryBar').addEventListener('click', (e) => {
      const chip = e.target.closest('.exp-chip');
      if (!chip) return;
      S.expiryIdx = Number(chip.dataset.i);
      S.selected = null;
      refresh.all();
    });

    // 持仓列表：平仓按钮（列表随账户变化重建，同样适合委托）
    $('posTable').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-close]');
      if (!btn) return;
      closePosition(btn.dataset.close);
    });

    // 策略卡片
    $('stratList').addEventListener('click', (e) => {
      const card = e.target.closest('.strat-card');
      if (!card) return;
      openStrategy(card.dataset.id);
    });
  }

  /* ================================================================== *
   * 设置
   * ================================================================== */
  function openSettings() {
    const s = S.account.settings;
    $('setCash').value = s.initialCash;
    $('setComm').value = s.commissionPerContract;
    $('setMinComm').value = s.minCommission;
    $('setSlip').value = s.slippageMode;
    $('setRate').value = s.riskFreeRate;
    $('settingsModal').classList.add('show');
  }

  function saveSettings() {
    const s = S.account.settings;
    s.commissionPerContract = Math.max(0, +$('setComm').value || 0);
    s.minCommission = Math.max(0, +$('setMinComm').value || 0);
    s.slippageMode = $('setSlip').value;
    s.riskFreeRate = +$('setRate').value || 0;
    const newCash = +$('setCash').value || s.initialCash;
    if (newCash !== s.initialCash && !S.account.trades.length) {
      s.initialCash = newCash;
      S.account.cash = newCash;
    }
    S.account.save();
    S.rates = {};
    $('settingsModal').classList.remove('show');
    toast('设置已保存', 'ok');
    refresh.all();
  }

  /* ================================================================== *
   * 初始化
   * ================================================================== */
  function init() {
    /* 标签切换 */
    document.querySelectorAll('.tab').forEach(t => {
      t.onclick = () => {
        document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
        document.querySelectorAll('.pane').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        $(t.dataset.pane).classList.add('active');
      };
    });

    /* 工具栏：只改变期权链的呈现方式，账户与图表不受影响 */
    ['cbNearAtm', 'cbGreeks', 'cbOi', 'ivSource'].forEach(id => {
      $(id).onchange = () => refresh.chainOnly();
    });
    $('atmRange').oninput = () => refresh.chainOnly();

    /* 设置 */
    $('btnSettings').onclick = openSettings;
    $('btnSetSave').onclick = saveSettings;
    $('btnSetCancel').onclick = () => $('settingsModal').classList.remove('show');
    $('btnResetAcct').onclick = () => {
      if (!confirm('确定重置账户？所有持仓与交易记录将被清空，此操作不可撤销。')) return;
      S.account.reset(+$('setCash').value || undefined);
      $('settingsModal').classList.remove('show');
      toast('账户已重置', 'ok');
      refresh.all();
    };

    /* 策略弹窗 */
    $('btnStratCancel').onclick = () => $('stratModal').classList.remove('show');
    $('btnStratExec').onclick = execStrategy;

    /* 持仓操作 */
    $('btnSettle').onclick = () => {
      const spotMap = {};
      if (S.chain) spotMap[S.chain.symbol] = S.chain.underlying.last;
      const r = S.account.settleExpired(spotMap);
      if (!r.count) toast('没有已到期的持仓', 'warn');
      else { toast('已结算 ' + r.count + ' 个到期持仓，盈亏 ' + money(r.pnl), 'ok'); refresh.account(); }
    };
    $('btnCloseAll').onclick = () => {
      const list = S.account.positions.slice();
      if (!list.length) return toast('无持仓可平', 'warn');
      if (!confirm('确定平掉全部 ' + list.length + ' 个持仓？')) return;
      let n = 0;
      list.forEach(p => {
        const f = findContract(p.symbol);
        if (!f && p.kind === 'option') return;
        const res = S.account.placeOrder({
          kind: p.kind, symbol: p.symbol,
          side: p.qty > 0 ? 'sell' : 'buy', qty: Math.abs(p.qty),
          quote: f ? f.o : { b: p.avgPrice, a: p.avgPrice, l: p.avgPrice, th: p.avgPrice },
          meta: {
            underlying: p.underlying, type: p.type, strike: p.strike,
            expiry: p.expiry, multiplier: p.multiplier,
            underlyingPrice: S.chain ? S.chain.underlying.last : p.strike,
          },
        });
        if (res.ok) n++;
      });
      toast('已平仓 ' + n + ' 个持仓' + (n < list.length ? '（部分合约不在当前链中，需切换标的）' : ''),
        n === list.length ? 'ok' : 'warn');
      refresh.account();
    };

    /* 弹窗背景点击关闭 */
    ['settingsModal', 'stratModal'].forEach(id => {
      $(id).onclick = (e) => { if (e.target.id === id) $(id).classList.remove('show'); };
    });

    /* 窗口尺寸变化重绘图表 */
    let rt = null;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => refresh.charts(), 220);
    });

    initDelegatedEvents();
    initSearch();
    renderStrategies();

    /* 定时刷新 */
    S.refreshTimer = setInterval(() => {
      if (!S.loading && S.chain) {
        loadChain(S.symbol, true);
      }
    }, 60000);
    $('statusRefresh').textContent = '每 60 秒自动刷新';

    loadChain(S.symbol);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
