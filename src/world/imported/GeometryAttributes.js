// Keep the exported source buffers intact on disk. Some client MDLs contain
// NaN texture coordinates; use a deterministic finite value only for rendering.
export function repairRenderAttributes(geometry) {
  const repaired = {};
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    if (!/^uv\d*$/.test(name) && name !== 'color') continue;
    let count = 0;
    for (let i = 0; i < attribute.array.length; i++) {
      if (Number.isFinite(attribute.array[i])) continue;
      attribute.array[i] = name === 'color' ? 1 : 0;
      count++;
    }
    if (count) {
      attribute.needsUpdate = true;
      repaired[name] = count;
    }
  }
  geometry.userData.sourceInvalidRenderComponents = repaired;
  return repaired;
}
