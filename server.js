import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkDomain, getTldList, hostStats, backendsFor, estimate } from './lib/check.js';
import { getWatch, addWatch, removeWatch, checkAll, startWatchLoop } from './lib/watch.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.resolve(import.meta.dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function json(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/check') {
      const domain = url.searchParams.get('domain');
      if (!domain) return json(res, 400, { error: '缺少 domain 参数' });
      const r = await checkDomain(domain, { fresh: url.searchParams.has('fresh') });
      const { raw, ...rest } = r;
      return json(res, 200, url.searchParams.has('raw') ? r : rest);
    }
    if (url.pathname === '/api/backends' && req.method === 'POST') {
      let body = '';
      for await (const c of req) { body += c; if (body.length > 200000) break; }
      return json(res, 200, await backendsFor(JSON.parse(body || '[]')));
    }
    // 关注列表：GET 列表，POST 添加，DELETE 移除，POST /api/watch/check 立即检查全部
    if (url.pathname === '/api/watch') {
      const domain = url.searchParams.get('domain');
      if (req.method === 'POST') return json(res, 200, await addWatch(domain));
      if (req.method === 'DELETE') { await removeWatch(domain); return json(res, 200, await getWatch()); }
      return json(res, 200, await getWatch());
    }
    if (url.pathname === '/api/watch/check' && req.method === 'POST') {
      return json(res, 200, await checkAll());
    }
    if (url.pathname === '/api/estimate' && req.method === 'POST') {
      let body = '';
      for await (const c of req) { body += c; if (body.length > 200000) break; }
      return json(res, 200, await estimate(JSON.parse(body || '{}')));
    }
    if (url.pathname === '/api/debug') {
      return json(res, 200, hostStats());
    }
    if (url.pathname === '/api/tlds') {
      return json(res, 200, await getTldList());
    }
    const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(decodeURIComponent(url.pathname)));
    if (!file.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: 'forbidden' });
    const body = await fs.readFile(file).catch(() => null);
    if (!body) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

// 单个请求、单个注册局连接出错不能把整个服务带崩（服务停了关注列表也就没人检查了）
process.on('unhandledRejection', (e) => console.error('未处理的异步错误：', e));
process.on('uncaughtException', (e) => console.error('未捕获的异常：', e));

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用：可能服务已经开着（直接打开 http://localhost:${PORT}），或换个端口：PORT=8080 npm start`);
  } else {
    console.error('服务启动失败：', e.message);
  }
  process.exit(1);
});

startWatchLoop();

// 默认只允许本机访问：否则同一网络里的人能用你的 IP 查询（耗你的注册局额度）、改你的关注列表。
// 确实要给局域网用时：HOST=0.0.0.0 npm start
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => console.log(`域名查询已启动：http://localhost:${PORT}${HOST === '127.0.0.1' ? '（仅本机可访问）' : `（监听 ${HOST}）`}`));
