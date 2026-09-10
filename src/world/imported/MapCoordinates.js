import catalog from '../../../tools/map-tools/world-catalog.json' with { type: 'json' };

const mapMetadata = new Map(catalog.scenes.map(scene => [scene.id, scene]));

export function mapImageBounds(sceneId) {
  const metadata = mapMetadata.get(sceneId);
  if (!metadata) throw new Error(`Missing map coordinates: ${sceneId}`);
  // The source map canvas is 2048 pixels. SizeFactor scales world units
  // into map pixels; offsets are in world units, before that scale.
  const half = 102400 / metadata.sizeFactor;
  return {
    minX: -half - metadata.offsetX, maxX: half - metadata.offsetX,
    minZ: -half - metadata.offsetY, maxZ: half - metadata.offsetY,
  };
}
