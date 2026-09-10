import assert from 'node:assert/strict';
import { assetDelivery } from '../../src/assets/AssetDelivery.js';
import { FetchScheduler } from '../../src/assets/FetchScheduler.js';

const originalFetch = globalThis.fetch;
const origin = 'https://cdn.test';
const base = `${origin}/ff14-assets/v1/`;
const requests = [];
let generation = 0;
const reply = keys => new Response(JSON.stringify({
  releaseId: 'fixture',
  expiresAt: new Date(Date.now() + 300000).toISOString(),
  assetBase: base,
  entryUrl: `${base}catalog.json?sign=fixture`,
  urls: Object.fromEntries(keys.map(key => [key, `${origin}/${key}?sign=fixture-${generation}`])),
}));
globalThis.fetch = async (url, options = {}) => {
  const address = new URL(url);
  requests.push({ path: address.pathname, mode: address.searchParams.get('mode'), method: options.method || 'GET' });
  if (options.method === 'POST') {
    const { keys } = JSON.parse(options.body);
    assert.ok(keys.length <= 256);
    assert.ok(keys.every(key => key.startsWith('ff14-assets/v1/')));
    generation++;
    return reply(keys);
  }
  assert.equal(address.searchParams.get('mode'), 'batch');
  return reply(['ff14-assets/v1/catalog.json']);
};
try {
  const delivery = await assetDelivery({ ticket: '/ff14-assets/ticket' }, 'https://app.test/ff14-web/extracted/');
  assert.equal(delivery.base, base);
  await delivery.authorize(Array.from({ length: 600 }, (_, i) => `${base}packs/${i}.pack`));
  assert.equal(requests.filter(request => request.method === 'POST').length, 3);
  const cached = await delivery.resolveUrl(`${base}packs/0.pack`);
  assert.match(cached, /sign=fixture-/);
  assert.equal(requests.length, 4, 'cached authorization made another request');
  const refreshed = await delivery.resolveUrl(`${base}packs/0.pack`, { refresh: true });
  assert.notEqual(refreshed, cached);
  assert.equal(requests.length, 5);

  const attempts = [];
  const scheduler = new FetchScheduler({
    fetcher: async url => {
      attempts.push(url);
      return attempts.length === 1 ? new Response('', { status: 403 }) : new Response('pack');
    },
  });
  const response = await scheduler.request('expired', attempt => delivery.resolveUrl(`${base}packs/0.pack`, { refresh: attempt > 0 }));
  assert.equal(new TextDecoder().decode(response.bytes), 'pack');
  assert.notEqual(attempts[0], attempts[1], 'expired authorization was retried without refreshing');
  console.log('verify-delivery: bounded authorization batches, cached tickets and expired-URL retry passed');
} finally {
  globalThis.fetch = originalFetch;
}
