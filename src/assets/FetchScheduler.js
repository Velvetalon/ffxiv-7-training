export class FetchScheduler {
  constructor({ concurrency = 6, retries = 2, fetcher = globalThis.fetch.bind(globalThis) } = {}) {
    this.concurrency = concurrency;
    this.retries = retries;
    this.fetcher = fetcher;
    this.pending = new Map();
    this.queue = [];
    this.running = 0;
    this.sequence = 0;
  }

  request(key, url, { priority = 10, signal, headers, onResponse } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    let task = this.pending.get(key);
    if (!task) {
      task = { key, url, headers, onResponse, priority, queuedAt: performance.now(), order: this.sequence++, controller: new AbortController(), clients: new Set() };
      this.pending.set(key, task);
      this.queue.push(task);
    }
    task.priority = Math.min(task.priority, priority);
    const result = new Promise((resolve, reject) => {
      const client = { resolve, reject, signal };
      client.abort = () => {
        task.clients.delete(client);
        reject(signal.reason || new DOMException('Aborted', 'AbortError'));
        if (!task.clients.size) {
          task.controller.abort();
          if (this.pending.get(key) === task) this.pending.delete(key);
        }
      };
      signal?.addEventListener('abort', client.abort, { once: true });
      task.clients.add(client);
    });
    this.pump();
    return result;
  }

  promote(key, priority) {
    const task = this.pending.get(key);
    if (task) task.priority = Math.min(task.priority, priority);
  }

  pump() {
    this.queue.sort((a, b) => a.priority - b.priority || a.order - b.order);
    while (this.running < this.concurrency && this.queue.length) {
      const task = this.queue.shift();
      if (!task.clients.size) continue;
      this.running++;
      this.execute(task).then(
        value => this.finish(task, null, value),
        error => this.finish(task, error),
      );
    }
  }

  async execute(task) {
    const signal = task.controller.signal;
    for (let attempt = 0; ; attempt++) {
      try {
        signal.throwIfAborted();
        const url = typeof task.url === 'function' ? await task.url(attempt) : task.url;
        const start = performance.now();
        const response = await this.fetcher(url, { headers: task.headers, signal });
        if (!response.ok) {
          const error = new Error(`Asset HTTP ${response.status}: ${new URL(url, globalThis.location?.href || 'http://localhost/').pathname}`);
          error.retryable = response.status === 408 || response.status === 429 || response.status >= 500 ||
            (typeof task.url === 'function' && [401, 403].includes(response.status) && attempt === 0);
          throw error;
        }
        const bytes = await response.arrayBuffer();
        const result = { bytes, status: response.status, headers: response.headers, fetchMs: performance.now() - start, queueMs: start - task.queuedAt, attempt };
        task.onResponse?.(result);
        return result;
      } catch (error) {
        if (signal.aborted || error.retryable === false || attempt >= this.retries) throw error;
        await new Promise((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 250 * 2 ** attempt);
          signal.addEventListener('abort', abort, { once: true });
        });
      }
    }
  }

  finish(task, error, result) {
    this.running--;
    if (this.pending.get(task.key) === task) this.pending.delete(task.key);
    for (const client of task.clients) {
      client.signal?.removeEventListener('abort', client.abort);
      if (error) client.reject(error);
      else client.resolve(result);
    }
    task.clients.clear();
    this.pump();
  }
}
