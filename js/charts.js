/**
 * 图表模块 — 纯 Canvas 手绘，无外部依赖
 * 损益图、隐含波动率微笑、持仓量分布、资金曲线
 */
(function (global) {
  'use strict';

  const C = {
    bg: '#141a22',
    grid: 'rgba(38,48,64,.75)',
    gridStrong: 'rgba(70,84,105,.9)',
    text: '#8b98a9',
    textBright: '#e6edf3',
    up: '#ff4d4f',
    down: '#00c853',
    accent: '#3b82f6',
    warn: '#f59e0b',
    upFill: 'rgba(255,77,79,.16)',
    downFill: 'rgba(0,200,83,.16)',
  };

  /** 初始化高清画布 */
  function setup(canvas, cssHeight) {
    const dpr = global.devicePixelRatio || 1;
    const w = canvas.clientWidth || canvas.parentElement.clientWidth || 360;
    const h = cssHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  function fmtMoney(v) {
    const a = Math.abs(v);
    if (a >= 1000) return (v < 0 ? '-' : '') + '$' + (a / 1000).toFixed(a >= 10000 ? 0 : 1) + 'k';
    return (v < 0 ? '-' : '') + '$' + a.toFixed(0);
  }

  function niceStep(range, targetTicks) {
    const raw = range / Math.max(1, targetTicks);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    let step;
    if (norm <= 1) step = 1;
    else if (norm <= 2) step = 2;
    else if (norm <= 2.5) step = 2.5;
    else if (norm <= 5) step = 5;
    else step = 10;
    return step * mag;
  }

  /* ================================================================== *
   * 损益图
   * ================================================================== */
  function payoffChart(canvas, data) {
    const pts = data.pts || [];
    if (!pts.length) return;
    const H = data.height || 240;
    const { ctx, w, h } = setup(canvas, H);

    const padL = 46, padR = 12, padT = 12, padB = 26;
    const plotW = w - padL - padR, plotH = h - padT - padB;

    const xs = pts.map(p => p.s);
    const showTheo = data.showTheo !== false;
    let ys = pts.map(p => p.expiry);
    if (showTheo) ys = ys.concat(pts.map(p => p.theo));

    const xMin = Math.min.apply(null, xs), xMax = Math.max.apply(null, xs);
    let yMin = Math.min.apply(null, ys), yMax = Math.max.apply(null, ys);
    const yPad = Math.max((yMax - yMin) * 0.12, 1);
    yMin -= yPad; yMax += yPad;
    if (yMin > 0) yMin = -yPad;
    if (yMax < 0) yMax = yPad;

    const X = v => padL + ((v - xMin) / (xMax - xMin || 1)) * plotW;
    const Y = v => padT + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    /* --- 网格 --- */
    ctx.font = '9px ui-monospace, monospace';
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;

    const yStep = niceStep(yMax - yMin, 5);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax; v += yStep) {
      const y = Y(v);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillStyle = C.text;
      ctx.fillText(fmtMoney(v), padL - 5, y);
    }

    const xStep = niceStep(xMax - xMin, 6);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let v = Math.ceil(xMin / xStep) * xStep; v <= xMax; v += xStep) {
      const x = X(v);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
      ctx.fillStyle = C.text;
      ctx.fillText(v.toFixed(0), x, padT + plotH + 5);
    }

    /* --- 零轴 --- */
    const y0 = Y(0);
    ctx.strokeStyle = C.gridStrong; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(padL, y0); ctx.lineTo(w - padR, y0); ctx.stroke();

    /* --- 到期损益填充（盈利红、亏损绿）--- */
    function fillRegion(above) {
      ctx.beginPath();
      let started = false;
      for (const p of pts) {
        const yv = above ? Math.max(p.expiry, 0) : Math.min(p.expiry, 0);
        const x = X(p.s), y = Y(yv);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(X(pts[i].s), y0);
      ctx.closePath();
      ctx.fillStyle = above ? C.upFill : C.downFill;
      ctx.fill();
    }
    fillRegion(true);
    fillRegion(false);

    /* --- 当前理论曲线（虚线）--- */
    if (showTheo) {
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = C.accent; ctx.lineWidth = 1.4;
      ctx.beginPath();
      pts.forEach((p, i) => { const x = X(p.s), y = Y(p.theo); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
      ctx.setLineDash([]);
    }

    /* --- 到期损益主线 --- */
    ctx.strokeStyle = C.textBright; ctx.lineWidth = 1.8;
    ctx.beginPath();
    pts.forEach((p, i) => { const x = X(p.s), y = Y(p.expiry); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();

    /* --- 现价竖线 --- */
    if (data.spot) {
      const xs2 = X(data.spot);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = C.warn; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(xs2, padT); ctx.lineTo(xs2, padT + plotH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = C.warn; ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(' ' + data.spot.toFixed(2), xs2, padT + 1);
    }

    /* --- 盈亏平衡点 --- */
    (data.breakevens || []).forEach(be => {
      const x = X(be);
      ctx.fillStyle = C.textBright;
      ctx.beginPath(); ctx.arc(x, y0, 2.8, 0, Math.PI * 2); ctx.fill();
      ctx.font = '8.5px ui-monospace, monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(be.toFixed(1), x, y0 - 4);
    });

    /* --- 行权价标记 --- */
    (data.strikes || []).forEach(k => {
      if (k < xMin || k > xMax) return;
      const x = X(k);
      ctx.strokeStyle = 'rgba(139,152,169,.28)'; ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
      ctx.setLineDash([]);
    });

    /* --- 图例 --- */
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    let lx = padL + 4;
    const legend = [['到期损益', C.textBright]];
    if (showTheo) legend.push(['当前理论', C.accent]);
    legend.forEach(([label, color]) => {
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(lx, padT + 5); ctx.lineTo(lx + 12, padT + 5); ctx.stroke();
      ctx.fillStyle = C.text;
      ctx.fillText(label, lx + 15, padT);
      lx += ctx.measureText(label).width + 34;
    });
  }

  /* ================================================================== *
   * 隐含波动率微笑
   * ================================================================== */
  function ivSmileChart(canvas, data) {
    const rows = (data.rows || []).filter(r =>
      (r.call && r.call.iv > 0) || (r.put && r.put.iv > 0));
    if (rows.length < 2) return;

    const H = data.height || 170;
    const { ctx, w, h } = setup(canvas, H);
    const padL = 40, padR = 10, padT = 12, padB = 24;
    const plotW = w - padL - padR, plotH = h - padT - padB;

    const ks = rows.map(r => r.strike);
    const ivs = [];
    rows.forEach(r => {
      if (r.call && r.call.iv > 0) ivs.push(r.call.iv);
      if (r.put && r.put.iv > 0) ivs.push(r.put.iv);
    });
    const xMin = Math.min.apply(null, ks), xMax = Math.max.apply(null, ks);
    let yMin = Math.min.apply(null, ivs), yMax = Math.max.apply(null, ivs);
    const pad = (yMax - yMin) * 0.15 || 0.02;
    yMin = Math.max(0, yMin - pad); yMax += pad;

    const X = v => padL + ((v - xMin) / (xMax - xMin || 1)) * plotW;
    const Y = v => padT + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);

    ctx.font = '9px ui-monospace, monospace';
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    const yStep = niceStep(yMax - yMin, 4);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax; v += yStep) {
      const y = Y(v);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillStyle = C.text; ctx.fillText((v * 100).toFixed(0) + '%', padL - 4, y);
    }
    const xStep = niceStep(xMax - xMin, 5);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let v = Math.ceil(xMin / xStep) * xStep; v <= xMax; v += xStep) {
      const x = X(v);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
      ctx.fillStyle = C.text; ctx.fillText(v.toFixed(0), x, padT + plotH + 4);
    }

    function drawSeries(key, color) {
      const pts = rows.filter(r => r[key] && r[key].iv > 0);
      if (pts.length < 2) return;
      ctx.strokeStyle = color; ctx.lineWidth = 1.6;
      ctx.beginPath();
      pts.forEach((r, i) => {
        const x = X(r.strike), y = Y(r[key].iv);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
      ctx.fillStyle = color;
      pts.forEach(r => {
        ctx.beginPath(); ctx.arc(X(r.strike), Y(r[key].iv), 1.6, 0, Math.PI * 2); ctx.fill();
      });
    }
    drawSeries('call', C.up);
    drawSeries('put', C.down);

    if (data.spot) {
      const x = X(data.spot);
      ctx.setLineDash([3, 3]); ctx.strokeStyle = C.warn; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = C.up; ctx.fillText('● 认购', padL + 4, padT);
    ctx.fillStyle = C.down; ctx.fillText('● 认沽', padL + 44, padT);
  }

  /* ================================================================== *
   * 持仓量 / 成交量分布（横向柱状，认购与认沽对置）
   * ================================================================== */
  function oiChart(canvas, data) {
    const rows = data.rows || [];
    if (!rows.length) return;
    const field = data.field || 'oi';
    const H = data.height || 220;
    const { ctx, w, h } = setup(canvas, H);
    const padL = 42, padR = 10, padT = 14, padB = 20;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const mid = padL + plotW / 2;

    let maxV = 0;
    rows.forEach(r => {
      if (r.call) maxV = Math.max(maxV, r.call[field] || 0);
      if (r.put) maxV = Math.max(maxV, r.put[field] || 0);
    });
    if (maxV <= 0) return;

    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);

    const barH = Math.max(1.5, Math.min(11, plotH / rows.length - 1.5));
    const halfW = plotW / 2 - 3;

    rows.forEach((r, i) => {
      const y = padT + (i / Math.max(1, rows.length - 1)) * (plotH - barH);
      if (r.call) {
        const bw = ((r.call[field] || 0) / maxV) * halfW;
        ctx.fillStyle = C.up;
        ctx.globalAlpha = .8;
        ctx.fillRect(mid - 1 - bw, y, bw, barH);
      }
      if (r.put) {
        const bw = ((r.put[field] || 0) / maxV) * halfW;
        ctx.fillStyle = C.down;
        ctx.globalAlpha = .8;
        ctx.fillRect(mid + 1, y, bw, barH);
      }
      ctx.globalAlpha = 1;
    });

    // 行权价刻度（隔行显示避免重叠）
    ctx.font = '8.5px ui-monospace, monospace';
    ctx.fillStyle = C.text;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const skip = Math.ceil(rows.length / 14);
    rows.forEach((r, i) => {
      if (i % skip) return;
      const y = padT + (i / Math.max(1, rows.length - 1)) * (plotH - barH) + barH / 2;
      ctx.fillText(r.strike.toFixed(0), padL - 3, y);
    });

    // 中轴
    ctx.strokeStyle = C.gridStrong; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(mid, padT); ctx.lineTo(mid, padT + plotH); ctx.stroke();

    // 现价水平线
    if (data.spot) {
      let closest = 0, best = Infinity;
      rows.forEach((r, i) => {
        const d = Math.abs(r.strike - data.spot);
        if (d < best) { best = d; closest = i; }
      });
      const y = padT + (closest / Math.max(1, rows.length - 1)) * (plotH - barH) + barH / 2;
      ctx.setLineDash([3, 3]); ctx.strokeStyle = C.warn; ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Max Pain
    if (data.maxPain) {
      let idx = -1, best = Infinity;
      rows.forEach((r, i) => {
        const d = Math.abs(r.strike - data.maxPain);
        if (d < best) { best = d; idx = i; }
      });
      if (idx >= 0) {
        const y = padT + (idx / Math.max(1, rows.length - 1)) * (plotH - barH) + barH / 2;
        ctx.strokeStyle = C.accent; ctx.lineWidth = 1.3;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      }
    }

    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = C.up; ctx.fillText('◀ 认购', mid - 34, 1);
    ctx.fillStyle = C.down; ctx.fillText('认沽 ▶', mid + 34, 1);
  }

  /* ================================================================== *
   * 资金曲线
   * ================================================================== */
  function equityChart(canvas, data) {
    const pts = data.points || [];
    const H = data.height || 130;
    const { ctx, w, h } = setup(canvas, H);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);

    if (pts.length < 2) {
      ctx.fillStyle = C.text; ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('交易后将生成资金曲线', w / 2, h / 2);
      return;
    }

    const padL = 44, padR = 10, padT = 10, padB = 16;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const base = data.initial || pts[0].e;

    const es = pts.map(p => p.e).concat([base]);
    let yMin = Math.min.apply(null, es), yMax = Math.max.apply(null, es);
    const pad = (yMax - yMin) * 0.15 || Math.max(base * 0.005, 1);
    yMin -= pad; yMax += pad;

    const X = i => padL + (i / (pts.length - 1)) * plotW;
    const Y = v => padT + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const yStep = niceStep(yMax - yMin, 3);
    for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax; v += yStep) {
      const y = Y(v);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillStyle = C.text; ctx.fillText(fmtMoney(v), padL - 4, y);
    }

    // 初始资金基准线
    const yb = Y(base);
    ctx.setLineDash([4, 3]); ctx.strokeStyle = 'rgba(139,152,169,.55)';
    ctx.beginPath(); ctx.moveTo(padL, yb); ctx.lineTo(w - padR, yb); ctx.stroke();
    ctx.setLineDash([]);

    const last = pts[pts.length - 1].e;
    const color = last >= base ? C.up : C.down;

    // 面积填充
    ctx.beginPath();
    ctx.moveTo(X(0), Y(pts[0].e));
    pts.forEach((p, i) => ctx.lineTo(X(i), Y(p.e)));
    ctx.lineTo(X(pts.length - 1), yb);
    ctx.lineTo(X(0), yb);
    ctx.closePath();
    ctx.fillStyle = last >= base ? C.upFill : C.downFill;
    ctx.fill();

    ctx.strokeStyle = color; ctx.lineWidth = 1.6;
    ctx.beginPath();
    pts.forEach((p, i) => { i ? ctx.lineTo(X(i), Y(p.e)) : ctx.moveTo(X(i), Y(p.e)); });
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(X(pts.length - 1), Y(last), 2.6, 0, Math.PI * 2); ctx.fill();
  }

  global.Charts = { payoffChart, ivSmileChart, oiChart, equityChart, fmtMoney };
})(window);
