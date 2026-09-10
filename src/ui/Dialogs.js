import { $, escape, icon, iconify } from './dom.js';
import { drawMap } from './Minimap.js';
import { skillIcon } from './SkillIcon.js';
export function createDialogs({world, combat, scenes: SCENES, settings, getSceneId, getTargetCount, hotbar, training}) {
let modal = null;
function openModal(title, eyebrow, body, cls = '') {
  hotbar.hideTooltip();
  world.setInputEnabled(false);
  modal = cls || title;
  $('#modal-layer').className = 'modal-layer';
  $('#modal-layer').innerHTML = `<section class="modal ${cls}" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-header"><div><span class="overline">${eyebrow}</span><h2 id="modal-title">${title}</h2></div><button class="icon-button modal-close" aria-label="关闭" title="关闭">${icon('x')}</button></header>${body}</section>`;
  iconify($('#modal-layer'));
  $('.modal-close').focus();
}
function closeModal() {
  $('#modal-layer').className = 'hidden';
  $('#modal-layer').innerHTML = '';
  modal = null;
  world.setInputEnabled(true);
  $('#world').focus();
}

function openTeleport() {
  const regions = [...new Set(SCENES.map(scene => scene.region))];
  openModal('传送', '以太之光网络', `<div class="teleport-layout"><nav class="teleport-regions"><b>已开放地区 <span>${SCENES.length}</span></b><button class="selected" data-region="all">${icon('globe-2')}全部地区</button>${regions.map(region => `<button data-region="${escape(region)}">${icon('map-pin')}${escape(region)}</button>`).join('')}</nav><div class="destinations"><div class="teleport-search search-field">${icon('search')}<input id="teleport-search" placeholder="搜索地区或区域" autocomplete="off"></div><div class="destination-heading"><span>以太之光</span><span>状态</span></div><div class="destination-list">${SCENES.map(scene => `<button class="destination ${scene.id === getSceneId() ? 'current' : ''}" data-teleport="${escape(scene.id)}" data-scene-region="${escape(scene.region)}" data-scene-search="${escape(`${scene.name} ${scene.en} ${scene.region}`.toLowerCase())}"><span class="destination-art" style="--scene-accent:${escape(scene.accent || '#99c9c5')}">${icon('map-pin')}</span><span class="destination-label"><small>${escape(scene.region)}</small><strong>${escape(scene.name)}</strong></span><span class="destination-status">${scene.id === getSceneId() ? '当前地区' : '已共鸣'}${icon(scene.id === getSceneId() ? 'check' : 'chevron-right')}</span></button>`).join('')}</div><div class="teleport-footer"><span>${icon('diamond')}以太之光已共鸣</span><b>费用 0 金币</b></div></div></div>`, 'teleport-modal');
}

function openBook(filter = '') {
  const actions = combat.getActions();
  openModal('技能一览', `${combat.getState().jobId} · LEVEL 100`, `
    <div class="book-filters"><div class="search-field">${icon('search')}<input id="skill-search" placeholder="搜索技能" value="${escape(filter)}" autocomplete="off"/></div><span>${actions.length} 项技能</span></div>
    <div id="book-detail" class="book-detail"><span>选择技能查看效果与使用条件</span></div>
    <div class="skillbook">${actions.map(action => `<button class="book-skill" data-inspect="${escape(action.id)}" data-search="${escape(`${action.name} ${action.en || ''}`.toLowerCase())}"><span style="--skill-color:${action.color || '#c1bd9e'}" class="book-icon">${skillIcon(action)}</span><span><strong>${escape(action.name)}</strong><small>${action.gcd ? '魔法 / 战技' : '能力'} · ${action.cast ? `${action.cast}s 咏唱` : '即时'}</small></span><em>${action.potency || '—'}</em></button>`).join('')}</div>`, 'book-modal');
}

function inspectSkill(id) {
  const action = combat.getActions().find(item => item.id === id);
  if (!action || !$('#book-detail')) return;
  $('#book-detail').innerHTML = `<div><strong>${escape(action.name)}</strong><small>${escape(action.en)} · 复唱 ${Number(action.recast).toFixed(1)}s</small><p>${escape(action.description)}</p></div><button class="command" data-action="${escape(id)}">施放</button>`;
  document.querySelectorAll('[data-inspect]').forEach(button => button.classList.toggle('selected', button.dataset.inspect === id));
}
function openSettings() {
  openModal('演武设置', 'CONFIGURATION', `<div class="settings-body"><div class="setting"><label for="control-mode">操作模式</label><select id="control-mode"><option value="traditional" ${settings.controlMode === 'traditional' ? 'selected' : ''}>传统 · 右键控制视角</option><option value="orbit" ${settings.controlMode === 'orbit' ? 'selected' : ''}>自由观察</option></select></div><div class="setting"><label>画面质量</label><div class="segmented"><button data-quality="low" class="${settings.quality === 'low' ? 'selected' : ''}">流畅</button><button data-quality="high" class="${settings.quality === 'high' ? 'selected' : ''}">高质量</button></div></div><div class="setting"><label for="sound-toggle">技能音效</label><input id="sound-toggle" type="checkbox" role="switch" ${settings.sound ? 'checked' : ''}></div><div class="setting"><label for="volume">音量</label><input id="volume" type="range" min="0" max="1" step="0.05" value="${settings.volume}"></div><div class="setting"><label for="hud-scale">界面缩放</label><div class="range-setting"><input id="hud-scale" type="range" min="80" max="110" step="5" value="${settings.scale}"><output id="hud-scale-output">${settings.scale}%</output></div></div><div class="setting"><label for="target-count">范围攻击目标数</label><input type="number" id="target-count" min="1" max="8" value="${getTargetCount()}"></div><div class="setting"><label for="healing-pressure">交战后每 8 秒承受练习伤害</label><input id="healing-pressure" type="checkbox" role="switch" ${training.enabled ? 'checked' : ''}></div><div class="setting"><span>治疗练习</span><button id="training-hit" class="command">承受一次伤害</button></div><div class="setting settings-build"><span>规则版本</span><b>7.0 · Lv.100</b></div><div class="setting settings-build"><span>伤害单位</span><b>技能威力</b></div></div>`, 'settings-modal');
}

function openMap() {
  const scene = SCENES.find(item => item.id === getSceneId());
  const info = world.getInfo();
  if (!info.map?.bounds) return;
  const connections = world.getConnections?.() || [];
  const landmarks = (info.map.landmarks || []).filter(landmark => landmark.type !== 'connection');
  const sceneName = id => SCENES.find(item => item.id === id)?.name || '未开放地区';
  openModal(scene.name, scene.region, `<div class="area-map"><canvas id="area-map-canvas" width="900" height="600"></canvas><div class="area-legend"><span><i class="legend-player"></i>冒险者</span><span><i class="legend-dummy"></i>木人</span><span><i class="legend-npc"></i>NPC</span></div></div><div class="map-places">${landmarks.map((landmark, i) => `<button data-landmark="${escape(landmark.id)}"><b>${i + 1}</b>${escape(landmark.name)}</button>`).join('')}</div>${connections.length ? `<section class="map-exits"><h3>${icon('send')}区域出口</h3>${connections.map(connection => `<button data-landmark="connection:${escape(connection.id)}"><span><strong>${escape(connection.name || '区域出口')}</strong><small>通往 ${escape(sceneName(connection.targetScene))}</small></span>${icon('chevron-right')}</button>`).join('')}</section>` : ''}<p class="map-note">点击出口可步行前往。真正跨区须脱战并靠近出口，再按 F 或点击现场按钮进入。</p>`, 'map-modal');
  drawMap($('#area-map-canvas'), world.getInfo(), getSceneId(), true);
}

function openDialogue(npc) {
  const dialogue = Array.isArray(npc.dialogue) ? npc.dialogue.join('\n') : npc.dialogue || '愿水晶的光辉与你同在。';
  openModal(escape(npc.name), 'DIALOGUE', `<div class="dialogue-body">${icon('message-circle')}<p>${escape(dialogue)}</p></div><footer class="dialogue-footer"><button class="command modal-close">${icon('check')}告辞</button></footer>`, 'dialogue-modal');
}


function openHelp() {
  openModal('演武指南', 'FIELD GUIDE', `<div class="help-body">
    <p>选择职业，锁定木人，开始你的循环练习。</p>
    <div class="help-grid"><span>移动</span><b>W A S D / 方向键</b><span>传统视角 / 同步朝向</span><b>按住右键 + 移动鼠标</b><span>观察 / 缩放镜头</span><b>左键拖动 / 滚轮</b><span>跳跃</span><b>Space</b><span>选择最近木人</span><b>Tab / 点击木人</b><span>进入区域出口</span><b>靠近后 F / 点击按钮</b><span>使用技能</span><b>1–0、−、=</b><span>第二行技能</span><b>Shift + 数字键</b><span>打开传送 / 地图 / 技能</span><b>T / M / P</b><span>关闭窗口 / 取消目标</span><b>Esc</b></div>
    <p>鼠标悬停技能可查看效果与条件。亮金色边框代表已触发技能；复唱与资源不足会显示在技能栏。点击技能栏右侧箭头切换全部技能。</p>
    <p>游戏区域不弹出右键菜单。传统模式按住右键直接控制镜头与角色朝向，松开后恢复鼠标；切换窗口或打开菜单也会释放。A/D 或 Q/E 可横移。</p><p>近战技能需要靠近木人；移动会中断咏唱。传送需要 5 秒，战斗中请先重置练习。范围攻击可在设置中调整目标数。</p>
    <p>左侧统计以技能威力计算。随时重置即可重新练习，也可导出战斗记录。</p>
  </div>`, 'help-modal');
}
function refreshCatalog() {
  if (modal === 'teleport-modal') openTeleport();
  if (modal === 'map-modal') openMap();
}
return { openTeleport, openBook, inspectSkill, openSettings, openMap, openDialogue, openHelp, closeModal, refreshCatalog, get active() { return modal; } };

}
