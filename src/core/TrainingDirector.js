// Optional, non-lethal incoming damage for practicing the healing kit.
// Encounter rules stay outside rendering and UI.
export class TrainingDirector {
  constructor(combat) {
    this.combat = combat;
    this.enabled = false;
    this.interval = 8;
    this.remaining = this.interval;
  }
  reset() { this.remaining = this.interval; }
  setEnabled(value) { this.enabled = Boolean(value); this.reset(); }
  hit() {
    const state = this.combat.getState();
    return this.combat.receiveDamage(Math.min(2500, Math.max(0, state.hp - 1)));
  }
  update(dt) {
    if (!this.enabled || !this.combat.getState().inCombat) return;
    this.remaining -= dt;
    if (this.remaining <= 0) { this.remaining += this.interval; this.hit(); }
  }
}
