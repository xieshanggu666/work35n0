/**
 * FG.Topbar —— 顶栏：时间/速度/科研进度/物品资源条
 */
FG.Topbar = (() => {
  let lastStrip = 0;
  let lastTime = 0;

  function init() {
    // 速度按钮
    const sb = document.getElementById('speed-btns');
    for (const b of sb.querySelectorAll('button')) {
      b.onclick = () => FG.game.setSpeed(parseFloat(b.dataset.speed));
    }
    document.getElementById('btn-pause').onclick = () => FG.game.togglePause();
    document.getElementById('btn-tech').onclick = () => FG.Tech.open();
    document.getElementById('btn-menu').onclick = () => FG.Modals.menu();

    FG.Events.on('speed:change', (s) => {
      document.querySelectorAll('#speed-btns button').forEach(b =>
        b.classList.toggle('active', parseFloat(b.dataset.speed) === s));
    });
    FG.Events.on('pause:change', (p) => {
      document.getElementById('btn-pause').textContent = p ? '▶ 继续' : '⏸ 暂停';
    });
    FG.Events.on('research:start', () => refreshResearch());
    FG.Events.on('research:complete', () => refreshResearch());
    FG.Events.on('research:cancel', () => refreshResearch());
    FG.Events.on('game:start', () => {
      refreshResearch();
      document.getElementById('btn-pause').textContent = '⏸ 暂停';
      document.querySelectorAll('#speed-btns button').forEach(b =>
        b.classList.toggle('active', parseFloat(b.dataset.speed) === FG.game.speed));
    });
    FG.Events.on('sim:tick', () => {
      const now = performance.now();
      if (now - lastTime > 200) { lastTime = now; refreshTime(); refreshResearch(); }
      if (now - lastStrip > 1000) { lastStrip = now; refreshStrip(); }
    });
  }

  function refreshTime() {
    document.getElementById('tb-time').textContent = '⏱ ' + FG.Utils.fmtTime(FG.game.playTime);
  }

  function refreshResearch() {
    const mgr = FG.game.research;
    const label = document.getElementById('rb-label');
    const fill = document.getElementById('rb-fill');
    if (mgr.current) {
      label.textContent = '研究: ' + mgr.current.name;
      fill.style.width = (mgr.progress() * 100).toFixed(1) + '%';
      fill.style.background = 'linear-gradient(90deg,#4da3ff,#7cc0ff)';
    } else {
      label.textContent = '研究: 未选择';
      fill.style.width = '0%';
      fill.style.background = '#3a4150';
    }
  }

  function refreshStrip() {
    const strip = document.getElementById('item-strip');
    const counts = FG.game.inventory();
    const entries = Object.entries(counts).filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!entries.length) { strip.innerHTML = ''; return; }
    let html = '';
    for (const [id, n] of entries) {
      const icon = FG.Renderer.itemIcon(id, 16);
      html += `<div class="item-chip" title="${FG.Items.byId(id).name}">
        ${icon.outerHTML}<span class="qty">${FG.Utils.fmtNum(n)}</span></div>`;
    }
    strip.innerHTML = html;
  }

  return { init };
})();
