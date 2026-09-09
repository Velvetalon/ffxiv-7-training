import { $, escape, icon, iconify } from './dom.js';
import { actionColor } from './ActionPresentation.js';
import { skillIcon } from './SkillIcon.js';

const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];
const codes = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal'];

export class Hotbar {
  constructor(combat, jobs) {
    this.combat = combat;
    this.jobs = jobs;
    this.page = 0;
    this.signature = '';
    this.hoverId = null;
    $('#hotbar-prev').addEventListener('click', () => this.changePage(-1));
    $('#hotbar-next').addEventListener('click', () => this.changePage(1));
  }
  reset() { this.page = 0; this.signature = ''; this.hideTooltip(); }
  getVisibleActions() {
    const actions = this.combat.getActions();
    const pages = Math.max(1, Math.ceil(actions.length / 24));
    this.page = Math.min(pages - 1, this.page);
    return { actions: actions.slice(this.page * 24, (this.page + 1) * 24), pages };
  }
  changePage(delta) {
    this.page = (this.page + delta + this.getVisibleActions().pages) % this.getVisibleActions().pages;
    this.signature = '';
    this.hideTooltip();
    this.render();
  }
  keyAction(event) {
    let index = codes.indexOf(event.code);
    if (index < 0) return null;
    if (event.shiftKey) index += 12;
    return this.getVisibleActions().actions[index]?.id;
  }
  flash(id) {
    document.querySelectorAll(`[data-action="${CSS.escape(id)}"]`).forEach(button => {
      button.classList.remove('activated');
      void button.offsetWidth;
      button.classList.add('activated');
    });
  }
  render() {
    const { actions, pages } = this.getVisibleActions();
    const state = this.combat.getState();
    const signature = `${state.jobId}:${this.page}:` + actions.map(action => `${action.id}:${action.icon}:${action.name}`).join('|');
    if (signature !== this.signature) {
      this.signature = signature;
      $('#hotbars').innerHTML = Array.from({ length: 24 }, (_, index) => {
        const action = actions[index];
        if (!action) return `<div class="skill empty"><span class="skill-key">${index >= 12 ? '⇧' : ''}${keys[index % 12]}</span></div>`;
        const color = actionColor(action, this.jobs.find(job => job.id === state.jobId));
        return `<button class="skill" data-action="${escape(action.id)}" aria-label="${escape(action.name)}" style="--skill-color:${color}">
          <span class="skill-art">${skillIcon(action)}</span><span class="cooldown-mask"></span><span class="skill-key">${index >= 12 ? '⇧' : ''}${keys[index % 12]}</span><span class="skill-cooldown"></span><span class="skill-charges"></span><span class="skill-label">${escape(action.name)}</span><span class="skill-kind ${action.gcd ? 'gcd' : 'ogcd'}"></span>
        </button>`;
      }).join('');
      iconify($('#hotbars'));
      $('#hotbar-page').textContent = `${this.page + 1}/${pages}`;
      $('#hotbar-prev').disabled = pages === 1;
      $('#hotbar-next').disabled = pages === 1;
    }
    actions.forEach(action => {
      const button = $(`#hotbars [data-action="${CSS.escape(action.id)}"]`);
      if (!button) return;
      const gcdLeft = action.gcd ? Number(state.gcd || 0) : 0;
      const actionLeft = action.maxCharges > 1 && action.charges > 0 ? 0 : Number(action.cooldown || 0);
      const left = Math.max(actionLeft, gcdLeft);
      const total = left === gcdLeft ? state.gcdTotal || 2.5 : action.cooldownRecast || action.recast || 1;
      button.style.setProperty('--cooldown', `${Math.min(100, left / total * 100)}%`);
      button.classList.toggle('unavailable', !action.enabled);
      button.classList.toggle('proc', !!action.highlight);
      button.classList.toggle('on-cooldown', left > 0.05);
      button.querySelector('.skill-cooldown').textContent = left >= 1 ? Math.ceil(left) : '';
      button.querySelector('.skill-charges').textContent = action.maxCharges > 1 ? String(action.charges ?? 0) : '';
    });
    if (this.hoverId) this.showTooltip(this.hoverId);
  }
  showTooltip(id) {
    const action = this.combat.getActions().find(item => item.id === id);
    if (!action) { this.hideTooltip(); return; }
    this.hoverId = id;
    const tooltip = $('#skill-tooltip');
    tooltip.innerHTML = `<div class="tooltip-heading"><span class="tooltip-icon" style="color:${action.color || '#ddc687'}">${skillIcon(action)}</span><div><h3>${escape(action.name)}</h3><small>${escape(action.en || ({ spell: '魔法', ability: '能力', weaponskill: '战技' })[action.kind] || '技能')}</small></div><span class="tooltip-type">${action.gcd ? 'GCD' : '能力'}</span></div><div class="tooltip-stats"><span>咏唱 <b>${action.cast ? `${action.cast.toFixed(1)}s` : '即时'}</b></span><span>复唱 <b>${Number(action.recast || 0).toFixed(1)}s</b></span><span>射程 <b>${action.range ?? 0}y</b></span>${action.potency ? `<span>威力 <b>${action.potency}</b></span>` : ''}</div><p>${escape(action.description)}</p>${!action.enabled && action.reason ? `<div class="tooltip-requirement">${escape(action.reason)}</div>` : ''}`;
    iconify(tooltip);
    tooltip.classList.remove('hidden');
  }
  hideTooltip() { this.hoverId = null; $('#skill-tooltip').classList.add('hidden'); }
}
