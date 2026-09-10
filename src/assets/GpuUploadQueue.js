export class GpuUploadQueue {
  constructor({ budgetMs = 4 } = {}) {
    this.budgetMs = budgetMs;
    this.queue = [];
    this.scheduled = false;
  }

  enqueue(run, { priority = 10, signal, onTiming } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ run, priority, signal, onTiming, resolve, reject });
      this.schedule();
    });
  }

  schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => this.drain());
  }

  drain() {
    this.scheduled = false;
    this.queue.sort((a, b) => a.priority - b.priority);
    const start = performance.now();
    do {
      const task = this.queue.shift();
      if (!task) break;
      try {
        task.signal?.throwIfAborted();
        const begin = performance.now();
        const value = task.run();
        task.onTiming?.(performance.now() - begin);
        task.resolve(value);
      } catch (error) {
        task.reject(error);
      }
    } while (performance.now() - start < this.budgetMs);
    if (this.queue.length) this.schedule();
  }
}
