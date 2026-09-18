/**
 * FG.Main —— 启动：输入处理、主循环
 */
(() => {
  const canvas = document.getElementById('map-canvas');
  const wrap = document.getElementById('map-wrap');
  const tooltip = document.getElementById('map-tooltip');

  FG.game = new FG.Game();

  let panning = false;
  let dragPlace = null;      // {lastX, lastY} 传送带拖拽放置

  // ================= 初始化 =================
  function init() {
    FG.Renderer.init(canvas, FG.game);
    FG.Toolbar.init();
    FG.Panels.init();
    FG.Tech.init();
    FG.Topbar.init();
    bindInput();

    window.addEventListener('resize', () => {
      FG.Renderer.resize();
      if (!document.getElementById('tech-tree').classList.contains('hidden')) FG.Tech.render();
    });

    // 首次启动：有存档显示帮助，无存档直接引导新建
    const hasSave = FG.Save.listSlots().some(s => s.exists);
    if (hasSave) FG.Modals.help();
    else FG.Modals.newGame();
  }

  // ================= 输入 =================
  function bindInput() {
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const tile = FG.Renderer.screenToTile(mx, my);
      FG.Renderer.setMouseTile(tile.x, tile.y);

      if (panning) {
        const t = FG.Config.TILE * FG.game.camera.zoom;
        FG.game.camera.x -= e.movementX / t;
        FG.game.camera.y -= e.movementY / t;
      }
      if (dragPlace) {
        const dx = tile.x - dragPlace.lastX, dy = tile.y - dragPlace.lastY;
        if (dx || dy) {
          FG.game.ghost.dir = dx !== 0 ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
          if (FG.game.placeGhost(tile.x, tile.y)) {
            dragPlace.lastX = tile.x;
            dragPlace.lastY = tile.y;
          }
        }
      }
      updateTooltip(e.clientX - wrap.getBoundingClientRect().left, e.clientY - wrap.getBoundingClientRect().top, tile);
    });

    canvas.addEventListener('mousedown', (e) => {
      const rect = canvas.getBoundingClientRect();
      const tile = FG.Renderer.screenToTile(e.clientX - rect.left, e.clientY - rect.top);
      if (e.button === 2 || e.button === 1) {
        panning = true;
        return;
      }
      if (e.button === 0) {
        if (FG.game.ghost) {
          if (FG.Buildings.byId(FG.game.ghost.type).beltTier !== undefined) {
            dragPlace = { lastX: tile.x, lastY: tile.y };
            FG.game.placeGhost(tile.x, tile.y);
          } else {
            FG.game.placeGhost(tile.x, tile.y);
          }
        } else {
          const b = FG.game.map.buildingAt(tile.x, tile.y);
          if (b) FG.game.selectBuilding(b);
          else { FG.game.selection = null; FG.Events.emit('selection:change'); }
        }
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button === 2 || e.button === 1) panning = false;
      if (e.button === 0) dragPlace = null;
    });

    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (FG.game.ghost) FG.game.cancelGhost();
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const cam = FG.game.camera;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const factor = e.deltaY > 0 ? 0.88 : 1.14;
      const nz = Math.min(2.5, Math.max(0.4, cam.zoom * factor));
      const t = FG.Config.TILE;
      cam.x = (mx / (t * nz)) - (mx / (t * cam.zoom) - cam.x);
      cam.y = (my / (t * nz)) - (my / (t * cam.zoom) - cam.y);
      cam.zoom = nz;
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      const game = FG.game;
      const techOpen = !document.getElementById('tech-tree').classList.contains('hidden');
      const modalOpen = !!document.querySelector('.modal-mask');

      if (e.key === 'Escape') {
        if (modalOpen) { FG.Modals.closeAll(); return; }
        if (techOpen) { FG.Tech.close(); return; }
        if (game.ghost) { game.cancelGhost(); return; }
        game.selection = null;
        FG.Events.emit('selection:change');
        return;
      }
      if (modalOpen || techOpen) return;

      switch (e.key) {
        case 'r': case 'R':
          if (game.ghost) game.rotateGhost();
          else if (game.selection && (game.selection.def.beltTier !== undefined || game.selection.def.inserterTier !== undefined)) {
            game.selection.dir = (game.selection.dir + 1) % 4;
          }
          break;
        case 'Delete': case 'Backspace':
          if (game.selection) game.removeBuilding(game.selection);
          break;
        case ' ':
          e.preventDefault();
          game.togglePause();
          break;
        case 't': case 'T': FG.Tech.open(); break;
        case 's': case 'S': game.showStatus = !game.showStatus; break;
        case '1': game.setSpeed(0.5); break;
        case '2': game.setSpeed(1); break;
        case '3': game.setSpeed(2); break;
        case '4': game.setSpeed(4); break;
      }
    });
  }

  // ================= 悬浮提示 =================
  function updateTooltip(px, py, tile) {
    const game = FG.game;
    const modalOpen = !!document.querySelector('.modal-mask');
    const techOpen = !document.getElementById('tech-tree').classList.contains('hidden');
    if (modalOpen || techOpen) { tooltip.classList.add('hidden'); return; }
    const m = game.map;
    if (!m || !m.inBounds(tile.x, tile.y)) { tooltip.classList.add('hidden'); return; }

    const b = m.buildingAt(tile.x, tile.y);
    const pile = !b ? m.pileAt(tile.x, tile.y) : null;
    let html = '';
    if (b) {
      const st = { working: '生产中/流动', starving: '缺料', blocked: '堵塞', idle: '闲置', empty: '枯竭' };
      html += `<div class="tt-title">${b.def.name}</div>`;
      html += `<div class="tt-row">状态：<b>${st[b.status] || b.status}</b></div>`;
      if (b.recipe) {
        const r = FG.Recipes.byId(b.recipe);
        const p = Math.min(1, b.progress / r.time);
        html += `<div class="tt-row">${r.name} <b>${(p * 100).toFixed(0)}%</b></div>`;
      }
      if (b.def.beltTier !== undefined) {
        let merge = 0;
        for (const side of [2, 3]) {
          const sv = FG.Map.beltSideVec(b.dir, side);
          const nb = m.buildingAt(b.x + sv.x, b.y + sv.y);
          if (nb && nb.def.beltTier !== undefined && FG.Map.beltFeedsInto(nb, b)) merge++;
        }
        html += `<div class="tt-row">方向 <b>${FG.Utils.dirName(b.dir)}</b> · ${b.items.length}/${FG.Config.BELT_CAP}${merge ? ` · ${merge} 路汇入` : ''}</div>`;
      }
      if (b.def.inserterTier !== undefined) html += `<div class="tt-row">方向 <b>${FG.Utils.dirName(b.dir)}</b> · 筛选 <b>${b.filter ? FG.Items.byId(b.filter).name : '任意'}</b>${b.demandMode ? ' · 按需' : ''}</div>`;
      if (b.type === 'pipe') html += `<div class="tt-row">流体 <b>${(b.level / FG.Config.FLUID_PIPE_CAP * 100).toFixed(0)}%</b></div>`;
      if (b.type === 'miner' && b.oreType) html += `<div class="tt-row">${FG.Items.byId(b.oreType).name} <b>${FG.Utils.fmtNum(m.amountAt(b.x, b.y))}</b></div>`;
    } else if (pile) {
      html += `<div class="tt-title">地面物料</div>`;
      for (const s of pile.slice(0, 6)) html += `<div class="tt-row">${FG.Items.byId(s.type).name} <b>×${FG.Utils.fmtNum(s.count)}</b></div>`;
      html += `<div class="tt-row" style="margin-top:3px">在此格放置建筑可回收</div>`;
    } else {
      const ore = m.ores[tile.y][tile.x];
      if (ore) {
        html += `<div class="tt-title">${FG.Items.byId(ore.type).name}</div>`;
        html += `<div class="tt-row">储量 <b>${FG.Utils.fmtNum(ore.amount)}</b></div>`;
      } else if (m.isOil(tile.x, tile.y)) {
        html += `<div class="tt-title">油田</div><div class="tt-row">放置抽油机抽取原油</div>`;
      } else if (m.isWater(tile.x, tile.y)) {
        html += `<div class="tt-title">水域</div><div class="tt-row">放置水泵取水</div>`;
      } else {
        tooltip.classList.add('hidden');
        return;
      }
    }
    tooltip.innerHTML = html;
    tooltip.classList.remove('hidden');
    tooltip.style.left = Math.min(px + 14, wrap.clientWidth - 250) + 'px';
    tooltip.style.top = Math.min(py + 14, wrap.clientHeight - 120) + 'px';
  }

  // ================= 主循环 =================
  let lastTime = performance.now();
  function loop(now) {
    const dt = Math.min(0.1, (now - lastTime) / 1000);
    lastTime = now;
    FG.game.update(dt);
    FG.Renderer.render();
    requestAnimationFrame(loop);
  }

  init();
  requestAnimationFrame(loop);
})();
