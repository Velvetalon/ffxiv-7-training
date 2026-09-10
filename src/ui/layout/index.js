import { HudLayoutRuntime } from './HudLayoutRuntime.js';

export function initializeHudLayout(options) {
  const runtime = new HudLayoutRuntime(options);
  return {
    open: () => runtime.open(),
    close: () => runtime.close(),
    toggle: () => runtime.toggle(),
    destroy: () => runtime.destroy(),
    get isEditing() { return runtime.editing; },
  };
}

export { HudLayoutRuntime, HUD_LAYOUT_IDS, HUD_LAYOUT_STORAGE_KEY, createDefaultLayout, normalizeLayout } from './HudLayoutRuntime.js';
