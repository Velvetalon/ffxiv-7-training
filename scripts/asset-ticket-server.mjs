#!/usr/bin/env node
// Local FF14 Type-D ticket sidecar. It signs allowlisted URLs; it never serves asset bytes.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const MAX_MANIFEST_ASSETS = 50_000;
const MAX_BATCH_KEYS = 256;
const MAX_BATCH_BODY_BYTES = 64 * 1024;
const MAX_LEGACY_RESPONSE_BYTES = 4 * 1024 * 1024;

const required = name => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
};

const normalisePrefix = value => {
  const result = value.replace(/^\/+|\/+$/g, '');
  if (!result || result.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('ASSET_PREFIX is unsafe');
  return result;
};

const normalisePath = (value, field) => {
  if (typeof value !== 'string' || !value || value.includes('\\')) throw new Error(`${field} must be a non-empty slash-separated relative path`);
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error(`${field} is unsafe`);
  return parts.join('/');
};

// Python urllib.parse.quote(value, safe='/~-._') equivalent, matching the existing Flask signer exactly.
const quoteCosPath = value => {
  const safe = new Set([...Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/~-._')]);
  let result = '';
  for (const byte of Buffer.from(value, 'utf8')) result += safe.has(byte) ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  return result;
};

const sha256 = value => createHash('sha256').update(value).digest('hex');

async function loadTicketState() {
  const manifestPath = resolve(required('TICKET_MANIFEST_PATH'));
  const raw = await readFile(manifestPath);
  const manifest = JSON.parse(raw.toString('utf8'));
  if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.releaseId !== 'string' || !manifest.releaseId) throw new Error('invalid publish manifest schemaVersion/releaseId');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > MAX_MANIFEST_ASSETS) throw new Error(`manifest files must contain 1..${MAX_MANIFEST_ASSETS} allowlisted objects`);
  const prefix = normalisePrefix(required('ASSET_PREFIX'));
  const cdn = new URL(required('CDN_ORIGIN'));
  if (cdn.protocol !== 'https:' || cdn.pathname !== '/' || cdn.search || cdn.hash) throw new Error('CDN_ORIGIN must be an HTTPS origin without path, query, or fragment');
  const secret = required('CDN_AUTH_SECRET');
  const entry = normalisePath(manifest.entry, 'entry');
  const urls = new Map();
  const addManifestFiles = (document, label) => {
    if (!Array.isArray(document.files) || document.files.length === 0 || document.files.length > MAX_MANIFEST_ASSETS) throw new Error(`${label}.files must contain 1..${MAX_MANIFEST_ASSETS} allowlisted objects`);
    for (const [index, item] of document.files.entries()) {
      const path = normalisePath(item?.path, `${label}.files[${index}].path`);
      if (!/^[a-f0-9]{64}$/.test(item?.hash || '')) throw new Error(`${label}.files[${index}].hash must be a lowercase SHA-256`);
      if (!path.includes(item.hash)) throw new Error(`${label}.files[${index}].path must include its content hash`);
      urls.set(path, null);
    }
  };
  addManifestFiles(manifest, 'current manifest');
  const priorPaths = (process.env.TICKET_PREVIOUS_MANIFEST_PATHS || '').split(';').map(value => value.trim()).filter(Boolean);
  for (const priorPath of priorPaths) {
    const prior = JSON.parse((await readFile(resolve(priorPath))).toString('utf8'));
    if (!prior || prior.schemaVersion !== 1) throw new Error('invalid previous publish manifest schemaVersion');
    addManifestFiles(prior, 'previous manifest');
  }
  if (!urls.has(entry)) throw new Error('entry is not in the ticket allowlist');
  const manifestHash = sha256(raw);
  const manifestPathRemote = `manifests/publish-manifest.${manifestHash}.json`;
  urls.set(manifestPathRemote, null);
  return { cdnOrigin: cdn.origin, entry, manifestPathRemote, prefix, releaseId: manifest.releaseId, secret, urls };
}

function ticketTiming() {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const ttl = Math.min(300, Math.max(60, Number.parseInt(process.env.TICKET_TTL_SECONDS || '300', 10) || 300));
  return { timestamp, expiresAt: new Date((Number(timestamp) + ttl) * 1000).toISOString() };
}

function signUrls(state, paths, timestamp) {
  const urls = {};
  for (const path of paths) {
    const canonicalKey = `${state.prefix}/${path}`;
    const requestPath = `/${quoteCosPath(canonicalKey)}`;
    const sign = createHash('md5').update(`${state.secret}${requestPath}${timestamp}`, 'utf8').digest('hex');
    urls[canonicalKey] = `${state.cdnOrigin}${requestPath}?sign=${sign}&t=${timestamp}`;
  }
  return urls;
}

function makeTicket(state) {
  const { timestamp, expiresAt } = ticketTiming();
  const urls = signUrls(state, state.urls.keys(), timestamp);
  const entryKey = `${state.prefix}/${state.entry}`;
  return {
    releaseId: state.releaseId,
    expiresAt,
    assetBase: `${state.cdnOrigin}/${quoteCosPath(state.prefix)}/`,
    entryKey,
    entryUrl: urls[entryKey],
    urls,
  };
}

function makeBatchBootstrap(state) {
  const { timestamp, expiresAt } = ticketTiming();
  const paths = [...state.urls.keys()].filter(path => !path.endsWith('.aethpak'));
  const urls = signUrls(state, paths, timestamp);
  const entryKey = `${state.prefix}/${state.entry}`;
  return {
    releaseId: state.releaseId,
    expiresAt,
    assetBase: `${state.cdnOrigin}/${quoteCosPath(state.prefix)}/`,
    entryKey,
    entryUrl: urls[entryKey],
    urls,
    supportsBatch: true,
  };
}

function makeBatchTicket(state, requestedKeys) {
  if (!Array.isArray(requestedKeys) || requestedKeys.length > MAX_BATCH_KEYS) throw new Error(`keys must contain at most ${MAX_BATCH_KEYS} canonical asset keys`);
  const prefix = `${state.prefix}/`;
  const paths = [];
  for (const [index, key] of requestedKeys.entries()) {
    if (typeof key !== 'string' || !key.startsWith(prefix)) throw new Error(`keys[${index}] is not a canonical asset key`);
    const path = normalisePath(key.slice(prefix.length), `keys[${index}]`);
    if (!state.urls.has(path)) throw new Error(`keys[${index}] is not allowlisted`);
    paths.push(path);
  }
  const { timestamp, expiresAt } = ticketTiming();
  return {
    releaseId: state.releaseId,
    expiresAt,
    assetBase: `${state.cdnOrigin}/${quoteCosPath(state.prefix)}/`,
    urls: signUrls(state, [...new Set(paths)], timestamp),
  };
}

function readJsonBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let bytes = 0;
    const chunks = [];
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BATCH_BODY_BYTES) {
        rejectBody(new Error(`request body exceeds ${MAX_BATCH_BODY_BYTES} bytes`));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { rejectBody(new Error('request body must be JSON')); }
    });
    request.on('error', rejectBody);
  });
}

async function main() {
  const state = await loadTicketState();
  const port = Number.parseInt(process.env.PORT || '8790', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer in 1..65535');
  const host = process.env.HOST || '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost', '0.0.0.0', '::'].includes(host)) throw new Error('HOST must be loopback or a container-network bind address');
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && requestUrl.pathname === '/healthz' && !requestUrl.search) {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' });
      response.end(JSON.stringify({ status: 'ok', releaseId: state.releaseId }));
      return;
    }
    try {
      if (request.method === 'GET' && requestUrl.pathname === '/ticket' && !requestUrl.search) {
        const body = JSON.stringify(makeTicket(state));
        if (Buffer.byteLength(body) > MAX_LEGACY_RESPONSE_BYTES) {
          response.writeHead(503, { 'Cache-Control': 'no-store, max-age=0' });
          response.end();
          return;
        }
        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store, max-age=0',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(body);
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/ticket' && requestUrl.search === '?mode=batch') {
        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store, max-age=0',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(JSON.stringify(makeBatchBootstrap(state)));
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/ticket' && !requestUrl.search) {
        const body = JSON.stringify(makeBatchTicket(state, (await readJsonBody(request))?.keys));
        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store, max-age=0',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(body);
        return;
      }
      response.writeHead(requestUrl.pathname === '/ticket' ? 405 : 404, { Allow: 'GET, POST', 'Cache-Control': 'no-store, max-age=0' });
      response.end();
    } catch (error) {
      response.writeHead(400, { 'Cache-Control': 'no-store, max-age=0' });
      response.end();
    }
  });
  server.listen(port, host, () => console.log(`asset-ticket-server listening on ${host}:${port}`));
}

function selfTest() {
  const quoted = quoteCosPath('ff14-assets/v1/objects/a b/雪.bin');
  if (quoted !== 'ff14-assets/v1/objects/a%20b/%E9%9B%AA.bin') throw new Error('Python quote compatibility check failed');
  const state = {
    cdnOrigin: 'https://img.example.test', entry: 'objects/a.bin', manifestPathRemote: 'manifests/publish-manifest.test.json',
    prefix: 'ff14-assets/v1', releaseId: 'self-test', secret: 'test-secret', urls: new Map([['objects/a.bin', null]]),
  };
  const ticket = makeTicket(state);
  if (ticket.entryKey !== 'ff14-assets/v1/objects/a.bin' || !ticket.entryUrl.startsWith('https://img.example.test/ff14-assets/v1/objects/a.bin?sign=')) throw new Error('ticket URL check failed');
  if (ticket.assetBase !== 'https://img.example.test/ff14-assets/v1/') throw new Error('ticket canonical base check failed');
  if (!ticket.entryUrl.includes('&t=')) throw new Error('ticket timestamp check failed');
  const bootstrap = makeBatchBootstrap(state);
  if (!bootstrap.supportsBatch || !bootstrap.entryUrl.startsWith('https://img.example.test/ff14-assets/v1/objects/a.bin?sign=')) throw new Error('batch bootstrap check failed');
  const batch = makeBatchTicket(state, ['ff14-assets/v1/objects/a.bin']);
  if (Object.keys(batch.urls).length !== 1 || !batch.urls['ff14-assets/v1/objects/a.bin']) throw new Error('batch allowlist check failed');
  try { makeBatchTicket(state, ['ff14-assets/v1/not-allowlisted.bin']); }
  catch { console.log('self-test: Type-D path encoding, legacy ticket, and batched allowlist passed'); return; }
  throw new Error('batch allowlist rejection check failed');
}

(process.argv.includes('--self-test') ? Promise.resolve().then(selfTest) : main()).catch(error => {
  // Never echo environment values; only configuration field names are reported above.
  console.error(`asset-ticket-server: ${error.message}`);
  process.exitCode = 2;
});
