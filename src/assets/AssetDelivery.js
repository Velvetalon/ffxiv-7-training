export async function assetDelivery(pointer, root) {
  if (!pointer.ticket) return {
    manifestUrl: new URL(pointer.manifest, root).href,
    base: new URL(pointer.base || './', root).href,
    resolveUrl: url => Promise.resolve(url),
  };
  const endpoint = new URL(pointer.ticket, root).href;
  let ticket, pending;
  const signed = new Map();
  const requested = new Map();
  let scheduled = false;
  const refresh = async (force = false) => {
    if (force) ticket = null;
    if (ticket?.endpoint === endpoint && Date.parse(ticket.expiresAt) > Date.now() + 30000) return ticket;
    const batchEndpoint = new URL(endpoint);
    batchEndpoint.searchParams.set('mode', 'batch');
    if (!pending) pending = fetch(batchEndpoint, { cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error(`Asset ticket HTTP ${response.status}`);
      const result = await response.json();
      ticket = { ...result, endpoint };
      for (const [key, url] of Object.entries(result.urls)) signed.set(key, { url, expiresAt: Date.parse(result.expiresAt) });
      return ticket;
    }).finally(() => { pending = null; });
    return pending;
  };
  const first = await refresh();
  const base = new URL(pointer.base || first.assetBase || './', first.entryUrl).href;
  const flush = async () => {
    scheduled = false;
    const items = [...requested];
    requested.clear();
    for (let offset = 0; offset < items.length; offset += 256) {
      const batch = items.slice(offset, offset + 256);
      try {
        const response = await fetch(endpoint, {
          method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keys: batch.map(([key]) => key) }),
        });
        if (!response.ok) throw new Error(`Asset authorization HTTP ${response.status}`);
        const result = await response.json();
        for (const [key, clients] of batch) {
          const url = result.urls[key];
          if (!url) throw new Error(`Resource absent from delivery ticket: ${key}`);
          signed.set(key, { url, expiresAt: Date.parse(result.expiresAt) });
          clients.forEach(client => client.resolve(url));
        }
      } catch (error) {
        for (const [, clients] of batch) clients.forEach(client => client.reject(error));
      }
    }
  };
  const authorize = (url, force = false) => {
    const key = new URL(url).pathname.replace(/^\/+/, '');
    const cached = signed.get(key);
    if (!force && cached?.expiresAt > Date.now() + 30000) return Promise.resolve(cached.url);
    return new Promise((resolve, reject) => {
      if (!requested.has(key)) requested.set(key, []);
      requested.get(key).push({ resolve, reject });
      if (!scheduled) { scheduled = true; queueMicrotask(flush); }
    });
  };
  return {
    manifestUrl: first.entryUrl,
    base,
    resolveUrl: (url, { refresh = false } = {}) => authorize(url, refresh),
    authorize: urls => Promise.all(urls.map(url => authorize(url))),
  };
}
