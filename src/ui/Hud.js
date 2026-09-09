import { $, escape, icon, iconify, formatTime, formatNumber } from './dom.js';
export function createHud({ combat, world, jobs: JOBS, getTeleportCast }) {
let lastJob = '';
let lastLogSignature = '';
function gaugeMarkup(job) {
  return (job.resources || []).map(resource => {
    const pips = resource.max <= 5;
    return `<div class="gauge${pips ? ' pip-gauge' : ''}" style="--gauge-color:${resource.color || job.color}" data-resource="${resource.key}"><div class="gauge-label"><span>${escape(resource.name)}</span><b>0${pips ? '' : ` / ${resource.max}`}</b></div>${pips ? `<div class="gauge-pips">${Array.from({ length: resource.max }, (_, i) => `<span data-pip="${i}"></span>`).join('')}</div>` : '<div class="gauge-track"><span></span></div>'}</div>`;
  }).join('');
}

function renderBuffs(selector, buffs = []) {
  $(selector).innerHTML = buffs.filter(b => b.remaining > 0 || b.stacks > 0).slice(0, 10).map(buff => `<span class="buff" title="${escape(buff.name)}" style="--buff-color:${buff.color || '#a2cdb0'}"><b>${escape(buff.name?.slice(0, 2) || '')}</b><small>${buff.stacks > 1 ? `${buff.stacks} · ` : ''}${Math.ceil(buff.remaining || 0)}</small></span>`).join('');
}

function render() {
  const state = combat.getState();
  const job = JOBS.find(item => item.id === state.jobId);
  if (lastJob !== state.jobId) {
    lastJob = state.jobId;
    $('#player-job').textContent = job.name;
    $('#job-emblem').innerHTML = icon(state.jobId === 'WHM' ? 'flower-2' : state.jobId === 'PCT' ? 'paintbrush' : 'swords');
    $('#job-emblem').style.color = job.color;
    $('#job-gauges').innerHTML = gaugeMarkup(job);
    document.querySelectorAll('[data-job]').forEach(button => button.classList.toggle('selected', button.dataset.job === state.jobId));
    iconify($('#job-emblem'));
  }
  for (const resource of job.resources || []) {
    const node = $(`[data-resource="${resource.key}"]`);
    const value = Number(state.resources?.[resource.key] || 0);
    node.querySelector('b').textContent = resource.max > 5 ? `${Math.floor(value)} / ${resource.max}` : Math.floor(value);
    node.querySelectorAll('[data-pip]').forEach(pip => pip.classList.toggle('filled', Number(pip.dataset.pip) < value));
    if (node.querySelector('.gauge-track span')) node.querySelector('.gauge-track span').style.width = `${Math.min(100, value / resource.max * 100)}%`;
  }
  $('#hp-value').textContent = formatNumber(state.hp ?? 100000);
  $('#hp-fill').style.width = `${Math.min(100, (state.hp ?? 10000) / (state.maxHp || 10000) * 100)}%`;
  $('#mp-value').textContent = formatNumber(state.mp);
  $('#mp-fill').style.width = `${(state.mp || 0) / 100}%`;
  $('#combat-dot').classList.toggle('active', state.inCombat);
  $('#combat-status').textContent = state.inCombat ? '交战中' : '待机';
  $('#encounter-time').textContent = formatTime(state.stats?.elapsed || 0);
  $('#pps').textContent = formatNumber(state.stats?.pps);
  $('#total-potency').textContent = formatNumber(state.stats?.potency);
  $('#gcd-count').textContent = state.stats?.gcdCount || 0;
  $('#ogcd-count').textContent = state.stats?.ogcdCount || 0;
  $('#job-resource-note').textContent = state.combo?.name || (typeof state.combo === 'string' ? state.combo : '') || `${job.id} · LEVEL 100`;
  renderBuffs('#player-buffs', state.buffs);
  renderBuffs('#target-debuffs', state.target?.dot);
  const log = (state.log || []).slice(-6).reverse();
  const signature = log.map(item => `${item.time}:${item.name}:${item.potency}`).join('|');
  if (lastLogSignature !== signature) {
    lastLogSignature = signature;
    $('#combat-log').innerHTML = log.length ? log.map(item => `<li><span>${formatTime(item.time)}</span><b>${escape(item.name)}</b><em class="${item.kind === 'heal' ? 'heal' : ''}">${item.healing ? `+${formatNumber(item.healing)}` : item.potency ? formatNumber(item.potency) : '·'}</em></li>`).join('') : '<li class="empty-log">尚未进入战斗</li>';
  }
  const cast = getTeleportCast() || state.cast;
  $('#casting').classList.toggle('hidden', !cast);
  if (cast) {
    $('#cast-name').textContent = cast.name;
    $('#cast-time').textContent = `${Math.max(0, cast.remaining).toFixed(2)}`;
    $('#cast-fill').style.width = `${(1 - cast.remaining / cast.total) * 100}%`;
  }
  const info = world.getInfo();
  const ctx = world.getContext();
  $('#target-frame').classList.toggle('no-target', !ctx.target);
  $('#target-name').textContent = info.target?.name || '未选择目标';
  $('#target-distance').textContent = ctx.target ? `${Number(ctx.distance || 0).toFixed(1)} y` : '';
  $('#target-position').textContent = ({ rear: '背面', flank: '侧面', front: '正面' })[ctx.positional] || '背面';
  $('#coordinates').textContent = `X: ${Number(info.position?.x || 0).toFixed(1)} · Y: ${Number(info.position?.z || 0).toFixed(1)}`;
}

return { render, invalidate: () => { lastLogSignature = null; lastJob = ''; } };
}
