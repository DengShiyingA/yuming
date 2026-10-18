// 离线回归测试：node test/run.mjs（或 npm test）
// 1. WHOIS 判断：test/fixtures/whois 里是各注册局的真实回复样本，expected.json 写着每份应判成什么
// 2. 域名评分：几个关键例子的等级
import fs from 'node:fs';
import path from 'node:path';
import { classifyWhois } from '../lib/check.js';
import '../public/grade.js';

const dir = path.join(import.meta.dirname, 'fixtures', 'whois');
const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
let pass = 0, fail = 0;
const check = (ok, label, detail) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  ← ' + detail}`);
};

// error 表示应当报错（交给 RDAP/DNS 兜底）；error:limit 要求报的是限流，error:retired 要求报的是停服
for (const [name, { status, note }] of Object.entries(expected)) {
  const text = fs.readFileSync(path.join(dir, name + '.txt'), 'utf8');
  let got, msg = '';
  try { got = classifyWhois(text).status; } catch (e) { got = 'error'; msg = e.message; }
  const [want, kind] = status.split(':');
  const ok = got === want
    && (kind !== 'limit' || /限流|拒绝/.test(msg))
    && (kind !== 'retired' || /停服/.test(msg));
  check(ok, `WHOIS ${name}（${note}）`, `期望 ${status}，实际 ${got}${msg ? '：' + msg : ''}`);
}

const g = globalThis.domainGrade;
const grades = [
  ['zyu.io', 'S'], ['ymu.io', 'S'], ['abc.com', 'S'], ['yimu.com', 'S'], ['888.com', 'S'],
  ['zxb.io', 'A'], ['vqq.io', 'A'], ['google.com', 'A'],
  ['mybrand2026.com', 'D'], ['qwzxkjhqwe.top', 'D'],
];
for (const [d, want] of grades) {
  const r = g(d);
  check(r.level === want, `评分 ${d} → ${want}`, `实际 ${r.level} ${r.score}（${r.reasons.join('，')}）`);
}
const shape = [['bok', 'alternating', true], ['abc', 'alternating', false], ['zxb', 'readable', false], ['yimu', 'readable', true]];
for (const [n, fn, want] of shape) check(g[fn](n) === want, `${fn}(${n}) = ${want}`, `实际 ${g[fn](n)}`);

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
