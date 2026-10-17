// 东方API 控制台壳注入脚本
// 1) 品牌替换：GPT-Load → 东方API（标题/文案/图标）
// 2) 内嵌「实时并发」页：侧边栏加一项，点开就是排队网关的实时面板
//    （接收并发 / 出口并发 / 排队 / 等待时间 / 吞吐 + 两条曲线）

(() => {
  const BRAND_FROM = 'GPT-Load';
  const BRAND_TO = '东方API';
  if (window.__dfShell) return;
  window.__dfShell = true;

  // ── 品牌 ───────────────────────────────────────────────────
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE']);
  const ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
  const DEFS =
    '<defs><linearGradient id="dfg" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#FF4F1F"/><stop offset="1" stop-color="#FF9A3C"/></linearGradient></defs>';
  const FONT = 'Microsoft YaHei,PingFang SC,Segoe UI,sans-serif';
  const LOGO_SQUARE =
    DEFS + '<rect x="16" y="16" width="480" height="480" rx="112" fill="url(#dfg)"/>' +
    `<text x="256" y="258" text-anchor="middle" dominant-baseline="central" font-family="${FONT}" font-size="290" font-weight="700" fill="#fff">东</text>`;
  const LOGO_WIDE =
    DEFS + '<rect x="0" y="0" width="48" height="48" rx="11" fill="url(#dfg)"/>' +
    `<text x="24" y="25" text-anchor="middle" dominant-baseline="central" font-family="${FONT}" font-size="30" font-weight="700" fill="#fff">东</text>` +
    `<text x="60" y="25" dominant-baseline="central" font-family="${FONT}" font-size="23" font-weight="700" fill="currentColor">东方API</text>`;

  function patchOne(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const v = node.nodeValue;
      if (v && v.includes(BRAND_FROM)) node.nodeValue = v.split(BRAND_FROM).join(BRAND_TO);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || SKIP.has(node.tagName)) return;
    for (const attr of ATTRS) {
      const val = node.getAttribute?.(attr);
      if (val && val.includes(BRAND_FROM)) node.setAttribute(attr, val.split(BRAND_FROM).join(BRAND_TO));
    }
  }

  function replaceText(root) {
    if (!root) return;
    const start = root.nodeType === Node.TEXT_NODE ? root.parentElement : root;
    if (!start) return;
    patchOne(start);
    const walker = document.createTreeWalker(start, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === Node.ELEMENT_NODE && (SKIP.has(n.tagName) || n.hasAttribute?.('data-df-shell'))) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode()) patchOne(walker.currentNode);
  }

  function swapLogos() {
    const svgs = document.querySelectorAll('svg[aria-label*="GPT-Load"], svg[aria-label*="东方API"]');
    for (const svg of svgs) {
      if (svg.dataset.dfLogo === '1') continue;
      svg.dataset.dfLogo = '1';
      const w = Number(svg.getAttribute('width') || 0);
      const h = Number(svg.getAttribute('height') || 0);
      if (w && h && w / h >= 1.6) {
        svg.setAttribute('viewBox', '0 0 168 48');
        svg.setAttribute('preserveAspectRatio', 'xMinYMid meet');
        svg.innerHTML = LOGO_WIDE;
      } else {
        svg.setAttribute('viewBox', '0 0 512 512');
        svg.innerHTML = LOGO_SQUARE;
      }
      svg.setAttribute('aria-label', BRAND_TO);
    }
  }

  function brandTitle() {
    if (document.title && document.title.includes(BRAND_FROM)) {
      document.title = document.title.split(BRAND_FROM).join(BRAND_TO);
    }
  }

  function applyBrand() {
    brandTitle();
    replaceText(document.body);
    swapLogos();
  }

  new MutationObserver(brandTitle).observe(document.head, { childList: true, subtree: true, characterData: true });

  // ── 深浅色 ─────────────────────────────────────────────────
  function isDark() {
    const de = document.documentElement;
    const theme = (de.dataset.theme || de.getAttribute('data-theme') || '').toLowerCase();
    if (theme === 'dark') return true;
    if (theme === 'light') return false;
    if (de.classList.contains('dark')) return true;
    return matchMedia('(prefers-color-scheme: dark)').matches;
  }

  const C = {
    line: '#FF4F1F',
    line2: '#f59e0b',
    wait: '#3b82f6',
    waitP95: '#8b5cf6',
    up: '#0ea5e9',
    mut: '#9ca3af',
  };

  // ── 工具 ───────────────────────────────────────────────────
  const el = (tag, style, text) => {
    const n = document.createElement(tag);
    if (style) n.style.cssText = style;
    if (text != null) n.textContent = text;
    return n;
  };
  const secs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
  const clock = (ms, long) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return long ? `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
                : `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  function themeVars() {
    const dark = isDark();
    return {
      bg: dark ? '#101216' : '#ffffff',
      card: dark ? 'rgba(255,255,255,.04)' : '#ffffff',
      fg: dark ? '#f3f4f6' : '#111827',
      mut: dark ? '#9ca3af' : '#6b7280',
      bd: dark ? 'rgba(255,255,255,.12)' : '#e5e7eb',
      grid: dark ? 'rgba(255,255,255,.09)' : 'rgba(0,0,0,.07)',
      chip: dark ? 'rgba(255,255,255,.07)' : '#f3f4f6',
      on: dark ? 'rgba(255,255,255,.16)' : '#ffffff',
    };
  }

  // ── 页面骨架 ───────────────────────────────────────────────
  const RANGES = [
    { label: '5 分钟', ms: 300_000 },
    { label: '15 分钟', ms: 900_000 },
    { label: '1 小时', ms: 3_600_000 },
    { label: '6 小时', ms: 21_600_000 },
    { label: '24 小时', ms: 86_400_000 },
  ];
  let range = RANGES[1];
  let open = false;
  let timer = null;
  let last = null;

  const page = el('div', 'position:fixed;z-index:2147482000;display:none;overflow:auto;background:var(--df-bg,#fff);color:var(--df-fg,#111)');
  page.setAttribute('data-df-shell', '1');
  page.setAttribute('data-df-page', '1');

  const wrap = el('div', 'padding:22px 26px 28px;max-width:1500px');
  const head = el('div', 'display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap;margin-bottom:16px');
  const titles = el('div', 'display:flex;flex-direction:column;gap:3px');
  titles.append(
    el('div', 'font-size:17px;font-weight:700;letter-spacing:.01em', '实时并发'),
    el('div', 'font-size:10.5px;color:var(--df-mut,#6b7280)', '东方API 排队网关 · 接收 → 排队 → 出口'),
  );
  const spacer = el('div', 'flex:1');
  const tabs = el('div', 'display:flex;gap:4px;background:var(--df-chip,#f3f4f6);padding:3px;border-radius:10px');
  const closeBtn = el('button', 'border:none;background:transparent;cursor:pointer;font:inherit;font-size:11px;color:var(--df-mut,#6b7280);padding:6px 10px;border-radius:8px', '✕ 关闭');
  // 2026-10-18：设置入口直接放进面板头部，不再依赖侧边栏注入是否成功
  const gearBtn = el('button', 'border:none;cursor:pointer;font:inherit;font-size:11px;font-weight:600;color:#fff;background:linear-gradient(135deg,#374151,#111827);padding:6px 12px;border-radius:8px', '⚙ 网关设置');
  gearBtn.setAttribute('data-df-shell', '1');
  gearBtn.addEventListener('click', () => openSettings(true));
  head.append(titles, spacer, tabs, gearBtn, closeBtn);

  const kpis = el('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:18px');
  const chart1Box = el('div', 'background:var(--df-card,#fff);border:1px solid var(--df-bd,#e5e7eb);border-radius:14px;padding:12px 14px 6px;margin-bottom:14px;position:relative');
  const chart1Title = el('div', 'display:flex;align-items:center;gap:14px;font-size:10.5px;color:var(--df-mut,#6b7280);margin-bottom:6px');
  chart1Title.innerHTML = '<span style="color:' + C.line + '">■</span> 出口并发（本网关）　'
    + '<span style="color:' + C.line2 + '">▨</span> 接收并发　'
    + '<span style="color:' + C.up + '">┄</span> 上游自报（GPT-Load）';
  const chart1Peak = el('span', 'margin-left:auto;color:var(--df-mut,#9ca3af)');
  chart1Title.append(chart1Peak);
  const chart1 = el('div', 'position:relative');
  chart1Box.append(chart1Title, chart1);

  const chart2Box = el('div', 'background:var(--df-card,#fff);border:1px solid var(--df-bd,#e5e7eb);border-radius:14px;padding:12px 14px 6px;position:relative');
  const chart2Title = el('div', 'display:flex;align-items:center;gap:14px;font-size:10.5px;color:var(--df-mut,#6b7280);margin-bottom:6px');
  chart2Title.innerHTML = '<span style="color:' + C.wait + '">—</span> 平均等待　<span style="color:' + C.waitP95 + '">┄</span> P95 等待';
  const chart2 = el('div', 'position:relative');
  chart2Box.append(chart2Title, chart2);

  const foot = el('div', 'display:flex;gap:18px;flex-wrap:wrap;font-size:10.5px;color:var(--df-mut,#9ca3af);margin-top:14px');
  const usersBox = el('div', 'background:var(--df-card,#fff);border:1px solid var(--df-bd,#e5e7eb);border-radius:14px;padding:12px 14px;margin-top:14px');
  const usersTitle = el('div', 'font-size:10.5px;color:var(--df-mut,#6b7280);margin-bottom:6px', '按人明细（每个访问密钥）');
  const usersBody = el('div', '');
  usersBox.append(usersTitle, usersBody);
  wrap.append(head, kpis, chart1Box, chart2Box, usersBox, foot);
  page.append(wrap);
  document.body.append(page);

  const pill = el('button', 'position:fixed;z-index:2147482001;right:20px;bottom:20px;display:none;align-items:center;gap:8px;border:none;cursor:pointer;border-radius:999px;padding:10px 16px;font:inherit;font-size:11px;font-weight:600;color:#fff;background:linear-gradient(135deg,#FF4F1F,#FF9A3C);box-shadow:0 8px 22px rgba(255,79,31,.35)', '📈 实时并发');
  pill.setAttribute('data-df-shell', '1');
  pill.addEventListener('click', () => togglePage(true));
  document.body.append(pill);

  // 设置入口悬浮按钮（侧边栏注入失败时的兜底入口）
  const pillSet = el('button', 'position:fixed;z-index:2147482001;right:20px;bottom:70px;display:flex;align-items:center;gap:8px;border:none;cursor:pointer;border-radius:999px;padding:10px 16px;font:inherit;font-size:11px;font-weight:600;color:#fff;background:linear-gradient(135deg,#374151,#111827);box-shadow:0 8px 22px rgba(0,0,0,.28)', '⚙ 网关设置');
  pillSet.setAttribute('data-df-shell', '1');
  pillSet.addEventListener('click', () => openSettings(!settingsOpen));
  document.body.append(pillSet);

  for (const r of RANGES) {
    const t = el('button', 'border:none;background:transparent;cursor:pointer;font:inherit;font-size:10.5px;padding:5px 11px;border-radius:8px;color:var(--df-mut,#6b7280)', r.label);
    t.dataset.range = String(r.ms);
    t.addEventListener('click', () => { range = r; paintTabs(); refresh(); });
    tabs.append(t);
  }
  function paintTabs() {
    for (const t of tabs.children) {
      const on = Number(t.dataset.range) === range.ms;
      t.style.background = on ? 'var(--df-on,#fff)' : 'transparent';
      t.style.color = on ? 'var(--df-fg,#111)' : 'var(--df-mut,#6b7280)';
      t.style.fontWeight = on ? '700' : '400';
      t.style.boxShadow = on ? '0 1px 3px rgba(0,0,0,.12)' : 'none';
    }
  }
  closeBtn.addEventListener('click', () => togglePage(false));

  // ── 布局：贴在主内容区 ─────────────────────────────────────
  function layout() {
    const main = document.querySelector('.modern-main-column') || document.querySelector('.modern-content');
    if (!main) { page.style.left = '0'; page.style.top = '0'; page.style.width = '100vw'; page.style.height = '100vh'; return; }
    const r = main.getBoundingClientRect();
    if (r.width < 200 || r.height < 100) return;
    page.style.left = `${r.left}px`;
    page.style.top = `${r.top}px`;
    page.style.width = `${r.width}px`;
    page.style.height = `${r.height}px`;
  }

  // ── KPI ────────────────────────────────────────────────────
  function kpi(label, value, sub, accent) {
    const box = el('div', 'background:var(--df-card,#fff);border:1px solid var(--df-bd,#e5e7eb);border-radius:14px;padding:13px 15px;display:flex;flex-direction:column;gap:3px');
    const v = el('div', 'font-size:22px;font-weight:700;line-height:1.1;font-variant-numeric:tabular-nums', value);
    if (accent) v.style.color = accent;
    box.append(v, el('div', 'font-size:10.5px;color:var(--df-mut,#9ca3af)', label));
    if (sub) box.append(el('div', 'font-size:10px;color:var(--df-mut,#9ca3af)', sub));
    return box;
  }

  // ── 并发分层能量槽（2026-10-18 运维加，按用户口径分三层）──────────
  //   入口接收 = 连到代理的请求（在飞 + 排队），刻度=虚拟上限（access key 并发上限之和）
  //   网关出口 = 已派发给 GPT-Load 的数量，刻度=cap（出口名额）
  //   上游确认 = GPT-Load 实际在处理的数量（真实并发），刻度=cap
  function trackRow(label, used, cap, color, tip) {
    const row = el('div', 'display:flex;align-items:center;gap:8px;margin-top:5px');
    row.append(el('div', 'font-size:10px;color:var(--df-mut,#9ca3af);width:56px;flex:0 0 auto', label));
    const n = Math.max(1, Number(cap) || 1);
    const u = Math.max(0, Math.min(n, Number(used) || 0));
    const track = el('div', 'position:relative;height:9px;flex:1;min-width:110px;border-radius:3px;background:var(--df-bd,#e5e7eb);overflow:hidden');
    if (n <= 20) {
      track.style.display = 'flex'; track.style.gap = '2px'; track.style.background = 'transparent';
      for (let i = 0; i < n; i++) {
        const c = el('div', 'height:9px;flex:1;border-radius:2px;background:var(--df-bd,#e5e7eb)');
        if (i < u) c.style.background = color;
        track.append(c);
      }
    } else {
      const fill = el('div', 'position:absolute;left:0;top:0;bottom:0;border-radius:3px');
      fill.style.width = `${Math.round((u / n) * 100)}%`;
      fill.style.background = color;
      track.append(fill);
    }
    row.append(track, el('div', 'font-size:10px;font-variant-numeric:tabular-nums;width:66px;text-align:right;flex:0 0 auto', tip ?? `${used}/${cap}`));
    return row;
  }

  // 2026-10-18 哨兵修正：「o − c」不是卡单。
  // gpt-load 的 concurrency.current 只统计「等首字节/上游处理中」，首字节返回后进入
  // 流式传输就不再计入；而 3001 的 inFlight 要算到响应结束。两者之差主要是「流式响应
  // 传输中」的正常请求（实测首字节 p50 3.6~4.0s、总耗时 p95 20s+），不是卡住的请求。
  // 真正的卡单看「首字节超时」：这里用 ttfbTimeouts 的 60 秒滑动增量表示。
  const ttfbHist = [];
  function ttfbDelta(s) {
    const now = Date.now();
    const v = Number(s?.ttfbTimeouts ?? 0);
    ttfbHist.push({ t: now, v });
    while (ttfbHist.length > 1 && now - ttfbHist[0].t > 60_000) ttfbHist.shift();
    const base = ttfbHist[0]?.v ?? v;
    return Math.max(0, v - base);
  }

  function slotCard(s) {
    const cap = s?.cap ?? 10;
    const o = s?.inFlight ?? 0;
    const q = s?.queued ?? 0;
    const inbound = s?.inbound ?? (o + q);
    // 入口刻度：0/空 = 自动跟随 GPT-Load 上 access key 的并发上限（virtualCap 后端动态求和）；
    // 只有用户显式填了数字才用手动值。任何情况下都不写死 100 当假值。
    const refRaw = Number(s?.virtualCapRef);
    const vCap = refRaw > 0
      ? refRaw
      : (Number(s?.virtualCap) > 0 ? Number(s.virtualCap) : Math.max(1, Number(s?.cap) || 1));
    const warn = Number(s?.stuckWarn) > 0 ? Number(s.stuckWarn) : 2;
    const down = s?.upstreamInFlight == null;
    const c = down ? 0 : s.upstreamInFlight;
    const transmitting = down ? 0 : Math.max(0, o - c);   // 流式传输中，非卡单
    const ttfbTO = ttfbDelta(s);                            // 近 60s 首字节超时次数
    // 真卡单：后端按「最后一次收到上游字节」计，≥60s 无新字节才算（stalled / maxIdleMs）
    const stalled = Number(s?.stalled ?? 0);
    const maxIdleMs = Number(s?.maxIdleMs ?? 0);
    const box = el('div', 'background:var(--df-card,#fff);border:1px solid var(--df-bd,#e5e7eb);border-radius:14px;padding:12px 15px;grid-column:span 2;min-width:320px');
    const head = el('div', 'display:flex;align-items:baseline;gap:8px');
    const big = el('div', 'font-size:16.5px;font-weight:700;font-variant-numeric:tabular-nums;margin-left:auto',
      down ? '上游无数据' : `${c} / ${cap}`);
    if (!down && (stalled > 0 || ttfbTO >= warn)) big.style.color = '#f59e0b';
    head.append(el('div', 'font-size:10.5px;color:var(--df-mut,#9ca3af)', '并发能量槽'), big);
    box.append(head);
    box.append(trackRow('入口接收', inbound, vCap, '#3b82f6', String(inbound) + (q ? ` 排${q}` : '')));
    box.append(trackRow('网关出口', o, cap, 'var(--df-line,#ef4444)', `${o}/${cap}`));
    box.append(trackRow('上游确认', c, cap, '#22c55e', down ? '—' : `${c}/${cap}`));
    const realCap = Number(s?.virtualCap) > 0 ? `（GPT-Load 实际 ${s.virtualCap}）` : '';
    box.append(el('div', 'font-size:10px;color:var(--df-mut,#9ca3af);margin-top:6px',
      `入口刻度 ${vCap}${refRaw > 0 ? ' 手动' : ' 自动'}${realCap} · 传输中 ${transmitting}（流式，正常） · 卡单 ${stalled}${stalled > 0 ? `（最久 ${Math.round(maxIdleMs / 1000)}s 无数据）` : ''} · 近60s首字节超时 ${ttfbTO}` + (stalled > 0 || ttfbTO >= warn ? ' ⚠' : '')));
    return box;
  }

  function renderKpi(s) {
    const cap = s?.cap ?? 0;
    const inflight = s?.inFlight ?? 0;
    const q = s?.queued ?? 0;
    const inbound = s?.inbound ?? inflight + q;
    const occ = cap ? Math.round((inflight / cap) * 100) : 0;
    const upDown = s?.upstreamInFlight == null;             // GPT-Load 没响应时不要拿旧值冒充实时
    const upNow = upDown ? 0 : s.upstreamInFlight;          // GPT-Load 实测的上游在飞
    const transmitting = upDown ? 0 : Math.max(0, inflight - upNow);   // 流式传输中，非卡单
    let upTxt = '上游无数据';
    if (upDown) {
      upTxt = '上游 GPT-Load 无响应';
    } else if (upNow > 0 || inflight > 0) {
      upTxt = transmitting === 0
        ? `上游自报 ${upNow} · 一致`
        : `上游自报 ${upNow} · 传输中 ${transmitting}`;
    }
    // 等待统计只在「真的排过队」时才有样本；样本为空时显示 —，不要拿 0 冒充「等待时间为 0」
    const waitN = Number(s?.waitSamples ?? 0);
    const hasWaitSample = waitN > 0 || (Number(s?.wait?.p95 ?? 0) > 0) || (Number(s?.wait?.avg ?? 0) > 0);
    kpis.replaceChildren(
      kpi('接收并发（在飞 + 排队）', String(inbound)),
      kpi('出口在飞 / 上限', `${inflight} / ${cap}`, `${upTxt} · 占用 ${occ}%`, occ >= 90 ? C.line : undefined),
      slotCard(s),
      kpi('排队中', String(q), q > 0 ? '正在等待出口' : '无积压'),
      kpi('平均等待', hasWaitSample ? secs(s.wait.avg) : '—', hasWaitSample ? `已排队 ${s.queuedTotal ?? 0} 次` : '本次启动后无排队'),
      kpi('P95 等待', secs(s?.wait?.p95 ?? 0), `最长 ${secs(s?.wait?.max ?? 0)}`),
      kpi('吞吐', String(s?.throughput1m ?? 0), '次/分钟'),
    );
  }

  // ── 通用折线图 ─────────────────────────────────────────────
  function drawChart(host, opts) {
    const W = Math.max(320, (host.clientWidth || 900) - 4);
    const H = opts.height;
    const padL = opts.padL ?? 40, padR = 12, padT = 10, padB = 22;
    const iw = W - padL - padR, ih = H - padT - padB;
    const t0 = opts.from, t1 = opts.to;
    const yMax = Math.max(opts.yMin ?? 5, ...opts.series.map((s) => s.peak)) * 1.15 || 5;
    const sx = (t) => padL + ((t - t0) / Math.max(1, t1 - t0)) * iw;
    const sy = (v) => padT + ih - (v / yMax) * ih;
    const th = themeVars();
    const fmtY = opts.fmtY ?? ((v) => String(Math.round(v)));

    let s = `<svg width="100%" viewBox="0 0 ${W} ${H}" style="display:block;overflow:visible">`;
    s += `<defs><linearGradient id="gOut" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.line}" stop-opacity=".45"/><stop offset="1" stop-color="${C.line}" stop-opacity=".02"/></linearGradient>`;
    s += `<linearGradient id="gQ" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.line2}" stop-opacity=".38"/><stop offset="1" stop-color="${C.line2}" stop-opacity=".05"/></linearGradient></defs>`;

    for (let i = 0; i <= 4; i++) {
      const v = (yMax / 4) * i;
      const y = sy(v);
      s += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${th.grid}"/>`;
      s += `<text x="${padL - 7}" y="${y + 4}" text-anchor="end" font-size="10" fill="${th.mut}">${fmtY(v)}</text>`;
    }
    for (let i = 0; i <= 4; i++) {
      const t = t0 + ((t1 - t0) / 4) * i;
      s += `<text x="${sx(t)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}" font-size="10" fill="${th.mut}">${clock(t, opts.long)}</text>`;
    }

    for (const ser of opts.series) {
      const pts = ser.points.filter((p) => p != null);
      if (pts.length < 2) continue;
      let d = '';
      pts.forEach((p, i) => { d += `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`; });
      if (ser.area) {
        s += `<path d="${d}L${sx(pts[pts.length - 1][0]).toFixed(1)},${sy(0)}L${sx(pts[0][0]).toFixed(1)},${sy(0)}Z" fill="${ser.area}"/>`;
      }
      s += `<path d="${d}" fill="none" stroke="${ser.color}" stroke-width="${ser.width ?? 2}" ${ser.dash ? `stroke-dasharray="${ser.dash}"` : ''} stroke-linejoin="round" stroke-linecap="round"/>`;
    }

    s += `<rect id="hov" x="${padL}" y="${padT}" width="${iw}" height="${ih}" fill="transparent"/>`;
    s += '</svg>';
    host.innerHTML = s;

    const tip = el('div', 'position:absolute;pointer-events:none;display:none;padding:6px 10px;border-radius:8px;font-size:10px;line-height:1.5;white-space:pre;background:rgba(17,24,39,.93);color:#fff;transform:translate(-50%,-120%);z-index:5');
    host.append(tip);
    const hov = host.querySelector('#hov');
    hov.addEventListener('mousemove', (ev) => {
      const rect = hov.getBoundingClientRect();
      const scale = W / Math.max(1, rect.width);
      const x = (ev.clientX - rect.left) * scale + padL;
      const tt = t0 + ((x - padL) / Math.max(1, iw)) * (t1 - t0);
      let best = null, bd = Infinity;
      for (const ser of opts.series) for (const p of ser.points) {
        if (!p) continue;
        const dd = Math.abs(p[0] - tt);
        if (dd < bd) { bd = dd; best = p[0]; }
      }
      if (best == null) return;
      tip.style.display = '';
      tip.style.left = `${((sx(best) / W) * rect.width)}px`;
      tip.style.top = `${opts.height * 0.35}px`;
      tip.textContent = opts.tooltip(best);
    });
    hov.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  }

  function render(h) {
    if (!h) return;
    const pts = h.points ?? [];
    const from = h.from, to = h.to;
    const long = range.ms > 3_600_000;
    const P = (fn) => pts.map((p) => [p.t, fn(p)]);

    const peakRecv = Math.max(0, ...pts.map((p) => p.o + p.q));
    const peakOut = Math.max(0, ...pts.map((p) => p.o));
    const peakUp = Math.max(0, ...pts.map((p) => p.c || 0));
    chart1Peak.textContent = pts.length
      ? `窗口峰值：出口 ${peakOut} · 接收 ${peakRecv} · 上游自报 ${peakUp}`
      : '';
    drawChart(chart1, {
      height: 260, from, to, long,
      yMin: h.cap ?? 5,
      series: [
        { points: P((p) => p.c || 0), color: C.up, width: 1.4, dash: '2 4', peak: peakUp },
        { points: P((p) => p.o + p.q), color: C.line2, area: 'url(#gQ)', width: 1.2, dash: '4 3', peak: peakRecv },
        { points: P((p) => p.o), color: C.line, area: 'url(#gOut)', peak: peakOut },
      ],
      tooltip: (t) => {
        const p = pts.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a), pts[0]);
        return `${clock(p.t)}\n接收 ${p.o + p.q}  ·  出口 ${p.o}  ·  排队 ${p.q}\n上游自报 ${p.c ?? 0}`;
      },
    });

    drawChart(chart2, {
      height: 150, from, to, long,
      yMin: 1000,
      fmtY: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`),
      series: [
        { points: P((p) => p.p), color: C.waitP95, width: 1.6, dash: '4 3', peak: Math.max(0, ...pts.map((p) => p.p)) },
        { points: P((p) => p.w), color: C.wait, width: 2, peak: Math.max(0, ...pts.map((p) => p.w)) },
      ],
      tooltip: (t) => {
        const p = pts.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a), pts[0]);
        return `${clock(p.t)}\n平均等待 ${secs(p.w)}  ·  P95 ${secs(p.p)}`;
      },
    });
  }

  // ── 按人明细 ───────────────────────────────────────────────
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function renderUsers(s) {
    const list = (s?.users ?? []).slice(0, 12);
    if (!list.length) {
      usersBody.innerHTML = '<div style="font-size:10.5px;color:var(--df-mut,#9ca3af)">暂无活跃用户</div>';
      return;
    }
    const th = 'padding:7px 10px;text-align:left;font-size:10px;color:var(--df-mut,#9ca3af);font-weight:600;border-bottom:1px solid var(--df-bd,#e5e7eb);white-space:nowrap';
    const td = 'padding:7px 10px;font-size:10.5px;border-bottom:1px solid var(--df-bd,#e5e7eb);white-space:nowrap';
    const tdn = `${td};font-variant-numeric:tabular-nums`;
    let html = '<table style="width:100%;border-collapse:collapse"><thead><tr>'
      + `<th style="${th}">用户</th><th style="${th}">在飞 / 上限</th><th style="${th}">上游实测</th><th style="${th}">排队</th>`
      + `<th style="${th}">已服务</th><th style="${th}">平均等待</th><th style="${th}">被拒</th><th style="${th}">占用</th></tr></thead><tbody>`;
    for (const u of list) {
      const pct = u.cap ? Math.min(100, Math.round((u.inflight / u.cap) * 100)) : 0;
      const color = pct >= 90 ? C.line : pct >= 60 ? C.line2 : '#16a34a';
      const nm = u.name || '未命名';
      html += `<tr><td style="${td}"><span style="font-weight:600">${esc(nm)}</span> `
        + `<span style="color:var(--df-mut,#9ca3af);font-size:10px">****${esc(u.suffix)}</span></td>`
        + `<td style="${tdn}">${u.inflight} / ${u.cap}</td>`
        + `<td style="${tdn}">${u.upCur == null || u.upCur === 0 ? '—' : u.upCur}</td>`
        + `<td style="${tdn}">${u.queued}</td>`
        + `<td style="${tdn}">${u.served}</td>`
        + `<td style="${tdn}">${secs(u.waitAvg || 0)}</td>`
        + `<td style="${tdn}">${u.rejected || 0}</td>`
        + `<td style="${td}"><div style="height:6px;width:90px;background:var(--df-chip,#f3f4f6);border-radius:4px;overflow:hidden"><div style="height:100%;width:${pct}%;background:${color}"></div></div></td></tr>`;
    }
    html += '</tbody></table>';
    usersBody.innerHTML = html;
  }

  // ── 数据 ───────────────────────────────────────────────────
  async function refresh() {
    if (!open) return;
    try {
      const [st, hist, homeLive] = await Promise.all([
        fetch('/df/queue/stats', { cache: 'no-store' }).then((r) => r.json()),
        fetch(`/df/queue/history?window=${range.ms}`, { cache: 'no-store' }).then((r) => r.json()),
        // 2026-10-18：上游并发改用 GPT-Load 实时值。原 /queue/stats 里的 upstreamInFlight 来自
        // UP_CONC（每 30s 才同步一次、且最多容忍 90s 陈旧），一波峰值后数字会挂在高位不动，
        // 看起来「上游确认总是很多」。这里直接读 /api/home（同源、管理员会话），3s 刷新一次。
        fetch('/api/home', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);
      const liveC = Number(homeLive?.data?.concurrency?.current);
      if (Number.isFinite(liveC)) {
        st.upstreamInFlight = liveC;
        st.upstreamSrc = 'home-live';
        st.upstreamConcAt = Date.now();
      }
      last = { st, hist };
      renderKpi(st);
      renderUsers(st);
      render(hist);
      foot.textContent = [
        `已服务 ${st.served} 次`,
        `排过队 ${st.queuedTotal} 次`,
        `队列满拒绝 ${st.rejectedFull}`,
        `等待超时 ${st.rejectedTimeout}`,
        `上游错误 ${st.upstreamErrors}`,
        `最久在飞 ${st.active?.[0]?.ageSec ?? 0}s`,
        `采样 ${hist.samples} 点`,
        `参数 上限 ${st.cap} · 队列 ${st.queueMax} · 最长等 ${Math.round(st.maxWaitMs / 1000)}s`,
      ].join('　·　');
    } catch (err) {
      foot.textContent = `排队网关取数失败：${err?.message ?? err}`;
    }
  }

  // ── 开关 ───────────────────────────────────────────────────
  function applyTheme() {
    const t = themeVars();
    page.style.setProperty('--df-bg', t.bg);
    page.style.setProperty('--df-fg', t.fg);
    page.style.setProperty('--df-card', t.card);
    page.style.setProperty('--df-bd', t.bd);
    page.style.setProperty('--df-mut', t.mut);
    page.style.setProperty('--df-chip', t.chip);
    page.style.setProperty('--df-on', t.on);
  }

  function togglePage(force) {
    open = force === undefined ? !open : force;
    page.style.display = open ? 'block' : 'none';
    pill.style.display = open ? 'none' : (navBtn() ? 'none' : 'flex');
    markNav(open);
    if (open) {
      applyTheme();
      layout();
      paintTabs();
      refresh();
      timer = setInterval(refresh, 3000);
    } else if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  // ── 侧边栏入口 ─────────────────────────────────────────────
  let navNode = null;
  const navBtn = () => document.querySelector('[data-df-nav="concurrency"]');
  const navBtnSettings = () => document.querySelector('[data-df-nav="gwsettings"]');

  function markNav(on) {
    const b = navBtn();
    if (!b) return;
    b.style.background = on ? 'var(--df-nav-on, rgba(255,79,31,.12))' : '';
    b.style.color = on ? C.line : '';
  }
  function markNavSettings(on) {
    const b = navBtnSettings();
    if (!b) return;
    b.style.background = on ? 'var(--df-nav-on, rgba(255,79,31,.12))' : '';
    b.style.color = on ? C.line : '';
  }

  function mountNav() {
    const nav = document.querySelector('.modern-sidebar-navigation');
    if (!nav || nav.querySelector('[data-df-nav="concurrency"]')) return;
    const b = el('button', 'display:flex;align-items:center;gap:10px;width:100%;border:none;background:transparent;cursor:pointer;font:inherit;font-size:inherit;text-align:left;padding:9px 12px;border-radius:10px;color:inherit;margin-top:2px');
    b.type = 'button';
    b.setAttribute('data-df-nav', 'concurrency');
    b.setAttribute('data-df-shell', '1');
    b.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 20h18"/><path d="M6 20V10"/><path d="M12 20V4"/><path d="M18 20v-7"/></svg><span>实时并发</span>';
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); togglePage(true); });
    b.addEventListener('mouseenter', () => { if (!open) b.style.background = 'rgba(127,127,127,.12)'; });
    b.addEventListener('mouseleave', () => { if (!open) b.style.background = ''; });
    nav.append(b);
    // 第二项：网关设置
    if (!nav.querySelector('[data-df-nav="gwsettings"]')) {
      const b2 = el('button', 'display:flex;align-items:center;gap:10px;width:100%;border:none;background:transparent;cursor:pointer;font:inherit;font-size:inherit;text-align:left;padding:9px 12px;border-radius:10px;color:inherit;margin-top:2px');
      b2.type = 'button';
      b2.setAttribute('data-df-nav', 'gwsettings');
      b2.setAttribute('data-df-shell', '1');
      b2.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.09a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.09a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg><span>网关设置</span>';
      b2.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openSettings(true); });
      b2.addEventListener('mouseenter', () => { if (!settingsOpen) b2.style.background = 'rgba(127,127,127,.12)'; });
      b2.addEventListener('mouseleave', () => { if (!settingsOpen) b2.style.background = ''; });
      nav.append(b2);
    }
    if (navNode !== nav) {
      navNode = nav;
      // 点其它导航项就收起来
      nav.addEventListener('click', (e) => {
        const t = e.target.closest?.('a[href]');
        if (t && !t.hasAttribute('data-df-nav') && open) togglePage(false);
      }, true);
    }
  }

  // ── 网关设置页 ─────────────────────────────────────────────
  let settingsOpen = false;
  let settingsTimer = null;

  const spage = el('div', 'position:fixed;z-index:2147482000;display:none;overflow:auto;background:var(--df-bg,#fff);color:var(--df-fg,#111)');
  spage.setAttribute('data-df-shell', '1');
  spage.setAttribute('data-df-page', '1');
  const swrap = el('div', 'padding:22px 26px 28px;max-width:1100px');
  const shead = el('div', 'display:flex;align-items:center;gap:14px;margin-bottom:16px');
  const stitles = el('div', 'display:flex;flex-direction:column;gap:3px');
  stitles.append(
    el('div', 'font-size:17px;font-weight:700', '网关设置'),
    el('div', 'font-size:10.5px;color:var(--df-mut,#6b7280)', '排队参数 · 注册开关 · 邀请码管理'),
  );
  const sSpacer = el('div', 'flex:1');
  const sClose = el('button', 'border:none;background:transparent;cursor:pointer;font:inherit;font-size:11px;color:var(--df-mut,#6b7280);padding:6px 10px;border-radius:8px', '✕ 关闭');
  shead.append(stitles, sSpacer, sClose);
  swrap.append(shead);
  spage.append(swrap);
  document.body.append(spage);

  const sMsg = el('div', 'font-size:10.5px;color:#16a34a;min-height:16px;margin-bottom:8px');
  const sGrid = el('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;margin-bottom:20px');
  sGrid.append(
    sField('出口并发（总 CAP）', '全局同时打到上游的请求数', 'df-cap', '10'),
    sField('每人排队上限', '单密钥最多排多少个', 'df-uq', '20'),
    sField('释放宽限 ms', '防临界429，一般 0~300', 'df-grace', '150'),
    sField('最长排队 ms', '超过就拒绝', 'df-wait', '180000'),
    sCheck('开放注册（登录页显示注册）', 'df-reg', true),
    sField('注册密钥并发上限', '新用户自动建的密钥并发数', 'df-ucap', '5'),
    // 能量槽口径（2026-10-18 加，可在页面直接调，不用改代码）
    sField('入口刻度（虚拟并发上限）', '填 0=自动跟随 GPT-Load 上 access key 的并发上限；填数字则手动固定刻度', 'df-vcapref', '0'),
    sField('首字节超时告警阈值', '近 60 秒首字节超时次数 ≥ 该值，能量槽变琥珀并提示（o−c 是流式传输中，不算卡单）', 'df-stuck', '2'),
  );
  swrap.append(sMsg, sGrid);

  // ── 容灾池 ────────────────────────────────────────────────
  const poolHead = el('div', 'display:flex;align-items:center;gap:12px;margin-bottom:8px');
  poolHead.append(el('div', 'font-size:13px;font-weight:700', '容灾池（模型自动切换）'));
  const poolHint = el('div', 'font-size:10px;color:var(--df-mut,#9ca3af)', '上游故障时按此顺序自动换模型重试；每行一个，排第一的是默认首选');
  const poolBox = el('div', 'background:var(--df-card,#fff);border:1px solid var(--df-bd,#e5e7eb);border-radius:14px;padding:12px 14px;margin-bottom:12px');
  const poolTa = el('textarea', 'width:100%;min-height:132px;border:1px solid var(--df-bd,#e5e7eb);border-radius:8px;padding:9px 11px;font:inherit;font-size:11px;line-height:1.7;background:var(--df-bg,#fff);color:var(--df-fg,#111);resize:vertical');
  poolTa.id = 'df-pool';
  const poolSave = el('button', 'border:none;cursor:pointer;font:inherit;font-size:10.5px;font-weight:600;color:#fff;background:#374151;border-radius:8px;padding:8px 18px;margin-top:8px', '保存容灾池');
  const poolStat = el('div', 'font-size:10.5px;color:var(--df-mut,#6b7280);margin-top:8px', '');
  poolBox.append(poolHint, poolTa, poolSave, poolStat);
  swrap.append(poolHead, poolBox);

  function renderPoolStat(j) {
    const br = j.breaker || [];
    const live = br.length
      ? br.map((b) => `${b.model} 熔断 ${b.secsLeft}s`).join('、')
      : '无模型熔断（全部正常）';
    poolStat.innerHTML = `累计自动切换 <b>${j.poolSwaps || 0}</b> 次 · ${live}`;
    if (br.length) poolStat.style.color = '#dc2626';
    else poolStat.style.color = 'var(--df-mut,#6b7280)';
  }

  // ── 渠道健康监控 ──────────────────────────────────────────
  const prHead = el('div', 'font-size:13px;font-weight:700;margin-bottom:8px', '渠道健康监控');
  const prBox = el('div', 'background:var(--df-card,#fff);border:1px solid var(--df-bd,#e5e7eb);border-radius:14px;padding:12px 14px;margin-bottom:12px');
  const prStat = el('div', 'font-size:10.5px;line-height:1.8;color:var(--df-mut,#6b7280)', '加载中…');
  const prRow = el('div', 'display:flex;gap:10px;align-items:flex-end;margin-top:10px;flex-wrap:wrap');
  const prInterval = sField('探测间隔（秒）', '每多久主动测一轮所有模型', 'df-probe-int', 60);
  const prDisable = sField('失败禁用时长（秒）', '连续失败 2 次后禁用多久', 'df-probe-dis', 300);
  prInterval.style.flex = '1'; prDisable.style.flex = '1';
  prInterval.style.minWidth = '160px'; prDisable.style.minWidth = '160px';
  const prSave = el('button', 'border:none;cursor:pointer;font:inherit;font-size:10.5px;font-weight:600;color:#fff;background:#374151;border-radius:8px;padding:8px 18px', '保存监控设置');
  prRow.append(prInterval, prDisable, prSave);
  prBox.append(prStat, prRow);
  swrap.append(prHead, prBox);

  function renderProbe(j) {
    const p = j.probe;
    if (!p || !p.lastRun) { prStat.textContent = '监控尚未运行（网关刚启动）'; return; }
    const ago = Math.round((Date.now() - p.lastRun) / 1000);
    const up = p.upstream;
    const upTxt = !up ? '未探测'
      : `<span style="color:${up.ok ? '#16a34a' : '#dc2626'};font-weight:600">${up.ok ? '正常' : '异常'}</span> <span style="color:#9ca3af">(${up.code} · ${up.ms}ms)</span>`;
    let rows = '';
    for (const [m, v] of Object.entries(p.models || {})) {
      const name = m.replace('cn:', '');
      const badge = v.ok === null ? '<span style="color:#9ca3af">待测</span>'
        : v.ok ? `<span style="color:#16a34a;font-weight:600">✓ ${v.ms}ms</span>`
        : `<span style="color:#dc2626;font-weight:600">✗ ${v.code}</span>`;
      const dis = v.disabled ? ' <span style="color:#dc2626;font-size:10px">已禁用</span>' : '';
      const agoM = v.t ? Math.round((Date.now() - v.t) / 1000) : '-';
      rows += `<tr><td style="padding:4px 8px 4px 0">${name}${dis}</td><td style="text-align:right">${badge}</td><td style="text-align:right;color:#9ca3af;font-size:10px">${agoM}s 前</td></tr>`;
    }
    prStat.innerHTML =
      `GPT-Load 本体（3101）：${upTxt} · 上轮探测 <b>${ago}s 前</b>（${p.probed} 个模型）<br>` +
      `<table style="width:100%;border-collapse:collapse;font-size:10.5px;margin-top:4px"><tr style="color:#9ca3af;font-size:10px"><th style="text-align:left;padding:2px 0">模型</th><th style="text-align:right;padding:2px 0">结果</th><th style="text-align:right;padding:2px 0">探测时间</th></tr>${rows}</table>`;
  }
  prSave.addEventListener('click', async () => {
    prSave.textContent = '保存中…';
    try {
      const r = await fetch('/df/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ probeIntervalSec: Number(gv('df-probe-int')) || 60, probeDisableSec: Number(gv('df-probe-dis')) || 300 }) });
      const j = await r.json();
      prSave.textContent = j.ok ? '已保存 ✓' : '保存失败';
      setTimeout(() => { prSave.textContent = '保存监控设置'; }, 2000);
    } catch { prSave.textContent = '保存失败'; setTimeout(() => { prSave.textContent = '保存监控设置'; }, 2000); }
  });

  function sField(label, hint, id, value, type) {
    const box = el('div', 'background:var(--df-card,#fff);border:1px solid var(--df-bd,#e5e7eb);border-radius:14px;padding:12px 14px');
    const lab = el('div', 'font-size:10.5px;color:var(--df-mut,#6b7280);margin-bottom:6px', label);
    const inp = el('input', 'width:100%;border:1px solid var(--df-bd,#e5e7eb);border-radius:8px;padding:8px 10px;font:inherit;font-size:12px;background:var(--df-bg,#fff);color:var(--df-fg,#111)');
    inp.id = id; inp.type = type || 'number'; inp.value = value;
    box.append(lab, inp);
    if (hint) box.append(el('div', 'font-size:10px;color:var(--df-mut,#9ca3af);margin-top:5px', hint));
    return box;
  }
  function sCheck(label, id, checked) {
    const box = el('div', 'background:var(--df-card,#fff);border:1px solid var(--df-bd,#e5e7eb);border-radius:14px;padding:12px 14px;display:flex;align-items:center;gap:10px');
    const inp = el('input', ''); inp.id = id; inp.type = 'checkbox'; inp.checked = checked; inp.style.width = '17px'; inp.style.height = '17px'; inp.style.accentColor = '#FF6A2B';
    box.append(inp, el('div', 'font-size:11px;font-weight:600', label));
    return box;
  }
  const sSave = el('button', 'border:none;cursor:pointer;font:inherit;font-size:11px;font-weight:600;color:#fff;background:linear-gradient(135deg,#FF4F1F,#FF9A3C);border-radius:10px;padding:9px 26px;margin-bottom:22px', '保存设置');
  swrap.append(sSave);

  // 邀请码区
  const invHead = el('div', 'display:flex;align-items:center;gap:12px;margin-bottom:10px');
  invHead.append(el('div', 'font-size:13px;font-weight:700', '邀请码'));
  const invNewUses = el('input', 'border:1px solid var(--df-bd,#e5e7eb);border-radius:8px;padding:6px 9px;font:inherit;font-size:11px;width:70px;background:var(--df-bg,#fff);color:var(--df-fg,#111)');
  invNewUses.type = 'number'; invNewUses.value = '5'; invNewUses.min = '1'; invNewUses.max = '100'; invNewUses.title = '可注册次数';
  const invNewBtn = el('button', 'border:none;cursor:pointer;font:inherit;font-size:10.5px;font-weight:600;color:#fff;background:#374151;border-radius:8px;padding:7px 14px', '+ 生成邀请码');
  const invHint = el('div', 'font-size:10px;color:var(--df-mut,#9ca3af)', '次数 = 这张码能给多少人注册');
  invHead.append(el('span', 'font-size:10.5px;color:var(--df-mut,#6b7280)', '次数'), invNewUses, invNewBtn, invHint);
  swrap.append(invHead);
  const invTable = el('div', 'background:var(--df-card,#fff);border:1px solid var(--df-bd,#e5e7eb);border-radius:14px;padding:12px 14px;margin-bottom:20px;font-size:11px');
  swrap.append(invTable);

  // 用户区
  swrap.append(el('div', 'font-size:13px;font-weight:700;margin-bottom:10px', '已注册用户'));
  const usrTable = el('div', 'background:var(--df-card,#fff);border:1px solid var(--df-bd,#e5e7eb);border-radius:14px;padding:12px 14px;font-size:11px');
  swrap.append(usrTable);

  sClose.addEventListener('click', () => openSettings(false));
  sSave.addEventListener('click', async () => {
    sMsg.style.color = '#6b7280'; sMsg.textContent = '保存中…';
    const body = {
      cap: Number(gv('df-cap')), userQueueMax: Number(gv('df-uq')), graceMs: Number(gv('df-grace')),
      maxWaitMs: Number(gv('df-wait')), registerEnabled: document.getElementById('df-reg').checked,
      defaultUserCap: Number(gv('df-ucap')),
      virtualCapRef: Number(gv('df-vcapref')), stuckWarn: Number(gv('df-stuck')),
    };
    try {
      const r = await fetch('/df/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      sMsg.style.color = j.ok ? '#16a34a' : '#dc2626';
      sMsg.textContent = j.ok ? '已保存并生效 ✓' : (j.error || '保存失败');
    } catch (e) { sMsg.style.color = '#dc2626'; sMsg.textContent = '保存失败：' + e; }
  });
  function gv(id) { return document.getElementById(id)?.value ?? '0'; }

  poolSave.addEventListener('click', async () => {
    const list = String(poolTa.value || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    if (!list.length) { poolStat.style.color = '#dc2626'; poolStat.textContent = '池不能为空'; return; }
    poolStat.style.color = '#6b7280'; poolStat.textContent = '保存中…';
    try {
      const r = await fetch('/df/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fallbackPool: list }) });
      const j = await r.json();
      if (j.ok) { poolStat.style.color = '#16a34a'; poolStat.textContent = `已保存 ${list.length} 个模型的容灾顺序 ✓`; }
      else { poolStat.style.color = '#dc2626'; poolStat.textContent = j.error || '保存失败'; }
    } catch (e) { poolStat.style.color = '#dc2626'; poolStat.textContent = '保存失败：' + e; }
  });

  invNewBtn.addEventListener('click', async () => {
    try {
      const r = await fetch('/df/invites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ max_uses: Number(invNewUses.value) || 1, note: '' }) });
      const j = await r.json();
      if (j.ok) { sMsg.style.color = '#16a34a'; sMsg.textContent = '已生成：' + j.invite.code; loadSettingsPage(); }
    } catch (e) { sMsg.textContent = '生成失败：' + e; }
  });

  function renderInvites(list) {
    if (!list?.length) { invTable.innerHTML = '<span style="color:#9ca3af">还没有邀请码</span>'; return; }
    const now = Date.now();
    invTable.innerHTML = '<table style="width:100%;border-collapse:collapse"><tr style="color:#6b7280;font-size:10.5px"><th style="text-align:left;padding:4px">邀请码</th><th>已用/总量</th><th>备注</th><th>创建</th><th></th></tr>' +
      list.map(i => `<tr><td style="padding:5px 4px"><b style="user-select:all">${i.code}</b></td><td style="text-align:center">${i.used}/${i.max_uses}${i.used >= i.max_uses ? ' <span style="color:#dc2626">已满</span>' : ''}</td><td style="color:#6b7280">${i.note || '-'}</td><td style="color:#9ca3af;font-size:10.5px">${new Date(i.created_at).toLocaleString()}</td><td><button data-del="${i.code}" style="border:none;background:transparent;color:#dc2626;cursor:pointer;font:inherit;font-size:10.5px">删除</button></td></tr>`).join('') + '</table>';
    for (const b of invTable.querySelectorAll('[data-del]')) {
      b.addEventListener('click', async () => {
        await fetch('/df/invites?code=' + encodeURIComponent(b.dataset.del), { method: 'DELETE' });
        loadSettingsPage();
      });
    }
  }
  function renderUsers(list) {
    if (!list?.length) { usrTable.innerHTML = '<span style="color:#9ca3af">还没有注册用户</span>'; return; }
    usrTable.innerHTML = '<table style="width:100%;border-collapse:collapse"><tr style="color:#6b7280;font-size:10.5px"><th style="text-align:left;padding:4px">用户名</th><th>密钥</th><th>邀请码</th><th>注册时间</th><th>状态</th><th>操作</th></tr>' +
      list.map(u => `<tr><td style="padding:5px 4px"><b>${u.username}</b></td><td style="user-select:all">${u.key_masked || '-'}</td><td style="color:#6b7280">${u.invited_by || '-'}</td><td style="color:#9ca3af;font-size:10.5px">${new Date(u.created_at).toLocaleString()}</td><td>${u.disabled ? '<span style="color:#dc2626">已禁用</span>' : '<span style="color:#16a34a">正常</span>'}</td><td style="white-space:nowrap">
      <button data-act="reset-password" data-u="${u.username}" style="border:none;background:transparent;color:#2563eb;cursor:pointer;font:inherit;font-size:10.5px">重置密码</button>
      <button data-act="${u.disabled ? 'enable' : 'disable'}" data-u="${u.username}" style="border:none;background:transparent;color:${u.disabled ? '#16a34a' : '#dc2626'};cursor:pointer;font:inherit;font-size:10.5px">${u.disabled ? '启用' : '禁用'}</button>
      </td></tr>`).join('') + '</table><div id="df-user-msg" style="font-size:10.5px;margin-top:8px;min-height:14px"></div>';
    for (const b of usrTable.querySelectorAll('[data-act]')) {
      b.addEventListener('click', async () => {
        const msg = document.getElementById('df-user-msg');
        msg.style.color = '#6b7280'; msg.textContent = '处理中…';
        try {
          const r = await fetch('/df/users/manage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: b.dataset.act, username: b.dataset.u }) });
          const j = await r.json();
          if (j.ok && j.password) {
            msg.style.color = '#16a34a';
            msg.innerHTML = `新密码：<b style="user-select:all">${j.password}</b>（只显示这一次，请立即发给用户）`;
            b.style.display = 'none';
          } else if (j.ok) { msg.style.color = '#16a34a'; msg.textContent = '已执行 ✓'; loadSettingsPage(); }
          else { msg.style.color = '#dc2626'; msg.textContent = j.error || '失败'; }
        } catch (e) { msg.style.color = '#dc2626'; msg.textContent = '失败：' + e; }
      });
    }
  }

  async function loadSettingsPage() {
    try {
      const [sr, ir] = await Promise.all([fetch('/df/settings'), fetch('/df/invites')]);
      const sj = await sr.json(); const ij = await ir.json();
      if (!sj.ok) { spage.style.display = 'none'; return; }
      const s = sj.settings;
      document.getElementById('df-cap').value = s.cap;
      document.getElementById('df-uq').value = s.userQueueMax;
      document.getElementById('df-grace').value = s.graceMs;
      document.getElementById('df-wait').value = s.maxWaitMs;
      document.getElementById('df-reg').checked = !!s.registerEnabled;
      document.getElementById('df-ucap').value = s.defaultUserCap;
      if (Array.isArray(s.fallbackPool) && s.fallbackPool.length) poolTa.value = s.fallbackPool.join('\n');
      const pi = document.getElementById('df-probe-int'); if (pi) pi.value = s.probeIntervalSec ?? 60;
      const pd = document.getElementById('df-probe-dis'); if (pd) pd.value = s.probeDisableSec ?? 300;
      const vc = document.getElementById('df-vcapref'); if (vc) vc.value = s.virtualCapRef ?? 100;
      const sk = document.getElementById('df-stuck'); if (sk) sk.value = s.stuckWarn ?? 2;
      renderInvites(ij.invites); renderUsers(ij.users);
      // 容灾池实时状态来自 queue/stats
      try {
        const qs = await (await fetch('/queue/stats')).json();
        renderPoolStat(qs);
        renderProbe(qs);
      } catch {}
    } catch (e) { sMsg.textContent = '加载失败：' + e; }
  }

  function layoutSettings() {
    const main = document.querySelector('.modern-main-column') || document.querySelector('.modern-content');
    if (!main) { spage.style.left = '0'; spage.style.top = '0'; spage.style.width = '100vw'; spage.style.height = '100vh'; return; }
    const r = main.getBoundingClientRect();
    if (r.width < 200 || r.height < 100) return;
    spage.style.left = `${r.left}px`;
    spage.style.top = `${r.top}px`;
    spage.style.width = `${r.width}px`;
    spage.style.height = `${r.height}px`;
  }

  async function openSettings(on) {
    settingsOpen = on;
    spage.style.display = on ? 'block' : 'none';
    markNavSettings(on);
    if (on) {
      if (open) togglePage(false);
      layoutSettings();
      await loadSettingsPage();
      clearInterval(settingsTimer);
      settingsTimer = setInterval(loadSettingsPage, 10000);
    } else clearInterval(settingsTimer);
  }

  // ── 启动 ───────────────────────────────────────────────────
  function tick() {
    applyBrand();
    mountNav();
    if (open) layout();
    if (settingsOpen) layoutSettings();
    if (!navBtn()) pill.style.display = open ? 'none' : 'flex';
    // 悬浮设置入口：只在没有任何设置页可见入口时显示（侧边栏没注入成功时兜底）
    pillSet.style.display = (navBtnSettings() || settingsOpen) ? 'none' : 'flex';
  }

  const boot = () => {
    if (!document.body) return setTimeout(boot, 50);
    applyBrand();
    tick();
    new MutationObserver(() => {
      if (tick._s) return;
      tick._s = true;
      requestAnimationFrame(() => { tick._s = false; tick(); });
    }).observe(document.body, { childList: true, subtree: true });
    setInterval(brandTitle, 2000);
    addEventListener('resize', () => { if (open) layout(); if (settingsOpen) layoutSettings(); });
    addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (open) togglePage(false); if (settingsOpen) openSettings(false); } });
    // 路由变化自动收起自建页面（避免挡住 SPA 的跳转后内容和点击）
    const closeAll = () => { if (open) togglePage(false); if (settingsOpen) openSettings(false); };
    addEventListener('popstate', closeAll);
    addEventListener('hashchange', () => { if (!/#concurrency/.test(location.hash)) closeAll(); });
    // 点击主内容区的链接（SPA 内部跳转）也收起
    document.addEventListener('click', (e) => {
      if (!open && !settingsOpen) return;
      const a = e.target.closest?.('a[href]');
      if (a && !a.closest('[data-df-shell]')) closeAll();
    }, true);
    // 深链接：#concurrency / ?df=chart（hash 可能被路由器改掉，前 6 秒反复确认）
    const wantDeep = () => location.hash === '#concurrency' || /[?&]df=chart/.test(location.search);
    let deepTries = 0;
    const deepTimer = setInterval(() => {
      deepTries++;
      if (wantDeep() && !open) togglePage(true);
      if (deepTries > 20 || open) clearInterval(deepTimer);
    }, 300);
    addEventListener('hashchange', () => { if (wantDeep() && !open) togglePage(true); });
  };
  boot();
})();
