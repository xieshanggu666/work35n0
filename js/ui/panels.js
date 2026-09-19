/**
 * FG.Panels —— 右侧面板：信息 / 统计 / 日志
 */
FG.Panels = (() => {
  let activeTab = 'info';
  let chartItems = [];
  let lastRefresh = 0;

  const tabsEl = () => document.getElementById('sp-tabs');
  const bodyEl = () => document.getElementById('sp-body');

  const STATUS_NAMES = { working: '生产中', starving: '缺料', blocked: '堵塞', idle: '闲置', empty: '枯竭' };

  function init() {
    for (const b of tabsEl().querySelectorAll('button')) {
      b.onclick = () => {
        activeTab = b.dataset.tab;
        tabsEl().querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
        render();
      };
    }
    FG.Events.on('sim:tick', () => {
      const now = performance.now();
      if (now - lastRefresh > 150) { lastRefresh = now; render(); }
    });
    FG.Events.on('selection:change', () => { render(); });
    FG.Events.on('recipe:change', () => { render(); });
    FG.Events.on('message', () => { if (activeTab === 'log') render(); });
  }

  function render() {
    if (!FG.game || FG.game.state !== 'playing') return;
    if (activeTab === 'info') renderInfo();
    else if (activeTab === 'stats') renderStats();
    else if (activeTab === 'log') renderLog();
    bindActions();
  }

  // ================= 信息 =================
  function renderInfo() {
    const game = FG.game;
    const sel = game.selection;
    let html = '';
    if (!sel) {
      html += `<div class="panel-sec"><h4>工厂概况</h4>
        <div class="info-grid">
          <div class="k">建筑数</div><div class="v">${game.totalBuildings()}</div>
          <div class="k">已研究</div><div class="v">${game.research.completed.size} / ${FG.Research.list().length}</div>
          <div class="k">游戏时间</div><div class="v">${FG.Utils.fmtTime(game.playTime)}</div>
        </div>
        <div style="color:var(--text-dim);font-size:11px;margin-top:8px;line-height:1.6">
          点击地图上的建筑查看详情。<br>
          拖动右键平移视野，滚轮缩放。<br>
          矿机→熔炉→组装机→科学包，最后发射卫星！
        </div></div>`;
    } else {
      html += buildingInfo(sel);
    }
    bodyEl().innerHTML = html;
  }

  function buildingInfo(b) {
    const game = FG.game;
    let h = `<div class="panel-sec"><h4>${b.def.name}</h4>
      <div class="info-grid">
        <div class="k">状态</div><div class="v status-${b.status}">${STATUS_NAMES[b.status] || b.status}</div>
        <div class="k">坐标</div><div class="v">(${b.x}, ${b.y})</div>
        ${b.def.beltTier !== undefined ? `<div class="k">方向</div><div class="v">${FG.Utils.dirName(b.dir)}</div>` : ''}
        ${b.def.inserterTier !== undefined ? `<div class="k">方向</div><div class="v">${FG.Utils.dirName(b.dir)}</div>` : ''}
        ${b.def.beltTier !== undefined ? `<div class="k">物品</div><div class="v">${b.items.length}/${FG.Config.BELT_CAP}</div>` : ''}
        ${b.type === 'pipe' ? `<div class="k">流体</div><div class="v">${(b.level / FG.Config.FLUID_PIPE_CAP * 100).toFixed(0)}%</div>` : ''}
        ${b.def.inserterTier !== undefined ? `<div class="k">手持</div><div class="v">${b.held ? FG.Items.byId(b.held.type).name : '空'}</div>` : ''}
        ${b.def.inserterTier !== undefined ? `<div class="k">筛选</div><div class="v">${b.filter ? FG.Items.byId(b.filter).name : '任意'}</div>` : ''}
        ${b.def.inserterTier !== undefined ? `<div class="k">按需供给</div><div class="v">${b.demandMode ? '开' : '关'}</div>` : ''}
        ${b.type === 'miner' ? `<div class="k">矿种</div><div class="v">${b.oreType ? FG.Items.byId(b.oreType).name : '无'}</div>` : ''}
        ${b.type === 'miner' && b.oreType ? `<div class="k">剩余</div><div class="v">${FG.Utils.fmtNum(game.map.amountAt(b.x, b.y))}</div>` : ''}
        ${b.def.recipeBuilding || b.type === 'lab' ? `<div class="k">供料优先级</div><div class="v">${({ high: '高', normal: '中', low: '低' })[b.priority] || '中'}</div>` : ''}
        ${b.def.recipeBuilding ? `<div class="k">产量</div><div class="v">${FG.Utils.fmtNum(b.totalCrafted)}</div>` : ''}
      </div>
      <div style="color:var(--text-dim);font-size:11px;margin-top:6px;line-height:1.5">${b.def.desc}</div></div>`;

    // 机械臂：筛选条件 + 下游缺料开关
    if (b.def.inserterTier !== undefined) {
      const solids = FG.Items.list().filter(i => !i.fluid);
      const wanted = FG.game.sim ? FG.game.sim.inserterWanted(b) : null;
      let needTxt = '—';
      if (wanted === null) needTxt = '任意（终端/箱子）';
      else if (!wanted.size) needTxt = '下游暂不缺料';
      else needTxt = Array.from(wanted).slice(0, 5).map(id => FG.Items.byId(id).name).join('、')
        + (wanted.size > 5 ? '…' : '');
      h += `<div class="panel-sec"><h4>取放规则</h4>
        <label class="cfg-row"><input type="checkbox" id="ins-demand" ${b.demandMode ? 'checked' : ''}>
          <span>按需供给：按下游缺口数量与在途预留联动（沿带追踪 ${FG.Config.BELT_TRACE_DEPTH} 格）</span></label>
        <div style="font-size:11px;color:var(--text-dim);margin:4px 0 6px">当前需求：<b style="color:var(--accent2)">${needTxt}</b></div>
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:4px">筛选物品（点击切换，再点取消）：</div>
        <div class="filter-grid">
          <button class="filter-chip ${b.filter === null ? 'active' : ''}" data-filter="">任意</button>
          ${solids.map(i => `<button class="filter-chip ${b.filter === i.id ? 'active' : ''}" data-filter="${i.id}">${i.name}</button>`).join('')}
        </div></div>`;
    }

    // 生产线供料优先级（消费者：生产建筑 + 实验室）
    if (b.def.recipeBuilding || b.type === 'lab') {
      const cur = b.priority || 'normal';
      const opts = [['high', '高优先', '缺料时优先供料'], ['normal', '普通', '同级轮转公平供料'], ['low', '低优先', '物料紧张时最后供料']];
      h += `<div class="panel-sec"><h4>生产线供料优先级</h4>
        <div class="prio-row">
          ${opts.map(([id, name, tip]) => `<button class="prio-btn prio-${id} ${cur === id ? 'active' : ''}"
            data-prio="${id}" title="${tip}">${name}</button>`).join('')}
        </div>
        <div style="font-size:11px;color:var(--text-dim);margin-top:4px;line-height:1.5">
          料源紧张时高优先级产线先得料，同优先级轮转均分；在途货物自动预留，在带面上以青色环标记。</div></div>`;
    }

    // 配方选择
    if (b.def.recipeBuilding) {
      const recipes = FG.Recipes.forBuilding(b.type);
      const r = b.recipe ? FG.Recipes.byId(b.recipe) : null;
      if (r) {
        const p = Math.min(1, b.progress / r.time);
        h += `<div class="panel-sec"><h4>生产进度</h4>
          <div class="progress-bar"><div class="fill" style="width:${(p * 100).toFixed(1)}%"></div></div>
          <div style="font-size:11px;color:var(--text-dim)">${r.name} · ${(p * 100).toFixed(0)}%</div></div>`;
      }
      h += `<div class="panel-sec"><h4>配方</h4><div class="recipe-list">`;
      for (const rc of recipes) {
        const unlocked = game.research.isRecipeUnlocked(rc.id);
        const ing = rc.ingredients.map(i => `${FG.Items.byId(i.item).name}×${i.count}`).join(' + ');
        h += `<button class="recipe-btn ${b.recipe === rc.id ? 'selected' : ''} ${unlocked ? '' : 'locked'}"
          data-recipe="${rc.id}"
          title="${unlocked ? '' : '需要研究：' + (FG.Research.byId(rc.unlockedBy) ? FG.Research.byId(rc.unlockedBy).name : rc.unlockedBy)}">
          <span class="rc-name">${rc.name}</span>
          <span class="rc-ing">${ing}</span>
        </button>`;
      }
      h += `</div></div>`;
    }

    // 输入/输出槽
    const hasSlots = Object.keys(b.slots.inputs).length || Object.keys(b.slots.outputs).length;
    if (hasSlots) {
      const recipe = b.recipe ? FG.Recipes.byId(b.recipe) : null;
      const needed = new Set(recipe ? recipe.ingredients.filter(i => !FG.Items.isFluid(i.item)).map(i => i.item) : []);
      h += `<div class="panel-sec"><h4>物料</h4>`;
      for (const k of Object.keys(b.slots.inputs)) {
        const s = b.slots.inputs[k];
        const orphan = b.def.recipeBuilding && !needed.has(k);
        h += slotRow((orphan ? '残留 ' : '输入 ') + FG.Items.byId(k).name, s, orphan);
      }
      for (const k of Object.keys(b.slots.outputs)) {
        const s = b.slots.outputs[k];
        h += slotRow('输出 ' + FG.Items.byId(k).name, s);
      }
      h += `</div>`;
    }
    // 流体罐
    if (Object.keys(b.fluidTanks).length) {
      h += `<div class="panel-sec"><h4>流体缓冲</h4>`;
      for (const k of Object.keys(b.fluidTanks)) {
        const cap = FG.Config.FLUID_TANK_CAP;
        h += `<div class="slot-row"><span class="sl-name">${FG.Items.byId(k).name}</span>
          <div class="sl-bar"><div class="fill" style="width:${(b.fluidTanks[k] / cap * 100).toFixed(0)}%"></div></div>
          <span class="sl-count">${FG.Utils.fmtNum(b.fluidTanks[k])}</span></div>`;
      }
      h += `</div>`;
    }
    // 箱子
    if (b.type === 'chest') {
      h += `<div class="panel-sec"><h4>存储</h4>`;
      for (const s of b.chest) {
        h += slotRow(s.type ? FG.Items.byId(s.type).name : '空', s);
      }
      h += `</div>`;
    }

    // 操作按钮
    h += `<div class="action-row">`;
    if (b.def.beltTier !== undefined || b.def.inserterTier !== undefined) {
      h += `<button id="btn-rotate">旋转</button>`;
    }
    h += `<button id="btn-demolish" class="danger">拆除</button>
      <button id="btn-clear">取消选择</button></div>`;

    return h;
  }

  function slotRow(name, s, warn) {
    return `<div class="slot-row${warn ? ' slot-warn' : ''}" title="${warn ? '当前配方不再需要，机械臂会将其运走' : ''}"><span class="sl-name">${name}</span>
      <div class="sl-bar"><div class="fill" style="width:${Math.min(100, s.count / s.cap * 100).toFixed(0)}%"></div></div>
      <span class="sl-count">${FG.Utils.fmtNum(s.count)}/${FG.Utils.fmtNum(s.cap)}</span></div>`;
  }

  // ================= 统计 =================
  function renderStats() {
    const game = FG.game;
    const stats = game.stats;
    let h = '';

    // 概况
    h += `<div class="panel-sec"><h4>全局状态</h4>
      <div class="info-grid">
        <div class="k">建筑</div><div class="v">${game.totalBuildings()}</div>
        <div class="k">缺料</div><div class="v" style="color:${stats.agg.starveCount ? 'var(--red)' : 'inherit'}">${stats.agg.starveCount}</div>
        <div class="k">堵塞</div><div class="v" style="color:${stats.agg.blockCount ? 'var(--orange)' : 'inherit'}">${stats.agg.blockCount}</div>
      </div></div>`;

    // 瓶颈
    const defs = stats.deficits();
    h += `<div class="panel-sec"><h4>瓶颈分析（近 30s 消耗>产出）</h4>`;
    if (!defs.length && !stats.agg.starveCount && !stats.agg.blockCount) {
      h += `<div style="color:var(--text-dim);font-size:11px">暂无瓶颈，流水线运转良好</div>`;
    } else {
      for (const d of defs.slice(0, 8)) {
        h += `<div class="bottleneck-item warn">
          <span>${FG.Items.byId(d.id).name}</span>
          <span class="gap">缺口 ${FG.Utils.fmtRate(d.gap)}</span>
        </div>`;
      }
      for (const [item, n] of Object.entries(stats.agg.starveByItem)) {
        h += `<div class="bottleneck-item warn"><span>🔴 缺料：${FG.Items.byId(item).name}</span><span class="gap">${n} 座</span></div>`;
      }
      for (const [item, n] of Object.entries(stats.agg.blockByItem)) {
        h += `<div class="bottleneck-item warn"><span>🟠 堵塞：${FG.Items.byId(item).name}</span><span class="gap">${n} 座</span></div>`;
      }
    }
    h += `</div>`;

    // 图表
    h += `<div class="panel-sec"><h4>产量 / 消耗曲线（近 4 分钟）</h4>
      <div class="stats-toolbar" id="chart-items"></div>
      <div class="chart-box"><canvas id="chart-canvas"></canvas></div>
      <div style="font-size:10px;color:var(--text-dim)">
        <span style="color:var(--green)">■ 产出</span> &nbsp; <span style="color:var(--red)">■ 消耗</span>
      </div></div>`;

    // 汇总表
    h += `<div class="panel-sec"><h4>累计产量</h4>`;
    const ids = stats.itemIds().slice(0, 16);
    for (const id of ids) {
      const t = stats.total(id);
      const r = stats.rate(id);
      h += `<div class="rate-row"><span class="rk">${FG.Items.byId(id).name}</span>
        <span class="rv">${FG.Utils.fmtNum(t.p)} 累计 · ${FG.Utils.fmtRate(r.p)} 产出 · ${FG.Utils.fmtRate(r.c)} 消耗</span></div>`;
    }
    if (!ids.length) h += `<div style="color:var(--text-dim);font-size:11px">尚无生产记录</div>`;
    h += `</div>`;

    bodyEl().innerHTML = h;

    // 图表物品选择
    const chipWrap = document.getElementById('chart-items');
    if (chipWrap) {
      if (!chartItems.length) chartItems = ids.slice(0, 4);
      for (const id of ids) {
        const chip = document.createElement('span');
        chip.className = 'chip-item' + (chartItems.includes(id) ? ' active' : '');
        chip.textContent = FG.Items.byId(id).name;
        chip.onclick = () => {
          if (chartItems.includes(id)) chartItems = chartItems.filter(i => i !== id);
          else { if (chartItems.length < 5) chartItems.push(id); }
          renderStats();
        };
        chipWrap.appendChild(chip);
      }
      drawChart();
    }
  }

  function drawChart() {
    const cv = document.getElementById('chart-canvas');
    if (!cv) return;
    const stats = FG.game.stats;
    const dpr = window.devicePixelRatio || 1;
    cv.width = cv.clientWidth * dpr;
    cv.height = cv.clientHeight * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = cv.clientWidth, H = cv.clientHeight;
    ctx.fillStyle = '#12151d';
    ctx.fillRect(0, 0, W, H);
    if (!chartItems.length) return;

    // 计算 Y 范围
    let maxV = 1;
    const hist = stats.history;
    for (const id of chartItems) {
      for (const bk of hist) {
        maxV = Math.max(maxV, bk.p[id] || 0, bk.c[id] || 0);
      }
    }
    const pad = 4;
    const step = hist.length > 1 ? (W - pad * 2) / (hist.length - 1) : W;

    // 网格
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad + (H - pad * 2) * (i / 4);
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();
    }

    for (const id of chartItems) {
      const color = FG.Items.byId(id).color;
      for (const [kind, key, kcol] of [['p', 'p', color], ['c', 'c', 'rgba(224,92,92,0.9)']]) {
        ctx.strokeStyle = kind === 'p' ? color : 'rgba(224,92,92,0.85)';
        ctx.lineWidth = kind === 'p' ? 2 : 1.5;
        ctx.beginPath();
        hist.forEach((bk, i) => {
          const v = bk[key][id] || 0;
          const x = pad + i * step;
          const y = H - pad - (v / maxV) * (H - pad * 2);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }
    }
    // 图例当前值
    ctx.fillStyle = '#8b93a8';
    ctx.font = '10px Consolas';
    chartItems.forEach((id, i) => {
      const r = stats.rate(id);
      ctx.fillText(`${FG.Items.byId(id).name} 产出${FG.Utils.fmtRate(r.p)}`, pad + 4, 14 + i * 12);
    });
  }

  // ================= 日志 =================
  function renderLog() {
    const game = FG.game;
    let h = `<div class="panel-sec"><h4>事件日志</h4><div class="log-list">`;
    for (const l of game.log) {
      const t = new Date(l.t);
      h += `<div class="log-line msg-${l.cls}"><span class="log-time">${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}</span>${l.text}</div>`;
    }
    h += `</div></div>`;
    bodyEl().innerHTML = h;
    bodyEl().scrollTop = bodyEl().scrollHeight;
  }

  function bindActions() {
    const btn = document.getElementById('btn-demolish');
    if (btn) btn.onclick = () => { if (FG.game.selection) FG.game.removeBuilding(FG.game.selection); };
    const rot = document.getElementById('btn-rotate');
    if (rot) rot.onclick = () => {
      const b = FG.game.selection;
      if (b) { b.dir = (b.dir + 1) % 4; render(); }
    };
    const clr = document.getElementById('btn-clear');
    if (clr) clr.onclick = () => { FG.game.selection = null; FG.Events.emit('selection:change'); };
    for (const el of document.querySelectorAll('.recipe-btn')) {
      el.onclick = () => {
        const b = FG.game.selection;
        if (!b) return;
        const rid = el.dataset.recipe;
        if (!FG.game.research.isRecipeUnlocked(rid)) return;
        FG.game.setRecipe(b, rid);
      };
    }
    const dm = document.getElementById('ins-demand');
    if (dm) dm.onchange = () => {
      const b = FG.game.selection;
      if (b) { b.demandMode = dm.checked; render(); }
    };
    for (const el of document.querySelectorAll('.filter-chip')) {
      el.onclick = () => {
        const b = FG.game.selection;
        if (!b) return;
        b.filter = el.dataset.filter || null;
        render();
      };
    }
    for (const el of document.querySelectorAll('.prio-btn')) {
      el.onclick = () => {
        const b = FG.game.selection;
        if (!b) return;
        b.priority = el.dataset.prio;
        render();
      };
    }
  }

  return { init, render, bindActions };
})();
