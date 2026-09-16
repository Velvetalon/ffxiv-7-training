#!/usr/bin/env node
/**
 * Local stand-in for the production origin, used only to rehearse the
 * release verification and rollback drill without deployment credentials.
 * Routes mirror the production layout:
 *   /ff14-web-babylon-preview/* -> site-babylon-preview/
 *   /ff14-web/*                 -> site/          (/ff14-web redirects)
 *   /api/healthz                -> {"status":"ok"}
 *   anything else               -> distinct 404 body (catch-all proof)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PORT) || 8791;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function serveFile(res, file) {
  const body = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);
  if (pathname === '/ff14-assets/ticket') {
    // Mirror the dev-server behavior: re-sign asset URLs through the
    // production ticket service and rewrite signed hosts back to this origin
    // so a local browser can load the CDN-backed packs.
    const upstream = `https://yuluo.site/ff14-assets/ticket${url.search}`;
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const response = await fetch(upstream, {
          method: req.method,
          headers: req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {},
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
        });
        const text = await response.text();
        res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'application/json' });
        res.end(text.replaceAll('https://img.yuluo.site/', `http://127.0.0.1:${PORT}/`));
      } catch (error) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(`ticket rewrite failed: ${error?.message || error}`);
      }
    });
    return;
  }
  if (pathname === '/api/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"ok"}');
    return;
  }
  if (pathname === '/ff14-web') {
    res.writeHead(308, { Location: '/ff14-web/' });
    res.end();
    return;
  }
  if (pathname.startsWith('/ff14-web/')) {
    const relative = pathname.slice('/ff14-web/'.length) || 'index.html';
    const file = path.join(REPO_ROOT, 'site', relative);
    if (fsSyncFile(file)) { serveFile(res, file); return; }
  }
  if (pathname.startsWith('/ff14-web-babylon-preview/')) {
    const relative = pathname.slice('/ff14-web-babylon-preview/'.length) || 'index.html';
    const file = path.join(REPO_ROOT, 'site-babylon-preview', relative);
    if (fsSyncFile(file)) { serveFile(res, file); return; }
  }
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>local-origin 404</title><p>no such artifact</p>');
});

function fsSyncFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return null;
  }
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`local origin on http://127.0.0.1:${PORT}`);
});

process.on('SIGTERM', () => process.exit(0));
