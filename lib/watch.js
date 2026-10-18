// 关注列表：把想要但已被注册的域名记下来，定时重查，状态一变就记一笔，前端据此提醒
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { checkDomain, normalizeDomain, writeFileAtomic } from './check.js';

const FILE = path.resolve(import.meta.dirname, '..', '.cache', 'watch.json');
const INTERVAL = 30 * 60 * 1000; // 每 30 分钟查一轮
let list = null;

async function load() {
  if (list) return list;
  let text;
  try { text = await fs.readFile(FILE, 'utf8'); } catch { list = []; return list; } // 还没有关注过
  try {
    list = JSON.parse(text);
    if (!Array.isArray(list)) throw new Error('格式不对');
  } catch (e) {
    // 文件坏了：先备份再从空列表开始，不悄悄覆盖掉用户的关注
    const backup = `${FILE}.broken-${Date.now()}`;
    await fs.rename(FILE, backup).catch(() => {});
    console.error(`关注列表文件损坏（${e.message}），已备份到 ${backup}`);
    list = [];
  }
  return list;
}
async function save() {
  await writeFileAtomic(FILE, JSON.stringify(list, null, 1));
}

// 只留前端需要的字段
function snapshot(r) {
  return { status: r.status, source: r.source, note: r.note, expires: r.info?.expires || null, checkedAt: new Date().toISOString() };
}

// ---------- 提醒：页面没开着也要能收到 ----------
const STATUS_TEXT = { available: '可注册', 'likely-available': '可能可注册', dropzone: '释放期·需申请', registered: '已注册',
  reserved: '保留/受限', premium: '疑似保留/溢价', unknown: '无法确定' };
const GOOD = ['available', 'likely-available', 'dropzone'];

// macOS 系统通知（默认开；WATCH_MAC_NOTIFY=0 关闭）。参数走 argv 传给 osascript，不拼进脚本，域名里有引号也安全
function macNotify(title, body) {
  if (process.platform !== 'darwin' || process.env.WATCH_MAC_NOTIFY === '0') return;
  execFile('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"', '-e', 'end run', title, body],
    (e) => { if (e) console.warn('系统通知发送失败：', e.message); });
}

// Webhook（可选）：WATCH_WEBHOOK=网址，状态变化时 POST JSON，可接 ntfy 等手机推送
async function webhook(payload) {
  const url = process.env.WATCH_WEBHOOK;
  if (!url) return;
  try {
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
  } catch (e) { console.warn('Webhook 发送失败：', e.message); }
}

function announce(item, change) {
  if (!GOOD.includes(change.to)) return; // 只在“能买了”的时候打扰人
  const text = `${item.domain}：${STATUS_TEXT[change.from] || change.from} → ${STATUS_TEXT[change.to] || change.to}`;
  console.log('关注提醒：' + text);
  macNotify(`${item.domain} ${STATUS_TEXT[change.to]}`, item.last?.note || '你关注的域名状态变了，赶紧去看看');
  webhook({ domain: item.domain, from: change.from, to: change.to, note: item.last?.note || '', text, at: change.at });
}

async function refresh(item) {
  const r = await checkDomain(item.domain, { fresh: true });
  const prev = item.last?.status;
  item.last = snapshot(r);
  // 状态真的变了才记一笔（DNS 兜底的“可能/无法确定”不算数，避免限流时误报）
  if (prev && prev !== r.status && r.source !== 'DNS') {
    const change = { at: item.last.checkedAt, from: prev, to: r.status };
    item.changes = [...(item.changes || []), change].slice(-20);
    announce(item, change);
  }
  return item;
}

export async function getWatch() {
  return load();
}

export async function addWatch(input) {
  const d = normalizeDomain(input);
  if (!d) throw new Error('域名格式不正确');
  await load();
  let item = list.find((x) => x.domain === d.unicode);
  if (!item) {
    item = { domain: d.unicode, addedAt: new Date().toISOString(), changes: [] };
    list.push(item);
    await refresh(item);
    await save();
  }
  return item;
}

export async function removeWatch(input) {
  await load();
  const d = normalizeDomain(input);
  const key = d ? d.unicode : String(input);
  list = list.filter((x) => x.domain !== key);
  await save();
}

let running = false;
export async function checkAll() {
  if (running) return load();
  running = true;
  try {
    await load();
    // 一个个来，不给注册局添压力
    for (const item of list) {
      try { await refresh(item); } catch { /* 这次查不到下次再说 */ }
    }
    await save();
    return list;
  } finally { running = false; }
}

export function startWatchLoop() {
  setInterval(() => { checkAll().catch(() => {}); }, INTERVAL).unref();
}
