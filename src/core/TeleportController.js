export class TeleportController {
  constructor({ scenes, getSceneId, isInCombat, onStart, onFinish, onCancel, onError }) {
    Object.assign(this, { scenes, getSceneId, isInCombat, onStart, onFinish, onCancel, onError });
    this.cast = null;
  }
  start(id, immediate = false, entry = {}) {
    let reason;
    if (!this.scenes.some(scene => scene.id === id)) reason = '未知场景';
    else if (!immediate && this.isInCombat()) reason = '战斗中无法传送，请先结束或重置练习';
    else if (!immediate && id === this.getSceneId()) reason = '已经位于该地区';
    if (reason) { this.onError(reason); return { ok: false, reason }; }
    if (immediate) this.finish(id, entry);
    else {
      this.cast = { id, name: '传送', remaining: 5, total: 5, entry };
      this.onStart();
    }
    return { ok: true };
  }
  cancel() {
    if (!this.cast) return;
    this.cast = null;
    this.onCancel();
  }
  finish(id, entry = {}) { this.cast = null; this.onFinish(id, entry); }
  update(dt, moving) {
    if (!this.cast) return;
    if (moving) { this.cancel(); return; }
    this.cast.remaining -= dt;
    if (this.cast.remaining <= 0) this.finish(this.cast.id, this.cast.entry);
  }
}
