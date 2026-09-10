export async function loadCollision(base, manifest) {
  const response = await fetch(`${base}${manifest.collisionFile || 'collision.bin'}`);
  if (!response.ok) throw new Error('未找到导出的原始碰撞数据');
  const payload = await response.arrayBuffer();
  let bytes = payload;
  if (manifest.collisionEncoding === 'gzip') {
    const header = new Uint8Array(payload, 0, Math.min(2, payload.byteLength));
    // Vite serves .gz with Content-Encoding:gzip, so fetch already decompresses
    // it. Plain static hosts may instead return the gzip file as-is.
    const decodedByHttp = /\bgzip\b/i.test(response.headers.get('content-encoding') || '')
      && payload.byteLength === manifest.collisionBytes;
    if (!decodedByHttp) {
      if (header[0] !== 0x1f || header[1] !== 0x8b) throw new Error('碰撞文件不是有效的 gzip 数据');
      bytes = await new Response(new Blob([payload]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    }
  }
  if (bytes.byteLength % 36 !== 0 || (manifest.collisionBytes && bytes.byteLength !== manifest.collisionBytes)) {
    throw new Error('碰撞数据长度与场景清单不一致');
  }
  return new Float32Array(bytes);
}
