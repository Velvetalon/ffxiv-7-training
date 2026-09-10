import { icon, iconify } from '../dom.js';

export const HUD_LAYOUT_STORAGE_KEY = 'aetheryte-hud-layouts-v1';
export const HUD_LAYOUT_IDS = Object.freeze(['target', 'encounter', 'location', 'hotbar', 'casting']);

const SLOT_COUNT = 4;
const ENTRY_LIMITS = Object.freeze({ scale: [0.65, 1.45], opacity: [0.2, 1] });

const HUD_DEFINITIONS = Object.freeze([
  { id: 'target', label: '目标信息', selector: '#target-frame', anchor: 'top', x: 0, y: 0.18 },
  { id: 'encounter', label: '战斗记录', selector: '.encounter', anchor: 'top-left', x: 0.13, y: 0.34 },
  { id: 'location', label: '地区小地图', selector: '.location', anchor: 'top-right', x: -0.13, y: 0.33 },
  { id: 'hotbar', label: '角色与热键栏', selector: '.bottom-hud', anchor: 'bottom', x: 0, y: -0.18, usesUiScale: true },
  { id: 'casting', label: '咏唱条', selector: '#casting', anchor: 'bottom', x: 0, y: -0.36 },
]);

const ANCHORS = Object.freeze({
  'top-left': [0, 0], top: [0.5, 0], 'top-right': [1, 0],
  left: [0, 0.5], center: [0.5, 0.5], right: [1, 0.5],
  'bottom-left': [0, 1], bottom: [0.5, 1], 'bottom-right': [1, 1],
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
const clone = value => JSON.parse(JSON.stringify(value));

export function createDefaultLayout() {
  return Object.fromEntries(HUD_DEFINITIONS.map(({ id, anchor, x, y }) => [id, {
    anchor, x, y, scale: 1, opacity: 1, visible: true,
  }]));
}

export function normalizeLayout(layout) {
  const defaults = createDefaultLayout();
  return Object.fromEntries(HUD_DEFINITIONS.map(({ id }) => {
    const entry = { ...defaults[id], ...(layout?.[id] || {}) };
    return [id, {
      anchor: ANCHORS[entry.anchor] ? entry.anchor : defaults[id].anchor,
      x: clamp(entry.x, -1, 1),
      y: clamp(entry.y, -1, 1),
      scale: clamp(entry.scale, ...ENTRY_LIMITS.scale),
      opacity: clamp(entry.opacity, ...ENTRY_LIMITS.opacity),
      visible: entry.visible !== false,
    }];
  }));
}

function loadSlots(storage) {
  try {
    const saved = JSON.parse(storage.getItem(HUD_LAYOUT_STORAGE_KEY) || '{}');
    const slotData = saved.slots || saved;
    return {
      persisted: Object.keys(slotData).length > 0,
      activeSlot: clamp(saved.activeSlot, 1, SLOT_COUNT) || 1,
      slots: Array.from({ length: SLOT_COUNT }, (_, index) => normalizeLayout(slotData[index + 1])),
    };
  } catch {
    return { persisted: false, activeSlot: 1, slots: Array.from({ length: SLOT_COUNT }, createDefaultLayout) };
  }
}

function anchorPoint(entry, rect) {
  const [anchorX, anchorY] = ANCHORS[entry.anchor];
  return {
    x: (anchorX + entry.x) * rect.width,
    y: (anchorY + entry.y) * rect.height,
  };
}

export class HudLayoutRuntime {
  constructor({ root = document.body, storage = window.localStorage, onEditingChange = () => {} } = {}) {
    this.root = root;
    this.storage = storage;
    this.onEditingChange = onEditingChange;
    const storedLayouts = loadSlots(storage);
    this.slot = storedLayouts.activeSlot;
    this.savedSlots = storedLayouts.slots;
    this.hasPersistedLayouts = storedLayouts.persisted;
    this.draftSlots = null;
    this.selectedId = 'hotbar';
    this.drag = null;
    this.nodes = new Map(HUD_DEFINITIONS.map(definition => [definition.id, {
      ...definition,
      element: root.querySelector(definition.selector),
    }]));
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onKeydown = this.onKeydown.bind(this);
    this.onResize = this.handleResize.bind(this);
    this.attachTargets();
    if (this.hasPersistedLayouts) this.applyLayout(this.savedSlots[this.slot - 1]);
    window.addEventListener('resize', this.onResize);
  }

  get editing() { return !!this.draftSlots; }
  get activeLayout() { return this.editing ? this.draftSlots[this.slot - 1] : this.savedSlots[this.slot - 1]; }
  get selectedEntry() { return this.activeLayout?.[this.selectedId]; }

  attachTargets() {
    for (const [id, target] of this.nodes) {
      if (!target.element) continue;
      target.element.dataset.hudLayoutId = id;
      target.element.addEventListener('pointerdown', event => this.onTargetPointerDown(event, id));
    }
  }

  open() {
    if (this.editing) return;
    this.openSlot = this.slot;
    this.draftSlots = clone(this.savedSlots);
    this.root.classList.add('hud-layout-editing');
    this.mountEditor();
    this.applyDraft();
    this.onEditingChange(true);
    document.addEventListener('keydown', this.onKeydown, true);
  }

  close({ save = false } = {}) {
    if (!this.editing) return;
    if (save) {
      this.savedSlots = clone(this.draftSlots);
      this.persist();
    } else this.slot = this.openSlot;
    this.draftSlots = null;
    this.drag = null;
    this.root.classList.remove('hud-layout-editing');
    this.editor?.remove();
    this.editor = null;
    if (save || this.hasPersistedLayouts) this.applyLayout(this.savedSlots[this.slot - 1]);
    else this.clearAppliedStyles();
    this.onEditingChange(false);
    document.removeEventListener('keydown', this.onKeydown, true);
  }

  toggle() { this.editing ? this.close() : this.open(); }

  destroy() {
    this.close();
    this.clearAppliedStyles();
    window.removeEventListener('resize', this.onResize);
    for (const { element } of this.nodes.values()) element?.removeAttribute('data-hud-layout-id');
  }

  persist() {
    this.hasPersistedLayouts = true;
    this.storage.setItem(HUD_LAYOUT_STORAGE_KEY, JSON.stringify({
      activeSlot: this.slot,
      slots: Object.fromEntries(this.savedSlots.map((layout, index) => [index + 1, layout])),
    }));
  }

  mountEditor() {
    this.editor = document.createElement('section');
    this.editor.id = 'hud-layout-editor';
    this.editor.className = 'hud-layout-editor';
    this.editor.setAttribute('aria-label', 'HUD 布局编辑器');
    this.editor.innerHTML = `
      <header class="hud-layout-header"><span class="overline">HUD LAYOUT</span><strong>界面布局</strong><button type="button" class="tiny-button" data-layout-action="cancel" title="取消" aria-label="取消">${icon('x')}</button></header>
      <div class="hud-layout-slots" role="tablist" aria-label="布局栏位">${Array.from({ length: SLOT_COUNT }, (_, index) => `<button type="button" data-layout-slot="${index + 1}" role="tab">${index + 1}</button>`).join('')}</div>
      <div class="hud-layout-selection"><span data-layout-selected></span><label class="hud-layout-visible"><input type="checkbox" data-layout-visible><span>显示</span></label></div>
      <label class="hud-layout-anchor"><span>锚点</span><select data-layout-anchor><option value="top-left">左上</option><option value="top">上方</option><option value="top-right">右上</option><option value="left">左侧</option><option value="center">中央</option><option value="right">右侧</option><option value="bottom-left">左下</option><option value="bottom">下方</option><option value="bottom-right">右下</option></select></label>
      <label class="hud-layout-range"><span>缩放 <output data-layout-scale-output></output></span><input data-layout-scale type="range" min="65" max="145" value="100"></label>
      <label class="hud-layout-range"><span>透明度 <output data-layout-opacity-output></output></span><input data-layout-opacity type="range" min="20" max="100" value="100"></label>
      <div class="hud-layout-actions"><button type="button" class="tiny-button" data-layout-action="reset" title="重置当前元素" aria-label="重置当前元素">${icon('rotate-ccw')}</button><button type="button" class="command" data-layout-action="save">${icon('check')}<span>保存</span></button><button type="button" class="command muted-command" data-layout-action="cancel"><span>取消</span></button></div>
    `;
    this.root.append(this.editor);
    iconify(this.editor);
    this.editor.addEventListener('pointerdown', event => event.stopPropagation());
    this.editor.addEventListener('click', event => this.onEditorClick(event));
    this.editor.addEventListener('input', event => this.onEditorInput(event));
    this.renderEditor();
  }

  onEditorClick(event) {
    const slot = event.target.closest('[data-layout-slot]');
    if (slot) {
      this.slot = Number(slot.dataset.layoutSlot);
      this.applyDraft();
      this.renderEditor();
      return;
    }
    const action = event.target.closest('[data-layout-action]')?.dataset.layoutAction;
    if (action === 'save') this.close({ save: true });
    if (action === 'cancel') this.close();
    if (action === 'reset') {
      const defaults = createDefaultLayout();
      this.activeLayout[this.selectedId] = defaults[this.selectedId];
      this.applyDraft();
      this.renderEditor();
    }
  }

  onEditorInput(event) {
    const entry = this.selectedEntry;
    if (!entry) return;
    if (event.target.matches('[data-layout-scale]')) entry.scale = Number(event.target.value) / 100;
    if (event.target.matches('[data-layout-opacity]')) entry.opacity = Number(event.target.value) / 100;
    if (event.target.matches('[data-layout-visible]')) entry.visible = event.target.checked;
    if (event.target.matches('[data-layout-anchor]')) entry.anchor = event.target.value;
    this.constrainEntry(this.selectedId);
    this.applyDraft();
    this.renderEditor();
  }

  onTargetPointerDown(event, id) {
    if (!this.editing || event.button !== 0 || event.target.closest('button,input,select,a')) return;
    event.preventDefault();
    event.stopPropagation();
    this.selectedId = id;
    this.drag = { id, startX: event.clientX, startY: event.clientY, entry: { ...this.selectedEntry } };
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp, { once: true });
    this.applyDraft();
    this.renderEditor();
  }

  onPointerMove(event) {
    if (!this.drag) return;
    const rect = this.root.getBoundingClientRect();
    const entry = this.activeLayout[this.drag.id];
    entry.x = this.drag.entry.x + (event.clientX - this.drag.startX) / rect.width;
    entry.y = this.drag.entry.y + (event.clientY - this.drag.startY) / rect.height;
    this.constrainEntry(this.drag.id);
    this.applyDraft();
  }

  onPointerUp() {
    this.drag = null;
    window.removeEventListener('pointermove', this.onPointerMove);
    this.renderEditor();
  }

  onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    }
  }

  handleResize() {
    if (this.editing) this.applyDraft();
    else if (this.hasPersistedLayouts) this.applyLayout(this.savedSlots[this.slot - 1]);
  }

  constrainEntry(id) {
    const target = this.nodes.get(id);
    const entry = this.activeLayout[id];
    if (!target?.element || !entry) return;
    const rootRect = this.root.getBoundingClientRect();
    const elementRect = target.element.getBoundingClientRect();
    const halfWidth = elementRect.width / 2;
    const halfHeight = elementRect.height / 2;
    const [anchorX, anchorY] = ANCHORS[entry.anchor];
    const minX = (halfWidth / rootRect.width) - anchorX;
    const maxX = 1 - (halfWidth / rootRect.width) - anchorX;
    const minY = (halfHeight / rootRect.height) - anchorY;
    const maxY = 1 - (halfHeight / rootRect.height) - anchorY;
    entry.x = clamp(entry.x, Math.min(minX, maxX), Math.max(minX, maxX));
    entry.y = clamp(entry.y, Math.min(minY, maxY), Math.max(minY, maxY));
  }

  applyDraft() {
    if (!this.editing) return;
    this.applyLayout(this.activeLayout, { editing: true });
  }

  applyLayout(layout, { editing = false } = {}) {
    for (const [id, target] of this.nodes) {
      const entry = layout[id];
      const element = target.element;
      if (!element || !entry) continue;
      const point = anchorPoint(entry, this.root.getBoundingClientRect());
      element.style.setProperty('--hud-layout-scale', String(entry.scale));
      element.style.left = `${point.x}px`;
      element.style.top = `${point.y}px`;
      element.style.right = 'auto';
      element.style.bottom = 'auto';
      element.style.transform = target.usesUiScale
        ? 'translate(-50%, -50%) scale(calc(var(--hud-scale) * var(--hud-layout-scale)))'
        : 'translate(-50%, -50%) scale(var(--hud-layout-scale))';
      element.style.transformOrigin = 'center';
      element.style.opacity = String(entry.opacity);
      element.classList.toggle('hud-layout-hidden', !entry.visible);
      element.classList.toggle('hud-layout-selected', editing && id === this.selectedId);
    }
  }

  clearAppliedStyles() {
    for (const { element } of this.nodes.values()) {
      if (!element) continue;
      ['left', 'top', 'right', 'bottom', 'transform', 'transform-origin', 'opacity', '--hud-layout-scale'].forEach(property => element.style.removeProperty(property));
      element.classList.remove('hud-layout-hidden', 'hud-layout-selected');
    }
  }

  renderEditor() {
    if (!this.editor) return;
    const entry = this.selectedEntry;
    const selected = HUD_DEFINITIONS.find(item => item.id === this.selectedId);
    this.editor.querySelector('[data-layout-selected]').textContent = selected?.label || '';
    this.editor.querySelector('[data-layout-visible]').checked = entry.visible;
    this.editor.querySelector('[data-layout-anchor]').value = entry.anchor;
    this.editor.querySelector('[data-layout-scale]').value = String(Math.round(entry.scale * 100));
    this.editor.querySelector('[data-layout-opacity]').value = String(Math.round(entry.opacity * 100));
    this.editor.querySelector('[data-layout-scale-output]').textContent = `${Math.round(entry.scale * 100)}%`;
    this.editor.querySelector('[data-layout-opacity-output]').textContent = `${Math.round(entry.opacity * 100)}%`;
    this.editor.querySelectorAll('[data-layout-slot]').forEach(button => {
      button.classList.toggle('selected', Number(button.dataset.layoutSlot) === this.slot);
      button.setAttribute('aria-selected', String(Number(button.dataset.layoutSlot) === this.slot));
    });
  }
}
