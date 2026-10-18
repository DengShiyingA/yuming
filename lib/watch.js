// 关注列表：把想要但已被注册的域名记下来，定时重查，状态一变就记一笔，前端据此提醒
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkDomain, normalizeDomain } from './check.js';

const FILE = path.resolve(import.meta.dirname, '..', '.cache', 'watch.json');
const INTERVAL = 30 * 60 * 1000; // 每 30 分钟查一轮
let list = null;

async function load() {
  if (list) return list;
  try { list = JSON.parse(await fs.readFile(FILE, 'utf8')); } catch { list = []; }
  return list;
}
async function save() {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(list, null, 1));
}

// 只留前端需要的字段
function snapshot(r) {
  return { status: r.status, source: r.source, note: r.note, expires: r.info?.expires || null, checkedAt: new Date().toISOString() };
}

async function refresh(item) {
  const r = await checkDomain(item.domain, { fresh: true });
  const prev = item.last?.status;
  item.last = snapshot(r);
  // 状态真的变了才记一笔（DNS 兜底的“可能/无法确定”不算数，避免限流时误报）
  if (prev && prev !== r.status && r.source !== 'DNS') {
    item.changes = [...(item.changes || []), { at: item.last.checkedAt, from: prev, to: r.status }].slice(-20);
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
