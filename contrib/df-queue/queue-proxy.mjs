// 东方API 三合一网关（单端口 3001）
//
//   /v1/*、其他 POST      → 排队转发到 GPT-Load（127.0.0.1:3101），出口并发 = CAP
//   /api/*                → 仅管理员会话可用（GPT-Load 管理接口，反代）
//   /（网页）             → 无会话=登录页；管理员=东方API管理台（品牌壳）；用户=用户门户
//   /df/*                 → 本网关自己的静态文件/登录/门户数据
//
// 会话：cookie df_sess（HMAC 签名，HttpOnly）。管理员用 AUTH_KEY 登录，
// 用户用 sk-gl-xxx 访问密钥登录（经 /v1/models 向上游验真）。
//
// 环境变量（都有默认值）：
//   DF_QUEUE_CAP=10 DF_QUEUE_MAX=500 DF_QUEUE_MAXWAIT_MS=180000
//   DF_LISTEN_PORT=3001 DF_UPSTREAM_PORT=3101
//   DF_USER_CAP=5 DF_USER_QUEUE_MAX=20 DF_USER_GRACE_MS=150

import http from 'node:http';
import { URL } from 'node:url';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as accounts from './accounts.mjs';
import * as mailer from './mailer.mjs';
import { appendFile as _af, writeFile as _wf } from 'node:fs/promises';


const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const WEB = 'C:\\AI\\GPTLoad\\df-dashboard\\web';   // 复用东方API壳的静态资源
const ENV_FILE = 'C:\\AI\\GPTLoad\\.env';
const SAMPLE_MS = 5000;
const KEEP_DAYS = 7;
const SESSION_TTL_MS = 7 * 86400_000;

const CAP = Number(process.env.DF_QUEUE_CAP ?? 10);
const DEFAULT_USER_CAP = Number(process.env.DF_USER_CAP ?? 5);
const USER_QUEUE_MAX = Number(process.env.DF_USER_QUEUE_MAX ?? 20);
const USER_GRACE_MS = Number(process.env.DF_USER_GRACE_MS ?? 150);
const MAX_QUEUE = Number(process.env.DF_QUEUE_MAX ?? 500);
const MAX_WAIT_MS = Number(process.env.DF_QUEUE_MAXWAIT_MS ?? 180_000);
const LISTEN_PORT = Number(process.env.DF_LISTEN_PORT ?? 3001);
const UP_PORT = Number(process.env.DF_UPSTREAM_PORT ?? 3101);
const UP_HOST = '127.0.0.1';

const LOG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'gateway.log');
const log = (...a) => {
  const line = new Date().toISOString() + ' ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(line);
  appendFile(LOG_FILE, line + '\n', 'utf8').catch(() => {});
};

// ── 可变网关设置（持久化 data/settings.json，改后即刻生效）────
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const settings = {
  cap: CAP,                    // 出口并发
  userQueueMax: USER_QUEUE_MAX, // 每人排队上限
  graceMs: USER_GRACE_MS,      // 释放宽限
  maxWaitMs: MAX_WAIT_MS,      // 单请求最长排队
  registerEnabled: true,       // 开放注册
  defaultUserCap: DEFAULT_USER_CAP, // 注册自动建的密钥并发上限
  fallbackPool: null,          // 降级池（null = 用 DEFAULT_POOL）；数组，按序尝试
  probeIntervalSec: 60,        // 渠道健康监控探测间隔
  probeDisableSec: 300,        // 探测连续失败 2 次后的禁用时长
  virtualCapRef: 0,            // 面板「入口接收」能量槽手动刻度；0 = 自动跟随 GPT-Load 上 access key 的并发上限（不写死）
  stuckWarn: 2,                // 面板「卡单」告警阈值（在飞 - 上游确认 ≥ 该值即变琥珀）
};
async function loadSettings() {
  try {
    Object.assign(settings, JSON.parse(await readFile(SETTINGS_FILE, 'utf8')));
  } catch (e) {
    // 2026-10-18：读不到/读半截时必须留痕。以前这里静默 catch，导致启动瞬间撞上
    // saveSettings 的「截断后写入」，配置整体回落到默认值且无人知道（cap 20 变 10 的成因）。
    log(`warn: settings.json 读取失败，使用默认值（${e?.message ?? e}）`);
  }
}
async function saveSettings() {
  // 原子写：先写 .tmp 再 rename，避免重启瞬间读到半截文件 → 静默回落默认值
  const tmp = `${SETTINGS_FILE}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8');
    await rename(tmp, SETTINGS_FILE);
  } catch (e) {
    log(`warn: settings.json 保存失败（${e?.message ?? e}）`);
  }
}
function applySettings() {
  st.cap = settings.cap;
  agent.maxSockets = settings.cap;      // 出口连接上限跟随配置（原来钉死常量 CAP=10）
  agent.maxFreeSockets = settings.cap;  // 空闲连接池同步跟随，避免复用超限
  MAX_QUEUE_REF.maxQueue = Math.max(50, settings.userQueueMax * 25);
  MAX_WAIT_REF.maxWaitMs = settings.maxWaitMs;
  PROBE_INTERVAL_MS_REF.ms = Math.max(30, settings.probeIntervalSec || 60) * 1000;
  PROBE_DISABLE_MS_REF.ms = Math.max(60, settings.probeDisableSec || 300) * 1000;
}
// 引用容器：让旧常量的读取点改走可变值
const MAX_QUEUE_REF = { maxQueue: MAX_QUEUE };
const MAX_WAIT_REF = { maxWaitMs: MAX_WAIT_MS };


// 2026-10-18 运维修正：原 keepAlive:true + timeout:0 会复用「半死」长连接——
// 请求写进已被对端静默关闭的 socket 后既无响应也无错误，出口名额被焊死。
// 证据：10-17 全天 6 段共约 60 分钟出现「3001 在飞≥5 而 gpt-load 并发=0」（最长 29 分钟）。
// loopback 建连接成本可忽略，改为 keepAlive:false 彻底消除该故障类。
// maxSockets 不再钉死＝CAP：出口并发由 settings.cap（页面可改）控制；
// 钉死常量会导致「配置改成 20，实际仍只能跑 10」。留默认不限，由队列层限流。
// 2026-10-18 Chief 裁定修正：keepAlive 必须保持 true（false 会让每条请求重建 TCP/TLS，
// 握手开销压在出口延迟上、反而放大 524）；正确修法是在 applySettings() 里把
// agent.maxSockets / maxFreeSockets 同步成 settings.cap，而不是关掉复用。
// 半死 socket 那一类故障由 timeout:30s（空闲超时回收）兜底，而非 keepAlive:false。
const agent = new http.Agent({ keepAlive: true, maxSockets: CAP, maxFreeSockets: CAP, timeout: 30_000 });

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'cookie']);

function cleanHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) if (!HOP.has(k.toLowerCase())) out[k] = v;
  out.host = `${UP_HOST}:${UP_PORT}`;
  return out;
}

// ── AUTH_KEY ──────────────────────────────────────────────────
let AUTH_KEY = '';
async function loadAuthKey() {
  const raw = await readFile(ENV_FILE, 'utf8').catch(() => '');
  const m = /^\s*AUTH_KEY\s*=\s*(.+?)\s*$/m.exec(raw);
  AUTH_KEY = m ? m[1].replace(/^["']|["']$/g, '') : '';
}
function isAdminToken(token) {
  if (!AUTH_KEY || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(AUTH_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── 排队层状态 ────────────────────────────────────────────────
const st = {
  startedAt: Date.now(),
  inFlight: 0, served: 0, queuedTotal: 0,
  rejectedFull: 0, rejectedTimeout: 0, abortedWhileQueued: 0, upstreamErrors: 0,
  waitSamples: [],
  cap: CAP, maxQueue: MAX_QUEUE, maxWaitMs: MAX_WAIT_MS,
};

// 活动请求集合：在飞数直接由集合大小得出，避免计数器增减不配对导致漂移
const ACTIVE = new Map();   // jobId -> startedAt
let jobSeq = 0;
const UP_CONC = { current: 0, at: 0 };   // GPT-Load 上报的实际上游在飞

function activeAdd(tag) { const id = ++jobSeq; const now = Date.now(); ACTIVE.set(id, { startedAt: now, lastByteAt: now, tag }); return id; }
function activeDel(id) { ACTIVE.delete(id); }
function inFlightCount() { return ACTIVE.size; }
// 自愈：超过 30 分钟仍未结束的活动请求视为漏减，强制回收并记日志
function sweepStaleActive(maxMs = 30 * 60_000) {
  const now = Date.now();
  for (const [id, v] of ACTIVE) {
    if (now - v.startedAt > maxMs) {
      ACTIVE.delete(id);
      log(`stale in-flight cleanup: ${v.tag || 'req'} 挂了 ${Math.round((now - v.startedAt) / 1000)}s，已回收名额`);
    }
  }
}

function recordWait(ms) {
  st.waitSamples.push(ms);
  if (st.waitSamples.length > 1000) st.waitSamples.shift();
}

function waitStats() {
  if (!st.waitSamples.length) return { avg: 0, p50: 0, p95: 0, max: 0 };
  const a = [...st.waitSamples].sort((x, y) => x - y);
  const pick = (p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
  return {
    avg: Math.round(a.reduce((s, v) => s + v, 0) / a.length),
    p50: pick(0.5), p95: pick(0.95), max: a[a.length - 1],
  };
}

// ── 采样历史（5s 点：t,inFlight,queued,waitAvg,p95,upstreamConcurrency）──
const history = [];
const dayFile = (d = new Date()) => path.join(DATA, `queue-${d.toISOString().slice(0, 10)}.jsonl`);

async function loadHistory() {
  await mkdir(DATA, { recursive: true });
  const since = Date.now() - KEEP_DAYS * 86400_000;
  const files = (await readdir(DATA).catch(() => []))
    .filter((f) => /^queue-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  for (const f of files) {
    const full = path.join(DATA, f);
    const s = await stat(full).catch(() => null);
    if (s && s.mtimeMs < since) { await unlink(full).catch(() => {}); continue; }
    const txt = await readFile(full, 'utf8').catch(() => '');
    for (const line of txt.split('\n')) {
      if (!line) continue;
      const p = line.split(',').map(Number);
      if (!Number.isFinite(p[0]) || p[0] < since) continue;
      history.push({ t: p[0], o: p[1] || 0, q: p[2] || 0, w: p[3] || 0, p: p[4] || 0, c: p[5] || 0 });
    }
  }
  history.sort((a, b) => a.t - b.t);
  log(`history loaded: ${history.length} points`);
}

const dispatchTimes = [];
let throughput1m = 0;
let upConc = 0;        // GPT-Load 自报的全局并发
let upLimit = 0;
let upstreamOk = false;

function upGet(pathname, key) {
  return new Promise((resolve) => {
    const req = http.request({
      host: UP_HOST, port: UP_PORT, path: pathname, method: 'GET', timeout: 10_000,
      headers: { authorization: `Bearer ${key}`, accept: 'application/json', 'accept-encoding': 'identity' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch { resolve({ status: res.statusCode ?? 0, json: null }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.end();
  });
}

async function sampleSelf() {
  const now = Date.now();
  throughput1m = dispatchTimes.length;
  while (dispatchTimes.length && now - dispatchTimes[0] > 60_000) dispatchTimes.shift();
  const w = waitStats();
  const home = AUTH_KEY ? await upGet('/api/home', AUTH_KEY) : { status: 0, json: null };
  upstreamOk = home.status === 200 && home.json?.code === 0;
  if (upstreamOk) {
    upConc = Number(home.json?.data?.concurrency?.current ?? 0);
    upLimit = Number(home.json?.data?.concurrency?.limit ?? 0);
  }
  const point = { t: now, o: inFlightCount(), q: queuedTotal(), w: w.avg, p: w.p95, c: upConc };
  const prev = history[history.length - 1];
  if (prev && now - prev.t < SAMPLE_MS / 2) Object.assign(prev, point);
  else history.push(point);
  appendFile(dayFile(), `${point.t},${point.o},${point.q},${point.w},${point.p},${point.c}\n`, 'utf8').catch(() => {});
}

function historyFor(windowMs, maxPoints = 600) {
  const from = Date.now() - windowMs;
  const pts = history.filter((x) => x.t >= from);
  if (pts.length <= maxPoints) return pts;
  const bucket = windowMs / maxPoints;
  const out = [];
  let i = 0;
  while (i < pts.length) {
    const start = pts[i].t;
    let o = 0, q = 0, w = 0, wc = 0, p = 0, c = 0;
    while (i < pts.length && pts[i].t < start + bucket) {
      o = Math.max(o, pts[i].o); q = Math.max(q, pts[i].q);
      w += pts[i].w; wc++; p = Math.max(p, pts[i].p); c = Math.max(c, pts[i].c || 0);
      i++;
    }
    out.push({ t: start, o, q, w: wc ? Math.round(w / wc) : 0, p, c });
  }
  return out;
}

// ── 用户（按访问密钥区分）+ 公平队列 ──────────────────────────
const users = new Map();
let rr = 0;
let capMap = new Map();       // suffix -> { limit, name }
let capsSyncedAt = 0;

function uidOf(req) {
  const auth = String(req.headers.authorization ?? '');
  let token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) token = String(req.headers['x-api-key'] ?? '').trim();
  if (!token) return { uid: 'anon', suffix: 'anon', token: '' };
  return {
    uid: createHash('sha256').update(token).digest('hex').slice(0, 10),
    suffix: token.slice(-4), token,
  };
}

function userOf(id) {
  let u = users.get(id.uid);
  if (!u) {
    u = { uid: id.uid, suffix: id.suffix, q: [], inflight: 0, served: 0, rejected: 0,
          waitSum: 0, waitN: 0, lastSeen: Date.now(), atCap: false };
    users.set(id.uid, u);
  }
  u.lastSeen = Date.now();
  return u;
}

function capOf(u) {
  const m = capMap.get(u.suffix);
  if (m && m.limit > 0) return m.limit;
  return DEFAULT_USER_CAP;
}

async function syncCaps() {
  if (!AUTH_KEY) return;
  try {
    const res = await fetch(`http://${UP_HOST}:${UP_PORT}/api/access-keys`, {
      headers: { authorization: `Bearer ${AUTH_KEY}` }, signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return;
    const body = await res.json();
    const next = new Map();
    let concNow = 0;
    for (const it of body?.data?.items ?? []) {
      const suffix = String(it.masked_key ?? '').slice(-4);
      if (!suffix) continue;
      const cur = Number(it?.concurrency?.current ?? 0);
      const curOk = Number.isFinite(cur) ? cur : 0;
      next.set(suffix, { limit: Number(it.concurrency_limit ?? 0), name: String(it.name ?? ''), cur: curOk });
      if (curOk > 0) concNow += curOk;
    }
    UP_CONC.current = concNow;   // GPT-Load 实测的实际上游在飞（所有密钥合计）
    UP_CONC.at = Date.now();
    capMap = next;
    capsSyncedAt = Date.now();
  } catch (err) {
    log('syncCaps failed:', err?.message ?? err);
  }
}

function shouldQueue(req) {
  if (req.method !== 'POST') return false;
  const p = req.url.split('?')[0];
  if (p.startsWith('/api/') || p.startsWith('/df/')) return false;
  return true;
}

function queuedTotal() {
  let n = 0;
  for (const u of users.values()) n += u.q.length;
  return n;
}

function pickNext() {
  const now = Date.now();
  const cands = [];
  for (const u of users.values()) {
    if (!u.q.length || u.inflight >= capOf(u)) continue;
    cands.push(u);
  }
  if (!cands.length) return null;
  const ready = cands.filter((u) => now >= (u.coolUntil || 0));
  // 冷却（graceMs）只用于「多用户公平」：只有一个用户在排队时，没有别人可让，
  // 不该因为冷却把空闲名额晾着（实测这样会白掉 150ms/次派发）。
  const list = ready.length ? ready : (cands.length === 1 ? cands : []);
  if (!list.length) return null;
  const u = list[rr % list.length];
  rr = (rr + 1) % Math.max(1, list.length);
  return u.q.shift();
}

let pumpTimer = null;
function pump() {
  while (inFlightCount() < settings.cap) {
    const job = pickNext();
    if (!job) {
      // 2026-10-18 运维修正：pickNext 因「用户冷却未到期」返回 null 时，以前没有任何人
      // 再唤醒 pump，空槽会一直等到 30 秒扫描（实测 o=0 仍在排队：q>0 且 o<9 有 1614/8559 个采样）。
      // 这里按最早的 coolUntil 补一次唤醒，冷却一到就派发，不再空等。
      if (pumpTimer) return;
      const now = Date.now();
      let earliest = 0;
      for (const u of users.values()) {
        if (!u.q.length || u.inflight >= capOf(u)) continue;
        const t = u.coolUntil || 0;
        if (t > now && (earliest === 0 || t < earliest)) earliest = t;
      }
      if (earliest) pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, Math.max(20, earliest - now + 5));
      return;
    }
    if (job.state !== 'queued') continue;
    job.state = 'running';
    clearTimeout(job.timer);
    const wait = Date.now() - job.enq;
    if (wait > 5) { st.queuedTotal++; recordWait(wait); }
    const u = users.get(job.uid);
    if (u) { u.inflight++; u.served++; u.waitSum += wait; u.waitN++; }
    st.served++;
    dispatchTimes.push(Date.now());
    forward(job.req, job.res, job.uid);
  }
}

function enqueue(req, res) {
  const id = uidOf(req);
  const u = userOf(id);
  const userCap = capOf(u);
  const userQueueMax = Math.max(1, Math.round(settings.userQueueMax));   // 2026-10-18 修正：原来取常量 USER_QUEUE_MAX(20)，页面设的 200 不生效

  if (u.q.length >= userQueueMax) {
    u.rejected++; st.rejectedFull++;
    res.writeHead(429, {
      'content-type': 'application/json; charset=utf-8',
      'retry-after': '5',
      'x-df-queue': `user-full(${u.suffix}:${u.q.length}/${userQueueMax})`,
    });
    return res.end(JSON.stringify({
      error: {
        message: `你的排队已满（${u.q.length}/${userQueueMax}，在飞 ${u.inflight}/${userCap}）。稍后重试。`,
        type: 'user_queue_full', code: 'user_queue_full',
      },
    }));
  }
  if (queuedTotal() >= MAX_QUEUE_REF.maxQueue) {
    st.rejectedFull++;
    res.writeHead(429, {
      'content-type': 'application/json; charset=utf-8',
      'retry-after': '5',
      'x-df-queue': `full(cap=${settings.cap},max=${MAX_QUEUE_REF.maxQueue})`,
    });
    return res.end(JSON.stringify({
      error: {
        message: `全局请求池已满（在飞 ${inFlightCount()}/${settings.cap}，排队 ${queuedTotal()}）。请稍后重试。`,
        type: 'queue_full', code: 'queue_full',
      },
    }));
  }

  const job = { req, res, enq: Date.now(), state: 'queued', timer: null, uid: id.uid };
  job.timer = setTimeout(() => {
    if (job.state !== 'queued') return;
    job.state = 'timeout';
    const i = u.q.indexOf(job);
    if (i >= 0) u.q.splice(i, 1);
    u.rejected++; st.rejectedTimeout++;
    res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'retry-after': '3' });
    res.end(JSON.stringify({
      error: {
        message: `排队超时，较长时间没有空闲出口（等待 ${Math.round((Date.now() - job.enq) / 1000)}s）。`,
        type: 'queue_timeout', code: 'queue_timeout',
      },
    }));
  }, MAX_WAIT_REF.maxWaitMs);
  req.pause();
  res.on('close', () => {
    if (job.state === 'queued') {
      job.state = 'aborted';
      clearTimeout(job.timer);
      const i = u.q.indexOf(job);
      if (i >= 0) u.q.splice(i, 1);
      st.abortedWhileQueued++;
    }
  });
  u.q.push(job);
  pump();
}

// ── 模型故障池：主模型挂了就按池序挨个试（跨族），全挂才报错 ──
// 优先级：主模型（用户指定的）→ 同族 → 全池其余。可用 /df/settings 的 fallback_pool 覆盖。
const DEFAULT_POOL = [
  'cn:deepseek-v4.1-flash', 'cn:deepseek-v4-flash',
  'cn:glm-5.3-flash', 'cn:step-5-preview',
  'cn:hy4-preview', 'cn:hy4-preview-f',
  'cn:hy3-x', 'cn:hy3', 'cn:minimax-m3', 'cn:space-bunny',
];
// 熔断：模型连续 N 次 upstream 错误后，X 秒内新请求跳过它
const BREAKER = new Map();   // model -> { fails, until }
const BREAK_THRESHOLD = 2;
const BREAK_MS = 90_000;

function poolOrder(primary) {
  const pool = Array.isArray(settings.fallbackPool) && settings.fallbackPool.length ? settings.fallbackPool : DEFAULT_POOL;
  const rest = pool.filter((m) => m !== primary);
  // 主模型排最前（用户指定的永远优先），随后是池序
  return [primary, ...rest.filter((m) => !BREAKER_OPEN_NOW(m))];
}
function BREAKER_OPEN_NOW(m) {
  const b = BREAKER.get(m);
  return !!(b && b.until > Date.now());
}
function fallbackOf(model) {
  const order = poolOrder(model);
  const alive = order.filter((m) => !BREAKER_OPEN_NOW(m));
  return alive.length > 1 ? alive[1] : null;   // 首个可用备选
}

function breakerOpen(model) { return BREAKER_OPEN_NOW(model); }

function noteFail(model) {
  const b = BREAKER.get(model) ?? { fails: 0, until: 0 };
  b.fails++;
  if (b.fails >= BREAK_THRESHOLD) {
    b.until = Date.now() + BREAK_MS;
    b.fails = 0;
    log(`breaker OPEN ${model} for ${BREAK_MS / 1000}s (pool skips it)`);
  }
  BREAKER.set(model, b);
}

function noteOk(model) { BREAKER.delete(model); }

// ── 主动健康监控：定期探测池内模型，失败 2 连即禁用 ──
const PROBE_INTERVAL_MS_REF = { ms: 60_000 };
const PROBE_DISABLE_MS_REF = { ms: 300_000 };
const PROBE_FAILS_TO_TRIP = 2;
const PROBE_STATE = new Map();   // model -> { fails, probing, last: {t, ok, code, ms} }
let PROBE_STATS = { lastRun: 0, probed: 0, disabled: [], history: [], models: {}, upstream: null };   // 面板可读

// GPT-Load 本体（3101）健康探测：/health 轻量 GET
async function probeUpstream() {
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const r = await fetch(`http://${UP_HOST}:${UP_PORT}/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    PROBE_STATS.upstream = { ok: r.ok, code: r.status, ms: Date.now() - started, t: started };
  } catch (e) {
    PROBE_STATS.upstream = { ok: false, code: e?.cause?.code || e?.name || 'error', ms: Date.now() - started, t: started };
  }
}

async function probeModel(model) {
  const st = PROBE_STATE.get(model) ?? { fails: 0, probing: false };
  PROBE_STATE.set(model, st);
  if (st.probing) return;
  st.probing = true;
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    const r = await fetch(`http://${UP_HOST}:${UP_PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_KEY}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    // 2026-10-18 运维修正：探针用 AUTH_KEY 调 /v1，实测该凭据不是有效 access key，只会拿到 401。
    // 旧逻辑把 status<500 一律记 OK —— 于是「probe OK 11ms」全是 401，探针永远假绿，
    // 10-18 00:03 全站停摆 22 分钟而监控无感。现改为：
    //   401 → 探针本身无效，既不算健康也不算模型故障（不计失败、不禁用模型），只提示一次；
    //   200 → 通道健康；5xx/超时/连接错误 → 计失败。
    // 真实通道健康以「真实请求完成率」为准（运维哨兵每 10 分钟读 request_logs 核验）。
    if (r.status === 401) {
      st.last = { t: started, ok: null, code: 401, ms: Date.now() - started };
      if (!PROBE_STATS.authWarned) {
        PROBE_STATS.authWarned = true;
        log('probe 401: AUTH_KEY 不是有效 access key，模型探针无法判定通道（不再假报 OK）');
      }
      return;
    }
    if (r.status === 200) {
      if (st.fails > 0) log(`probe OK ${model} (${Date.now() - started}ms) — 恢复`);
      st.fails = 0;
      // 探测期自己拉黑的（上游整机挂掉时会把整个池子都拉黑），一恢复就立刻解除，
      // 不能让「本体恢复」还继续等 5 分钟禁用到期
      const pb = BREAKER.get(model);
      if (pb && pb.by === 'probe') { BREAKER.delete(model); log(`probe OK ${model} — 解除探测禁用`); }
      st.last = { t: started, ok: true, code: r.status, ms: Date.now() - started };
      PROBE_STATS.history.push({ t: started, model, ok: true, ms: Date.now() - started });
    } else {
      st.fails++;
      st.last = { t: started, ok: false, code: r.status, ms: Date.now() - started };
      PROBE_STATS.history.push({ t: started, model, ok: false, code: r.status, ms: Date.now() - started });
      if (st.fails >= PROBE_FAILS_TO_TRIP && !BREAKER_OPEN_NOW(model)) {
        BREAKER.set(model, { fails: 0, until: Date.now() + PROBE_DISABLE_MS_REF.ms, by: 'probe' });
        log(`probe DISABLE ${model} for ${PROBE_DISABLE_MS_REF.ms / 1000}s (probe failed x${st.fails}, http ${r.status})`);
      }
    }
  } catch (e) {
    st.fails++;
    st.last = { t: started, ok: false, code: e?.cause?.code || e?.name || 'error', ms: Date.now() - started };
    PROBE_STATS.history.push({ t: started, model, ok: false, code: 'conn', ms: Date.now() - started });
    if (st.fails >= PROBE_FAILS_TO_TRIP && !BREAKER_OPEN_NOW(model)) {
      BREAKER.set(model, { fails: 0, until: Date.now() + PROBE_DISABLE_MS_REF.ms, by: 'probe' });
      log(`probe DISABLE ${model} for ${PROBE_DISABLE_MS_REF.ms / 1000}s (probe failed x${st.fails}, ${e?.cause?.code || e?.name || 'error'})`);
    }
  } finally {
    st.probing = false;
    if (PROBE_STATS.history.length > 200) PROBE_STATS.history = PROBE_STATS.history.slice(-200);
  }
}

async function probeAll() {
  const pool = Array.isArray(settings.fallbackPool) && settings.fallbackPool.length ? settings.fallbackPool : DEFAULT_POOL;
  PROBE_STATS.lastRun = Date.now();
  PROBE_STATS.probed = pool.length;
  await Promise.all([probeUpstream(), ...pool.map(probeModel)]);
  PROBE_STATS.models = {};
  for (const m of pool) {
    const st = PROBE_STATE.get(m) ?? {};
    PROBE_STATS.models[m] = {
      ok: st.last?.ok ?? null,
      code: st.last?.code ?? null,
      ms: st.last?.ms ?? null,
      t: st.last?.t ?? 0,
      fails: st.fails || 0,
      disabled: BREAKER_OPEN_NOW(m),
    };
  }
  PROBE_STATS.disabled = [...BREAKER.entries()].filter(([, b]) => b.until > Date.now()).map(([m, b]) => ({ model: m, secsLeft: Math.round((b.until - Date.now()) / 1000) }));
}

// （isBodyRetryable 已内联进 forward 的响应处理，无需独立函数）

// ── 转发 ──────────────────────────────────────────────────────
function forward(req, res, uid) {
  // 读出 body 以便失败重发（推理请求都不大；流式也先收完再转发，代价可接受？——不行，流式请求体也小，但响应是流式。此处只缓存请求体）
  const chunks = [];
  let size = 0;
  let aborted = false;
  let bodyDone = false;
  const myId = activeAdd('inference');   // 名额由集合管理，任何路径结束都必须 activeDel
  const act = ACTIVE.get(myId);
  if (act) { act.path = String(req.url ?? '').split('?')[0]; act.uid = uid; }
  req.resume();               // 关键：enqueue 时 pause 过，必须恢复流才会流动
  req.on('data', (c) => { size += c.length; if (size > 5_000_000) { aborted = true; req.destroy(); } else chunks.push(c); });
  req.on('error', () => { aborted = true; if (!bodyDone) finishEarly(); });
  req.on('aborted', () => { aborted = true; if (!bodyDone) finishEarly(); });
  req.on('end', () => {
    bodyDone = true;
    if (aborted) return finishEarly();
    startPool(Buffer.concat(chunks));
  });

  let finished = false;
  let currentUp = null;
  const done = () => {
    if (finished) return;
    finished = true;
    activeDel(myId);
    const u = users.get(uid);
    if (u) {
      if (u.inflight > 0) u.inflight--;
      u.coolUntil = Date.now() + settings.graceMs;
    }
    pump();
  };

  // 请求体没读完就断开/超限：必须回收名额，否则出口名额会被永久焊死（曾经的就地漂移源）
  function finishEarly() {
    if (finished) return;
    try {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: '请求体不完整或过大', type: 'bad_request' } }));
      }
    } catch {}
    done();
  }

  // 客户端断开只注册一次（以前每次换池重试都注册，客户端在重试窗口断开时无人回收名额）
  res.on('close', () => {
    if (!res.writableEnded) { try { currentUp?.destroy(); } catch {} }
    done();
  });

  // 池序发送：主模型失败（502/524/conn）→ 池内下一个活着的，全挂才透传错误
  function startPool(body) {
    let userModel = '';
    let isStream = false;
    try {
      const o = JSON.parse(body.toString('utf8'));
      userModel = String(o.model ?? '');
      isStream = o.stream === true;
    } catch {}
    const chain = poolOrder(userModel).slice(0, 5);   // 最多试 5 个，防雪崩
    let idx = 0;
    // 首字节超时：快速回收出口名额（10 个名额是稀缺资源，不能焊死）
    // 2026-10-18 运维调整：200s/300s -> 30s/45s。依据：实测正常首字节 8.3s、p90 15.5s，
    // 上游卡单时旧值会让 1 个出口名额停摆 3-5 分钟，连续几条即全站饿死（10-18 00:03 事故）。
    const TTFB_TIMEOUT_MS = isStream ? 30_000 : 45_000;

  function attempt() {
    if (idx >= chain.length) {
      // 全挂：透传最后一次响应
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: '所有可用模型通道都暂时不可用', type: 'pool_exhausted' } }));
      } else res.destroy();
      done();
      return;
    }
    const model = chain[idx++];
    if (act) { act.model = model; act.stream = isStream; }
    let sendBody = body;
    if (model !== userModel) {
      try {
        const obj = JSON.parse(body.toString('utf8'));
        obj.model = model;
        sendBody = Buffer.from(JSON.stringify(obj), 'utf8');
      } catch {}
    }
    const headers = cleanHeaders(req.headers);
    headers['content-length'] = sendBody.length;
    const tSend = Date.now();

    const up = http.request({
      host: UP_HOST, port: UP_PORT, path: req.url, method: req.method,
      headers, agent,
    }, (ur) => {
      currentUp = up;
      clearTimeout(ttfbTimer);
      const sc = ur.statusCode ?? 502;
      const ttfb = Date.now() - tSend;
      if (ttfb > 30_000) log(`slow upstream ${model}: 等响应头 ${Math.round(ttfb / 1000)}s`);
      const upstreamFail = sc === 502 || sc === 503 || sc === 504;
      if (upstreamFail && idx < chain.length) {
        const b2 = [];
        ur.on('data', (c) => b2.push(c));
        ur.on('end', () => {
          noteFail(model);
          st.poolSwaps = (st.poolSwaps ?? 0) + 1;
          log(`pool retry: ${model} -> ${chain[idx] ?? '(none)'} (http ${sc})`);
          return attempt();
        });
        ur.on('error', () => { done(); res.destroy(); });
        return;
      }
      if (sc < 400) noteOk(model);
      // 2026-10-18 用户口径：60s 不出就切模型池，90s 斩断。
      // 要能「换模型」就必须延迟写响应头：客户端在拿到第一块数据前不该收到头，
      // 否则 HTTP 头只能发一次，之后再换池也救不回来。
      const isSse = /text\/event-stream/i.test(String(ur.headers['content-type'] ?? ''));
      let headSent = false;
      const sendHead = () => {
        if (headSent || res.headersSent) return;
        headSent = true;
        try { res.writeHead(sc, ur.headers); } catch {}
      };
      let lastByteAt = Date.now();
      let lastLogAt = 0;
      let switched = false;
      ur.on('data', (chunk) => {
        lastByteAt = Date.now();
        if (act) act.lastByteAt = lastByteAt;   // 供 stats 识别「卡单」＝60s 无新字节
        sendHead();
        try { res.write(chunk); } catch {}
      });
      // 空响应（假 200）：上游回了 200 但一个字节都没吐就 end。
      // 绝不能让客户端收到一个「看起来成功、其实是空的」响应——那等于骗人。
      // 处理：先换池重试；池也换完还是空，就给客户端明确的 502 empty_response。
      ur.on('end', () => {
        if (!headSent) {
          if (!switched && idx < chain.length) {
            switched = true;
            noteFail(model);
            st.poolSwaps = (st.poolSwaps ?? 0) + 1;
            log(`empty response ${model}: 200 但 0 字节 → 换池 ${chain[idx] ?? '(none)'}`);
            clearInterval(hb);
            return attempt();
          }
          log(`empty response ${model}: 200 但 0 字节，池已耗尽 → 502`);
          if (!res.headersSent) {
            try {
              res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ error: { message: '上游返回空响应（200 但 0 字节）', type: 'empty_response' } }));
            } catch {}
          } else { try { res.end(); } catch {} }
          return done();
        }
        try { res.end(); } catch {}
        done();
      });
      ur.on('error', () => { done(); try { res.destroy(); } catch {} });

      const hb = setInterval(() => {
        if (res.writableEnded || res.destroyed) { clearInterval(hb); return; }
        const gap = Date.now() - lastByteAt;
        if (gap >= 20_000 && isSse && headSent) {
          try { res.write(`: df-keepalive ${Math.round(gap / 1000)}s\n\n`); } catch {}
        }
        if (gap >= 30_000 && Date.now() - lastLogAt >= 60_000) {
          lastLogAt = Date.now();
          log(`stream stall ${model}: 上游 ${Math.round(gap / 1000)}s 无数据${headSent ? '（已开始输出，等 90s 斩断）' : '（尚未输出，等 60s 换池）'}`);
        }
        // 60s 还没吐出第一块数据 → 换模型池：客户端尚未收到任何内容，安全重试
        if (gap >= 60_000 && !headSent && !switched && idx < chain.length) {
          switched = true;
          clearInterval(hb);
          noteFail(model);
          st.poolSwaps = (st.poolSwaps ?? 0) + 1;
          log(`stream stall switch ${model}: 上游 ${Math.round(gap / 1000)}s 无数据 → 换池 ${chain[idx] ?? '(none)'}`);
          try { ur.destroy(); } catch {}
          return attempt();
        }
        // 90s 一直无新数据 → 斩断，释放出口名额
        if (gap >= 90_000) {
          log(`stream stall kill ${model}: 上游 ${Math.round(gap / 1000)}s 无数据 → 斩断请求、释放出口名额`);
          clearInterval(hb);
          try { ur.destroy(); } catch {}
          try { res.destroy(); } catch {}
          done();
        }
      }, 5_000);
      const stopHb = () => clearInterval(hb);
      ur.on('end', stopHb); ur.on('close', stopHb); res.on('close', stopHb);
    });
    // 首字节超时：上游收下请求却不给响应头 → 换池，别把出口名额焊死
    const ttfbTimer = setTimeout(() => {
      st.upstreamErrors++;
      st.ttfbTimeouts = (st.ttfbTimeouts ?? 0) + 1;
      log(`first-byte timeout ${model}: ${Math.round(TTFB_TIMEOUT_MS / 1000)}s 无响应头，换池`);
      up.destroy(new Error('ttfb_timeout'));
    }, TTFB_TIMEOUT_MS);
    up.on('error', () => {
      clearTimeout(ttfbTimer);
      st.upstreamErrors++;
      noteFail(model);
      if (idx < chain.length) {
        log(`pool retry(conn): ${model} -> ${chain[idx]}`);
        return attempt();
      }
      if (!res.headersSent) {
        res.writeHead(504, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: '上游长时间无响应', type: 'upstream_timeout' } }));
      } else res.destroy();
      done();
    });
    up.end(sendBody);
  }
  attempt();
  }
}

function passThrough(req, res) {
  const up = http.request({
    host: UP_HOST, port: UP_PORT, path: req.url, method: req.method,
    headers: cleanHeaders(req.headers),
  }, (ur) => {
    res.writeHead(ur.statusCode ?? 502, ur.headers);
    ur.pipe(res);
  });
  up.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`upstream error: ${err?.message ?? err}`);
  });
  req.pipe(up);
}

// ── 会话（cookie df_sess = base64(payload).hmac）──────────────
const SECRET_FILE = path.join(DATA, 'session-secret');
let SECRET = '';
async function loadSecret() {
  await mkdir(DATA, { recursive: true });
  try { SECRET = (await readFile(SECRET_FILE, 'utf8')).trim(); } catch {}
  if (!SECRET || SECRET.length < 32) {
    SECRET = randomBytes(32).toString('hex');
    await writeFile(SECRET_FILE, SECRET, 'utf8').catch(() => {});
  }
}

function sign(s) { return createHmac('sha256', SECRET).update(s).digest('base64url'); }

function makeSession(payload) {
  const p = { ...payload, exp: Date.now() + SESSION_TTL_MS };
  const body = Buffer.from(JSON.stringify(p)).toString('base64url');
  return `${body}.${sign(body)}`;
}

function parseSession(req) {
  const cookies = String(req.headers.cookie ?? '');
  const m = /(?:^|;\s*)df_sess=([^;]+)/.exec(cookies);
  if (!m) return null;
  const [body, sig] = m[1].split('.');
  if (!body || !sig) return null;
  const want = sign(body);
  if (want.length !== sig.length || !timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}

// 登录限速：每 IP 每分钟 5 次
const loginFails = new Map();
function loginAllowed(ip) {
  const now = Date.now();
  const arr = (loginFails.get(ip) ?? []).filter((t) => now - t < 60_000);
  loginFails.set(ip, arr);
  return arr.length < 5;
}
function loginFail(ip) {
  const arr = loginFails.get(ip) ?? [];
  arr.push(Date.now());
  loginFails.set(ip, arr);
}

// 用户密钥验真：拿它去上游 /v1/models 试
async function verifyUserKey(token) {
  if (!/^sk-gl-/.test(token)) return null;
  const r = await upGet('/v1/models', token);
  if (r.status !== 200) return null;
  const suffix = token.slice(-4);
  const info = capMap.get(suffix) ?? {};
  return {
    role: 'user',
    suffix,
    name: info.name || `密钥·${suffix}`,
    cap: info.limit > 0 ? info.limit : DEFAULT_USER_CAP,
  };
}

function readBody(req, limit = 64_000) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ── 品牌壳（反代管理台 + 注入）────────────────────────────────
const BRAND_TITLE = '东方API';
const INJECT_TAG = '<script src="/df/gate.js" defer></script><script src="/df/inject.js" defer></script>';

function rewriteHtml(html) {
  let out = html;
  out = out.replace(/<title>[\s\S]*?<\/title>/i, `<title>${BRAND_TITLE}</title>`);
  out = out.replace(/<link[^>]+rel=["']icon["'][^>]*>/gi,
    `<link rel="icon" href="/df/favicon.svg" type="image/svg+xml" />`);
  if (!/\/df\/inject\.js/.test(out)) {
    if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, `${INJECT_TAG}</body>`);
    else out += INJECT_TAG;
  }
  return out;
}

function fetchUpstreamHtml(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: UP_HOST, port: UP_PORT, path: pathname, method: 'GET',
      headers: { 'accept-encoding': 'identity', authorization: `Bearer ${AUTH_KEY}` }, timeout: 10_000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const type = String(res.headers['content-type'] ?? '');
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ type, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function serveAdminHtml(req, res) {
  try {
    const { type, body } = await fetchUpstreamHtml(req.url);
    if (!/text\/html/i.test(type)) {
      res.writeHead(200, { 'content-type': type || 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(body);
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(rewriteHtml(body));
  } catch (err) {
    log('serveAdminHtml fallback:', err?.message ?? err);
    passThrough(req, res);
  }
}

// ── 静态资源（/df/*，含内嵌登录页/门户）───────────────────────
const MIME = {
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.html': 'text/html; charset=utf-8', '.ico': 'image/x-icon',
};

async function serveStatic(pathname, res) {
  const rel = pathname.slice('/df/'.length) || 'index.html';
  const full = path.join(WEB, path.normalize(rel).replace(/^([.][.][\\/])+/, ''));
  if (!full.startsWith(WEB)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const buf = await readFile(full);
    res.writeHead(200, {
      'content-type': MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store', 'content-length': buf.length,
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

const PAGE_CSS = `*{box-sizing:border-box;margin:0}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:'Segoe UI','Microsoft YaHei',sans-serif;
background:linear-gradient(160deg,#2b1608,#1a0d05 60%,#120702);color:#f5ede4}
.card{background:#241207ee;border:1px solid #5a2d10;border-radius:18px;padding:36px 40px;width:360px;box-shadow:0 18px 60px #000a}
h1{font-size:22px;display:flex;align-items:center;gap:10px;margin-bottom:6px}
h1 img{width:34px;height:34px;border-radius:9px}
.sub{color:#c9a888;font-size:13px;margin-bottom:22px}
input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid #6b3a17;background:#170a03;color:#fff;font-size:15px;outline:none}
input:focus{border-color:#ff8a3c}
button{width:100%;margin-top:14px;padding:12px;border:0;border-radius:10px;background:linear-gradient(135deg,#ff6a2b,#e8380d);
color:#fff;font-size:15px;font-weight:600;cursor:pointer}
button:hover{filter:brightness(1.1)}
.err{color:#ff9d7a;font-size:13px;margin-top:12px;min-height:18px}
.hint{color:#8a6a4e;font-size:12px;margin-top:18px;line-height:1.7}
.kpi{display:flex;gap:10px;margin:14px 0}
.kpi div{flex:1;background:#1a0c04;border:1px solid #4a2410;border-radius:12px;padding:12px;text-align:center}
.kpi b{display:block;font-size:20px;color:#ffb066}
.kpi span{font-size:11px;color:#c9a888}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
td,th{padding:7px 6px;border-bottom:1px solid #3a1d0c;text-align:left}
code{background:#170a03;border:1px solid #4a2410;border-radius:6px;padding:2px 6px;font-size:12px;color:#ffca9a;word-break:break-all}
a{color:#ff9d5c}`;

const LOGIN_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · 东方API</title><link rel="icon" href="/df/favicon.svg" type="image/svg+xml">
<style>${PAGE_CSS}
.tabs{display:flex;gap:6px;margin-bottom:18px}
.tabs button{margin:0;flex:1;padding:9px;background:#170a03;border:1px solid #4a2410;border-radius:9px;font-weight:400;color:#c9a888}
.tabs button.on{background:#3a1d0c;color:#fff;border-color:#ff8a3c}
.f{display:none}.f.on{display:block}
#reg-ok{background:#1a0c04;border:1px solid #4a2410;border-radius:10px;padding:12px;margin-top:12px;display:none}
#reg-ok b{color:#7fe08f;user-select:all;word-break:break-all}
.cpy{background:#3a1d0c!important;margin-top:8px!important}
</style></head><body><div class="card">
<h1><img src="/df/logo.svg">东方API</h1><div class="sub">管理台 / 用户门户 · 一个入口</div>
<div class="tabs"><button id="tab-l" class="on" onclick="sw('l')">登录</button><button id="tab-r" onclick="sw('r')">注册</button></div>
<form id="f-l" class="f on" onsubmit="return go()">
<input id="k" type="password" placeholder="管理密钥 / sk-gl-… / 用户名" autofocus>
<input id="pw" type="password" placeholder="密码（用户名登录时填）" style="margin-top:10px">
<div class="err" id="e"></div><button>登 录</button>
<div class="hint">管理员：管理密钥 · 用户：密钥或账号密码<br>程序调用 API：地址 <code>/v1</code>，无需登录</div>
</form>
<form id="f-r" class="f" onsubmit="return reg()">
<input id="r-u" placeholder="用户名（2~32位字母数字下划线）">
<input id="r-p" type="password" placeholder="密码（至少6位）" style="margin-top:10px">
<input id="r-i" placeholder="邀请码（或改用邮箱验证码）" style="margin-top:10px">
<div style="display:flex;gap:8px;align-items:center;margin-top:10px">
<input id="r-e" placeholder="邮箱（可选，替代邀请码）" style="flex:1;margin:0">
<button type="button" id="r-send" onclick="sendCode()" style="margin:0;flex:0 0 auto;padding:10px 14px;font-size:13px;background:#3a1d0c">发验证码</button></div>
<input id="r-ec" placeholder="邮箱验证码（6位，用了邮箱就不用邀请码）" style="margin-top:10px">
<div class="err" id="e2"></div><button>注 册</button>
<div class="hint">没有邀请码？找管理员要一个</div>
</form>
<div id="reg-ok">注册成功！你的 API 密钥（<b>只显示这一次</b>，请立即复制保存）：<br><b id="reg-key"></b>
<button class="cpy" type="button" onclick="navigator.clipboard.writeText(document.getElementById('reg-key').textContent);this.textContent='已复制 ✓'">复制密钥</button>
<button type="button" onclick="location.href='/portal'" style="background:linear-gradient(135deg,#ff6a2b,#e8380d)">进入我的用量 →</button></div>
</div><script>
function sw(t){for(const[id,f]of[['tab-l','f-l'],['tab-r','f-r']]){document.getElementById(id).classList.toggle('on',id==='tab-'+t);document.getElementById(f).classList.toggle('on',f==='f-'+t)}}
async function go(){
 const k=document.getElementById('k').value.trim();
 const p=document.getElementById('pw').value;
 const e=document.getElementById('e'); e.textContent='验证中…';
 const r=await fetch('/df/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:k,password:p})});
 const j=await r.json().catch(()=>({}));
 if(j.ok){location.href='/';return false}
 e.textContent=j.error||'登录失败';return false}
async function sendCode(){
 const e=document.getElementById('e2'); const btn=document.getElementById('r-send');
 if(!r_e.value.trim()){e.textContent='先填邮箱';return}
 btn.disabled=true; btn.textContent='发送中…';
 const r=await fetch('/df/email-code',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:r_e.value.trim()})});
 const j=await r.json().catch(()=>({}));
 if(j.ok){e.style.color='#7fe08f';e.textContent='验证码已发送，查收邮箱（垃圾箱也看看）';
  let n=60; const t=setInterval(()=>{btn.textContent=n+'s';if(--n<0){clearInterval(t);btn.disabled=false;btn.textContent='发验证码'}},1000);}
 else {btn.disabled=false;btn.textContent='发验证码';e.style.color='#ff9d7a';e.textContent=j.error||'发送失败'}
}
async function reg(){
 const b={username:r_u.value.trim(),password:r_p.value,invite:r_i.value.trim(),
  email:r_e.value.trim(),email_code:r_ec.value.trim()};
 const e=document.getElementById('e2'); e.style.color=''; e.textContent='注册中…';
 const r=await fetch('/df/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});
 const j=await r.json().catch(()=>({}));
 if(!j.ok){e.textContent=j.error||'注册失败';return false}
 e.textContent='';
 document.getElementById('reg-key').textContent=j.api_key;
 document.getElementById('reg-ok').style.display='block';
 return false}
</script></body></html>`;

const PORTAL_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>我的用量 · 东方API</title><link rel="icon" href="/df/favicon.svg" type="image/svg+xml">
<style>${PAGE_CSS}
.wrap{max-width:720px;width:92vw}</style></head><body>
<div class="card wrap"><h1><img src="/df/logo.svg">东方API · 我的用量</h1>
<div class="sub" id="who"></div>
<div class="kpi">
<div><b id="k-cap">-</b><span>并发上限</span></div>
<div><b id="k-run">-</b><span>正在运行</span></div>
<div><b id="k-served">-</b><span>累计服务</span></div>
<div><b id="k-wait">-</b><span>平均等待</span></div>
</div>
<table><tr><th>排队中</th><th>被拒次数</th><th>全局出口</th></tr>
<tr><td id="t-q">-</td><td id="t-r">-</td><td id="t-g">-</td></tr></table>
<h1 style="font-size:16px;margin-top:26px">接入方式</h1>
<div class="hint" style="margin-top:10px">
API 地址：<code id="c-url"></code><br>
密钥：<code>sk-gl-****<span id="c-suf"></span></code>（即你登录用的那把）<br>
示例：<code>curl <span id="c-url2"></span>/v1/chat/completions -H "Authorization: Bearer 你的密钥" -d '{"model":"cn:deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}]}'</code>
</div>
<div style="margin-top:22px;display:flex;gap:10px"><button style="margin:0;flex:0 0 auto;padding:9px 22px" onclick="location.reload()">刷新</button>
<button style="margin:0;flex:0 0 auto;padding:9px 22px;background:#3a1d0c" onclick="togglePw()">改密码</button>
<button style="margin:0;flex:0 0 auto;padding:9px 22px;background:#3a1d0c" onclick="fetch('/df/logout').then(()=>location.href='/')">退出</button></div>
<div id="pwbox" style="display:none;margin-top:14px;background:#1a0c04;border:1px solid #4a2410;border-radius:12px;padding:14px">
<input id="pw-old" type="password" placeholder="旧密码" style="margin-bottom:8px">
<input id="pw-new" type="password" placeholder="新密码（至少8位）" style="margin-bottom:8px">
<div style="display:flex;gap:8px"><button style="margin:0;padding:8px 18px" onclick="doPw()">确认修改</button>
<span id="pw-msg" style="font-size:13px;align-self:center"></span></div></div>
</div><script>
function f(n){return n==null?'-':n}
async function load(){
 const j=await (await fetch('/df/portal-data')).json();
 if(!j.ok){location.href='/';return}
 document.getElementById('who').textContent=(j.name||'用户')+' · 密钥尾号 '+j.suffix;
 k_cap.textContent=f(j.cap); k_run.textContent=(f(j.inflight))+' / '+f(j.cap);
 k_served.textContent=f(j.served); k_wait.textContent=j.waitAvg+' ms';
 t_q.textContent=f(j.queued); t_r.textContent=f(j.rejected);
 t_g.textContent=j.globInFlight+' / '+j.globCap;
 c_suf.textContent=j.suffix; c_url.textContent=j.baseUrl; c_url2.textContent=j.baseUrl;
}
load(); setInterval(load,5000);
function togglePw(){const b=document.getElementById('pwbox');b.style.display=b.style.display==='none'?'block':'none'}
async function doPw(){
 const m=document.getElementById('pw-msg');
 const r=await fetch('/df/password',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({old:pw_old.value,new:pw_new.value})});
 const j=await r.json().catch(()=>({}));
 m.style.color=j.ok?'#7fe08f':'#ff9d7a';
 m.textContent=j.ok?'已修改 ✓':(j.error||'失败');
 if(j.ok){pw_old.value='';pw_new.value=''}
}
</script></body></html>`;

// ── 登录/门户处理 ─────────────────────────────────────────────
function setCookie(res, value) {
  res.setHeader('set-cookie', `df_sess=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`);
}

async function handleLogin(req, res, ip) {
  if (!loginAllowed(ip)) {
    res.writeHead(429, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '尝试过于频繁，稍后再试' }));
  }
  let body = {};
  try { body = JSON.parse(await readBody(req)); } catch {}
  const key = String(body.key ?? body.username ?? '').trim();
  const password = String(body.password ?? '');
  if (!key) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '缺少密钥' }));
  }
  if (isAdminToken(key)) {
    setCookie(res, makeSession({ role: 'admin' }));
    log(`login admin from ${ip}`);
    return res.end(JSON.stringify({ ok: true, role: 'admin' }));
  }
  // 用户名+密码（账号登录）
  if (!key.startsWith('sk-gl-') && !key.startsWith('DF-') && key.length < 64) {
    const u = accounts.getUser(key);
    if (u && !u.disabled && accounts.checkPass(password, u.pass_hash)) {
      setCookie(res, makeSession({ role: 'user', suffix: u.key_suffix, name: `用户-${u.username}`, cap: DEFAULT_USER_CAP, username: u.username }));
      log(`login account ${u.username} from ${ip}`);
      return res.end(JSON.stringify({ ok: true, role: 'user' }));
    }
  }
  const u = await verifyUserKey(key);
  if (u) {
    setCookie(res, makeSession(u));
    log(`login user ${u.suffix} from ${ip}`);
    return res.end(JSON.stringify({ ok: true, role: 'user' }));
  }
  loginFail(ip);
  res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: '密钥无效或已停用' }));
}

function userRowOf(sess) {
  for (const u of users.values()) if (u.suffix === sess.suffix && (u.served || u.inflight || u.q.length)) return u;
  return null;
}

// ── 注册 + 账号登录 ──────────────────────────────────────────
async function createAccessKeyFor(username) {
  // 建并发 5、只挂月卡110分组(3)的密钥
  const idem = randomUUID();
  const r = await fetch(`http://${UP_HOST}:${UP_PORT}/api/access-keys`, {
    method: 'POST',
    headers: { authorization: `Bearer ${AUTH_KEY}`, 'content-type': 'application/json', 'idempotency-key': idem },
    body: JSON.stringify({
      name: `用户-${username}`,
      concurrency_limit: DEFAULT_USER_CAP,
      rpm_limit: 0,
      filters: { groups: [3], protocols: [], models: [], allowed_cidrs: [] },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok || body?.code !== 0 || !body?.data?.key) throw new Error(body?.message ?? `HTTP ${r.status}`);
  return body.data;      // { id, key: 明文, ... }（明文只此一次）
}

// ── 邮箱验证码发送 ───────────────────────────────────────────
async function handleEmailCode(req, res, ip) {
  if (!loginAllowed(ip)) {
    res.writeHead(429, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '尝试过于频繁，稍后再试' }));
  }
  if (!settings.registerEnabled) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '当前未开放注册' }));
  }
  let body = {};
  try { body = JSON.parse(await readBody(req)); } catch {}
  const r = await mailer.sendCode(body.email);
  if (!r.ok) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: r.error }));
  }
  log(`email code sent to ${String(body.email).slice(0, 3)}***`);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  return res.end(JSON.stringify({ ok: true }));
}

async function handleRegister(req, res, ip) {
  if (!loginAllowed(ip)) {
    res.writeHead(429, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '尝试过于频繁，稍后再试' }));
  }
  let body = {};
  try { body = JSON.parse(await readBody(req)); } catch {}
  const username = String(body.username ?? '').trim();
  const password = String(body.password ?? '');
  const invite = String(body.invite ?? '').trim();
  const email = String(body.email ?? '').trim().toLowerCase();
  const emailCode = String(body.email_code ?? '').trim();
  if (!/^[a-zA-Z0-9_-]{2,32}$/.test(username)) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '用户名 2~32 位，仅字母数字下划线' }));
  }
  if (password.length < 6) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '密码至少 6 位' }));
  }
  if (accounts.getUser(username)) {
    res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '用户名已被占用' }));
  }
  // 二选一：邀请码 或 邮箱验证码
  let invitedBy = '';
  if (email && emailCode) {
    if (!settings.registerEnabled) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '当前未开放注册' }));
    }
    const v = mailer.verifyCode(email, emailCode);
    if (!v.ok) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: v.error }));
    }
    invitedBy = `email:${email}`;
  } else {
    const inv = accounts.consumeInvite(invite);
    if (!inv.ok) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '邀请码或邮箱验证码无效：' + inv.error }));
    }
    invitedBy = invite;
  }
  try {
    const key = await createAccessKeyFor(username);
    const suffix = String(key.key).slice(-4);
    accounts.createUser({
      username, password,
      keyId: key.id ?? null, keySuffix: suffix,
      keyMasked: `sk-gl-****${suffix}`, invitedBy,
    });
    log(`register user=${username} key_suffix=${suffix}`);
    // 直接登录进门户
    setCookie(res, makeSession({ role: 'user', suffix, name: `用户-${username}`, cap: DEFAULT_USER_CAP, username }));
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, api_key: key.key }));
  } catch (err) {
    log('register failed:', err?.message ?? err);
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: `创建密钥失败：${err?.message ?? err}` }));
  }
}

// 账号（用户名+密码）登录：成功后会话与该用户密钥绑定
function handleAccountLogin(req, res, ip) {
  return null; // 在 handleLogin 内联处理
}

// ── 密码：用户自改 + 管理员重置/禁用 ─────────────────────────
async function handlePasswordChange(req, res, sess) {
  if (!sess || sess.role !== 'user' || !sess.username) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '需要用户登录' }));
  }
  let body = {};
  try { body = JSON.parse(await readBody(req)); } catch {}
  const oldPw = String(body.old ?? '');
  const newPw = String(body.new ?? '');
  const u = accounts.getUser(sess.username);
  if (!u || u.disabled) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '账号不存在或已禁用' }));
  }
  if (!accounts.checkPass(oldPw, u.pass_hash)) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '旧密码不对' }));
  }
  if (newPw.length < 8) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '新密码至少 8 位' }));
  }
  accounts.setPassHash(sess.username, accounts.hashPass(newPw));
  log(`password changed: ${sess.username}`);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  return res.end(JSON.stringify({ ok: true }));
}

async function handleUserManage(req, res, sess) {
  if (!sess || sess.role !== 'admin') {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '需要管理员登录' }));
  }
  let body = {};
  try { body = JSON.parse(await readBody(req)); } catch {}
  const action = String(body.action ?? '');
  const username = String(body.username ?? '').trim();
  const u = accounts.getUser(username);
  if (!u) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '用户不存在' }));
  }
  if (action === 'reset-password') {
    const pw = accounts.randomPassword();
    accounts.setPassHash(username, accounts.hashPass(pw));
    log(`password reset by admin: ${username}`);
    return res.end(JSON.stringify({ ok: true, password: pw }));  // 明文只显示这一次
  }
  if (action === 'disable' || action === 'enable') {
    const disabled = action === 'disable';
    accounts.setUserDisabled(username, disabled);
    // 联动停用/启用密钥
    if (u.key_id && AUTH_KEY) {
      await fetch(`http://${UP_HOST}:${UP_PORT}/api/access-keys/${u.key_id}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${AUTH_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !disabled }),
        signal: AbortSignal.timeout(8000),
      }).catch(() => {});
    }
    log(`user ${username} ${action}d by admin`);
    return res.end(JSON.stringify({ ok: true, disabled }));
  }
  res.writeHead(400);
  return res.end(JSON.stringify({ error: '未知操作' }));
}

async function handleSettingsAdmin(req, res, sess, method) {
  if (!sess || sess.role !== 'admin') {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '需要管理员登录' }));
  }
  if (method === 'GET') {
    const pool = Array.isArray(settings.fallbackPool) && settings.fallbackPool.length ? settings.fallbackPool : DEFAULT_POOL;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, settings: { ...settings, fallbackPool: pool }, effective: { cap: settings.cap, maxQueue: MAX_QUEUE_REF.maxQueue } }));
  }
  if (method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    const num = (v, lo, hi, dft) => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), lo), hi) : dft; };
    if (body.cap !== undefined) settings.cap = num(body.cap, 1, 500, settings.cap);
    if (body.userQueueMax !== undefined) settings.userQueueMax = num(body.userQueueMax, 1, 500, settings.userQueueMax);
    if (body.graceMs !== undefined) settings.graceMs = num(body.graceMs, 0, 5000, settings.graceMs);
    if (body.maxWaitMs !== undefined) settings.maxWaitMs = num(body.maxWaitMs, 5000, 3_600_000, settings.maxWaitMs);
    if (body.registerEnabled !== undefined) settings.registerEnabled = !!body.registerEnabled;
    if (body.defaultUserCap !== undefined) settings.defaultUserCap = num(body.defaultUserCap, 1, 100, settings.defaultUserCap);
    if (body.fallbackPool !== undefined) {
      const list = Array.isArray(body.fallbackPool)
        ? body.fallbackPool.map((s) => String(s).trim()).filter(Boolean)
        : String(body.fallbackPool).split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      if (list.length) settings.fallbackPool = [...new Set(list)];
    }
    if (body.probeIntervalSec !== undefined) settings.probeIntervalSec = num(body.probeIntervalSec, 30, 600, settings.probeIntervalSec);
    if (body.probeDisableSec !== undefined) settings.probeDisableSec = num(body.probeDisableSec, 60, 3600, settings.probeDisableSec);
    // 0 = 自动跟随（不能用 num 夹，num 的下限会把 0 变成 1，导致「自动」永远存不进去）
    if (body.virtualCapRef !== undefined) {
      const n = Number(body.virtualCapRef);
      settings.virtualCapRef = Number.isFinite(n) && n > 0 ? Math.min(Math.max(Math.round(n), 1), 100000) : 0;
    }
    if (body.stuckWarn !== undefined) settings.stuckWarn = num(body.stuckWarn, 1, 100, settings.stuckWarn);
    PROBE_INTERVAL_MS_REF.ms = settings.probeIntervalSec * 1000;
    PROBE_DISABLE_MS_REF.ms = settings.probeDisableSec * 1000;
    applySettings();
    await saveSettings();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, settings }));
  }
  res.writeHead(405); return res.end();
}

async function handleInviteAdmin(req, res, sess, method) {
  if (!sess || sess.role !== 'admin') {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '需要管理员登录' }));
  }
  if (method === 'GET') {
    return res.end(JSON.stringify({ ok: true, invites: accounts.listInvites(), users: accounts.listUsers() }));
  }
  if (method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    const inv = accounts.createInvite({ maxUses: Math.min(Math.max(Number(body.max_uses ?? 1), 1), 100), note: String(body.note ?? '') });
    return res.end(JSON.stringify({ ok: true, invite: inv }));
  }
  if (method === 'DELETE') {
    const code = new URL(req.url, 'http://x').searchParams.get('code') ?? '';
    accounts.deleteInvite(code);
    return res.end(JSON.stringify({ ok: true }));
  }
  res.writeHead(405); return res.end();
}

function portalData(sess, req) {
  const u = userRowOf(sess);
  const host = req.headers.host ?? `127.0.0.1:${LISTEN_PORT}`;
  return {
    ok: true, role: 'user', name: sess.name, suffix: sess.suffix, cap: sess.cap,
    inflight: u?.inflight ?? 0, queued: u?.q?.length ?? 0,
    served: u?.served ?? 0, rejected: u?.rejected ?? 0,
    waitAvg: u?.waitN ? Math.round(u.waitSum / u.waitN) : 0,
    globInFlight: inFlightCount(), globCap: settings.cap,
    baseUrl: `http://${host}`,
  };
}

// ── 管理员数据接口（原 /queue/*，收进会话保护）────────────────
function adminStats() {
  const inflightNow = inFlightCount();
  // 2026-10-18 用户要求：卡单要能直接识别。
  // 真卡单＝已派发但「超过 60 秒没有收到任何新字节」的请求（不是 o−c；o−c 是流式传输中）。
  const nowMs = Date.now();
  let stalled = 0, maxIdleMs = 0;
  for (const a of ACTIVE.values()) {
    const idle = nowMs - (a.lastByteAt ?? a.startedAt);
    if (idle >= 60_000) stalled++;
    if (idle > maxIdleMs) maxIdleMs = idle;
  }
  // 2026-10-18：给面板「能量槽」补分层口径
  //   virtualCap = 按 access key 的并发上限动态求和得来（不写死常量）
  //     若当前有密钥正在跑，取「在用密钥的上限之和」；否则取所有密钥里的最大上限
  //   inbound    = 本轮进入 3001 的请求（在飞 + 排队），即「连到代理的并发」
  //   inFlight   = 已派发给 GPT-Load 的数量（含未确认的卡单）
  //   upstreamInFlight = GPT-Load 确认在处理的数量（真实出口并发）
  let virtualCap = 0, maxKeyLimit = 0, activeKeyLimit = 0;
  for (const v of capMap.values()) {
    const lim = Math.max(0, Number(v.limit) || 0);
    maxKeyLimit = Math.max(maxKeyLimit, lim);
    if ((Number(v.cur) || 0) > 0) activeKeyLimit += lim;
  }
  virtualCap = activeKeyLimit > 0 ? activeKeyLimit : maxKeyLimit;
  return JSON.stringify({
    cap: settings.cap, inFlight: inflightNow, queued: queuedTotal(),
    inbound: inflightNow + queuedTotal(), queueMax: MAX_QUEUE, maxWaitMs: MAX_WAIT_MS,
    virtualCap, virtualCapKeys: capMap.size,
    // 卡单识别（2026-10-18）：stalled=已派发但 60s 无新字节的请求数；maxIdleMs=当前最久空闲
    stalled, maxIdleMs,
    // 面板口径（可在设置页改）：入口刻度、卡单告警阈值
    virtualCapRef: settings.virtualCapRef, stuckWarn: settings.stuckWarn,
    // 上游实测：GPT-Load 没响应就不给数字（避免把崩溃前卡住的旧值当实时值展示）
    upstreamInFlight: upstreamOk ? (UP_CONC.current > 0 && Date.now() - UP_CONC.at < 90_000 ? UP_CONC.current : upConc) : null,
    upstreamSrc: upstreamOk ? (UP_CONC.current > 0 && Date.now() - UP_CONC.at < 90_000 ? 'keys' : 'home') : 'down',
    upstreamConcAt: UP_CONC.at,
    served: st.served, throughput1m, queuedTotal: st.queuedTotal,
    rejectedFull: st.rejectedFull, rejectedTimeout: st.rejectedTimeout,
    abortedWhileQueued: st.abortedWhileQueued, upstreamErrors: st.upstreamErrors,
    ttfbTimeouts: st.ttfbTimeouts ?? 0,
    wait: waitStats(), userCapDefault: DEFAULT_USER_CAP, userQueueMax: USER_QUEUE_MAX,
    capsSyncedAt, upstreamOk, upConc, upLimit,
    users: [...users.values()]
      .filter((u) => u.inflight || u.q.length || u.served || u.rejected)
      .map((u) => ({
        suffix: u.suffix, name: capMap.get(u.suffix)?.name ?? '', cap: capOf(u),
        inflight: u.inflight, queued: u.q.length, served: u.served, rejected: u.rejected,
        upCur: capMap.get(u.suffix)?.cur ?? null,
        waitAvg: u.waitN ? Math.round(u.waitSum / u.waitN) : 0, lastSeen: u.lastSeen,
      }))
      .sort((a, b) => (b.inflight + b.queued) - (a.inflight + a.queued) || b.served - a.served),
    poolSwaps: st.poolSwaps ?? 0,
    breaker: [...BREAKER.entries()]
      .filter(([, b]) => b.until > Date.now())
      .map(([m, b]) => ({ model: m, until: b.until, secsLeft: Math.round((b.until - Date.now()) / 1000) })),
    fallbackPool: Array.isArray(settings.fallbackPool) && settings.fallbackPool.length ? settings.fallbackPool : DEFAULT_POOL,
    probe: PROBE_STATS,
    // 在飞明细（排查计数漂移用）：最老的几条，[型号|路径|已挂多久]
    active: [...ACTIVE.values()]
      .map((v) => ({ ageSec: Math.round((Date.now() - v.startedAt) / 1000), model: v.model ?? '', path: v.path ?? '', stream: v.stream === true }))
      .filter((v) => v.ageSec >= 5)
      .sort((a, b) => b.ageSec - a.ageSec).slice(0, 20),
    activeTotal: ACTIVE.size,
    uptimeMs: Date.now() - st.startedAt,
  });
}

// ── 反代（带上游头修正）───────────────────────────────────────
function proxyAdmin(req, res) {
  const headers = { ...req.headers, host: `${UP_HOST}:${UP_PORT}` };
  delete headers.cookie;
  headers.authorization = `Bearer ${AUTH_KEY}`;   // 已过门卫，替管理员注入上游凭据
  const up = http.request({
    host: UP_HOST, port: UP_PORT, path: req.url, method: req.method, headers,
  }, (ur) => {
    res.writeHead(ur.statusCode ?? 502, ur.headers);
    ur.pipe(res);
  });
  up.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`upstream error: ${err?.message ?? err}`);
  });
  req.pipe(up);
}

// SPA 路由：没有扩展名、也不是 /api|/assets|/df 的 GET，都当作页面
function isHtmlRoute(pathname, req) {
  if (pathname === '/' || pathname === '/index.html') return true;
  if (/^\/(api|assets|df)(\/|$)/.test(pathname)) return false;
  if (/\.[a-z0-9]+$/i.test(pathname)) return false;
  return String(req.headers.accept ?? '').includes('text/html') || !(req.headers['sec-fetch-mode'] === 'cors');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');

  // ── /df/* 自己的 ──
  const sess = parseSession(req);
  if (p === '/df/login' && req.method === 'POST') return handleLogin(req, res, ip);
  if (p === '/df/register' && req.method === 'POST') return handleRegister(req, res, ip);
  if (p === '/df/email-code' && req.method === 'POST') return handleEmailCode(req, res, ip);
  if (p === '/df/invites') return handleInviteAdmin(req, res, sess, req.method);
  if (p === '/df/settings') return handleSettingsAdmin(req, res, sess, req.method);
  if (p === '/df/password' && req.method === 'POST') return handlePasswordChange(req, res, sess);
  if (p === '/df/users/manage' && req.method === 'POST') return handleUserManage(req, res, sess);
  if (p === '/df/logout') { setCookie(res, ''); res.writeHead(303, { location: '/' }); return res.end(); }

  if (p === '/df/me') {
    if (!sess) return res.end(JSON.stringify({ ok: false }));
    if (sess.role === 'admin') {
      return res.end(JSON.stringify({ ok: true, role: 'admin', key: AUTH_KEY }));
    }
    return res.end(JSON.stringify({ ok: true, role: 'user', name: sess.name, suffix: sess.suffix }));
  }
  if (p === '/df/portal-data') {
    if (!sess || sess.role !== 'user') {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false }));
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(portalData(sess, req)));
  }
  if (p === '/df/login-page' || (p === '/' && !sess)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(LOGIN_HTML);
  }
  if (p === '/portal') {
    if (!sess || sess.role !== 'user') { res.writeHead(303, { location: '/' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(PORTAL_HTML);
  }

  // 管理员历史曲线
  if (p === '/df/history') {
    if (!sess || sess.role !== 'admin') {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false }));
    }
    const winMs = Math.min(Math.max(Number(url.searchParams.get('window') ?? 900_000), 60_000), KEEP_DAYS * 86400_000);
    const pts = historyFor(winMs);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({
      ok: true, upstreamOk, window: winMs, from: Date.now() - winMs, to: Date.now(),
      limit: upLimit, current: upConc, cap: settings.cap,
      points: pts, samples: history.length,
    }));
  }

  // 排队统计（仅管理员）
  if (p.startsWith('/df/queue/')) {
    if (!sess || sess.role !== 'admin') {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '需要管理员登录' }));
    }
    // 兼容旧壳注入页：/df/queue/stats → /queue/stats
    req.url = '/queue/' + p.slice('/df/queue/'.length) + (url.search || '');
    if (req.url === '/queue/stats') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(adminStats());
    }
    const winMs2 = Math.min(Math.max(Number(url.searchParams.get('window') ?? 900_000), 60_000), KEEP_DAYS * 86400_000);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ cap: settings.cap, from: Date.now() - winMs2, to: Date.now(), points: historyFor(winMs2), samples: history.length }));
  }
  if ((p === '/queue/stats' || p === '/queue/history') && (!sess || sess.role !== 'admin')) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '需要管理员登录' }));
  }
  if (p === '/queue/stats') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(adminStats());
  }
  if (p === '/queue/history') {
    const winMs = Math.min(Math.max(Number(url.searchParams.get('window') ?? 900_000), 60_000), KEEP_DAYS * 86400_000);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ cap: settings.cap, from: Date.now() - winMs, to: Date.now(), points: historyFor(winMs), samples: history.length }));
  }

  if (p.startsWith('/df/')) return serveStatic(p, res);

  // ── GPT-Load 管理接口：仅管理员 ──
  if (p.startsWith('/api/') || p.startsWith('/assets/')) {
    if (!sess || sess.role !== 'admin') {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '需要管理员登录（东方API 门卫）' }));
    }
    return proxyAdmin(req, res);
  }

  // ── 网页路由：管理员 → 品牌壳管理台；用户 → 门户 ──
  if (req.method === 'GET' && isHtmlRoute(p, req)) {
    if (sess?.role === 'user') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(PORTAL_HTML);
    }
    return serveAdminHtml(req, res);
  }

  // 其他非网页 GET/HEAD（如 /v1/models）：直通
  if (!shouldQueue(req)) return passThrough(req, res);
  return enqueue(req, res);
});

// WebSocket：直通
server.on('upgrade', (req, socket, head) => {
  const up = http.request({
    host: UP_HOST, port: UP_PORT, path: req.url, method: req.method,
    headers: { ...cleanHeaders(req.headers), connection: 'Upgrade', upgrade: req.headers.upgrade },
  });
  up.on('upgrade', (ur, usocket, uhead) => {
    socket.write(`HTTP/1.1 101 ${ur.statusMessage}\r\n` + Object.entries(ur.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
    if (uhead?.length) socket.write(uhead);
    usocket.pipe(socket); socket.pipe(usocket);
    usocket.on('error', () => socket.destroy());
    socket.on('error', () => usocket.destroy());
  });
  up.on('error', () => { try { socket.destroy(); } catch {} });
  up.end();
});

server.headersTimeout = 0;
server.requestTimeout = 0;
server.keepAliveTimeout = 65_000;

await loadAuthKey();
if (!AUTH_KEY) log('warn: AUTH_KEY 未读到');
// 2026-10-18 关键修复：启动时必须先加载 settings.json 再 applySettings。
// 此前只调用 applySettings()、从不调 loadSettings()，于是每次重启都回落到代码默认值
// （cap 10 / userQueueMax 20 / maxWait 180000），页面保存的值一重启就失效——
// 这就是「把出口并发设成 20 但没变化」的真正原因。
await loadSettings();
applySettings();
log(`settings loaded: cap=${settings.cap} userQueueMax=${settings.userQueueMax} maxWaitMs=${settings.maxWaitMs}`);
await loadSecret();
await loadHistory();
await syncCaps();
setInterval(syncCaps, 30_000);
setInterval(() => { sweepStaleActive(); pump(); }, 30_000);   // 自愈：回收漏减名额并补排
await sampleSelf();
setInterval(sampleSelf, SAMPLE_MS);
probeAll().catch(() => {});
setInterval(() => probeAll().catch(() => {}), PROBE_INTERVAL_MS_REF.ms);

// ── 死连接自愈看护（2026-10-18 运维加）──────────────────────────────────────
// 判据：gpt-load 侧 /api/home 可读(upstreamOk) 且 并发=0，但本层在飞 ≥5，连续 2 分钟
//   → 请求没有真正进入上游（死 socket / 半关闭连接）。处置：记录 + 自愈重启（vbs 1 秒内拉起）。
// 熔断：30 分钟内最多自愈 3 次，超过则只告警不重启，避免与真实上游故障形成重启风暴。
const HEAL_FILE = path.join(DATA, '.stall-heal.json');
const HEAL_WINDOW_MS = 30 * 60_000, HEAL_MAX = 3, STALL_MS = 120_000;
let stallSince = 0, healBusy = false;
async function healTrip(o, c) {
  if (healBusy) return;
  healBusy = true;
  try {
    let hist = [];
    try { hist = JSON.parse(await readFile(HEAL_FILE, 'utf8')); } catch {}
    const now = Date.now();
    hist = (Array.isArray(hist) ? hist : []).filter((t) => now - Number(t) < HEAL_WINDOW_MS);
    if (hist.length >= HEAL_MAX) {
      log(`WATCHDOG 熔断：30 分钟内已自愈 ${hist.length} 次，本次只告警不重启（在飞 ${o}, 上游并发 ${c}）`);
      return;
    }
    hist.push(now);
    await writeFile(HEAL_FILE, JSON.stringify(hist), 'utf8').catch(() => {});
    log(`WATCHDOG 触发：在飞 ${o} 但 gpt-load 并发 0 持续 ${Math.round(STALL_MS / 1000)}s（30 分钟内第 ${hist.length} 次）→ 自愈重启`);
    // 2026-10-18 Chief 要求：自愈重启会打断各 Bot 的 turn，必须落盘可对账。
    // 记录：触发时刻(UTC)、当时在飞数、上游并发数、被中断的请求数、排队数。
    try {
      const qn = queuedTotal();
      const utc = new Date(now).toISOString().replace('.000Z', 'Z');
      const line = `${utc} | WATCHDOG 自愈重启 | 释放 0 MB | 余 n/a | 触发判据：在飞 ${o} 且上游并发 ${c} = 0 持续 ${Math.round(STALL_MS / 1000)}s（30 分钟内第 ${hist.length} 次）；被中断请求 ${o} 个；排队 ${qn} 个；3001 将在 0.5s 内退出并由 start-queue.vbs 拉起\n`;
      await appendFile('C:/AI/ops-watch/ops-log.md', line, 'utf8').catch(() => {});
    } catch {}
    setTimeout(() => process.exit(75), 500);
  } finally {
    healBusy = false;
  }
}
setInterval(() => {
  const o = inFlightCount();
  if (upstreamOk && upConc === 0 && o >= 5) {
    if (!stallSince) stallSince = Date.now();
    else if (Date.now() - stallSince >= STALL_MS) { stallSince = 0; healTrip(o, upConc); }
  } else stallSince = 0;
}, 30_000);

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  log(`东方API 网关 :${LISTEN_PORT}  cap=${CAP}  管理台+用户门户+API 三合一 -> ${UP_HOST}:${UP_PORT}`);
});
