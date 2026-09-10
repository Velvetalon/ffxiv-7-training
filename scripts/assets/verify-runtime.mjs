import assert from 'node:assert/strict';
import { AssetCache } from '../../src/assets/AssetCache.js';
import { AssetRuntime } from '../../src/assets/AssetRuntime.js';
import { FetchScheduler } from '../../src/assets/FetchScheduler.js';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const abortName = error => error?.name === 'AbortError' || error?.message === 'aborted';
const response = (bytes, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  arrayBuffer: async () => Uint8Array.from(bytes).buffer,
});

async function verifyFetchScheduler() {
  let active = 0, peak = 0, calls = 0;
  const scheduler = new FetchScheduler({
    concurrency: 2,
    fetcher: async () => {
      calls++; active++; peak = Math.max(peak, active);
      await delay(15); active--;
      return response([calls]);
    },
  });
  await Promise.all(['a', 'b', 'c', 'd'].map(key => scheduler.request(key, `https://assets.test/${key}`)));
  assert.equal(calls, 4);
  assert.equal(peak, 2, 'scheduler exceeded its configured concurrency');

  let sharedCalls = 0;
  let releaseShared;
  const sharedGate = new Promise(resolve => { releaseShared = resolve; });
  const shared = new FetchScheduler({
    fetcher: async () => { sharedCalls++; await sharedGate; return response([7]); },
  });
  const first = new AbortController();
  const second = new AbortController();
  const firstResult = shared.request('same', 'https://assets.test/same', { signal: first.signal });
  const secondResult = shared.request('same', 'https://assets.test/same', { signal: second.signal });
  await delay(0);
  first.abort(new DOMException('aborted', 'AbortError'));
  await assert.rejects(firstResult, abortName);
  releaseShared();
  assert.equal((await secondResult).bytes.byteLength, 1);
  assert.equal(sharedCalls, 1, 'shared request was fetched more than once');

  let abortObserved = false;
  let cancellationCalls = 0;
  const cancelled = new FetchScheduler({
    fetcher: (_, { signal }) => new Promise((resolve, reject) => {
      cancellationCalls++;
      signal.addEventListener('abort', () => { abortObserved = true; reject(new DOMException('aborted', 'AbortError')); }, { once: true });
      if (cancellationCalls > 1) resolve(response([9]));
    }),
  });
  const left = new AbortController(), right = new AbortController();
  const cancelledLeft = cancelled.request('retry-after-cancel', 'https://assets.test/retry', { signal: left.signal });
  const cancelledRight = cancelled.request('retry-after-cancel', 'https://assets.test/retry', { signal: right.signal });
  await delay(0);
  left.abort(new DOMException('aborted', 'AbortError'));
  right.abort(new DOMException('aborted', 'AbortError'));
  await Promise.allSettled([cancelledLeft, cancelledRight]);
  assert(abortObserved, 'all-consumer cancellation did not abort the underlying fetch');
  assert.equal((await cancelled.request('retry-after-cancel', 'https://assets.test/retry')).bytes.byteLength, 1);
  assert.equal(cancellationCalls, 2, 'request after all-consumer cancellation did not create fresh work');

  let attempts = 0;
  const retrying = new FetchScheduler({ retries: 1, fetcher: async () => response([3], ++attempts === 1 ? 503 : 200) });
  assert.equal((await retrying.request('retry', 'https://assets.test/retry')).bytes.byteLength, 1);
  assert.equal(attempts, 2, 'retryable failure was not retried exactly once');
}

function makeRuntime(fetcher, memoryBudget = 0) {
  const runtime = new AssetRuntime({ memoryBudget });
  runtime.scheduler = new FetchScheduler({ retries: 0, fetcher });
  runtime.decoder('bin', async bytes => bytes);
  runtime.decoder('parent', async (_, record, store) => store.get(record.dependencies[0]));
  return runtime;
}

async function verifyRuntime() {
  let calls = 0;
  const runtime = makeRuntime(async () => { calls++; await delay(5); return response([1, 2, 3, 4]); });
  runtime.configure({ schemaVersion: 1, bundles: {}, resources: {
    child: { type: 'bin', hash: 'child', size: 4, dependencies: [], url: 'child.bin' },
    parent: { type: 'parent', hash: 'parent', size: 0, virtual: true, dependencies: ['child'] },
  } }, 'https://assets.test/');
  await Promise.all([runtime.load('parent'), runtime.load('parent')]);
  assert.equal(calls, 1, 'runtime did not deduplicate concurrent dependency work');
  assert.equal(runtime.entries.get('parent').refs, 2);
  assert.equal(runtime.entries.get('child').refs, 1);
  runtime.release('parent');
  assert.equal(runtime.entries.get('parent').refs, 1);
  runtime.release('parent');
  assert.equal(runtime.memoryBytes, 0, 'dependency cascade did not return runtime to its memory budget');
  assert.equal(runtime.entries.size, 0, 'released parent/dependency entries were not evicted');

  let failedAttempts = 0;
  const recovering = makeRuntime(async () => response([6], ++failedAttempts === 1 ? 404 : 200), 1024);
  recovering.configure({ schemaVersion: 1, bundles: {}, resources: {
    flaky: { type: 'bin', hash: 'flaky', size: 1, dependencies: [], url: 'flaky.bin' },
  } }, 'https://assets.test/');
  await assert.rejects(recovering.load('flaky'), /Asset HTTP 404/);
  assert.equal((await recovering.load('flaky')).byteLength, 1);
  assert.equal(failedAttempts, 2, 'failed runtime load did not recover with fresh work');
}

class FakeCache {
  constructor() { this.entries = new Map(); }
  async match(key) {
    const entry = this.entries.get(String(key));
    return entry && new Response(entry.bytes.slice(0), { headers: entry.headers });
  }
  async keys() { return [...this.entries.keys()]; }
  async delete(key) { return this.entries.delete(String(key)); }
  async put(key, value) {
    const bytes = new Uint8Array(await value.arrayBuffer());
    this.entries.set(String(key), { bytes, headers: new Headers(value.headers) });
  }
}

async function verifyCache() {
  const previous = globalThis.caches;
  const opened = [];
  const cache = new FakeCache();
  globalThis.caches = { open: async name => { opened.push(name); return cache; } };
  try {
    const assetCache = new AssetCache({ name: 'runtime-fixture', budget: 10 });
    await assetCache.put('a', Uint8Array.from([1, 2, 3, 4, 5, 6]).buffer);
    await assetCache.put('b', Uint8Array.from([7, 8, 9, 10, 11, 12]).buffer);
    assert.deepEqual(opened, ['runtime-fixture', 'runtime-fixture']);
    assert.equal(await assetCache.get('a'), null, 'quota eviction retained the oldest entry');
    assert.equal((await assetCache.get('b')).byteLength, 6);
    await assetCache.put('oversize', new ArrayBuffer(11));
    assert.equal(await assetCache.get('oversize'), null, 'oversize cache entry bypass was ignored');
    const write = assetCache.put('pending', Uint8Array.from([13, 14, 15]).buffer);
    const read = await assetCache.get('pending');
    assert.equal(read?.byteLength, 3, 'read during pending persistence became a false cache miss');
    await write;
  } finally {
    globalThis.caches = previous;
  }
}

await verifyFetchScheduler();
await verifyRuntime();
await verifyCache();
console.log('verify-runtime: FetchScheduler sharing/cancellation/retry, AssetRuntime dedup/recovery/eviction, and AssetCache namespace/quota passed');
