const EMPTY_ENTRANCES = Object.freeze([]);

function cleanKey(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cleanPosition(point) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  const z = Number(point?.z);
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
}

export function normalizeDutyEntrances(value) {
  const source = Array.isArray(value)
    ? value
    : value?.entrances || value?.gates;
  if (!Array.isArray(source)) return [...EMPTY_ENTRANCES];
  return source.flatMap((gate, index) => {
    const dutyKey = cleanKey(gate?.dutyKey);
    const fromSceneId = cleanKey(gate?.fromSceneId || gate?.sceneId || gate?.sourceSceneId);
    const position = cleanPosition(gate?.position || gate);
    if (!dutyKey || !fromSceneId || !position) return [];
    return [{
      ...gate,
      dutyKey,
      fromSceneId,
      position,
      radius: Number.isFinite(Number(gate?.radius)) ? Number(gate.radius) : 4,
      name: cleanKey(gate?.name) || dutyKey,
      status: cleanKey(gate?.status) || 'unverified',
      order: index,
    }];
  });
}

export async function loadDutyEntrances(url = `${import.meta.env.BASE_URL}duties/entrances.json`) {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return [...EMPTY_ENTRANCES];
    return normalizeDutyEntrances(await response.json());
  } catch {
    return [...EMPTY_ENTRANCES];
  }
}
