const KEY = 'aetheryte-settings';
const DEFAULTS = { quality: 'high', sound: true, volume: 0.2, scale: 100, controlMode: 'traditional' };

export function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
export function saveSettings(settings) {
  localStorage.setItem(KEY, JSON.stringify(settings));
  document.documentElement.style.setProperty('--hud-scale', settings.scale / 100);
}
