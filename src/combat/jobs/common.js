export function validateRole(engine, action) {
  if (action.id === 'role-rescue' && !engine.lastContext.target) return '没有队员目标';
  return null;
}

export function executeRole(engine, action) {
  switch (action.effect) {
    case 'lucid': engine.addBuff('lucid', '醒梦', 21); return { buffEvent: true };
    case 'swiftcast': engine.addBuff('swiftcast', '即刻咏唱', 10); return { buffEvent: true };
    case 'surecast': engine.addBuff('surecast', '沉稳咏唱', 6); return { buffEvent: true };
    case 'trueNorth': engine.addBuff('true-north', '真北', 10); return { buffEvent: true };
    case 'bloodbath': engine.addBuff('bloodbath', '浴血', 20); return { buffEvent: true };
    case 'armsLength': engine.addBuff('arms-length', '亲疏自行', 6); return { buffEvent: true };
    case 'addle': engine.addBuff('addle', '昏乱', 15); return { buffEvent: true };
    case 'feint': engine.addBuff('feint', '牵制', 15); return { buffEvent: true };
    case 'stun': engine.addBuff('target-stun', '眩晕', 3); return { buffEvent: true };
    case 'sleep':
    case 'repose': engine.addBuff('target-sleep', '睡眠', 30); return { buffEvent: true };
    case 'heal': return { heal: action.heal };
    case 'esuna':
    case 'raise':
    case 'rescue': return { buffEvent: true };
    default: return null;
  }
}

