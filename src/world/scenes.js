export const SCENES = [
  { id: 'gridania', name: '格里达尼亚新街', en: 'NEW GRIDANIA', region: '黑衣森林', description: '水道与木桥环抱着古老的以太之光。', accent: '#b7d794' },
  { id: 'limsa', name: '利姆萨·罗敏萨下层甲板', en: 'LIMSA LOMINSA', region: '拉诺西亚', description: '白石拱廊、帆影和无尽的大海。', accent: '#79cbd4' },
];

export async function loadSceneCatalog() {
  const response = await fetch(`${import.meta.env.BASE_URL}extracted/active.json`, { cache: 'no-store' });
  if (!response.ok) throw new Error('无法读取已开放地图清单');
  const active = await response.json();
  const defaults = new Map(SCENES.map(scene => [scene.id, scene]));
  const scenes = Object.entries(active.scenes || {}).map(([id, record]) => ({
    id, name: record.name || defaults.get(id)?.name || id,
    en: record.en || defaults.get(id)?.en || id.toUpperCase(),
    region: record.region || defaults.get(id)?.region || '大世界',
    description: record.description || defaults.get(id)?.description || '',
    accent: record.accent || defaults.get(id)?.accent || '#99c9c5',
    territoryId: record.territoryId,
  }));
  if (!scenes.length) throw new Error('已开放地图清单为空');
  SCENES.splice(0, SCENES.length, ...scenes);
  return SCENES;
}
