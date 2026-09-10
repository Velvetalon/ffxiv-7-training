// Optional GPU execution timing. Never block rendering with gl.finish() or query waits.
export class GpuTimer {
  constructor(renderer, onResult) {
    this.gl = renderer.getContext();
    this.extension = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.onResult = onResult;
    this.pending = [];
  }

  begin(detail) {
    if (!this.extension || this.pending.length >= 8) return null;
    const query = this.gl.createQuery();
    this.gl.beginQuery(this.extension.TIME_ELAPSED_EXT, query);
    return { query, detail, frames: 0 };
  }

  end(token) {
    if (!token) return;
    this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
    this.pending.push(token);
  }

  poll() {
    if (!this.extension) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.extension.GPU_DISJOINT_EXT);
    for (const token of [...this.pending]) {
      const ready = gl.getQueryParameter(token.query, gl.QUERY_RESULT_AVAILABLE);
      if (!ready && !disjoint && ++token.frames < 300) continue;
      this.pending.splice(this.pending.indexOf(token), 1);
      this.onResult({
        ...token.detail,
        gpuMs: ready && !disjoint ? gl.getQueryParameter(token.query, gl.QUERY_RESULT) / 1e6 : null,
        status: disjoint ? 'disjoint' : ready ? 'measured' : 'timeout',
      });
      gl.deleteQuery(token.query);
    }
  }

  dispose() {
    for (const token of this.pending) this.gl.deleteQuery(token.query);
    this.pending = [];
  }
}
