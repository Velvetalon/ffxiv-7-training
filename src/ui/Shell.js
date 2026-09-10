import { $, escape, icon, iconify } from './dom.js';

export function mountShell(JOBS) {
$('#app').innerHTML = `
  <canvas id="world" tabindex="0" aria-label="三维演武场"></canvas>
  <div class="vignette"></div>
  <div id="loading"><span class="loading-crystal"></span><h1>以太演武场</h1><p>AETHERYTE · TRAINING GROUNDS</p><span class="loading-line"></span></div>
  <header class="topbar">
    <div class="brand"><span class="brand-mark">${icon('diamond')}</span><div><h1>以太演武场</h1><small>A E T H E R Y T E</small></div><span class="version">7.0</span></div>
    <nav class="job-switch" aria-label="职业">${JOBS.map(j => `<button data-job="${j.id}" title="${j.name}" aria-label="切换${j.name}">${icon(j.id === 'WHM' ? 'flower-2' : j.id === 'PCT' ? 'paintbrush' : 'swords')}<span>${escape(j.name)}</span><small>${j.id}</small></button>`).join('')}</nav>
    <div class="top-actions"><button id="teleport-open" class="command">${icon('orbit')}<span>传送</span></button><button id="book-open" class="icon-button" title="技能一览" aria-label="技能一览">${icon('book-open')}</button><button id="help-open" class="icon-button" title="演武指南" aria-label="演武指南">${icon('circle-help')}</button><button id="settings-open" class="icon-button" title="设置" aria-label="设置">${icon('settings-2')}</button></div>
  </header>
  <section class="target-frame" id="target-frame">
    <div class="target-title"><span class="target-type">${icon('crosshair')}<b>Lv.100</b></span><strong id="target-name">训练木人</strong><span id="target-distance">8.0 y</span></div>
    <div class="target-hp"><span></span></div><div class="target-meta"><span>练习目标</span><span id="target-position">背面</span><b>100%</b></div>
    <div id="target-debuffs" class="buff-list"></div>
  </section>
  <aside class="encounter">
    <div class="panel-heading"><span class="overline">STRIKING DUMMY</span><button id="encounter-toggle" title="收起战斗记录" class="tiny-button" aria-label="收起战斗记录">${icon('chevron-up')}</button></div>
    <h2>木人歼灭战<span id="combat-dot"></span></h2>
    <div class="encounter-body">
      <div class="session-time"><span id="encounter-time">00:00</span><small>战斗时间</small></div>
      <div class="stats-grid"><div><b id="pps">0</b><span>威力 / 秒</span></div><div><b id="total-potency">0</b><span>累计威力</span></div></div>
      <div class="rotation-summary"><span>GCD <b id="gcd-count">0</b></span><span>能力技 <b id="ogcd-count">0</b></span><span id="combat-status">待机</span></div>
      <div class="timeline-heading"><span>战斗记录</span><button id="log-export" class="tiny-button" title="导出战斗记录" aria-label="导出战斗记录">${icon('download')}</button></div>
      <ol id="combat-log"><li class="empty-log">尚未进入战斗</li></ol>
      <div class="encounter-actions"><button id="reset" class="command">${icon('rotate-ccw')}<span>重置练习</span></button><button id="reposition" class="icon-button" title="返回木人" aria-label="返回木人">${icon('locate-fixed')}</button></div>
    </div>
  </aside>
  <aside class="location">
    <div class="location-name"><span id="scene-region">黑衣森林</span><h2 id="scene-name">格里达尼亚新街</h2><small id="scene-en">NEW GRIDANIA</small></div>
    <div class="minimap"><canvas id="minimap" width="240" height="240"></canvas><span class="compass-n">N</span><span class="map-center"></span></div>
    <div class="coordinates"><span id="coordinates">X: 0.0 · Y: 0.0</span><span class="daytime">${icon('sun')}<span id="eorzea-time">ET 10:24</span></span></div>
    <button id="area-open" class="area-button">${icon('map')}<span>地区地图</span></button>
  </aside>
  <div id="scene-title" class="scene-title"><span></span><h2></h2><small></small></div>
  <div id="connection-prompt" class="connection-prompt hidden"><span>${icon('send')}<b id="connection-name"></b></span><button id="connection-travel" class="command" data-connection-travel=""><kbd>F</kbd>进入</button></div>
  <div id="feedback" role="status" aria-live="polite"></div>
  <div id="floating-damage" aria-hidden="true"></div>
  <div id="casting" class="casting hidden"><div><span id="cast-name"></span><span id="cast-time"></span></div><div class="cast-track"><span id="cast-fill"></span></div></div>
  <div class="bottom-hud">
    <div class="player-row">
      <div class="player-identity"><span class="job-emblem" id="job-emblem">${icon('flower-2')}</span><div><span class="player-name">光之冒险者 <small>Lv.100</small></span><span class="player-job" id="player-job">白魔法师</span></div></div>
      <div class="vitals"><div class="vital-label"><b>HP</b><span id="hp-value">100,000</span></div><div class="vital-bar health"><span id="hp-fill"></span></div><div class="vital-label mp-label"><b>MP</b><span id="mp-value">10,000</span></div><div class="vital-bar mana"><span id="mp-fill"></span></div></div>
      <div class="job-gauges" id="job-gauges"></div>
      <div id="player-buffs" class="buff-list"></div>
    </div>
    <div class="hotbar-area"><div id="hotbars" class="hotbars" role="group" aria-label="技能热键栏"></div><div class="hotbar-side"><button id="hotbar-prev" class="tiny-button" aria-label="上一组技能" title="上一组技能">${icon('chevron-up')}</button><span id="hotbar-page">1</span><button id="hotbar-next" class="tiny-button" aria-label="下一组技能" title="下一组技能">${icon('chevron-down')}</button><button id="target-nearest" class="tiny-button" aria-label="选择木人" title="选择木人">${icon('crosshair')}</button></div></div>
    <div class="hud-footer"><span><i class="connection-dot"></i>单人演武场</span><span id="job-resource-note"></span><span id="render-stats">60 FPS</span></div>
  </div>
  <div id="mobile-controls"><div class="direction-pad"><button data-move="KeyW" aria-label="前进">${icon('chevron-up')}</button><button data-move="KeyA" aria-label="左移">${icon('chevron-left')}</button><button data-move="KeyS" aria-label="后退">${icon('chevron-down')}</button><button data-move="KeyD" aria-label="右移">${icon('chevron-right')}</button></div><button id="mobile-target" class="icon-button" title="选择木人" aria-label="选择木人">${icon('crosshair')}</button></div>
  <div id="skill-tooltip" class="skill-tooltip hidden"></div>
  <div id="modal-layer" class="hidden"></div>
`;
iconify();
}
