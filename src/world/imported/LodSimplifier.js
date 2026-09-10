import { MeshoptSimplifier } from 'meshoptimizer/simplifier';

export async function simplifyLevels({ indices, positions, attributes, stride, weights }) {
  await MeshoptSimplifier.ready;
  return [0.55, 0.25].map((ratio, level) => {
    const target = Math.max(3, Math.floor(indices.length * ratio / 3) * 3);
    const [result, error] = MeshoptSimplifier.simplifyWithAttributes(
      indices, positions, 3, attributes, stride, weights, null,
      target, level === 0 ? 0.006 : 0.018, ['LockBorder'],
    );
    return { indices: result, error };
  });
}
