export async function decompressGzip(payload) {
  // Keep collision bytes in the stream, avoiding a Blob backing-store read while
  // the previous scene and queued cache writes still occupy browser storage.
  const input = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(payload));
      controller.close();
    },
  });
  return new Response(input.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}
