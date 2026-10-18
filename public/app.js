// 页面逻辑：查询、后缀组、短域名、等级、关注列表等（由 index.html 引用）
const HOT = ['com','net','org','cn','com.cn','net.cn','io','ai','co','app','dev','xyz','top','me','cc','tv','info','biz','shop','site','online','tech','store','club','vip','pro','so','sh','to','gg','中国','网址','公司'];
const STATUS = {
  available: '可注册', 'likely-available': '可能可注册', premium: '疑似保留/溢价', dropzone: '释放期·需申请', registered: '已注册', reserved: '保留/受限',
  unknown: '无法确定', invalid: '无效', error: '查询失败', pending: '查询中',
};
const FILTERS = [['all','全部'],['available','可注册'],['registered','已注册'],['other','其他']];
// 服务端按注册局后端限速，客户端多开并发只是多排队，不会给注册局加压；但能让快的注册局不被慢的拖住
const CONCURRENCY = 24;
const RENDER_MAX = 500;

const $ = (id) => document.getElementById(id);
let allTlds = [];
// 关注列表（服务端定时检查，这里只负责显示和提醒）
let watchItems = [];
let watched = new Set();
let group = localGet('group') || 'hot';
if (!['hot', 'cc', 'g', 'all', 'custom'].includes(group)) group = 'hot';
// 短域名模式组合数会成倍放大，只用用户自选的后缀
function activeGroup() { return mode === 'short' ? 'custom' : group; }
// 自定义选中的后缀，统一存 ASCII（xn--）形式
let picked = new Set(loadPicked());
let pkQuery = '';
let pkOpen = localGet('pkOpen') !== '0';
function setPkOpen(v) { pkOpen = v; localSet('pkOpen', v ? '1' : '0'); }
function loadPicked() {
  const raw = localGet('pickedTlds');
  if (raw) { try { return JSON.parse(raw); } catch {} }
  return ['com', 'net', 'org', 'cn', 'io', 'ai'];
}
function savePicked() { localSet('pickedTlds', JSON.stringify([...picked])); }
let filter = 'all';
let rows = [];
let runId = 0;
let running = false;
let retrying = false;
let retryMsg = '';
let userStopped = false;
// 自动补查：因短时限流（几分钟）暂用 DNS 判断的，冷却结束后自动再查，最多三轮
let autoTimer = null, autoAt = 0, autoRounds = 0;

function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
function toAscii(t) { try { return new URL('http://a.' + t).hostname.slice(2); } catch { return t; } }
// 浏览器不提供 punycode 解码，这里用 RFC 3492 的标准实现
function punyDecode(input) {
  const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
  const out = []; let n = 128, i = 0, bias = 72;
  let b = input.lastIndexOf('-'); if (b < 0) b = 0;
  for (let j = 0; j < b; j++) out.push(input.charCodeAt(j));
  const adapt = (delta, num, first) => {
    let k = 0; delta = first ? Math.floor(delta / damp) : delta >> 1; delta += Math.floor(delta / num);
    for (; delta > ((base - tMin) * tMax) >> 1; k += base) delta = Math.floor(delta / (base - tMin));
    return Math.floor(k + (base - tMin + 1) * delta / (delta + skew));
  };
  for (let idx = b > 0 ? b + 1 : 0; idx < input.length;) {
    const oldi = i;
    for (let w = 1, k = base; ; k += base) {
      const c = input.charCodeAt(idx++);
      const digit = c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : base;
      i += digit * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (digit < t) break;
      w *= base - t;
    }
    bias = adapt(i - oldi, out.length + 1, oldi === 0);
    n += Math.floor(i / (out.length + 1)); i %= out.length + 1;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}
function puny(t) {
  try { return t.split('.').map((l) => l.startsWith('xn--') ? punyDecode(l.slice(4)) : l).join('.'); } catch { return t; }
}

function groups() {
  const cc = allTlds.filter((t) => t.length === 2);
  const g = allTlds.filter((t) => t.length > 2);
  return [
    ['hot', '热门', HOT],
    ['cc', '国家/地区', cc],
    ['g', '通用及新后缀', g],
    ['all', '全部后缀', allTlds],
    ['custom', '自定义', [...picked]],
  ];
}

function renderGroups() {
  const box = $('groups');
  box.querySelectorAll('.chip').forEach((c) => c.remove());
  box.querySelector('.label').textContent = mode === 'short' ? '后缀（自选，查询数 = 组合数 × 后缀数）' : '后缀组';
  if (mode === 'short') { $('picker').hidden = false; renderPicker(); renderShortInfo(); return; }
  for (const [key, label, list] of groups()) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip';
    b.setAttribute('aria-pressed', key === group);
    b.innerHTML = label + (list ? `<small>${list.length || (key === 'custom' ? 0 : '…')}</small>` : '');
    b.onclick = () => {
      if (group === key) setPkOpen(!pkOpen);
      else { group = key; localSet('group', key); $('pkSearch').value = pkQuery = ''; setPkOpen(true); }
      renderGroups();
    };
    box.appendChild(b);
  }
  $('picker').hidden = false;
  renderPicker();
  renderShortInfo();
  scheduleEstimate();
}

function currentTlds() {
  if (activeGroup() === 'custom') {
    return [...picked];
  }
  return groups().find((g) => g[0] === activeGroup())[2];
}

// 只查等级：低于这个等级的直接跳过，不请求注册局（只作用于“名字 × 后缀”展开出来的，手动输入的完整域名照查）
const QG_ORDER = { S: 5, A: 4, B: 3, C: 2, D: 1 };
function queryGrade() { return $('queryGrade').value; }
function gradePass(domain, g = queryGrade()) {
  return !g || (QG_ORDER[domainGrade(domain).level] || 0) >= QG_ORDER[g];
}
function expand(input) {
  const tokens = input.split(/[\s,，、;；]+/).map((t) => t.trim()).filter(Boolean);
  const out = [];
  for (const t of tokens) {
    if (t.replace(/^https?:\/\//i, '').replace(/[。．｡]/g, '.').includes('.')) out.push(t);
    else for (const tld of currentTlds()) { const d = `${t}.${puny(tld)}`; if (gradePass(d)) out.push(d); }
  }
  return [...new Set(out.map((d) => d.toLowerCase()))];
}

function isOther(s) { return !['available','likely-available','registered','pending'].includes(s); }
// 等级筛选：和状态筛选叠加
const GRADE_ORDER = { S: 5, A: 4, B: 3, C: 2, D: 1 };
const GRADE_FILTERS = [['', '全部等级'], ['S', 'S'], ['A', 'A 及以上'], ['B', 'B 及以上']];
let minGrade = ['S', 'A', 'B'].includes(localGet('minGrade')) ? localGet('minGrade') : '';
function gradeOk(r, g = minGrade) {
  return !g || (GRADE_ORDER[gradeOf(r).level] || 0) >= GRADE_ORDER[g];
}
function matches(r) {
  if (!gradeOk(r)) return false;
  if (filter === 'all') return true;
  if (filter === 'available') return r.status === 'available' || r.status === 'likely-available';
  if (filter === 'registered') return r.status === 'registered';
  return isOther(r.status);
}

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d) ? s : d.toISOString().slice(0, 10);
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

function nameHtml(domain) {
  const i = domain.indexOf('.');
  return i < 0 ? esc(domain) : esc(domain.slice(0, i)) + `<span class="tld">${esc(domain.slice(i))}</span>`;
}

function rowHtml(r) {
  const info = r.info || {};
  const meta = [];
  if (r.status === 'registered') {
    if (info.registrar) meta.push(info.registrar);
    if (info.expires) meta.push('到期 ' + fmtDate(info.expires));
  }
  if (r.error) meta.push(r.error);
  if (r.note) meta.push(r.note);
  if (r.source) meta.push('via ' + r.source + (r.cached ? '（缓存）' : ''));
  const dl = [
    ['状态', STATUS[r.status] || r.status],
    ['来源', r.source],
    ['注册商', info.registrar],
    ['注册时间', fmtDate(info.created)],
    ['到期时间', fmtDate(info.expires)],
    ['DNS', (info.nameservers || []).join('\n')],
    ['状态码', (info.status || []).join(', ')],
    ['Punycode', r.ascii && r.ascii !== r.domain ? r.ascii : ''],
    ['等级', `${gradeOf(r).level} · ${gradeOf(r).score} 分（${gradeOf(r).reasons.join('，')}）`],
    ['备注', (r.errors || []).join('；')],
  ].filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd style="white-space:pre-line">${esc(v)}</dd>`).join('');
  return `<div class="main"><div><div class="name">${nameHtml(r.domain)}</div>
    <div class="meta">${esc(meta.join(' · '))}</div></div>
    <div class="right"><button type="button" class="star${watched.has(r.domain) ? ' on' : ''}" data-domain="${esc(r.domain)}" title="${watched.has(r.domain) ? '取消关注' : '关注：被释放时提醒我'}">${watched.has(r.domain) ? '★' : '☆'}</button><span class="grade g-${gradeOf(r).level}" title="${esc(gradeOf(r).reasons.join('，'))}">${gradeOf(r).level} ${gradeOf(r).score}</span>
    <span class="badge">${STATUS[r.status] || r.status}</span></div></div>
    <div class="detail"><dl>${dl}</dl></div>`;
}

// ---------- 预估时间 ----------
function fmtDuration(sec) {
  if (sec < 60) return '不到 1 分钟';
  if (sec < 3600) return `约 ${Math.round(sec / 60)} 分钟`;
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return `约 ${h} 小时${m ? ` ${m} 分钟` : ''}`;
}
// 常见注册局后端的叫法，让“最慢的是谁”看得懂
function backendName(key) {
  const known = [['verisign', 'Verisign（.com/.net）'], ['godaddy', 'GoDaddy Registry'], ['identitydigital', 'Identity Digital'],
    ['registry.google', 'Google'], ['centralnic', 'CentralNic'], ['nomgslb.uk', 'Nominet（.uk）'], ['gmoregistry', 'GMO'],
    ['zdnsgtld', 'ZDNS（.top 等）'], ['publicinterestregistry', 'PIR（.org）']];
  if (key.startsWith('whois:')) return `.${key.slice(6)} 的 WHOIS`;
  return (known.find(([k]) => key.includes(k)) || [, key])[1];
}
let estimateTimer = null, estimateSeq = 0;
function scheduleEstimate() {
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(updateEstimate, 400);
}
async function updateEstimate() {
  const el = $('estimate');
  let counts = null, total = 0;
  if (mode === 'short') {
    const p = shortPlan();
    if (p.perTld && p.total && p.total <= SHORT_MAX) { counts = {}; for (const [t, n] of Object.entries(p.perTld)) counts[toAscii(t).split('.').pop()] = (counts[toAscii(t).split('.').pop()] || 0) + n; total = p.total; }
  } else {
    const list = expand($('q').value);
    // 输入了名字但被等级筛光了，明确告诉用户，免得以为没反应
    if (!list.length && $('q').value.trim() && queryGrade()) {
      el.textContent = `按“只查等级”筛选后没有要查的域名，名字较长或不好读时等级偏低，可以放宽等级`;
      return;
    }
    if (list.length) { counts = {}; for (const d of list) { const t = toAscii(d.split('.').pop()); counts[t] = (counts[t] || 0) + 1; } total = list.length; }
  }
  if (!counts || !total) { el.textContent = ''; return; }
  const seq = ++estimateSeq;
  try {
    const r = await (await fetch('/api/estimate', { method: 'POST', body: JSON.stringify(counts) })).json();
    if (seq !== estimateSeq) return; // 已经有更新的输入了
    const head = mode === 'short' ? '' : `将查询 <b>${total.toLocaleString()}</b> 个域名，`;
    const slow = r.slowest?.backend && r.seconds >= 60
      ? `（最慢的是 ${esc(backendName(r.slowest.backend))}：${r.slowest.count.toLocaleString()} 个，${fmtDuration(r.slowest.seconds)}）` : '';
    el.innerHTML = `${head}预计 <b>${fmtDuration(r.seconds)}</b>${slow}`;
  } catch { el.textContent = ''; }
}

// 查询中：按实际速度估剩余时间
let etaStart = 0, etaTotal = 0, etaDone = 0;
function etaText() {
  const elapsed = (Date.now() - etaStart) / 1000;
  if (etaDone < 5 || elapsed < 3) return `已查 ${etaDone}/${etaTotal} · 正在估算剩余时间…`;
  const left = (etaTotal - etaDone) / (etaDone / elapsed);
  return `已查 ${etaDone.toLocaleString()}/${etaTotal.toLocaleString()} · 剩余${fmtDuration(left).replace('约 ', '约 ')}`;
}

// 等级只取决于域名本身，按域名缓存
const gradeCache = new Map();
function gradeOf(r) {
  if (!gradeCache.has(r.domain)) gradeCache.set(r.domain, window.domainGrade ? domainGrade(r.domain) : { score: 0, level: '-', reasons: [] });
  return gradeCache.get(r.domain);
}
let sortByGrade = localGet('sortByGrade') === '1';
function displayRows() {
  return sortByGrade ? [...rows].sort((a, b) => gradeOf(b).score - gradeOf(a).score) : rows;
}
$('sort').onclick = () => {
  sortByGrade = !sortByGrade;
  localSet('sortByGrade', sortByGrade ? '1' : '0');
  render();
};

function render() {
  $('sort').textContent = sortByGrade ? '按等级排序 ✓' : '按等级排序';
  const ul = $('results');
  ul.innerHTML = '';
  let shown = 0, hiddenCount = 0;
  for (const r of displayRows()) {
    if (!matches(r)) continue;
    // 短域名一次可能上万条，DOM 只画前 RENDER_MAX 条
    if (shown >= RENDER_MAX) { hiddenCount++; continue; }
    shown++;
    const li = document.createElement('li');
    li.className = `row s-${r.status}` + (r.open ? ' open' : '');
    li.innerHTML = rowHtml(r);
    li.querySelector('.main').onclick = (e) => {
      const star = e.target.closest('.star');
      if (star) { e.stopPropagation(); toggleWatch(star.dataset.domain); return; }
      r.open = !r.open; li.classList.toggle('open');
    };
    ul.appendChild(li);
  }
  $('empty').hidden = !rows.length || (shown > 0 && !hiddenCount);
  $('empty').textContent = hiddenCount ? `还有 ${hiddenCount.toLocaleString()} 条未显示，可切换筛选或“复制可注册”导出` : '没有符合筛选的结果';
  renderTabs();
}

function renderTabs() {
  const count = (k) => rows.filter((r) => { const f = filter; filter = k; const m = matches(r); filter = f; return m; }).length;
  $('tabs').innerHTML = FILTERS.map(([k, l]) => `<button type="button" data-k="${k}" class="${k === filter ? 'on' : ''}">${l}<b>${count(k)}</b></button>`).join('');
  $('tabs').querySelectorAll('button').forEach((b) => b.onclick = () => { filter = b.dataset.k; render(); });
  // 等级按钮上的数字：在当前状态筛选下，各等级档有多少条
  const gcount = (g) => rows.filter((r) => { const m = minGrade; minGrade = g; const ok = matches(r); minGrade = m; return ok; }).length;
  $('gradeTabs').innerHTML = GRADE_FILTERS.map(([g, l]) => `<button type="button" data-g="${g}" class="${g === minGrade ? 'on' : ''}">${l}<b>${gcount(g)}</b></button>`).join('');
  $('gradeTabs').querySelectorAll('button').forEach((b) => b.onclick = () => { minGrade = b.dataset.g; localSet('minGrade', minGrade); render(); });
  const done = rows.filter((r) => r.status !== 'pending').length;
  const failed = rows.filter(needsRetry).length;
  $('retry').hidden = !failed && !retryMsg;
  $('retry').disabled = running || !failed;
  $('retry').textContent = running && retrying ? '重试中…' : failed ? `重试未确认 ${failed}` : retryMsg;
  $('retry').title = retryMsg;
  const autoMsg = autoTimer && !running
    ? `注册局限流中，${new Date(autoAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 自动补查（第 ${autoRounds + 1}/3 轮）`
    : '';
  $('retryMsg').textContent = failed && !running ? (autoMsg || retryMsg) : '';
  $('progress').hidden = !running;
  $('eta').hidden = !running;
  if (running) $('eta').textContent = etaText();
  $('progress').firstElementChild.style.width = rows.length ? (done / rows.length * 100) + '%' : 0;
}

// 批量查询时结果来得很快，每 250ms 最多重绘一次，避免页面卡顿
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => requestAnimationFrame(() => { renderQueued = false; render(); saveRowsSoon(); }), 250);
}

async function check(domain, fresh) {
  try {
    const res = await fetch('/api/check?domain=' + encodeURIComponent(domain) + (fresh ? '&fresh' : ''));
    const j = await res.json();
    if (!res.ok) return { domain, status: 'error', error: j.error };
    return j;
  } catch (e) {
    return { domain, status: 'error', error: '网络错误' };
  }
}

async function run(list, startFilter) {
  const id = ++runId;
  running = true;
  userStopped = false;
  clearTimeout(autoTimer); autoTimer = null; autoRounds = 0;
  $('go').textContent = '停止'; $('go').classList.add('stop');
  filter = startFilter || (list.length > 1 ? filter : 'all');
  retryMsg = '';
  $('restored').hidden = true;
  rows = list.map((d) => ({ domain: d, status: 'pending' }));
  $('bar').hidden = false;
  await work(rows, id);
  if (!userStopped) scheduleAutoRetry();
}

// 从“约 4 分钟后恢复”“约 6 小时后恢复”里取出等待毫秒数
function waitMsOf(r) {
  const m = (r.errors || []).join(' ').match(/约 (\d+) (分钟|小时)/);
  return m ? Number(m[1]) * (m[2] === '小时' ? 3600000 : 60000) : null;
}

function scheduleAutoRetry() {
  clearTimeout(autoTimer); autoTimer = null;
  const waits = rows.filter(needsRetry).map(waitMsOf).filter((w) => w !== null && w <= 10 * 60000);
  if (!waits.length || autoRounds >= 3) { renderTabs(); return; }
  const wait = Math.max(...waits) + 15000;
  autoAt = Date.now() + wait;
  autoTimer = setTimeout(() => { autoTimer = null; autoRounds++; retryFailed(); }, wait);
  renderTabs();
}

// 逐个查询给定的行（新查询或重试失败项共用）
// 各注册局能承受的速度差很多（Google、GoDaddy 约每秒 1 次），而且一家常管几百个后缀。
// 按“注册局后端”分组，每家最多同时查 PER_BACKEND 个，其余并发去查别家：
// 快的不被慢的拖住，慢的按自己的速度稳定推进，不会堆出排队超时。
const PER_BACKEND = 3;
function suffixOf(domain) { return domain.slice(domain.indexOf('.') + 1); }
function groupKey(domain) { return suffixOf(domain); }
async function loadBackends(targets) {
  const tlds = [...new Set(targets.map((t) => t.domain.split('.').pop()))];
  try {
    const res = await fetch('/api/backends', { method: 'POST', body: JSON.stringify(tlds), signal: AbortSignal.timeout(20000) });
    const map = await res.json();
    return (domain) => map[domain.split('.').pop()] || suffixOf(domain);
  } catch {
    return groupKey; // 拿不到就退回按后缀分组
  }
}
async function schedule(targets, concurrency, task, cancelled, keyOf = groupKey) {
  const groups = new Map();
  for (const t of targets) {
    const k = keyOf(t.domain);
    if (!groups.has(k)) groups.set(k, { items: [], next: 0, inflight: 0 });
    groups.get(k).items.push(t);
  }
  const list = [...groups.values()];
  let rr = 0, left = targets.length;
  const waiters = [];
  const wakeAll = () => { while (waiters.length) waiters.shift()(); };
  const take = () => {
    // 轮流从各后缀取，跳过已到并发上限或已取完的
    for (let n = 0; n < list.length; n++) {
      const g = list[(rr + n) % list.length];
      if (g.next < g.items.length && g.inflight < PER_BACKEND) {
        rr = (rr + n + 1) % list.length;
        g.inflight++;
        return { g, item: g.items[g.next++] };
      }
    }
    return null;
  };
  const worker = async () => {
    while (left > 0 && !cancelled()) {
      const got = take();
      if (!got) {
        if (list.every((g) => g.next >= g.items.length)) return;
        await new Promise((r) => waiters.push(r));
        continue;
      }
      try { await task(got.item); } finally { got.g.inflight--; left--; wakeAll(); }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

async function work(targets, id, fresh) {
  etaStart = Date.now(); etaTotal = targets.length; etaDone = 0;
  render();
  const keyOf = await loadBackends(targets);
  if (id !== runId) return;
  await schedule(targets, CONCURRENCY, async (r) => {
    const res = await check(r.domain, fresh);
    if (id !== runId) return;
    etaDone++;
    Object.assign(r, res);
    scheduleRender();
  }, () => id !== runId, keyOf);
  if (id !== runId) return;
  stop();
}

// 查询失败、无法确定，或注册局限流只能凭 DNS 判断的，都值得过会儿再查一次
function needsRetry(r) {
  return r.status === 'error' || r.status === 'unknown' || (r.source === 'DNS' && (r.errors || []).some((e) => /限流|拒绝/.test(e)));
}

async function retryFailed() {
  if (running) return;
  const targets = rows.filter(needsRetry);
  if (!targets.length) return;
  clearTimeout(autoTimer); autoTimer = null;
  userStopped = false;
  for (const r of targets) { for (const k of Object.keys(r)) if (k !== 'domain') delete r[k]; r.status = 'pending'; }
  const id = ++runId;
  running = true;
  retryMsg = '';
  retrying = true;
  $('go').textContent = '停止'; $('go').classList.add('stop');
  await work(targets, id, true);
  retrying = false;
  const left = rows.filter(needsRetry);
  if (left.length) {
    // 告诉用户为什么还没确认，免得以为按钮没反应
    const longest = Math.max(0, ...left.map(waitMsOf).filter((w) => w !== null));
    const when = longest >= 3600000 ? `约 ${Math.round(longest / 3600000)} 小时` : `约 ${Math.ceil(longest / 60000)} 分钟`;
    retryMsg = `已重试 ${targets.length} 个，仍有 ${left.length} 个未确认` + (longest ? `：注册局仍在限流，${when}后再试` : '');
  } else retryMsg = `已重试 ${targets.length} 个，全部确认`;
  if (!userStopped) scheduleAutoRetry();
  else renderTabs();
}
$('retry').onclick = retryFailed;

function stop() {
  runId++;
  running = false;
  retrying = false;
  // 没查到的保留下来，点“重试未确认”可以从停下的地方继续
  for (const r of rows) if (r.status === 'pending') Object.assign(r, { status: 'error', error: '已停止，未查询' });
  saveRows();
  $('go').textContent = '查询'; $('go').classList.remove('stop');
  render();
}

// ---------- 短域名：字母池 × 长度 → 全部组合 ----------
const SHORT_MAX = 20000;
let mode = localGet('mode') === 'short' ? 'short' : 'normal';
let lengths = new Set((localGet('lengths') || '3').split(',').map(Number).filter((n) => n >= 1 && n <= 6));

function letterPool() {
  return [...new Set($('letters').value.toLowerCase().replace(/[^a-z0-9]/g, ''))];
}

function comboCount(n, k, repeat) {
  if (repeat) return n ** k;
  let c = 1;
  for (let i = 0; i < k; i++) c *= n - i;
  return Math.max(c, 0);
}

// 按字母顺序生成长度为 k 的全部排列（repeat=true 时允许同一字母重复使用）
function* combos(pool, k, repeat) {
  const idx = new Array(k).fill(0);
  const used = new Array(pool.length).fill(0);
  function* walk(pos) {
    if (pos === k) { yield idx.map((i) => pool[i]).join(''); return; }
    for (let i = 0; i < pool.length; i++) {
      if (!repeat && used[i]) continue;
      idx[pos] = i; used[i]++;
      yield* walk(pos + 1);
      used[i]--;
    }
  }
  yield* walk(0);
}

// 短域名先筛再查：只查好读的 / 辅音元音交替的 / A 级以上的，查询量少、不容易被限流
const SCAN_MAX = 3000000;
function shortKeep(name, tld, f, g) {
  if (f === 'readable' && !domainGrade.readable(name)) return false;
  if (f === 'alternating' && !domainGrade.alternating(name)) return false;
  return !g || gradePass(name + '.' + puny(tld), g);
}
let planCache = { key: '', plan: null };
function shortPlan() {
  const pool = letterPool();
  const repeat = $('repeat').checked;
  const tlds = currentTlds();
  const ks = [...lengths].sort((a, b) => a - b);
  const f = $('shortFilter').value;
  const g = queryGrade();
  const key = JSON.stringify([pool, repeat, tlds, ks, f, g]);
  if (planCache.key === key) return planCache.plan;
  const names = ks.reduce((sum, k) => sum + comboCount(pool.length, k, repeat), 0);
  const raw = names * tlds.length;
  let total = raw, kept = names;
  // 每个后缀各要查多少个，给预估时间用
  let perTld = Object.fromEntries(tlds.map((t) => [t, names]));
  if (f !== 'all' || g) {
    // 等级筛选每个“组合×后缀”都要算分，上限更低，防止页面卡住
    if (raw > (g ? 600000 : SCAN_MAX)) { total = null; kept = null; perTld = null; }
    else if (g) {
      total = 0; kept = null;
      perTld = Object.fromEntries(tlds.map((t) => [t, 0]));
      for (const k of ks) for (const n of combos(pool, k, repeat)) for (const t of tlds) if (shortKeep(n, t, f, g)) { total++; perTld[t]++; }
    } else {
      kept = 0;
      for (const k of ks) for (const n of combos(pool, k, repeat)) if (shortKeep(n, '', f)) kept++;
      total = kept * tlds.length;
      perTld = Object.fromEntries(tlds.map((t) => [t, kept]));
    }
  }
  const plan = { pool, repeat, tlds, ks, f, g, names, raw, kept, total, perTld };
  planCache = { key, plan };
  return plan;
}

function renderShortInfo() {
  scheduleEstimate();
  if (mode !== 'short') return;
  const p = shortPlan();
  const el = $('shortInfo');
  if (!p.pool.length) { el.textContent = '先输入可用字母，例如 abcxyz；再选长度和下方的后缀。'; return; }
  if (!p.ks.length) { el.textContent = '至少选一个长度。'; return; }
  if (!p.tlds.length) { el.textContent = '在下方至少选一个后缀。'; return; }
  if (p.total === null) {
    el.innerHTML = `<span class="over">组合太多（${p.raw.toLocaleString()} 个），没法先筛选，请减少字母或长度</span>`;
    return;
  }
  const over = p.total > SHORT_MAX;
  const head = `字母 <b>${esc(p.pool.join(''))}</b>（${p.pool.length} 个）→ <b>${p.names.toLocaleString()}</b> 个组合`;
  const mid = p.f === 'all' && !p.g ? ` × <b>${p.tlds.length}</b> 个后缀`
    : p.kept !== null ? `，筛选后剩 <b>${p.kept.toLocaleString()}</b> 个 × <b>${p.tlds.length}</b> 个后缀`
    : ` × <b>${p.tlds.length}</b> 个后缀，筛选后`;
  el.innerHTML = head + mid + ` = <b class="${over ? 'over' : ''}">${p.total.toLocaleString()}</b> 次查询` +
    ((p.f !== 'all' || p.g) && p.raw > p.total ? `（原本 ${p.raw.toLocaleString()} 次）` : '') +
    (over ? `<span class="over">，超过单次上限 ${SHORT_MAX.toLocaleString()}，请减少字母、长度或后缀，或换更严格的筛选</span>` : '');
}

function shortList() {
  const p = shortPlan();
  if (!p.pool.length || !p.ks.length || !p.tlds.length || p.total === null || p.total > SHORT_MAX) return [];
  const out = [];
  // 先按后缀、再按长度排，短的优先出结果
  for (const k of p.ks) for (const tld of p.tlds) for (const name of combos(p.pool, k, p.repeat)) {
    if (shortKeep(name, tld, p.f, p.g)) out.push(`${name}.${puny(tld)}`);
  }
  return out;
}

function renderLengths() {
  const box = $('lengths');
  box.querySelectorAll('.mini').forEach((b) => b.remove());
  for (let k = 1; k <= 6; k++) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'mini'; b.textContent = k;
    b.setAttribute('aria-pressed', lengths.has(k));
    b.onclick = () => {
      lengths.has(k) ? lengths.delete(k) : lengths.add(k);
      localSet('lengths', [...lengths].join(','));
      renderLengths(); renderShortInfo();
    };
    box.appendChild(b);
  }
}

function setMode(m) {
  if (running) { userStopped = true; stop(); }
  mode = m; localSet('mode', m);
  $('modes').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  const short = m === 'short';
  $('q').hidden = short; $('letters').hidden = !short;
  $('hintNormal').hidden = short; $('shortOpts').hidden = !short;
  $('pkSearch').value = pkQuery = '';
  if (short) setPkOpen(true);
  renderGroups();
  (short ? $('letters') : $('q')).focus();
  renderShortInfo();
}

$('modes').querySelectorAll('button').forEach((b) => b.onclick = () => setMode(b.dataset.mode));
$('shortOpts').querySelectorAll('[data-fill]').forEach((b) => b.onclick = () => {
  $('letters').value = b.dataset.fill; localSet('letters', b.dataset.fill); renderShortInfo(); $('letters').focus();
});
$('letters').value = localGet('letters') || '';
// 打字时停顿 0.3 秒再算预估，筛选要遍历全部组合，边打边算会卡
let shortInfoTimer = null;
$('letters').addEventListener('input', () => {
  localSet('letters', $('letters').value);
  clearTimeout(shortInfoTimer);
  shortInfoTimer = setTimeout(renderShortInfo, 300);
});
$('repeat').checked = localGet('repeat') !== '0';
if (localGet('shortFilter') === 'grade') { localSet('shortFilter', 'all'); localSet('queryGrade', 'A'); }
$('shortFilter').value = localGet('shortFilter') || 'all';
$('queryGrade').value = localGet('queryGrade') || '';
$('queryGrade').addEventListener('change', () => { localSet('queryGrade', $('queryGrade').value); renderShortInfo(); scheduleEstimate(); });
$('shortFilter').addEventListener('change', () => { localSet('shortFilter', $('shortFilter').value); renderShortInfo(); });
$('repeat').addEventListener('change', () => { localSet('repeat', $('repeat').checked ? '1' : '0'); renderShortInfo(); });

$('form').onsubmit = (e) => {
  e.preventDefault();
  if (running) { userStopped = true; return stop(); }
  if (mode === 'short') {
    const list = shortList();
    if (!list.length) { renderShortInfo(); return (letterPool().length && lengths.size && !picked.size ? $('pkSearch') : $('letters')).focus(); }
    if (list.length > 300 && !confirmBig(list.length)) return;
    return run(list, 'available');
  }
  const list = expand($('q').value);
  try { history.replaceState(null, '', $('q').value.trim() ? '?q=' + encodeURIComponent($('q').value.trim()) : location.pathname); } catch {}
  if (!list.length) { scheduleEstimate(); return (group === 'custom' && $('q').value.trim() ? $('pkSearch') : $('q')).focus(); }
  if (list.length > 300 && !confirmBig(list.length)) return;
  run(list);
};

function confirmBig(n) {
  const b = $('go');
  if (b.dataset.confirm === String(n)) { delete b.dataset.confirm; return true; }
  b.dataset.confirm = String(n);
  b.textContent = `确认查 ${n} 个`;
  setTimeout(() => { if (b.dataset.confirm) { delete b.dataset.confirm; if (!running) b.textContent = '查询'; } }, 4000);
  return false;
}

$('q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('form').requestSubmit(); }
});
$('q').addEventListener('input', scheduleEstimate);
$('q').addEventListener('input', () => { $('q').style.height = 'auto'; $('q').style.height = $('q').scrollHeight + 'px'; });
// ---------- 自定义后缀选择面板 ----------
const SECOND_LEVEL = ['com.cn','net.cn','org.cn','gov.cn','co.uk','org.uk','co.jp','ne.jp','com.hk','com.tw','com.sg','com.au',
  'co.kr','co.in','com.br','com.mx','co.nz','co.za','com.my','com.ph','com.vn','co.id','com.tr','com.ar'];
let regionNames = null;
try { regionNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' }); } catch {}
const REGION_FIX = { uk: 'GB', ac: 'AC', eu: '欧盟', su: '苏联(旧)' };
function regionName(t) {
  if (t.length !== 2 || !regionNames) return '';
  const fix = REGION_FIX[t];
  if (fix && fix.length > 2) return fix;
  try { const n = regionNames.of((fix || t).toUpperCase()); return n && n.toUpperCase() !== t.toUpperCase() ? n : ''; } catch { return ''; }
}

function pickerSections() {
  const cc = allTlds.filter((t) => t.length === 2);
  const g = allTlds.filter((t) => t.length > 2);
  if (activeGroup() === 'hot') return [['热门', HOT.map(toAscii)]];
  if (activeGroup() === 'cc') return [['国家/地区', cc]];
  if (activeGroup() === 'g') return [['通用及新后缀', g]];
  if (activeGroup() === 'all') return [['国家/地区', cc], ['通用及新后缀', g]];
  return [
    ['已选', [...picked]],
    ['热门', HOT.map(toAscii)],
    ['常用二级后缀', SECOND_LEVEL],
    ['国家/地区', allTlds.filter((t) => t.length === 2)],
    ['通用及新后缀', allTlds.filter((t) => t.length > 2)],
  ];
}

// 后缀按开头匹配（输入 us 不再带出 .airbus/.museum）；国家中文名按包含匹配（搜“美国”“日本”）
function pkMatch(t, q) {
  if (!q) return true;
  const u = puny(t);
  return t.startsWith(q) || u.startsWith(q) || regionName(t).includes(q);
}
// 完全一致的排最前，其次是越短越接近
function pkRank(t, q) {
  if (!q) return 0;
  const u = puny(t);
  return (t === q || u === q ? 0 : 1) * 1000 + t.length;
}

function renderPicker() {
  const view = activeGroup() !== 'custom';
  // 只有自定义需要搜索（用来找后缀点选），预设组只是浏览
  const q = view ? '' : pkQuery.trim().toLowerCase().replace(/^\./, '');
  const body = $('pkBody');
  const total = new Set(pickerSections().flatMap(([, l]) => l)).size;
  $('picker').classList.toggle('view', view);
  $('picker').classList.toggle('collapsed', !pkOpen);
  $('pkToggle').textContent = pkOpen ? '收起' : `展开查看 ${view ? total + ' 个后缀' : '已选后缀'}`;
  $('pkAction').hidden = !view;
  $('pkCountWrap').hidden = !pkOpen;
  $('pkCountLabel').textContent = view ? '共' : '已选';
  $('pkCount').textContent = view ? total : picked.size;
  if (!pkOpen) return;
  if (view) {
    let html = '';
    for (const [title, list] of pickerSections()) {
      const shown = list.filter((t) => pkMatch(t, q));
      if (!shown.length) continue;
      html += `<div class="pk-sec"><h4><span>${title} · ${shown.length}</span></h4><div class="pk-grid">` +
        shown.map((t) => { const name = regionName(t); return `<span class="tg">.${esc(puny(t))}${name ? `<small>${esc(name)}</small>` : ''}</span>`; }).join('') +
        `</div></div>`;
    }
    body.innerHTML = html || `<div class="pk-empty">${allTlds.length || activeGroup() === 'hot' ? `没有匹配“${esc(q)}”的后缀` : '后缀列表加载中…'}</div>`;
    return;
  }
  let html = '';
  for (const [title, list] of pickerSections()) {
    if (title === '已选' && !list.length) continue;
    // 已选一栏搜索时也完整显示，方便看清选了哪些
    const shown = title === '已选' ? [...new Set(list)]
      : [...new Set(list)].filter((t) => pkMatch(t, q)).sort((a, b) => pkRank(a, q) - pkRank(b, q));
    if (!shown.length) continue;
    const allOn = shown.every((t) => picked.has(t));
    html += `<div class="pk-sec"><h4><span>${title} · ${shown.length}</span>` +
      (title === '已选' ? `<button type="button" data-act="clear">清空</button>`
        : `<button type="button" data-act="${allOn ? 'none' : 'all'}" data-list="${esc(shown.join(' '))}">${allOn ? '取消全选' : '全选'}</button>`) +
      `</h4><div class="pk-grid">` +
      shown.map((t) => {
        const name = regionName(t);
        return `<button type="button" class="tg" data-t="${esc(t)}" aria-pressed="${picked.has(t)}">.${esc(puny(t))}${name ? `<small>${esc(name)}</small>` : ''}</button>`;
      }).join('') + `</div></div>`;
  }
  // 列表里没有、但看起来是合法后缀（如 co.jp），允许手动添加
  const custom = toAscii(q);
  if (q && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(custom) && !picked.has(custom) && !SECOND_LEVEL.includes(custom)) {
    html += `<div class="pk-sec"><h4><span>手动添加</span></h4><button type="button" class="pk-add" data-add="${esc(custom)}">+ 添加 .${esc(q)}</button></div>`;
  }
  body.innerHTML = html || `<div class="pk-empty">${q ? `没有匹配“${esc(q)}”的后缀` : '还没选后缀，搜索或在下方点选'}</div>`;
}

$('pkToggle').onclick = () => { setPkOpen(!pkOpen); renderPicker(); };
$('pkAction').onclick = () => {
  picked = new Set(pickerSections().flatMap(([, l]) => l));
  savePicked();
  group = 'custom'; localSet('group', group);
  $('pkSearch').value = pkQuery = '';
  renderGroups();
};

$('pkBody').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || activeGroup() !== 'custom') return;
  if (b.dataset.t) {
    const t = b.dataset.t;
    picked.has(t) ? picked.delete(t) : picked.add(t);
    b.setAttribute('aria-pressed', picked.has(t));
  } else if (b.dataset.add) {
    picked.add(b.dataset.add);
    $('pkSearch').value = pkQuery = '';
  } else if (b.dataset.act === 'clear') {
    picked.clear();
  } else if (b.dataset.act) {
    for (const t of b.dataset.list.split(' ')) b.dataset.act === 'all' ? picked.add(t) : picked.delete(t);
  }
  savePicked();
  // 单个切换只更新计数，避免整块重绘导致滚动跳动
  if (b.dataset.t) { $('pkCount').textContent = picked.size; updateCustomChip(); }
  else { renderPicker(); updateCustomChip(); }
  renderShortInfo();
});
$('pkSearch').addEventListener('input', (e) => { pkQuery = e.target.value; renderPicker(); });

function updateCustomChip() {
  const chip = [...$('groups').querySelectorAll('.chip')].pop();
  if (chip) chip.querySelector('small').textContent = picked.size;
}

// ---------- 结果保存：刷新或误关页面后能找回，没查完的可以继续 ----------
const SAVE_KEY = 'lastRun';
let saveTimer = null;
function saveRowsSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveRows(); }, 3000);
}
function saveRows() {
  if (!rows.length) return;
  const compact = rows.map((r) => [r.domain, r.status, r.source || '', r.note || r.error || '',
    r.info?.registrar || '', r.info?.expires || '', (r.errors || []).join('；')]);
  try { localStorage.setItem(SAVE_KEY, JSON.stringify({ at: Date.now(), rows: compact })); } catch { /* 超出存储上限就算了 */ }
}
function restoreRows() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch {}
  if (!saved?.rows?.length) return;
  let unfinished = 0;
  rows = saved.rows.map(([domain, status, source, note, registrar, expires, errors]) => {
    const r = { domain, status, source: source || undefined, note: note || undefined, errors: errors ? errors.split('；') : undefined };
    if (registrar || expires) r.info = { registrar, expires };
    if (status === 'pending') { unfinished++; Object.assign(r, { status: 'error', note: undefined, error: '上次没查完' }); }
    return r;
  });
  const when = new Date(saved.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  $('restored').innerHTML = `已恢复 ${when} 的查询结果（${rows.length} 条）` +
    (unfinished ? `，其中 ${unfinished} 条没查完，可点“重试未确认”继续` : '') + ` <button type="button" id="clearSaved">清除</button>`;
  $('restored').hidden = false;
  $('clearSaved').onclick = () => {
    try { localStorage.removeItem(SAVE_KEY); } catch {}
    rows = []; $('restored').hidden = true; $('bar').hidden = true; render();
  };
  $('bar').hidden = false;
  render();
}

$('csv').onclick = () => {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['域名', '等级', '分数', '状态', '来源', '注册商', '到期', '说明'].map(cell).join(',')];
  for (const r of rows) {
    if (r.status === 'pending') continue;
    lines.push([r.domain, gradeOf(r).level, gradeOf(r).score, STATUS[r.status] || r.status, r.source, r.info?.registrar, fmtDate(r.info?.expires), r.note || r.error].map(cell).join(','));
  }
  // 加 BOM，Excel 打开中文不乱码
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `域名查询-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// ---------- 关注列表 ----------
const GOOD = ['available', 'likely-available', 'dropzone'];
function fmtExpire(iso) {
  if (!iso) return '';
  const days = Math.round((Date.parse(iso) - Date.now()) / 86400000);
  return days >= 0 ? `${fmtDate(iso)} 到期（还有 ${days} 天）` : `${fmtDate(iso)} 已过期 ${-days} 天`;
}
function renderWatch() {
  watched = new Set(watchItems.map((w) => w.domain));
  // 上次看过之后状态有变化的，按钮标红提醒
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem('watchSeen') || '{}'); } catch {}
  const fresh = watchItems.filter((w) => w.last && seen[w.domain] && seen[w.domain] !== w.last.status);
  $('watchBtn').textContent = (fresh.length ? '★' : '☆') + ' 关注' + (watchItems.length ? ' ' + watchItems.length : '') +
    (fresh.length ? ` · ${fresh.length} 个有变化` : '');
  $('watchBtn').classList.toggle('alert', fresh.length > 0);
  $('watchList').innerHTML = watchItems.length ? watchItems.map((w) => {
    const st = w.last?.status;
    const changed = fresh.includes(w);
    const last = w.changes?.length ? w.changes[w.changes.length - 1] : null;
    const meta = [fmtExpire(w.last?.expires), w.last?.checkedAt ? '检查于 ' + new Date(w.last.checkedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '',
      last ? `${STATUS[last.from] || last.from} → ${STATUS[last.to] || last.to}` : ''].filter(Boolean).join(' · ');
    return `<li class="s-${st}"><div><div class="w-name">${nameHtml(w.domain)}${changed ? ' <span class="w-new">有变化</span>' : ''}</div><div class="w-meta">${esc(meta)}</div></div>
      <span class="badge">${STATUS[st] || st || '检查中'}</span><button type="button" class="w-del" data-domain="${esc(w.domain)}" title="取消关注">✕</button></li>`;
  }).join('') : '<li class="watch-empty">还没有关注的域名。在查询结果里点 ☆，被释放时会提醒你。</li>';
  if (!$('watchPanel').hidden) markWatchSeen();
}
function markWatchSeen() {
  const seen = Object.fromEntries(watchItems.filter((w) => w.last).map((w) => [w.domain, w.last.status]));
  try { localStorage.setItem('watchSeen', JSON.stringify(seen)); } catch {}
}
// 和上次看到的比，变成可注册/释放期就弹通知
function notifyChanges(items) {
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem('watchSeen') || '{}'); } catch {}
  for (const w of items) {
    const st = w.last?.status;
    if (!st || !seen[w.domain] || seen[w.domain] === st || !GOOD.includes(st)) continue;
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(`${w.domain} ${STATUS[st]}`, { body: w.last.note || '你关注的域名状态变了，赶紧去看看', tag: w.domain });
    }
  }
}
async function loadWatch() {
  try {
    const items = await (await fetch('/api/watch')).json();
    if (!Array.isArray(items)) return;
    notifyChanges(items);
    watchItems = items;
    // 第一次见到的域名直接记为“已看过”，免得刚加就提示有变化
    let seen = {};
    try { seen = JSON.parse(localStorage.getItem('watchSeen') || '{}'); } catch {}
    let added = false;
    for (const w of items) if (w.last && !seen[w.domain]) { seen[w.domain] = w.last.status; added = true; }
    if (added) try { localStorage.setItem('watchSeen', JSON.stringify(seen)); } catch {}
    renderWatch();
    if (rows.length) render();
  } catch { /* 服务没开就算了 */ }
}
async function toggleWatch(domain) {
  const on = watched.has(domain);
  // 第一次关注时顺便申请通知权限
  if (!on && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  try {
    await fetch('/api/watch?domain=' + encodeURIComponent(domain), { method: on ? 'DELETE' : 'POST' });
  } catch {}
  await loadWatch();
}
$('watchBtn').onclick = () => {
  $('watchPanel').hidden = !$('watchPanel').hidden;
  if (!$('watchPanel').hidden) { markWatchSeen(); renderWatch(); }
};
$('watchList').addEventListener('click', (e) => {
  const del = e.target.closest('.w-del');
  if (del) toggleWatch(del.dataset.domain);
});
$('watchCheck').onclick = async () => {
  $('watchCheck').textContent = '检查中…'; $('watchCheck').disabled = true;
  try { await fetch('/api/watch/check', { method: 'POST' }); } catch {}
  await loadWatch();
  $('watchCheck').textContent = '立即检查'; $('watchCheck').disabled = false;
};
loadWatch();
setInterval(loadWatch, 60000);

$('copy').onclick = async () => {
  // 跟随当前等级筛选：选了“A 及以上”就只复制 A 级以上的可注册域名
  const list = rows.filter((r) => (r.status === 'available' || r.status === 'likely-available') && gradeOk(r)).map((r) => r.domain);
  try { await navigator.clipboard.writeText(list.join('\n')); $('copy').textContent = `已复制 ${list.length} 个`; }
  catch { $('copy').textContent = '复制失败'; }
  setTimeout(() => $('copy').textContent = '复制可注册', 1500);
};

renderGroups();
renderLengths();
setMode(mode);
const initial = new URLSearchParams(location.search).get('q');
if (initial) { setMode('normal'); $('q').value = initial; $('q').dispatchEvent(new Event('input')); setTimeout(() => $('form').requestSubmit()); }
else restoreRows();
// 关页面前把进行中的结果存一下
addEventListener('pagehide', saveRows);
fetch('/api/tlds').then((r) => r.json()).then((list) => { allTlds = list; renderGroups(); }).catch(() => {});
