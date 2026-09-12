// The preview build resolves the three engine-dependent imports in src/main
// to native Babylon modules; shared combat, audio and DOM UI stay unchanged.
const viewer = new URL(location.href).searchParams.get('viewer') === '1';
if (viewer) await import('./app.js');
else {
  await import('../../src/main.js');
  const { mountDebugRenderPanel } = await import('./DebugRenderPanel.js');
  mountDebugRenderPanel(document.querySelector('[data-dev-tab-panel="environment"]'),
    () => globalThis.__APP__?.world?.renderDebug);
}
