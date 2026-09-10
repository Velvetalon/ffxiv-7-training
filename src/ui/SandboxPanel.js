import { icon, iconify, escape } from './dom.js';

export class SandboxPanel {
  constructor({ root, world, onAppearance, onMount, onAnimation, onError }) {
    Object.assign(this, { root, world, onAppearance, onMount, onAnimation, onError });
    this.busy = false;
    this.element = document.createElement('aside');
    this.element.className = 'sandbox-panel hidden';
    this.element.setAttribute('aria-label', '角色与世界');
    this.element.innerHTML = `
      <header><h2>角色与世界</h2><button class="icon-button" data-sandbox-close title="关闭" aria-label="关闭">${icon('x')}</button></header>
      <section><h3>角色</h3>
        <label class="command sandbox-file">${icon('upload')}<span>导入外观 DAT</span><input type="file" accept=".dat" data-appearance-file></label>
        <output data-appearance-state>未导入外观</output>
        <label><span>动作</span><select data-animation><option value="">待载入</option></select></label>
        <button class="command" data-play-animation>${icon('play')}<span>播放</span></button>
      </section>
      <section><h3>坐骑</h3>
        <label><span>坐骑</span><select data-mount><option value="">待载入</option></select></label>
        <div class="sandbox-commands"><button class="command" data-mount-toggle>${icon('navigation')}<span>骑乘</span></button><button class="command" data-flight-toggle>${icon('arrow-up')}<span>起飞</span></button></div>
        <output data-mount-state>步行</output>
      </section>
      <section><h3>环境时间</h3>
        <label><span>时间</span><input type="range" min="0" max="23.99" step="0.05" data-world-hour><output data-world-hour-label></output></label>
        <label><span>暂停时间</span><input type="checkbox" data-world-paused></label>
      </section>`;
    root.append(this.element);
    iconify(this.element);
    this.element.querySelector('[data-sandbox-close]').addEventListener('click', () => this.close());
    this.element.querySelector('[data-appearance-file]').addEventListener('change', async event => {
      const file = event.target.files?.[0];
      if (!file) return;
      try { await onAppearance(file); }
      catch (error) { onError(error.message); }
      finally { event.target.value = ''; }
    });
    this.element.querySelector('[data-play-animation]').addEventListener('click', () => {
      const state = this.element.querySelector('[data-animation]').value;
      if (state) onAnimation(state);
    });
    this.element.querySelector('[data-mount-toggle]').addEventListener('click', () => {
      if (this.busy) return;
      this.busy = true;
      this.update();
      Promise.resolve(onMount(this.element.querySelector('[data-mount]').value))
        .catch(error => onError(error.message))
        .finally(() => { this.busy = false; this.update(); });
    });
    this.element.querySelector('[data-flight-toggle]').addEventListener('click', () => {
      if (this.busy) return;
      if (world.mount.state.movementMode === 'ground') world.mount.takeoff();
      else world.mount.land();
      this.update();
    });
    this.element.querySelector('[data-world-hour]').addEventListener('input', event => world.worldTime.setHour(Number(event.target.value)));
    this.element.querySelector('[data-world-paused]').addEventListener('change', event => world.worldTime.setState({ paused: event.target.checked }));
    this.update();
  }

  setAssets({ animations = [], mounts = [] }) {
    this.element.querySelector('[data-animation]').innerHTML = animations.map(id => `<option value="${escape(id)}">${escape(id)}</option>`).join('');
    this.element.querySelector('[data-mount]').innerHTML = mounts.map(mount => `<option value="${escape(mount.id)}">${escape(mount.name || mount.id)}</option>`).join('');
    this.element.querySelector('[data-mount-toggle]').disabled = this.busy || !mounts.length;
  }

  setAppearance(appearance) {
    this.element.querySelector('[data-appearance-state]').textContent =
      `${appearance.raceName || appearance.race} / ${appearance.tribeName || appearance.tribe} · Face ${appearance.face} · Hair ${appearance.hair}`;
  }

  toggle() { this.element.classList.toggle('hidden'); this.update(); }
  close() { this.element.classList.add('hidden'); }
  get isOpen() { return !this.element.classList.contains('hidden'); }

  update() {
    const hour = this.world.worldTime.hour;
    const range = this.element.querySelector('[data-world-hour]');
    if (document.activeElement !== range) range.value = hour;
    this.element.querySelector('[data-world-hour-label]').textContent = `${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.floor(hour % 1 * 60)).padStart(2, '0')}`;
    this.element.querySelector('[data-world-paused]').checked = this.world.worldTime.paused;
    const state = this.world.mount.state;
    const mountButton = this.element.querySelector('[data-mount-toggle]');
    mountButton.disabled = this.busy || (!state.isMounted && !this.element.querySelector('[data-mount]').value);
    mountButton.querySelector('span').textContent = state.loading ? '载入中' : state.isMounted ? '下坐骑' : '骑乘';
    this.element.querySelector('[data-flight-toggle]').disabled = this.busy || !state.isMounted || !this.world.mount.definition?.canFly;
    this.element.querySelector('[data-flight-toggle] span').textContent = state.movementMode === 'ground' ? '起飞' : '降落';
    const status = state.loading ? '载入坐骑资源…' : state.loadError ? `坐骑载入失败：${state.loadError}` : !state.isMounted ? '步行' : ({ ground: '骑乘', takeoff: '起飞', flying: '飞行', landing: '降落' })[state.movementMode] || state.movementMode;
    this.element.querySelector('[data-mount-state]').textContent = status;
  }
}
