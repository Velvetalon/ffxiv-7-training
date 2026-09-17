/**
 * EffectDefinition decoder for AssetRuntime.
 * Definitions are pre-converted JSON produced by tools/vfx; the browser never
 * parses binary AVFX. The decoder normalizes them into definitions for EffectRuntime.
 */
export function installEffectDecoder(runtime) {
  if (!runtime || runtime.__effectDecoderInstalled) return;
  runtime.decoder('effect-definition', async (bytes, record) => {
    const text = new TextDecoder().decode(bytes);
    const definition = JSON.parse(text);
    definition.effectId = record.id;
    return definition;
  });
  runtime.__effectDecoderInstalled = true;
}

