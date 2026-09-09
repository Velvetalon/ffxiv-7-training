export function drawMap(canvas, info, sceneId, expanded = false) {
  if (!canvas || !info.map) return;
  const ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
  const { bounds, roads = [], surfaces = [], water = [], landmarks = [] } = info.map;
  const x = info.position?.x || 0, z = info.position?.z || 0;
  const scale = expanded ? Math.min((w - 70) / (bounds.maxX - bounds.minX), (h - 65) / (bounds.maxZ - bounds.minZ)) : 2.8;
  const centerX = expanded ? (bounds.minX + bounds.maxX) / 2 : x;
  const centerZ = expanded ? (bounds.minZ + bounds.maxZ) / 2 : z;
  const px = value => w / 2 + (value - centerX) * scale;
  const py = value => h / 2 + (value - centerZ) * scale;
  const polygon = points => {
    ctx.beginPath(); points.forEach(([x, z], i) => i ? ctx.lineTo(px(x), py(z)) : ctx.moveTo(px(x), py(z))); ctx.closePath();
  };
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = sceneId === 'gridania' ? '#637c65' : '#477b88'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#e4e3b519'; ctx.lineWidth = 1;
  for (let i = -500; i < 500; i += 20) {
    ctx.beginPath(); ctx.moveTo(px(i), 0); ctx.lineTo(px(i), h); ctx.moveTo(0, py(i)); ctx.lineTo(w, py(i)); ctx.stroke();
  }
  for (const patch of water) { polygon(patch.points); ctx.fillStyle = '#477b88'; ctx.fill(); }
  for (const surface of surfaces) {
    polygon(surface.points); ctx.fillStyle = surface.kind === 'wood' ? '#c3a979' : '#d4c99d'; ctx.fill();
    ctx.strokeStyle = '#6f674b'; ctx.stroke();
  }
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const road of roads) {
    ctx.beginPath();
    road.points.forEach(([x, z], i) => i ? ctx.lineTo(px(x), py(z)) : ctx.moveTo(px(x), py(z)));
    ctx.strokeStyle = '#6b6349'; ctx.lineWidth = road.width * scale + 2; ctx.stroke();
    ctx.strokeStyle = road.kind === 'wood' ? '#c6ab7a' : '#d4c99d'; ctx.lineWidth = road.width * scale; ctx.stroke();
  }
  landmarks.forEach((landmark, i) => {
    const lx = px(landmark.x), lz = py(landmark.z);
    ctx.fillStyle = landmark.type === 'crystal' ? '#99f3f0' : '#634f40';
    ctx.beginPath(); ctx.arc(lx, lz, expanded ? 9 : 3.5, 0, Math.PI * 2); ctx.fill();
    if (expanded) {
      ctx.fillStyle = '#fff4d2'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = 'bold 10px sans-serif'; ctx.fillText(i + 1, lx, lz + 0.5);
    }
  });
  for (const entity of info.entities || []) {
    ctx.fillStyle = entity.type === 'npc' ? '#f4d56d' : '#ed866d';
    ctx.fillRect(px(entity.x) - 2, py(entity.z) - 2, 4, 4);
  }
  ctx.fillStyle = '#fffbe0'; ctx.strokeStyle = '#203640'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(px(x), py(z) - 7); ctx.lineTo(px(x) + 5, py(z) + 5); ctx.lineTo(px(x) - 5, py(z) + 5); ctx.closePath(); ctx.fill(); ctx.stroke();
  if (expanded) {
    ctx.font = 'bold 15px serif'; ctx.fillStyle = '#f6eecf'; ctx.textAlign = 'right'; ctx.fillText('N ↑', w - 22, 23);
  }
}
