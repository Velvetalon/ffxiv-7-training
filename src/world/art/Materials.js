import * as THREE from 'three';

const cache = new Map();
const palettes = {
  stone: ['#a7a393', '#d9d4b8', '#efe5c8', '#c2bc9f'],
  marble: ['#aaa89a', '#ece7d5', '#fff3d4', '#d9d6c9'],
  wood: ['#67432d', '#a77445', '#cf9b5d', '#895b37'],
  earth: ['#716347', '#a89770', '#cab185', '#8e805c'],
  grass: ['#344934', '#61714b', '#8b9664', '#485d40'],
  roof: ['#254b4a', '#457472', '#79a08b', '#396563'],
  cloth: ['#bfb3a4', '#eee2c7', '#fff3d9', '#dccbac'],
  bark: ['#3c3026', '#68523b', '#967a53', '#51412e'],
};
function noise(x, y) { return Math.sin(x * 123.43 + y * 45.37) * 0.5 + 0.5; }

export function paintedTexture(kind = 'stone') {
  if (cache.has(kind)) return cache.get(kind);
  const colors = palettes[kind] || palettes.stone;
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = colors[0]; ctx.fillRect(0, 0, 512, 512);
  if (['stone', 'marble', 'wood', 'roof'].includes(kind)) {
    const bw = kind === 'wood' ? 512 : kind === 'roof' ? 42 : 100;
    const bh = kind === 'wood' ? 48 : kind === 'roof' ? 32 : 64;
    for (let y = -1; y < 512 / bh + 1; y++) for (let x = -1; x < 512 / bw + 1; x++) {
      const bx = x * bw + (y % 2) * bw / 2, by = y * bh;
      const grad = ctx.createLinearGradient(bx, by, bx + bw / 3, by + bh);
      grad.addColorStop(0, colors[2]); grad.addColorStop(0.14, colors[1]); grad.addColorStop(1, colors[3]);
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.roundRect(bx + 2, by + 2, bw - 4, bh - 4, kind === 'wood' ? 2 : 7); ctx.fill();
      ctx.strokeStyle = colors[2] + '77'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(bx + 7, by + 5); ctx.lineTo(bx + bw - 8, by + 5); ctx.stroke();
      for (let n = 0; n < 12; n++) {
        const px = bx + noise(x + n, y) * bw, py = by + noise(y + n, x) * bh;
        ctx.strokeStyle = colors[n % 2 ? 0 : 2] + '22'; ctx.lineWidth = 1.8;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.quadraticCurveTo(px + 8, py - 2, px + (kind === 'wood' ? 65 : 20), py + 2); ctx.stroke();
      }
    }
  } else {
    ctx.fillStyle = colors[1]; ctx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 1800; i++) {
      const x = noise(i, 13) * 512, y = noise(i, 97) * 512;
      ctx.strokeStyle = colors[i % colors.length] + '55';
      ctx.lineWidth = 1 + noise(i, 4) * 4;
      ctx.beginPath(); ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + 5, y - 3, x + (kind === 'bark' ? 2 : 14), y + (kind === 'bark' ? 55 : 3)); ctx.stroke();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  cache.set(kind, texture); return texture;
}

export function paintedMaterial(kind, color = '#ffffff', repeat = 1) {
  const map = paintedTexture(kind).clone(); map.repeat.set(repeat, repeat); map.needsUpdate = true;
  map.userData.sceneOwned = true;
  return new THREE.MeshStandardMaterial({ map, color, roughness: 0.88, metalness: 0, bumpMap: map, bumpScale: kind === 'cloth' ? 0.025 : 0.075 });
}
export function worldUV(geometry, scale = 0.16) {
  const p = geometry.attributes.position, n = geometry.attributes.normal, uv = [];
  for (let i = 0; i < p.count; i++) {
    if (!n || Math.abs(n.getY(i)) > 0.6) uv.push(p.getX(i) * scale, p.getZ(i) * scale);
    else uv.push((Math.abs(n.getX(i)) > 0.6 ? p.getZ(i) : p.getX(i)) * scale, p.getY(i) * scale);
  }
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return geometry;
}
