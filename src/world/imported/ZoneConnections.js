import * as THREE from 'three';

export function connectionDistance(connection, point) {
  const [x, y, z] = connection.position;
  if (Math.abs(point.y - y) > 4) return Infinity;
  return Math.hypot(point.x - x, point.z - z);
}

export function nearestConnection(connections, point) {
  let nearest = null, distance = Infinity;
  for (const connection of connections) {
    const candidate = connectionDistance(connection, point);
    if (candidate <= (connection.radius || 3) && candidate < distance) {
      nearest = connection; distance = candidate;
    }
  }
  return nearest;
}

export function mountConnections(group, connections) {
  for (const connection of connections) {
    const marker = new THREE.Group();
    marker.name = `connection:${connection.id}`;
    marker.position.fromArray(connection.position);
    marker.userData.connection = connection;
    const material = new THREE.MeshBasicMaterial({ color: '#9be3ef', transparent: true, opacity: 0.7 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.35, 0.07, 6, 28), material);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.14;
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.45, 0.85, 4), material);
    arrow.rotation.z = Math.PI;
    arrow.position.y = 2.6;
    marker.add(ring, arrow);
    ring.userData.connection = connection;
    arrow.userData.connection = connection;
    group.add(marker);
  }
}

export function findArrival(manifest, navigation, entry = {}) {
  const connection = entry.arrivalConnection
    ? manifest.connections?.find(item => item.id === entry.arrivalConnection) : null;
  if (entry.arrivalConnection && !connection) throw new Error('目标地图缺少对应连接点');
  const destination = entry.arrival || connection?.spawn || connection?.position;
  if (!destination) return null;
  const [x, y, z] = destination;
  const floor = navigation.nearestWalkable(x, z, 10, y);
  if (!floor || Math.abs(floor.y - y) > 5) throw new Error('区域连接点没有可安全落地的位置');
  return floor;
}
