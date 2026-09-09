export class InputController {
  constructor(canvas, { onOrbit, onClick } = {}) {
    this.canvas = canvas;
    this.enabled = true;
    this.keys = new Set();
    this.drag = null;
    this.start = null;
    this.onOrbit = onOrbit;
    this.onClick = onClick;
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onWheel = this.onWheel.bind(this);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.style.touchAction = 'none';
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) this.keys.clear();
  }

  axes() {
    const forward = Number(this.keys.has('KeyW') || this.keys.has('ArrowUp')) - Number(this.keys.has('KeyS') || this.keys.has('ArrowDown'));
    const right = Number(this.keys.has('KeyD') || this.keys.has('ArrowRight')) - Number(this.keys.has('KeyA') || this.keys.has('ArrowLeft'));
    return { forward, right, sprint: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') };
  }

  consumeJump() {
    const jumping = this.keys.has('Space');
    this.keys.delete('Space');
    return jumping;
  }

  dispose() {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
  }

  onKeyDown(event) {
    if (!this.enabled || event.ctrlKey || event.metaKey || this.isTyping(event.target)) return;
    if (event.code === 'Tab') {
      event.preventDefault();
      this.onClick?.('nearest');
      return;
    }
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight'].includes(event.code)) {
      event.preventDefault();
      this.keys.add(event.code);
    }
  }

  onKeyUp(event) {
    this.keys.delete(event.code);
  }

  onPointerDown(event) {
    if (!this.enabled) return;
    this.drag = { x: event.clientX, y: event.clientY, button: event.button };
    this.start = { x: event.clientX, y: event.clientY };
    this.canvas.setPointerCapture?.(event.pointerId);
  }

  onPointerMove(event) {
    if (!this.drag || !this.enabled) return;
    const dx = event.clientX - this.drag.x;
    const dy = event.clientY - this.drag.y;
    if (this.drag.button === 0 || this.drag.button === 2) this.onOrbit?.(dx, dy);
    this.drag.x = event.clientX;
    this.drag.y = event.clientY;
  }

  onPointerUp(event) {
    if (!this.drag) return;
    const moved = Math.hypot(event.clientX - this.start.x, event.clientY - this.start.y);
    this.drag = null;
    if (moved < 7 && event.button === 0) this.onClick?.('pick', event);
  }

  onWheel(event) {
    if (!this.enabled) return;
    event.preventDefault();
    this.onOrbit?.(0, 0, event.deltaY);
  }

  isTyping(target) {
    const tag = target?.tagName?.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable;
  }
}
