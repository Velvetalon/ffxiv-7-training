// Unified workbench panel (S10): every control calls the same dispatch chain
// as scripts and browser automation — no second implementation. Sections:
// cases | object+provenance | overrides+patches | isolation | anomalies |
// versions/status. Scoped styling, no impact on game input (panel sits above
// the canvas and stops pointer events at its root).

const STYLES = `
.ff14-workbench {
  position: fixed; right: 16px; bottom: 16px; z-index: 60;
  width: 380px; max-height: 70vh; overflow: auto;
  background: rgba(12, 16, 24, 0.94); color: #d7dde6;
  border: 1px solid #2c3542; border-radius: 10px;
  font: 12px/1.45 'Segoe UI', system-ui, sans-serif;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
}
.ff14-workbench[data-closed] { display: none; }
.ff14-workbench header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; border-bottom: 1px solid #2c3542; position: sticky; top: 0;
  background: rgba(12, 16, 24, 0.98); cursor: default;
}
.ff14-workbench header strong { font-size: 12px; letter-spacing: 0.04em; }
.ff14-workbench header .wb-version { color: #7f8b9b; }
.ff14-workbench section { padding: 8px 12px; border-bottom: 1px solid #222a35; }
.ff14-workbench section h3 { margin: 2px 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #8fa3ba; }
.ff14-workbench .wb-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 4px 0; }
.ff14-workbench button {
  background: #1d2634; color: #d7dde6; border: 1px solid #334052;
  border-radius: 6px; padding: 4px 9px; font: inherit; cursor: pointer;
}
.ff14-workbench button:hover { background: #27334a; }
.ff14-workbench button:disabled { opacity: 0.45; cursor: default; }
.ff14-workbench select, .ff14-workbench input {
  background: #141a24; color: #d7dde6; border: 1px solid #334052;
  border-radius: 6px; padding: 3px 6px; font: inherit; min-width: 0;
}
.ff14-workbench input.wb-num { width: 64px; }
.ff14-workbench textarea {
  width: 100%; box-sizing: border-box; min-height: 90px; resize: vertical;
  background: #10151d; color: #cfe3cf; border: 1px solid #334052; border-radius: 6px;
  font: 11px/1.4 Consolas, monospace; white-space: pre;
}
.ff14-workbench .wb-status { color: #9aa7b8; min-height: 16px; margin-top: 4px; }
.ff14-workbench .wb-status[data-error] { color: #ff9d9d; }
.ff14-workbench .wb-kv { color: #9aa7b8; word-break: break-all; }
.ff14-workbench .wb-kv b { color: #d7dde6; font-weight: 600; }
`;

function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

export class WorkbenchPanel {
  constructor(workbench, { onCloseStateChange = null, initialOpen = true } = {}) {
    this.workbench = workbench;
    this.onCloseStateChange = onCloseStateChange;
    this.root = null;
    this.status = null;
    this.open = initialOpen;
  }

  async dispatch(command, args, successMessage = null) {
    const result = await this.workbench.dispatch(command, args);
    this.showResult(result, successMessage);
    return result;
  }

  showResult(result, successMessage = null) {
    if (!this.status) return;
    if (result.status === 'ok' || result.status === 'accepted') {
      this.status.removeAttribute('data-error');
      this.status.textContent = successMessage || `done: ${result.status}`;
    } else {
      this.status.setAttribute('data-error', '1');
      this.status.textContent = `${result.status}${result.errorCode ? ` (${result.errorCode})` : ''}`;
    }
  }

  mount(parent) {
    if (!document.getElementById('ff14-workbench-styles')) {
      const style = el('style', { id: 'ff14-workbench-styles', text: STYLES });
      document.head.append(style);
    }
    this.root = el('div', { class: 'ff14-workbench' });
    if (!this.open) this.root.setAttribute('data-closed', '1');

    const title = el('strong', { text: 'WORKBENCH' });
    const version = el('span', { class: 'wb-version', text: 'v1' });
    const toggle = el('button', { text: this.open ? '×' : '▤', title: 'toggle workbench' });
    toggle.addEventListener('click', () => {
      this.open = !this.open;
      if (this.open) this.root.removeAttribute('data-closed');
      else this.root.setAttribute('data-closed', '1');
      toggle.textContent = this.open ? '×' : '▤';
      this.onCloseStateChange?.(this.open);
    });
    this.root.append(el('header', {}, [title, el('span', {}, [version, ' ', toggle])]));

    // --- Cases -------------------------------------------------------------
    const casesSection = el('section', {}, [el('h3', { text: 'Cases 案例' })]);
    const caseSelect = el('select', { 'data-wb': 'case-select' });
    const caseRow = el('div', { class: 'wb-row' }, [
      el('button', { text: 'Capture', 'data-wb': 'case-capture' }),
      el('button', { text: 'Save', 'data-wb': 'case-save' }),
      el('button', { text: 'Restore', 'data-wb': 'case-restore' }),
      el('button', { text: 'Refresh', 'data-wb': 'case-refresh' }),
      caseSelect,
    ]);
    const caseStatus = el('div', { class: 'wb-status', 'data-wb': 'case-status' });
    casesSection.append(caseRow, caseStatus);
    this.caseSelect = caseSelect;
    this.caseStatus = caseStatus;
    this.root.append(casesSection);

    let lastCase = null;
    caseSelect.addEventListener('change', () => {
      if (caseSelect.selectedOptions[0]) lastCase = caseSelect.selectedOptions[0].caseData || null;
    });
    caseRow.querySelector('[data-wb="case-capture"]').addEventListener('click', async () => {
      const result = await this.dispatch('case.capture', { caseId: `ui-${Date.now()}`, objectLimit: 2 }, 'case captured');
      if (result.status === 'ok') {
        lastCase = result.data.case;
        this.caseStatus.textContent = `captured ${lastCase.caseId} (${lastCase.objects.length} objects)`;
      }
    });
    caseRow.querySelector('[data-wb="case-save"]').addEventListener('click', async () => {
      if (!lastCase) { this.caseStatus.textContent = 'capture a case first'; return; }
      const result = await this.dispatch('case.save', { case: lastCase }, 'case saved');
      if (result.status === 'ok') this.refreshCases();
    });
    caseRow.querySelector('[data-wb="case-restore"]').addEventListener('click', async () => {
      if (!lastCase) { this.caseStatus.textContent = 'select a case'; return; }
      const result = await this.dispatch('case.restore', { case: lastCase }, 'case restored');
      if (result.status === 'ok') this.caseStatus.textContent = `restored: ${result.data.completeness}`;
    });
    caseRow.querySelector('[data-wb="case-refresh"]').addEventListener('click', () => this.refreshCases());
    this.lastCase = () => lastCase;

    // --- Object & provenance ------------------------------------------------
    const objectSection = el('section', {}, [el('h3', { text: 'Object 对象溯源' })]);
    const addressInput = el('input', { 'data-wb': 'object-address', placeholder: 'e3t1:118:0', style: 'flex:1 1 120px' });
    addressInput.value = 'e3t1:118:0';
    const objectStatus = el('div', { class: 'wb-kv', 'data-wb': 'object-status' });
    const objectRow = el('div', { class: 'wb-row' }, [
      addressInput,
      el('button', { text: 'Inspect', 'data-wb': 'object-inspect' }),
      el('button', { text: 'Isolate', 'data-wb': 'isolate-enter' }),
      el('button', { text: 'Release', 'data-wb': 'isolate-exit' }),
    ]);
    objectSection.append(objectRow, objectStatus);
    this.root.append(objectSection);
    this.objectStatus = objectStatus;
    objectRow.querySelector('[data-wb="object-inspect"]').addEventListener('click', async () => {
      const result = await this.dispatch('objects.inspect', { stableAddress: addressInput.value.trim() });
      if (result.status === 'ok' && result.data?.found !== false) {
        const material = result.data.materials?.[0];
        this.objectStatus.innerHTML = '';
        this.objectStatus.append(
          el('div', {}, [el('b', { text: result.data.instance.stableAddress }), `  ${result.data.model.resourceId.slice(0, 28)}…`]),
          el('div', {}, [`${material?.ffxiv?.materialPath || '?'} · ${material?.ffxiv?.workflow || '?'}`]),
          el('div', {}, [(material?.textures || []).map(slot => slot.semantic).join(' · ')]),
        );
      } else {
        this.objectStatus.textContent = 'object not found';
      }
    });
    objectRow.querySelector('[data-wb="isolate-enter"]').addEventListener('click', async () => {
      const result = await this.dispatch('isolate.enter', { stableAddress: addressInput.value.trim() }, 'isolated');
      if (result.status === 'ok') this.objectStatus.textContent = `isolated, ${result.data.visibleMeshes} meshes visible`;
    });
    objectRow.querySelector('[data-wb="isolate-exit"]').addEventListener('click', async () => {
      const result = await this.dispatch('isolate.exit', {}, 'isolation released');
      if (result.status === 'ok') this.objectStatus.textContent = `restored ${result.data.reEnabledMeshes} meshes`;
    });

    // --- Overrides & patch --------------------------------------------------
    const overrideSection = el('section', {}, [el('h3', { text: 'Overrides 参数与补丁' })]);
    const roughInput = el('input', { class: 'wb-num', 'data-wb': 'roughness', value: '0.5', type: 'number', step: '0.05', min: '0', max: '1' });
    const patchOutput = el('textarea', { 'data-wb': 'patch-output', readonly: 'readonly', placeholder: 'exported patch JSON appears here' });
    const overrideRow = el('div', { class: 'wb-row' }, [
      el('span', { text: 'roughness' }), roughInput,
      el('button', { text: 'Apply', 'data-wb': 'override-apply' }),
      el('button', { text: 'Undo', 'data-wb': 'override-undo' }),
      el('button', { text: 'Export', 'data-wb': 'patch-export' }),
      el('button', { text: 'Clear', 'data-wb': 'override-clear' }),
    ]);
    const overrideStatus = el('div', { class: 'wb-status', 'data-wb': 'override-status' });
    overrideSection.append(overrideRow, overrideStatus, patchOutput);
    this.root.append(overrideSection);
    this.overrideStatus = overrideStatus;
    overrideRow.querySelector('[data-wb="override-apply"]').addEventListener('click', async () => {
      const result = await this.dispatch('override.set', {
        scope: 'instance', stableAddress: addressInput.value.trim(), property: 'roughness', value: Number(roughInput.value),
      });
      if (result.status === 'ok') this.overrideStatus.textContent = `roughness ${result.data.before} → ${result.data.after}`;
    });
    overrideRow.querySelector('[data-wb="override-undo"]').addEventListener('click', async () => {
      const result = await this.dispatch('override.undo', {});
      if (result.status === 'ok') this.overrideStatus.textContent = 'undone';
    });
    overrideRow.querySelector('[data-wb="patch-export"]').addEventListener('click', async () => {
      const result = await this.dispatch('patch.export', { patchId: `ui-${Date.now()}` }, 'patch exported below');
      if (result.status === 'ok') patchOutput.value = JSON.stringify(result.data.patch, null, 2);
    });
    overrideRow.querySelector('[data-wb="override-clear"]').addEventListener('click', async () => {
      const result = await this.dispatch('override.clear', {});
      if (result.status === 'ok') this.overrideStatus.textContent = `cleared ${result.data.cleared} override(s)`;
    });

    // --- Anomalies & status -------------------------------------------------
    const anomalySection = el('section', {}, [el('h3', { text: 'Anomalies 异常与状态' })]);
    const anomalyStatus = el('div', { class: 'wb-kv', 'data-wb': 'anomaly-status' });
    const anomalyRow = el('div', { class: 'wb-row' }, [
      el('button', { text: 'Anomalies', 'data-wb': 'anomalies' }),
      el('button', { text: 'Status', 'data-wb': 'status' }),
    ]);
    anomalySection.append(anomalyRow, anomalyStatus);
    this.root.append(anomalySection);
    this.anomalyStatus = anomalyStatus;
    anomalyRow.querySelector('[data-wb="anomalies"]').addEventListener('click', async () => {
      const result = await this.dispatch('anomalies.list', {});
      if (result.status === 'ok') {
        const top = result.data.anomalies.slice(0, 3).map(entry => `${entry.kind}×${entry.count}`).join(', ');
        this.anomalyStatus.textContent = `${result.data.totalKinds} kind(s)${top ? `: ${top}` : ' — clean'}`;
      }
    });
    anomalyRow.querySelector('[data-wb="status"]').addEventListener('click', async () => {
      const result = await this.dispatch('state.read', {});
      if (result.status === 'ok') {
        const data = result.data;
        this.anomalyStatus.textContent = `${data.mapId} stage=${data.stage} meshes=${data.meshes} fps=${data.fps?.toFixed?.(0) ?? '--'} rev=${result.stateRevision} epoch=${result.sceneEpoch}`;
      }
    });

    this.status = el('div', { class: 'wb-status', 'data-wb': 'global-status' });
    this.root.append(this.status);
    parent.append(this.root);
    this.refreshCases();
    return this.root;
  }

  async refreshCases() {
    if (!this.caseSelect) return;
    const result = await this.workbench.dispatch('case.list');
    this.caseSelect.innerHTML = '';
    for (const entry of result.data?.cases || []) {
      const option = el('option', { value: entry.caseId, text: `${entry.caseId} (${entry.mapId || '?'})` });
      option.caseData = entry.case;
      this.caseSelect.append(option);
    }
    if (this.caseSelect.selectedOptions[0]) {
      this.caseSelect.selectedOptions[0].selected = true;
    }
  }

  dispose() {
    this.root?.remove();
    this.root = null;
  }
}

export default WorkbenchPanel;
