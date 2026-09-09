import * as THREE from 'three';
import { paintedMaterial } from './Materials.js';
import { insidePolygon } from '../terrain/Navigation.js';

function canopyTexture() {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 384;
  const ctx = canvas.getContext('2d');
  for (let i = 0; i < 660; i++) {
    const angle = i * 2.39996, r = Math.sqrt(i / 660);
    const x = 256 + Math.cos(angle) * r * 226, y = 186 + Math.sin(angle) * r * 159;
    ctx.fillStyle = ['#2e5343', '#487257', '#66936c', '#95b47b', '#759d6b'][i % 5];
    ctx.beginPath(); ctx.ellipse(x, y, 19 + i % 8, 10 + i % 6, angle, 0, Math.PI * 2); ctx.fill();
    if (i % 3 === 0) {
      ctx.strokeStyle = '#bbcf9277'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x - 8, y); ctx.lineTo(x + 6, y - 4); ctx.stroke();
    }
  }
  const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace; map.userData.sceneOwned = true;
  return map;
}

export function addWoodland(state, group, layout) {
  const sites = [];
  const b = layout.bounds;
  for (let i = 0; i < 420; i++) {
    const u = ((i * 0.61803398875) % 1), v = ((i * 0.41421356237) % 1);
    const x = b.minX - 18 + u * (b.maxX - b.minX + 36), z = b.minZ - 18 + v * (b.maxZ - b.minZ + 36);
    if (layout.water.some(water => insidePolygon(x, z, water.points))) continue;
    if (state.navigation.nearestWalkable(x, z, 5)) continue;
    sites.push({ x, z, size: 0.8 + (i % 7) * 0.14 });
  }
  const bark = paintedMaterial('bark');
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.25, 0.57, 8, 20), bark, sites.length);
  const leaves = new THREE.InstancedMesh(new THREE.PlaneGeometry(13, 9), new THREE.MeshStandardMaterial({ map: canopyTexture(), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 1 }), sites.length * 3);
  const dummy = new THREE.Object3D();
  sites.forEach(({ x, z, size }, i) => {
    dummy.position.set(x, 4 * size - 0.7, z); dummy.scale.set(size, size, size); dummy.rotation.set(0, i * 1.3, 0);
    dummy.updateMatrix(); trunks.setMatrixAt(i, dummy.matrix);
    for (let n = 0; n < 3; n++) {
      dummy.position.set(x, (8 + n * 0.8) * size - 0.7, z); dummy.rotation.set(n === 2 ? -0.65 : 0, n * Math.PI / 3 + i, 0);
      dummy.updateMatrix(); leaves.setMatrixAt(i * 3 + n, dummy.matrix);
    }
  });
  trunks.castShadow = true; trunks.receiveShadow = true; leaves.castShadow = true;
  group.add(trunks, leaves);
}

export function addPaintedSky(group, theme) {
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 512;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 512);
  gradient.addColorStop(0, '#5b7f9c'); gradient.addColorStop(0.5, '#95b9c2'); gradient.addColorStop(1, theme === 'limsa' ? '#e5dbc4' : '#d7dfc0');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 1024, 512);
  for (let i = 0; i < 85; i++) {
    const x = (i * 173.13) % 1024, y = 190 + Math.sin(i * 7.3) * 45;
    ctx.fillStyle = `rgba(255,246,222,${0.04 + (i % 3) * 0.02})`;
    ctx.beginPath(); ctx.ellipse(x, y, 40 + i % 70, 9 + i % 14, 0, 0, Math.PI * 2); ctx.fill();
  }
  const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace; map.userData.sceneOwned = true;
  const sky = new THREE.Mesh(new THREE.SphereGeometry(450, 48, 32), new THREE.MeshBasicMaterial({ map, side: THREE.BackSide, fog: false }));
  group.add(sky);
}
