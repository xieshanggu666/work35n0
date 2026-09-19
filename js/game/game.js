/**
 * FG.Game —— 游戏主类：状态、建筑放置、主循环、存档序列化、消息
 */
FG.Game = class Game {
  constructor() {
    this.state = 'menu';          // 'menu' | 'playing'
    this.map = null;
    this.sim = null;
    this.stats = new FG.Stats();
    this.research = new FG.ResearchMgr(this);
    this.speed = 1;
    this.paused = false;
    this.tickCount = 0;
    this.playTime = 0;            // 仿真秒
    this.simAcc = 0;
    this.autosaveTimer = 0;
    this.camera = { x: 0, y: 0, zoom: 1 };
    this.selection = null;        // 选中的建筑
    this.ghost = null;            // {type, dir}
    this.showStatus = false;      // 状态高亮开关
    this.log = [];
    this.saveInfo = { slot: null, name: '', startDate: Date.now() };
    this.mapInfo = { presetId: 'greenfield', sizeId: 'medium', seed: 1, biome: 'grass' };
  }

  // ================= 开始 / 载入 =================
  newGame(presetId, sizeId, seed, slot, name) {
    const preset = FG.Maps.getPreset(presetId);
    const gen = FG.Maps.generate(preset, seed, sizeId);
    this.startWithMap(gen, slot, name);
    this.logMsg('新游戏开始：' + preset.name, 'info');
    this.logMsg('提示：从矿脉开采矿石 → 熔炉冶炼 → 组装机加工', 'info');
  }

  startWithMap(gen, slot, name) {
    this.map = new FG.Map(gen.w, gen.h, gen.terrain, gen.ores, gen.water, gen.oil);
    // 恢复地面物料堆（拆除保留的在途/库存物料）
    for (const p of (gen.piles || [])) {
      for (const s of p.items) this.map.pileAdd(p.x, p.y, s.type, s.count);
    }
    this.sim = new FG.Sim();
    this.sim.init(this);
    this.stats = new FG.Stats();
    this.research = new FG.ResearchMgr(this);
    this.tickCount = 0;
    this.playTime = 0;
    this.simAcc = 0;
    this.autosaveTimer = 0;
    this.selection = null;
    this.ghost = null;
    this.saveInfo = { slot: slot || null, name: name || '未命名工厂', startDate: Date.now() };
    this.mapInfo = {
      presetId: gen.presetId, sizeId: gen.sizeId || 'medium',
      seed: gen.seed || 1, biome: gen.biome,
    };
    this.log = [];
    this.state = 'playing';
    // 居中相机
    const cw = window.innerWidth, ch = window.innerHeight;
    this.camera.x = gen.w / 2 - cw / 2 / FG.Config.TILE;
    this.camera.y = gen.h / 2 - ch / 2 / FG.Config.TILE;
    this.camera.zoom = 1;
    FG.Events.emit('game:start');
  }

  // ================= 存档 =================
  serialize() {
    const cleanTag = (t) => t ? { c: t.c, item: t.item, t0: t.t0 || 0 } : undefined;
    const blds = [];
    for (const b of this.map.buildings.values()) {
      blds.push({
        type: b.type, x: b.x, y: b.y, dir: b.dir, recipe: b.recipe,
        progress: b.progress, slots: b.slots, fluidTanks: b.fluidTanks,
        items: b.items.map(it => {
          const ni = { type: it.type, pos: it.pos, from: it.from };
          if (it.tag) ni.tag = cleanTag(it.tag);
          return ni;
        }),
        held: b.held ? { type: b.held.type, tag: cleanTag(b.held.tag) } : null,
        phase: b.phase, timer: b.timer,
        level: b.level, fluidType: b.fluidType, chest: b.chest, oreType: b.oreType,
        consumeCounter: b.consumeCounter, totalCrafted: b.totalCrafted,
        rr: b.rr, filter: b.filter, demandMode: b.demandMode,
        priority: b.priority, status: b.status,
      });
    }
    const ores = this.map.ores.map(row => row.map(c => c ? { type: c.type, amount: c.amount } : null));
    const piles = [];
    for (const [k, pile] of this.map.piles) {
      const [x, y] = k.split(',').map(Number);
      piles.push({ x, y, items: pile.map(s => ({ type: s.type, count: s.count })) });
    }
    return {
      v: FG.Config.VERSION,
      map: {
        presetId: this.mapInfo.presetId, biome: this.mapInfo.biome,
        w: this.map.w, h: this.map.h, seed: this.mapInfo.seed, sizeId: this.mapInfo.sizeId,
        terrain: this.map.terrain, ores,
        water: Array.from(this.map.water), oil: Array.from(this.map.oil),
        piles,
      },
      buildings: blds,
      research: {
        completed: Array.from(this.research.completed),
        current: this.research.current ? this.research.current.id : null,
        points: this.research.points,
      },
      totals: this.stats.totals,
      meta: { playTime: this.playTime, name: this.saveInfo.name, startDate: this.saveInfo.startDate },
    };
  }

  deserialize(data) {
    const m = data.map;
    const gen = {
      presetId: m.presetId, biome: m.biome, w: m.w, h: m.h, seed: m.seed, sizeId: m.sizeId,
      terrain: m.terrain,
      ores: m.ores.map(row => row.map(c => c ? { type: c.type, amount: c.amount } : null)),
      water: new Set(m.water), oil: new Set(m.oil),
      piles: m.piles || [],
    };
    this.startWithMap(gen, data._slot || null, (data.meta && data.meta.name) || '存档');
    this.playTime = (data.meta && data.meta.playTime) || 0;
    this.saveInfo.startDate = (data.meta && data.meta.startDate) || Date.now();

    for (const sb of data.buildings) {
      const b = FG.Map.create(sb.type, sb.x, sb.y, sb.dir || 0);
      if (sb.recipe !== undefined) b.recipe = sb.recipe;
      b.progress = sb.progress || 0;
      b.slots = sb.slots || { inputs: {}, outputs: {} };
      b.fluidTanks = sb.fluidTanks || {};
      b.items = (sb.items || []).map(it => {
        const ni = { type: it.type, pos: it.pos, from: it.from || 0 };
        if (it.tag) ni.tag = { c: it.tag.c, item: it.tag.item, t0: it.tag.t0 || 0 }; // 在途预留
        return ni;
      });
      b.held = sb.held ? {
        type: sb.held.type,
        tag: sb.held.tag ? { c: sb.held.tag.c, item: sb.held.tag.item, t0: sb.held.tag.t0 || 0 } : null,
      } : null;
      b.phase = sb.phase || 'rest';
      b.timer = sb.timer || 4;
      b.level = sb.level || 0;
      b.fluidType = sb.fluidType || null;
      b.chest = sb.chest || [];
      b.oreType = sb.oreType || null;
      b.consumeCounter = sb.consumeCounter || 0;
      b.totalCrafted = sb.totalCrafted || 0;
      b.rr = sb.rr || 0;
      b.filter = sb.filter || null;
      b.demandMode = !!sb.demandMode;
      b.priority = FG.Config.PRIORITIES[sb.priority] ? sb.priority : 'normal'; // 旧存档默认普通
      b.status = sb.status || 'idle';
      // 旧存档箱子槽位补齐
      if (b.def.storage) {
        while (b.chest.length < FG.Config.CHEST_SLOTS) b.chest.push({ type: null, count: 0, cap: FG.Config.CHEST_SLOT_CAP });
      }
      // 旧存档实验室输入槽补齐
      if (b.def.science) {
        for (const s of ['science1', 'science2', 'science3']) {
          if (!b.slots.inputs[s]) b.slots.inputs[s] = { count: 0, cap: 50 };
        }
      }
      this.map.register(b);
      this.sim.register(b);
    }

    if (data.research) {
      this.research.completed = new Set(data.research.completed || []);
      this.research.points = data.research.points || {};
      if (data.research.current) this.research.current = FG.Research.byId(data.research.current);
    }
    if (data.totals) {
      this.stats.totals = data.totals;
      for (const id of Object.keys(data.totals)) this.stats.recordProduce(id, 0); // 登记 itemIds
    }
    this.logMsg('存档已载入', 'info');
    FG.Events.emit('game:start');
  }

  saveTo(slot, name) {
    if (name) this.saveInfo.name = name;
    this.saveInfo.slot = slot;
    const data = this.serialize();
    data._slot = slot;
    const ok = FG.Save.saveToSlot(slot, {
      name: this.saveInfo.name, playTime: this.playTime,
      date: new Date().toLocaleString('zh-CN'),
    }, data);
    if (ok) this.logMsg('已保存到槽位 ' + slot + '：' + this.saveInfo.name, 'info');
    return ok;
  }

  loadSlot(slot) {
    const obj = FG.Save.loadSlot(slot);
    if (!obj) { this.logMsg('槽位 ' + slot + ' 无存档', 'error'); return false; }
    obj.data._slot = slot;
    this.deserialize(obj.data);
    this.saveInfo.slot = slot;
    this.saveInfo.name = (obj.meta && obj.meta.name) || '存档';
    return true;
  }

  // ================= 主循环 =================
  update(dt) {
    if (this.state !== 'playing' || this.paused) return;
    const tickLen = 1 / FG.Config.TPS;
    this.simAcc += dt * this.speed;
    let guard = 0;
    while (this.simAcc >= tickLen && guard++ < 500) {
      this.simAcc -= tickLen;
      this.tickOnce();
    }
    // 推进仿真秒
    const prev = Math.floor(this.playTime);
    this.playTime += dt * this.speed;
    if (Math.floor(this.playTime) > prev) {
      this.stats.onSecond();
      // 自动存档
      this.autosaveTimer += dt * this.speed;
      if (this.autosaveTimer >= FG.Config.AUTOSAVE_SEC) {
        this.autosaveTimer = 0;
        this.saveTo('auto', null);
      }
    }
    FG.Events.emit('sim:tick');
  }

  tickOnce() {
    this.sim.tick();
    this.tickCount++;
  }

  // ================= 建筑放置 =================
  setGhost(type) {
    if (!this.research.isBuildingUnlocked(type)) return;
    this.ghost = { type, dir: 0 };
    this.selection = null;
    FG.Events.emit('ghost:change');
  }
  rotateGhost() {
    if (!this.ghost) return;
    this.ghost.dir = (this.ghost.dir + 1) % 4;
    FG.Events.emit('ghost:change');
  }
  cancelGhost() {
    this.ghost = null;
    FG.Events.emit('ghost:change');
  }

  canPlace(type, x, y) {
    const def = FG.Buildings.byId(type);
    if (!this.map.inBounds(x, y)) return false;
    if (this.map.isOccupied(x, y)) return false;
    const terr = this.map.terrainAt(x, y);
    if (terr === 'water') {
      return type === 'pump';
    }
    if (def.onTerrain === 'ore') return this.map.oreAt(x, y) !== null;
    if (def.onTerrain === 'water') return false;
    if (def.onTerrain === 'oil') return this.map.isOil(x, y);
    return true;
  }

  placeGhost(x, y) {
    if (!this.ghost) return false;
    if (!this.canPlace(this.ghost.type, x, y)) return false;
    const b = FG.Map.create(this.ghost.type, x, y, this.ghost.dir);
    if (b.type === 'miner') b.oreType = this.map.oreAt(x, y);
    this.map.register(b);
    this.sim.register(b);
    // 若该格有拆除时遗留的地面物料，优先回收进新建筑（在途物品不丢失）
    this.absorbPile(b);
    FG.Events.emit('building:placed', b);
    return true;
  }

  /** 放置建筑时吸收同格地面堆，吸不完的继续留在地面 */
  absorbPile(b) {
    const pile = this.map.pileAt(b.x, b.y);
    if (!pile) return;
    for (let i = pile.length - 1; i >= 0; i--) {
      const s = pile[i];
      let left = s.count;
      if (b.def.beltTier !== undefined) {
        const SP = 1 / FG.Config.BELT_CAP;
        while (left > 0 && b.items.length < FG.Config.BELT_CAP) {
          b.items.unshift({ type: s.type, pos: 0, from: 0 });
          left--;
        }
        // 进料物品按间距排开，避免叠在入口
        b.items.sort((a, c) => a.pos - c.pos);
        for (let k = b.items.length - 2; k >= 0; k--) b.items[k].pos = Math.min(b.items[k].pos, b.items[k + 1].pos - SP);
      } else if (b.type === 'chest') {
        left = this.tryChestAdd(b, s.type, left);
      } else if (b.slots) {
        FG.Map.syncRecipeSlots(b);
        const ins = b.slots.inputs[s.type];
        if (ins) { const put = Math.min(left, ins.cap - ins.count); ins.count += put; left -= put; }
        const out = b.slots.outputs[s.type];
        if (out && left > 0) { const put = Math.min(left, out.cap - out.count); out.count += put; left -= put; }
      }
      s.count = left;
      if (s.count <= 0) pile.splice(i, 1);
    }
    if (!pile.length) this.map.piles.delete(FG.Utils.key(b.x, b.y));
  }

  tryChestAdd(chest, type, n) {
    for (const slot of chest.chest) {
      if (slot.type === type && slot.count < slot.cap) {
        const put = Math.min(n, slot.cap - slot.count);
        slot.count += put; n -= put;
      }
    }
    for (const slot of chest.chest) {
      if (n <= 0) break;
      if (slot.count === 0) {
        const put = Math.min(n, slot.cap);
        slot.type = type; slot.count = put; n -= put;
      }
    }
    return n;
  }

  removeBuilding(b) {
    // 物料保留：传送带上的在途物品、手中物品、槽位与箱子物料全部落到该格地面堆
    // 拆建即释放预留：落地前剥离在途预留标签，物料恢复为自由货物可被任何产线取用
    if (b.items) for (const it of b.items) this.map.pileAdd(b.x, b.y, it.type, 1);
    if (b.held) this.map.pileAdd(b.x, b.y, b.held.type, 1);
    if (b.chest) for (const s of b.chest) if (s.count > 0) this.map.pileAdd(b.x, b.y, s.type, s.count);
    if (b.slots) {
      for (const k of Object.keys(b.slots.inputs)) if (b.slots.inputs[k].count > 0) this.map.pileAdd(b.x, b.y, k, b.slots.inputs[k].count);
      for (const k of Object.keys(b.slots.outputs)) if (b.slots.outputs[k].count > 0) this.map.pileAdd(b.x, b.y, k, b.slots.outputs[k].count);
    }
    this.sim.unregister(b);
    this.map.unregister(b);
    if (this.selection === b) this.selection = null;
    FG.Events.emit('building:removed', b);
  }

  setRecipe(b, rid) {
    b.recipe = rid || null;
    b.progress = 0;
    // 物料保留：不再需要的输入/输出槽不删除，残留物料可继续被机械臂运走；
    // 指向旧配方物品的在途预留标签由调度器在下一 tick 自动剥离（释放给其他产线）
    FG.Map.syncRecipeSlots(b);
    FG.Events.emit('recipe:change', b);
  }

  selectBuilding(b) { this.selection = b; FG.Events.emit('selection:change', b); }

  setSpeed(s) { this.speed = s; FG.Events.emit('speed:change', s); }
  togglePause() { this.paused = !this.paused; FG.Events.emit('pause:change', this.paused); }

  // ================= 科研 =================
  startResearch(id) { return this.research.start(id); }
  cancelResearch() { this.research.cancel(); }

  // ================= 消息 =================
  logMsg(text, cls) {
    this.log.push({ t: Date.now(), text, cls: cls || 'info' });
    if (this.log.length > 200) this.log.shift();
    FG.Events.emit('message', { text, cls });
  }

  /** 盘点全图物品（每 1 秒刷新顶栏），含在途物品（传送带/机械臂手上/地面堆） */
  inventory() {
    const counts = {};
    const add = (id, n) => { if (id) counts[id] = (counts[id] || 0) + n; };
    for (const b of this.map.buildings.values()) {
      if (b.items) for (const it of b.items) add(it.type, 1);
      if (b.held) add(b.held.type, 1);
      if (b.chest) for (const s of b.chest) if (s.count > 0) add(s.type, s.count);
      if (b.slots) {
        for (const k of Object.keys(b.slots.inputs)) add(k, b.slots.inputs[k].count);
        for (const k of Object.keys(b.slots.outputs)) add(k, b.slots.outputs[k].count);
      }
    }
    for (const pile of this.map.piles.values()) for (const s of pile) add(s.type, s.count);
    return counts;
  }

  totalBuildings() { return this.map ? this.map.buildings.size : 0; }
};
