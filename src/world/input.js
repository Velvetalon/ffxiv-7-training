export class InputController {
  constructor(canvas, { onOrbit, onClick, onLookStart } = {}) {
    this.canvas = canvas;
    this.enabled = true;
    this.keys = new Set();
    this.drag = null;
    this.start = null;
    this.onOrbit = onOrbit;
    this.onClick = onClick;
    this.onLookStart = onLookStart;
    this.controlMode = 'traditional';
    this.onContextMenu = event => event.preventDefault();
    this.onBlur = () => { this.keys.clear(); this.releaseLook(); };
    this.onLockChange = () => {
      if (document.pointerLockElement === this.canvas) {
        if (!this.isLooking) document.exitPointerLock();
      } else if (this.wasLocked) this.releaseLook();
      this.wasLocked = document.pointerLockElement === this.canvas;
    };
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
    canvas.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('pointercancel', this.onBlur);
    document.addEventListener('pointerlockchange', this.onLockChange);
    canvas.style.touchAction = 'none';
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) { this.keys.clear(); this.releaseLook(); }
  }

  get isLooking() { return this.drag?.button === 2 && this.controlMode === 'traditional'; }
  setControlMode(mode) { this.releaseLook(); this.controlMode = mode === 'orbit' ? 'orbit' : 'traditional'; }
  releaseLook() {
    const pointerId = this.drag?.pointerId;
    this.drag = null; this.start = null; this.canvas.style.cursor = '';
    if (pointerId !== undefined && this.canvas.hasPointerCapture?.(pointerId)) this.canvas.releasePointerCapture(pointerId);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }
  axes() {
    const forward = Number(this.keys.has('KeyW') || this.keys.has('ArrowUp')) - Number(this.keys.has('KeyS') || this.keys.has('ArrowDown'));
    const right = Number(this.keys.has('KeyD') || this.keys.has('KeyE') || this.keys.has('ArrowRight')) - Number(this.keys.has('KeyA') || this.keys.has('KeyQ') || this.keys.has('ArrowLeft'));
    return { forward, right, sprint: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'), ascend: Number(this.keys.has('Space')), descend: Number(this.keys.has('KeyX')) };
  }

  consumeJump() {
    const jumping = this.keys.has('Space');
    this.keys.delete('Space');
    return jumping;
  }

  dispose() {
    this.releaseLook();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('pointercancel', this.onBlur);
    document.removeEventListener('pointerlockchange', this.onLockChange);
  }

  onKeyDown(event) {
    if (!this.enabled || event.ctrlKey || event.metaKey || this.isTyping(event.target)) return;
    if (event.code === 'Tab') {
      event.preventDefault();
      this.onClick?.('nearest');
      return;
    }
    if (event.code === 'Escape') this.releaseLook();
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyX', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight'].includes(event.code)) {
      event.preventDefault();
      this.keys.add(event.code);
    }
  }

  onKeyUp(event) {
    this.keys.delete(event.code);
  }

  onPointerDown(event) {
    if (!this.enabled) return;
    if (![0, 2].includes(event.button)) return;
    event.preventDefault();
    this.drag = { x: event.clientX, y: event.clientY, button: event.button, pointerId: event.pointerId, moved: 0 };
    this.start = { x: event.clientX, y: event.clientY };
    this.canvas.setPointerCapture?.(event.pointerId);
    if (this.isLooking) {
      this.canvas.style.cursor = 'none';
      this.onLookStart?.();
      // Embedded browsers may deny pointer lock. Pointer capture still provides drag-look.
      try { this.canvas.requestPointerLock?.()?.catch(() => {}); } catch { /* Keep captured drag-look. */ }
    }
  }

  onPointerMove(event) {
    if (!this.drag || !this.enabled) return;
    const locked = document.pointerLockElement === this.canvas;
    if (!locked && event.pointerId !== this.drag.pointerId) return;
    const dx = locked ? event.movementX : event.clientX - this.drag.x;
    const dy = locked ? event.movementY : event.clientY - this.drag.y;
    if (this.drag.button === 0 || this.drag.button === 2) {
      this.drag.moved += Math.hypot(dx || 0, dy || 0);
      this.onOrbit?.(dx || 0, dy || 0);
    }
    this.drag.x = event.clientX;
    this.drag.y = event.clientY;
  }

  onPointerUp(event) {
    if (!this.drag) return;
    if (event.button !== this.drag.button) return;
    if (event.pointerId !== undefined && event.pointerId !== this.drag.pointerId && document.pointerLockElement !== this.canvas) return;
    const moved = this.drag.moved || Math.hypot(event.clientX - this.start.x, event.clientY - this.start.y);
    this.releaseLook();
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
