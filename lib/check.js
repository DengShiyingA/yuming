// 域名注册状态查询核心：RDAP 优先，WHOIS 兜底，DNS 最后兜底。
// 覆盖 IANA 根区里的全部后缀（gTLD / ccTLD / 新 gTLD / IDN）。
import net from 'node:net';
import http2 from 'node:http2';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { domainToASCII, domainToUnicode } from 'node:url';

const CACHE_DIR = path.resolve(import.meta.dirname, '..', '.cache');
const DAY = 24 * 3600 * 1000;
const DEBUG = !!process.env.DEBUG;

// ---------- 通用工具 ----------

// 并发上限 + 两次请求之间的最小间隔
function limiter(max, gapMs = 0) {
  let active = 0, lastStart = 0, timer = null;
  const queue = [];
  const next = () => {
    // 排队超过期限的直接放弃（调用方会改用其他办法），不让一个请求无限等下去
    while (queue.length && queue[0].deadline && Date.now() > queue[0].deadline) queue.shift().reject(new Error('排队超时'));
    if (timer || active >= max || !queue.length) return;
    const wait = lastStart + run.gap - Date.now();
    if (wait > 0) { timer = setTimeout(() => { timer = null; next(); }, wait); return; }
    active++;
    lastStart = Date.now();
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
    next();
  };
  const run = (fn, deadline = 0) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject, deadline }); next(); });
  const baseGap = gapMs, baseMax = max;
  run.gap = gapMs;
  run.stats = () => ({ active, queued: queue.length, gap: Math.round(run.gap), max });
  // 自适应节奏：被限流就间隔翻倍并改单并发；每次成功缩短 3%，逐步回到初始速度。
  // 每家注册局最终会稳定在它能承受的最快速度附近（如 Google 约每秒 1 次）。每次成功缩短 15%，限流过后很快恢复。
  run.slowDown = () => { run.gap = Math.min(Math.max(run.gap * 2, 1000), 8000); max = 1; };
  run.speedUp = () => {
    if (run.gap <= baseGap) return;
    run.gap = Math.max(baseGap, run.gap * 0.85);
    if (run.gap < 500) max = baseMax;
  };
  return run;
}

// 每个上游主机单独限速，避免被注册局封 IP。
// Identity Digital（.info/.tv/.vip/.pro 等约 300 个后缀共用）对“查不到的域名”限流很严，
// 超限会被 Cloudflare 封 IP 约 24 小时，所以单独放慢。
const HOST_PACE = {
  'rdap.identitydigital.services': [1, 1500],
  // GoDaddy Registry（rdap.nic.<后缀>，几百个后缀共用）实测每秒 1 次稳定
  'rdap.nic.biz': [2, 800],
  // Google（.app/.dev/.page 等约 46 个后缀）实测每秒约 1 次，超过会 429
  'pubapi.registry.google': [2, 1000],
  'whois.iana.org': [2, 200],
};
const hostLimiters = new Map();
function perHost(host, max, fn, deadline = 0) {
  if (!hostLimiters.has(host)) {
    // 配置按主机名写，限速器按后端建：主机名指向同一后端的配置也算
    const pace = HOST_PACE[host] || Object.entries(HOST_PACE).find(([h]) => backends?.[h] === host)?.[1];
    const [m, gap] = pace || [Math.min(max, 3), 250];
    hostLimiters.set(host, limiter(m, gap));
  }
  return hostLimiters.get(host)(fn, deadline);
}
// 调试用：各上游主机的并发、排队和当前节奏
export function hostStats() {
  const out = {};
  for (const [h, l] of hostLimiters) { const s = l.stats(); if (s.active || s.queued) out[h] = s; }
  return out;
}
function slowDownHost(host) { hostLimiters.get(host)?.slowDown(); }
function speedUpHost(host) { hostLimiters.get(host)?.speedUp(); }
function isSlowed(host) { return (hostLimiters.get(host)?.gap || 0) >= 4000; }

// 很多主机名其实是同一家注册局的后端：GoDaddy Registry 用 rdap.nic.<后缀> 运营几百个后缀，
// 全都 CNAME 到同一个服务，共享同一个限流额度。限速和冷却必须按“真实后端”算，否则会被成片限流。
// 后端 = 主机名 CNAME 链的终点；没有 CNAME 就用主机名本身（不按 IP 合并，CDN 上不相关的站点会共用 IP）。
let backends = null;
const backendPending = new Map();
let warmed = null;
async function backendOf(host) {
  backends ??= (await readCache('backends.json', 30 * DAY)) || {};
  // 先解析限速配置里的主机名，后面按后端反查配置时才对得上
  warmed ??= Promise.all(Object.keys(HOST_PACE).map(resolveBackend));
  await warmed;
  return resolveBackend(host);
}
async function resolveBackend(host) {
  if (backends[host]) return backends[host];
  if (!backendPending.has(host)) {
    backendPending.set(host, (async () => {
      let key = host;
      try {
        const res = await fetchWithTimeout(`https://cloudflare-dns.com/dns-query?name=${host}&type=A`, 5000, { headers: { accept: 'application/dns-json' } });
        const cnames = ((await res.json()).Answer || []).filter((a) => a.type === 5);
        if (cnames.length) key = cnames[cnames.length - 1].data.replace(/\.$/, '').toLowerCase();
      } catch { /* 查不到就按主机名单独算 */ }
      backends[host] = key;
      writeCache('backends.json', backends).catch(() => {});
      return key;
    })().finally(() => backendPending.delete(host)));
  }
  return backendPending.get(host);
}

// 给前端用：每个后缀属于哪个注册局后端。前端按后端分组控制并发，
// 让 GoDaddy 这种一家管几百个后缀的注册局按自己的速度稳定推进，而不是堆一大队然后超时。
const dohLimit = limiter(8, 0);
export async function backendsFor(suffixes) {
  const rdapMap = await getRdapMap();
  const out = {};
  await Promise.all([...new Set(suffixes)].slice(0, 2000).map(async (sfx) => {
    const tld = domainToASCII(String(sfx).split('.').pop() || '');
    const rdap = rdapMap[tld];
    out[sfx] = rdap ? await dohLimit(() => backendOf(new URL(rdap).host)) : 'whois:' + tld;
  }));
  return out;
}

// 预估查询耗时：counts = { 后缀: 域名数 }。
// 每家注册局按它当前的节奏（并发、间隔、是否被封）算各自要多久，各家并行，取最慢的那家；
// 再和前端总并发的上限比一比，取大的。被封禁的注册局直接走 DNS，很快。
const LATENCY = 1.2;          // 单次查询大约 1.2 秒
const CLIENT_CONCURRENCY = 24; // 前端总并发
const CLIENT_PER_BACKEND = 3;  // 前端每家注册局最多同时 3 个
export async function estimate(counts) {
  const tlds = Object.keys(counts || {});
  const map = await backendsFor(tlds);
  const perBackend = new Map();
  for (const t of tlds) {
    const key = map[t];
    perBackend.set(key, (perBackend.get(key) || 0) + Number(counts[t] || 0));
  }
  let slowest = { backend: '', count: 0, seconds: 0 };
  let total = 0;
  for (const [key, n] of perBackend) {
    total += n;
    let rate; // 每秒能查几个
    if (key.startsWith('whois:')) rate = 2 / LATENCY;
    else if (await getCooldown(key)) rate = 5; // 被封期间直接用 DNS 判断
    else {
      const l = hostLimiters.get(key);
      const pace = HOST_PACE[key] || Object.entries(HOST_PACE).find(([h]) => backends?.[h] === key)?.[1];
      const max = l ? l.stats().max : pace ? pace[0] : 3;
      const gap = l ? l.gap : pace ? pace[1] : 250;
      rate = Math.min(max / LATENCY, 1000 / gap);
    }
    rate = Math.min(rate, CLIENT_PER_BACKEND / LATENCY);
    const sec = n / rate;
    if (sec > slowest.seconds) slowest = { backend: key, count: n, seconds: sec };
  }
  const seconds = Math.max(slowest.seconds, total / (CLIENT_CONCURRENCY / LATENCY));
  return { seconds: Math.round(seconds), total, slowest: { ...slowest, seconds: Math.round(slowest.seconds) } };
}

// 被注册局长时间封禁的主机：记下解封时间，期间直接跳过，重试只会延长封禁
let cooldowns = null;
async function getCooldown(host) {
  cooldowns ??= (await readCache('cooldowns.json', 2 * DAY)) || {};
  // 兼容按主机名记下的旧冷却：指向同一后端的取最晚的那个
  let until = cooldowns[host] || 0;
  for (const [h, t] of Object.entries(cooldowns)) if (backends?.[h] === host && t > until) until = t;
  return until > Date.now() ? until : 0;
}
async function setCooldown(host, until) {
  cooldowns ??= {};
  cooldowns[host] = until;
  await writeCache('cooldowns.json', cooldowns).catch(() => {});
}
function fmtWait(ms) {
  const m = Math.ceil(ms / 60000);
  return m >= 60 ? `约 ${Math.round(m / 60)} 小时` : `约 ${m} 分钟`;
}

async function readCache(name, maxAge) {
  try {
    const file = path.join(CACHE_DIR, name);
    const st = await fs.stat(file);
    if (Date.now() - st.mtimeMs > maxAge) return null;
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch { return null; }
}

async function writeCache(name, data) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(path.join(CACHE_DIR, name), JSON.stringify(data));
}

async function fetchWithTimeout(url, ms, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal, redirect: 'follow' });
  } finally { clearTimeout(t); }
}

// 少数注册局（如 TWNIC）只接受 HTTP/2，fetch 走的是 HTTP/1.1 会拿到 426
function http2Get(url, headers, ms) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const client = http2.connect(u.origin);
    const timer = setTimeout(() => { client.destroy(); reject(new Error('HTTP/2 超时')); }, ms);
    const done = (fn, v) => { clearTimeout(timer); client.close(); fn(v); };
    client.on('error', (e) => done(reject, e));
    const req = client.request({ ':path': u.pathname + u.search, ...headers });
    let status = 0, body = '';
    req.setEncoding('utf8');
    req.on('response', (h) => { status = h[':status']; });
    req.on('data', (c) => { body += c; });
    req.on('end', () => done(resolve, { status, ok: status >= 200 && status < 300, json: async () => JSON.parse(body) }));
    req.on('error', (e) => done(reject, e));
  });
}

async function whoisQuery(host, query, ms = 12000) {
  const key = await backendOf(host);
  return perHost(key, 2, () => new Promise((resolve, reject) => {
    let data = '';
    const sock = net.connect(43, host, () => sock.write(query + '\r\n'));
    sock.setEncoding('utf8');
    sock.setTimeout(ms, () => { sock.destroy(); reject(new Error('WHOIS 超时')); });
    sock.on('data', (c) => { data += c; });
    sock.on('end', () => resolve(data));
    sock.on('close', () => resolve(data));
    sock.on('error', reject);
  }));
}

// ---------- 后缀数据（IANA） ----------

let tldListPromise;
export function getTldList() {
  tldListPromise ??= (async () => {
    const cached = await readCache('tlds.json', 7 * DAY);
    if (cached) return cached;
    const res = await fetchWithTimeout('https://data.iana.org/TLD/tlds-alpha-by-domain.txt', 15000);
    const text = await res.text();
    const list = text.split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#'));
    await writeCache('tlds.json', list);
    return list;
  })().catch((e) => { tldListPromise = null; throw e; });
  return tldListPromise;
}

let rdapMapPromise;
function getRdapMap() {
  rdapMapPromise ??= (async () => {
    let data = await readCache('rdap-dns.json', DAY);
    if (!data) {
      const res = await fetchWithTimeout('https://data.iana.org/rdap/dns.json', 15000);
      data = await res.json();
      await writeCache('rdap-dns.json', data);
    }
    const map = {};
    for (const [tlds, urls] of data.services) {
      const url = urls.find((u) => u.startsWith('https')) || urls[0];
      for (const t of tlds) map[t.toLowerCase()] = url.endsWith('/') ? url : url + '/';
    }
    return map;
  })().catch((e) => { rdapMapPromise = null; throw e; });
  return rdapMapPromise;
}

// 各后缀的 WHOIS 服务器，从 whois.iana.org 查询并持久缓存
let whoisServers = null;
const whoisServerPending = new Map();
async function getWhoisServer(tld) {
  whoisServers ??= (await readCache('whois-servers.json', 30 * DAY)) || {};
  if (tld in whoisServers) return whoisServers[tld];
  if (!whoisServerPending.has(tld)) {
    whoisServerPending.set(tld, (async () => {
      const text = await whoisQuery('whois.iana.org', tld);
      const m = text.match(/^whois:[ \t]*(\S+)/im);
      whoisServers[tld] = m ? m[1].toLowerCase() : null;
      await writeCache('whois-servers.json', whoisServers);
      return whoisServers[tld];
    })().finally(() => whoisServerPending.delete(tld)));
  }
  return whoisServerPending.get(tld);
}

// ---------- 输入规范化 ----------

export function normalizeDomain(input) {
  let s = String(input || '').trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');      // 去协议
  s = s.split(/[/?#]/)[0].replace(/:\d+$/, '');       // 去路径和端口
  s = s.replace(/^www\./, '').replace(/\.+$/, '').replace(/[。．｡]/g, '.');
  const ascii = domainToASCII(s);
  if (!ascii || !ascii.includes('.')) return null;
  if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(ascii)) return null;
  if (ascii.length > 253) return null;
  return { ascii, unicode: domainToUnicode(ascii), tld: ascii.split('.').pop() };
}

// ---------- RDAP ----------

function pickRdapInfo(j) {
  const ev = (a) => j.events?.find((e) => e.eventAction === a)?.eventDate || null;
  let registrar = null;
  for (const e of j.entities || []) {
    if (e.roles?.includes('registrar')) {
      const fn = e.vcardArray?.[1]?.find((v) => v[0] === 'fn');
      registrar = fn?.[3] || e.handle || null;
    }
  }
  return {
    registrar,
    created: ev('registration'),
    expires: ev('expiration'),
    updated: ev('last changed'),
    status: j.status || [],
    nameservers: (j.nameservers || []).map((n) => (n.ldhName || '').toLowerCase()).filter(Boolean),
  };
}

// hasWhois 是异步函数：只有被限流、需要决定是否改走 WHOIS 时才去查 WHOIS 服务器
async function checkRdap(base, domain, hasWhois, fresh = false, budget = Infinity) {
  const host = await backendOf(new URL(base).host);
  const url = base + 'domain/' + domain;
  const headers = { accept: 'application/rdap+json, application/json' };
  let blocked = await getCooldown(host);
  // 用户手动重试：短冷却（≤5 分钟，多是我们自己设的）就真去问一次；长封禁仍跳过，免得延长封禁
  if (blocked && fresh && blocked - Date.now() <= 5 * 60000) blocked = 0;
  // 短冷却且没有 WHOIS 可替代：等冷却结束再查，拿注册局的准确答案
  if (blocked && blocked - Date.now() <= 60000 && blocked < budget && !(await hasWhois())) {
    await new Promise((r) => setTimeout(r, blocked - Date.now()));
    blocked = 0;
  }
  if (blocked) throw new Error(`RDAP 限流：注册局限制了当前 IP 的查询，${fmtWait(blocked - Date.now())}后恢复`);
  const deadline = Math.min(Date.now() + 60000, budget);
  let res;
  // 短暂限流：放慢该主机节奏并退避重试，宁可慢也要拿到注册局的准确答案。
  // 只有 retry-after 超过 2 分钟（真正的封禁）才放弃，改用 DNS 兜底。
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      res = await perHost(host, 3, () => fetchWithTimeout(url, 12000, { headers }), deadline);
      if (res.status === 426) res = await perHost(host, 3, () => http2Get(url, headers, 12000), deadline);
    } catch (e) {
      if (e.message === '排队超时') throw new Error('RDAP 限流：注册局正在限流，排队太久，请稍后重试');
      throw e;
    }
    if (DEBUG) console.log(new Date().toISOString().slice(11, 19), 'RDAP', res.status, domain, `attempt=${attempt}`);
    if (![403, 429, 500, 502, 503, 504].includes(res.status)) { speedUpHost(host); break; }
    const retryAfter = Number(res.headers?.get?.('retry-after')) * 1000;
    if (retryAfter > 120000) {
      await setCooldown(host, Date.now() + retryAfter);
      throw new Error(`RDAP 限流：注册局限制了当前 IP 的查询，${fmtWait(retryAfter)}后恢复`);
    }
    if ([403, 429].includes(res.status)) {
      slowDownHost(host);
      // 有 WHOIS 就别在这排队：短冷却 RDAP，本次和后续请求都改走 WHOIS
      if (await hasWhois()) {
        await setCooldown(host, Date.now() + Math.max(retryAfter, 60000));
        throw new Error('RDAP 限流，已改用 WHOIS');
      }
    }
    const wait = retryAfter || Math.min(2000 * 2 ** attempt, 20000);
    if (Date.now() + wait > deadline) break;
    await new Promise((r) => setTimeout(r, wait));
  }
  if ([403, 429].includes(res.status)) {
    // 等过也没恢复：冷却 5 分钟，后续请求直接给结果，不再每个都等
    await setCooldown(host, Date.now() + 5 * 60000);
    throw new Error('RDAP 限流：注册局限制了当前 IP 的查询，约 5 分钟后恢复');
  }
  if (res.status === 404) return { status: 'available', source: 'RDAP' };
  if (res.ok) {
    const j = await res.json().catch(() => ({}));
    return { status: 'registered', source: 'RDAP', info: pickRdapInfo(j) };
  }
  throw new Error('RDAP HTTP ' + res.status);
}

// ---------- WHOIS ----------

const AVAILABLE_PATTERNS = [
  /no match/i, /not found/i, /no found/i, /no data found/i, /no entries found/i, /no object found/i,
  /nothing found/i, /no matching record/i, /not registered/i, /is available/i, /is free/i,
  /\bstatus:\s*(free|available)\b/i, /^%% no entries/im, /no data was found/i, /does not exist/i, /no information available/i,
  /domain unknown/i, /no such domain/i, /not been registered/i, /object_not_found/i,
  /the domain has not been registered/i, /available for registration/i, /未注册|没有匹配/,
];
// 只在非注释行里匹配，免责声明里常有 restricted / prohibited 之类的词
const RESERVED_PATTERNS = [/\bstatus:\s*(reserved|blocked|restricted|prohibited)/i, /\bis reserved\b/i, /^\s*reserved\b/im,
  /reserved (domain|name|by)/i, /not available for registration/i, /violates registry policy/i, /cannot be registered/i,
  /\b(platinum|premium) (domain|name)\b.*\bavailable for purchase/i, /make an offer/i,
  // 品牌保护屏蔽（如 Identity Digital DPML）：商标方付费把名字在整家注册局屏蔽
  /registration of this domain is restricted/i, /\bDPML\b|brand protection|blocked by .*(trademark|brand)/i];
const LIMIT_PATTERNS = [/limit exceeded/i, /too many (requests|queries)/i, /quota exceeded/i, /try again later/i,
  /access denied/i, /allowed queries exceeded/i, /not permitted/i, /exceeded/i, /rate limit/i,
  /interval is too short/i]; // CNNIC（.cn）查得太快时的回复

// 部分注册局要求特殊查询格式
const WHOIS_QUERY = {
  'whois.denic.de': (d) => `-T dn,ace ${d}`,
  'whois.jprs.jp': (d) => `${d}/e`,
  'whois.nic.ad.jp': (d) => `${d}/e`,
};

function field(text, ...names) {
  for (const n of names) {
    const m = text.match(new RegExp(`^\\s*(?:[a-z]\\.\\s*)?\\[?${n}(?:\\s*:\\s*|\\]\\s+)(.+)$`, 'im'));
    if (m) return m[1].trim();
  }
  return null;
}

function parseWhois(text) {
  return {
    registrar: field(text, 'Registrar', 'Sponsoring Registrar', 'registrar name', 'Registrar Name'),
    created: field(text, 'Creation Date', 'Created', 'Registration Time', 'created', 'Registered on', 'Domain Registration Date'),
    expires: field(text, 'Registry Expiry Date', 'Expiration Date', 'Expiration Time', 'Expiry date', 'expires', 'paid-till', 'Expiry Date'),
    status: [],
    nameservers: [...text.matchAll(/^\s*(?:Name Server|nserver|Nameservers?)\s*:\s*(\S+)/gim)].map((m) => m[1].toLowerCase()),
  };
}

async function checkWhois(server, domain) {
  const q = (WHOIS_QUERY[server] || ((d) => d))(domain);
  return classifyWhois(await whoisQuery(server, q));
}

// 根据 WHOIS 原文判断状态（纯函数，不联网，回归测试直接拿真实回复样本来测）
export function classifyWhois(text) {
  if (!text.trim()) throw new Error('WHOIS 空响应');
  if (/tld is not supported|whois service has been (retired|discontinued|decommissioned)/i.test(text)) throw new Error('WHOIS 已停服');
  const body = text.split('\n').filter((l) => !/^\s*[%#;]/.test(l)).join('\n');
  if (LIMIT_PATTERNS.some((p) => p.test(body)) && body.trim().length < 400) throw new Error('WHOIS 拒绝查询/频率受限');
  // 已注册的域名响应里通常有这些字段，先判断，避免免责声明里的 "not found" 误判
  // 兼容 "Field: value" 与 JPRS 的 "a. [Field]  value" 两种格式
  const fieldLine = (names) => new RegExp(`^\\s*(?:[a-z]\\.\\s*)?\\[?(?:${names})\\]?(?:\\s*:\\s*|\\]?\\s{2,})\\S`, 'im');
  const hasRecord = fieldLine('domain name|domain|domain information').test(text)
    && fieldLine('creation date|created|registered date|registration time|registrar|registrant|nserver|name server|expir\\w* date').test(text);
  // 刚删除的域名进入释放期（如 Identity Digital Dropzone），只能经注册商申请/竞拍，不能直接注册
  if (!hasRecord && /dropzone|available for application|pending ?delete|redemption period/i.test(body)) {
    return { status: 'dropzone', source: 'WHOIS', raw: text,
      note: '刚删除、处于释放期：不能直接注册，需通过支持的注册商提交申请，多人申请则竞拍' };
  }
  // 保留词要先于“可注册”判断：如 Identity Digital 的白金域名会写 "available for purchase ... reserved by the Registry"
  if (!hasRecord && RESERVED_PATTERNS.some((p) => p.test(body))) {
    const offer = /make an offer|available for purchase|platinum|premium/i.test(body);
    const brand = /DPML|brand protection|trademark/i.test(body);
    return { status: 'reserved', source: 'WHOIS', raw: text,
      note: brand ? '被商标方的品牌保护屏蔽（如 DPML），普通人不能注册'
        : offer ? '注册局保留的白金/溢价域名，不能普通注册，只能向注册局报价购买' : '注册局保留，不开放注册' };
  }
  if (!hasRecord && AVAILABLE_PATTERNS.some((p) => p.test(text))) {
    return { status: 'available', source: 'WHOIS', raw: text };
  }
  if (hasRecord) return { status: 'registered', source: 'WHOIS', info: parseWhois(text), raw: text };
  // 看不懂的响应宁可交给 DNS 兜底，也不猜“已注册”
  throw new Error('WHOIS 响应无法识别');
}

// ---------- DNS 兜底（DoH，不依赖本机解析器） ----------

const DOH = [
  (d) => `https://cloudflare-dns.com/dns-query?name=${d}&type=NS`,
  (d) => `https://dns.google/resolve?name=${d}&type=NS`,
];

async function checkDns(domain) {
  for (const u of DOH) {
    try {
      const res = await fetchWithTimeout(u(domain), 8000, { headers: { accept: 'application/dns-json' } });
      const j = await res.json();
      if (j.Status === 3) return { status: 'likely-available', source: 'DNS' };
      if (j.Status === 0) {
        const ns = (j.Answer || []).filter((a) => a.type === 2).map((a) => a.data.replace(/\.$/, ''));
        // 有 NS 或存在该名字但无 NS 记录（名字已被委派/注册）
        // NOERROR 就说明这个名字在 DNS 里存在（有记录或有子域），不可能是空闲域名
        return { status: 'registered', source: 'DNS', info: { nameservers: ns } };
      }
      // SERVFAIL 且提示“在委派处无可达权威”：父区已把它委派出去，说明已注册（只是对方 DNS 坏了）
      if (j.Status === 2 && (j.Comment || []).some((c) => /delegation/i.test(c))) {
        return { status: 'registered', source: 'DNS', info: { nameservers: [] }, note: '已委派但 DNS 无响应' };
      }
    } catch { /* 换下一个 DoH */ }
  }
  return { status: 'unknown', source: 'DNS' };
}

// ---------- 主入口 ----------

// 结果缓存：内存 + 磁盘（.cache/results.json），重启服务、几小时内重查同一批都直接用，少打扰注册局
const HOUR = 3600 * 1000;
const resultCache = new Map();
// 不同结果能放多久：已注册的很稳定；快到期、可注册、释放期的随时会变
function ttlOf(result) {
  if (result.status === 'registered') {
    const exp = Date.parse(result.info?.expires || '');
    return exp && exp - Date.now() < 30 * DAY ? HOUR : 24 * HOUR;
  }
  if (result.status === 'reserved' || result.status === 'premium') return 24 * HOUR;
  return HOUR; // available、dropzone 等
}
let cacheLoaded = null;
let cacheDirty = false;
function loadResultCache() {
  cacheLoaded ??= (async () => {
    const saved = await readCache('results.json', 2 * DAY);
    for (const [k, v] of Object.entries(saved || {})) if (Date.now() < v.until) resultCache.set(k, v);
  })();
  return cacheLoaded;
}
// 每 30 秒把有变化的缓存写回磁盘，顺便清掉过期项
setInterval(() => {
  if (!cacheDirty) return;
  cacheDirty = false;
  const out = {};
  for (const [k, v] of resultCache) if (Date.now() < v.until) out[k] = v; else resultCache.delete(k);
  writeCache('results.json', out).catch(() => {});
}, 30000).unref();
// 停服务（Ctrl+C / kill）时同步写一次，不丢最后 30 秒的结果
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    try {
      const out = {};
      for (const [k, v] of resultCache) if (Date.now() < v.until) out[k] = v;
      fsSync.mkdirSync(CACHE_DIR, { recursive: true });
      fsSync.writeFileSync(path.join(CACHE_DIR, 'results.json'), JSON.stringify(out));
    } catch { /* 写不了就算了 */ }
    process.exit(0);
  });
}

export async function checkDomain(input, { fresh = false } = {}) {
  const d = normalizeDomain(input);
  if (!d) return { domain: input, status: 'invalid', error: '域名格式不正确' };

  const tlds = await getTldList();
  if (!tlds.includes(d.tld)) return { domain: d.unicode, ascii: d.ascii, status: 'invalid', error: `.${d.tld} 不是存在的后缀` };

  await loadResultCache();
  const hit = !fresh && resultCache.get(d.ascii);
  if (hit && Date.now() < hit.until) return { ...hit.result, cached: true };

  const base = { domain: d.unicode, ascii: d.ascii, tld: d.tld };
  const errors = [];
  // 单个域名最多花 45 秒：拿不到注册局答案就先给 DNS 判断，之后可用“重试未确认”补查
  const budget = Date.now() + 45000;
  let result = null;

  const rdap = (await getRdapMap())[d.tld];
  // WHOIS 服务器按需查：RDAP 正常时完全不碰 whois.iana.org，查“全部后缀”时省掉上千次查询
  const whoisServer = () => getWhoisServer(d.tld).catch(() => null);
  if (rdap) {
    try { result = await checkRdap(rdap, d.ascii, async () => !!(await whoisServer()), fresh, budget); } catch (e) { errors.push(e.message); }
  }
  if (!result) {
    try {
      const server = await whoisServer();
      if (server) result = await checkWhois(server, d.ascii);
      else errors.push('该后缀无公开 WHOIS');
    } catch (e) {
      errors.push(e.message);
      // gTLD 的 WHOIS 陆续停服，记下来，之后限流时不再指望它
      if (e.message === 'WHOIS 已停服') { whoisServers[d.tld] = null; writeCache('whois-servers.json', whoisServers).catch(() => {}); }
    }
  }
  // WHOIS 也被拒（同一家注册局，如 .top），RDAP 只是短冷却：等它恢复再查一次，别急着退回 DNS 猜
  if (!result && rdap) {
    const backend = await backendOf(new URL(rdap).host);
    const until = await getCooldown(backend);
    if (until && until - Date.now() <= 60000 && until < budget && !isSlowed(backend)) {
      try { result = await checkRdap(rdap, d.ascii, async () => false, false, budget); } catch (e) { errors.push(e.message); }
    }
  }
  if (!result) {
    result = await checkDns(d.ascii);
    // 注册局拒绝查询时只能凭 DNS：查无记录大概率可注册，但有少数“已注册未解析”的域名，注明让用户下单前确认
    // 只能凭 DNS 时，写清楚为什么没拿到注册局的答案
    if (result.status === 'likely-available' && errors.length) {
      const limited = errors.find((e) => e.startsWith('RDAP 限流：'));
      const why = limited ? limited.slice('RDAP 限流：'.length)
        : errors.some((e) => /无法识别/.test(e)) ? '注册局返回了无法识别的结果'
        : errors.some((e) => /拒绝|超时/.test(e)) ? '注册局暂时拒绝查询'
        : '该后缀无公开查询接口';
      result = { ...result, note: `${why}；DNS 无记录，大概率可注册，下单前请确认` };
    }
  }

  // 1–2 个字符的域名：几乎都被注册局保留或按溢价出售，而 RDAP 对保留词也返回 404，接口区分不了
  const label = domainToUnicode(d.ascii.split('.')[0]);
  if ([...label].length <= 2 && (result.status === 'available' || result.status === 'likely-available')) {
    result = { ...result, status: 'premium', note: `${[...label].length} 个字符的域名通常被注册局保留或按溢价出售，查询接口无法区分，请到注册商确认能否注册及价格` };
  }

  result = { ...base, ...result, errors: errors.length ? errors : undefined, checkedAt: new Date().toISOString() };
  // 只缓存注册局给出的确定答案；靠 DNS 猜的、没查到的不缓存，方便过会儿重试
  if (result.source !== 'DNS') {
    resultCache.set(d.ascii, { until: Date.now() + ttlOf(result), result });
    cacheDirty = true;
  }
  return result;
}
