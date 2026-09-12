import { icon, iconify } from '../../src/ui/dom.js';
import './debug-render.css';

export function mountDebugRenderPanel(host, getController) {
  if (!host) return () => {};
  const panel = document.createElement('div');
  panel.className = 'render-debug-controls';
  panel.dataset.renderDebug = '';
  panel.innerHTML = `
    <label class="render-debug-mode"><span>Render</span><select data-render-mode aria-label="Debug render mode">
      <option value="full">Full Final</option>
      <option value="neutral">Neutral</option>
      <option value="albedo">Albedo Only</option>
      <option value="albedo-normal">Albedo + Normal</option>
      <option value="pbr-no-environment">PBR Without Environment</option>
    </select></label>
    <div class="render-debug-flags">
      <label><input type="checkbox" data-render-contribution="vertexColors" checked>Vertex Color</label>
      <label><input type="checkbox" data-render-contribution="ao" checked>AO</label>
      <label><input type="checkbox" data-render-contribution="extraColor" checked>Extra Color</label>
      <button type="button" class="icon-button" data-render-dump title="Export color parameters" aria-label="Export color parameters">${icon('download')}</button>
    </div>`;
  host.append(panel);
  iconify(panel);
  panel.addEventListener('change', event => {
    const debug = getController();
    if (!debug) return;
    if (event.target.matches('[data-render-mode]')) debug.setMode(event.target.value);
    const contribution = event.target.dataset.renderContribution;
    if (contribution) debug.setContributions({ [contribution]: event.target.checked ? null : false });
    debug.apply();
  });
  panel.querySelector('[data-render-dump]').addEventListener('click', () => {
    const debug = getController();
    if (!debug) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(debug.dump(), null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `babylon-color-${debug.mode}-${Date.now()}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const update = () => {
    const debug = getController();
    for (const input of panel.querySelectorAll('input,select,button')) input.disabled = !debug;
    if (!debug) return;
    panel.querySelector('[data-render-mode]').value = debug.mode;
    for (const input of panel.querySelectorAll('[data-render-contribution]')) {
      input.checked = debug.contributions[input.dataset.renderContribution] !== false;
    }
  };
  const timer = setInterval(update, 400);
  update();
  const dispose = () => { clearInterval(timer); panel.remove(); };
  window.addEventListener('pagehide', dispose, { once: true });
  return dispose;
}
