export function drawMap(canvas, info, sceneId, expanded = false) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const x = info.position?.x || 0, z = info.position?.z || 0;
  const scale = expanded ? 5 : 3.2;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  if (!expanded) {
    ctx.beginPath(); ctx.arc(w / 2, h / 2, w / 2 - 5, 0, Math.PI * 2); ctx.clip();
  }
  ctx.fillStyle = sceneId === 'gridania' ? '#263f35' : '#234a54';
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
  ctx.strokeStyle = sceneId === 'gridania' ? '#4e6351' : '#51818a';
  ctx.lineWidth = 1;
  for (let i = -20; i <= 20; i++) {
    ctx.beginPath(); ctx.moveTo(i * 24 - x % 24, -h); ctx.lineTo(i * 24 - x % 24, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-w, i * 24 - z % 24); ctx.lineTo(w, i * 24 - z % 24); ctx.stroke();
  }
  ctx.translate(-x * scale, -z * scale);
  if (info.map?.paths) {
    for (const path of info.map.paths) {
      ctx.fillStyle = path.color || (sceneId === 'gridania' ? '#9eae82' : '#c4d5c4');
      ctx.save();
      ctx.translate(path.x * scale, path.z * scale);
      ctx.rotate(path.rotation || 0);
      ctx.fillRect(-path.w * scale / 2, -path.d * scale / 2, path.w * scale, path.d * scale);
      ctx.restore();
    }
  }
  for (const entity of info.entities || []) {
    const ex = entity.x ?? entity.position?.x ?? 0;
    const ez = entity.z ?? entity.position?.z ?? 0;
    ctx.fillStyle = entity.type === 'npc' ? '#d2bd72' : entity.type === 'dummy' || entity.type === 'monster' ? '#eb7969' : '#70dae3';
    ctx.beginPath(); ctx.arc(ex * scale, ez * scale, expanded ? 5 : 4, 0, Math.PI * 2); ctx.fill();
    if (expanded) {
      ctx.font = '14px "Microsoft YaHei", sans-serif';
      ctx.fillStyle = '#fff'; ctx.fillText(entity.name, ex * scale + 10, ez * scale + 5);
    }
  }
  ctx.translate(x * scale, z * scale);
  ctx.rotate(info.cameraAngle || 0);
  ctx.fillStyle = '#f4f1cf';
  ctx.strokeStyle = '#233c34'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(6, 7); ctx.lineTo(0, 4); ctx.lineTo(-6, 7); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.restore();
}
