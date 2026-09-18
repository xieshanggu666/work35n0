/**
 * FG.Sim —— 仿真核心
 * 每 tick 依次处理：传送带 → 机械臂 → 流体生产 → 管道扩散 → 生产建筑 → 矿机 → 实验室
 * 物流模型：
 *  - 传送带物品带「进料侧」，直行/转弯/多路汇入共用同一套路径与间距规则；
 *  - 合流采用目标带轮转（round-robin）选择上游，统一解决抢料与一侧饿死；
 *  - 每个 tick 重置入口占用表，机械臂/合流共用 hasEntryRoom，统一处理拥堵与在途物品；
 *  - 机械臂支持筛选(filter)与「按下游缺料」(demandMode)取放。
 * 扩展方式：新增建筑类型时在此注册到对应列表并实现逻辑
 */
FG.Sim = class Sim {
  constructor() {
    this.game = null;
    this.belts = [];
    this.inserters = [];
    this.pipes = [];
    this.chests = [];
    this.fluidProducers = [];
    this.crafters = [];
    this.miners = [];
    this.labs = [];
    this.entryClaims = new Set(); // 本 tick 已被占用的带入口 key
    this.demandCache = new Map(); // 本 tick 的下游需求缓存 key -> Set|null
  }

  init(game) { this.game = game; }
  reset() {
    this.belts.length = 0; this.inserters.length = 0; this.pipes.length = 0;
    this.chests.length = 0; this.fluidProducers.length = 0; this.crafters.length = 0;
    this.miners.length = 0; this.labs.length = 0;
    this.entryClaims.clear(); this.demandCache.clear();
  }

  register(b) {
    const t = b.type;
    if (b.def.beltTier !== undefined) this.belts.push(b);
    else if (b.def.inserterTier !== undefined) this.inserters.push(b);
    else if (t === 'pipe') this.pipes.push(b);
    else if (t === 'chest') this.chests.push(b);
    else if (t === 'pump' || t === 'pumpjack') this.fluidProducers.push(b);
    else if (t === 'miner') this.miners.push(b);
    else if (t === 'lab') this.labs.push(b);
    else if (b.def.recipeBuilding) this.crafters.push(b);
  }

  unregister(b) {
    for (const arr of [this.belts, this.inserters, this.pipes, this.chests,
                       this.fluidProducers, this.crafters, this.miners, this.labs]) {
      const i = arr.indexOf(b);
      if (i >= 0) { arr.splice(i, 1); return; }
    }
  }

  // ================= 主循环 =================
  tick() {
    this.entryClaims.clear();
    this.demandCache.clear();
    this.moveBelts();
    this.updateInserters();
    this.updateFluidProducers();
    this.flowPipes();
    this.updateCrafters();
    this.updateMiners();
    this.updateLabs();
  }

  // ================= 传送带 =================
  moveBelts() {
    const SP = 1 / FG.Config.BELT_CAP;
    const EPS = 0.01;
    const m = this.game.map;

    // ---- 阶段 1：各带内部推进 + 间距压缩（直行与转弯路径统一处理） ----
    for (const b of this.belts) {
      if (!b.items.length) { b.status = 'idle'; continue; }
      const spd = b.def.beltSpeed;
      for (const it of b.items) it.pos += spd;
      b.items.sort((a, c) => beltArcLen(b, a) - beltArcLen(b, c));
      for (let k = b.items.length - 1; k >= 0; k--) {
        b.items[k].pos = Math.min(b.items[k].pos, 1);
        if (k < b.items.length - 1) {
          b.items[k].pos = Math.min(b.items[k].pos, b.items[k + 1].pos - SP);
        }
        if (b.items[k].pos < 0) b.items[k].pos = 0;
      }
    }

    // ---- 阶段 2：以目标带为中心的合流轮转（公平合流）+ 末端卸料 ----
    for (const dst of this.belts) {
      // 收集三条可汇入侧上的上游带
      const feeders = [];
      for (const side of [0, 2, 3]) {
        const sv = FG.Map.beltSideVec(dst.dir, side);
        const src = m.buildingAt(dst.x + sv.x, dst.y + sv.y);
        if (src && src.def.beltTier !== undefined && FG.Map.beltFeedsInto(src, dst)) feeders.push({ src, side });
      }
      if (feeders.length) {
        if (dst.rr >= feeders.length) dst.rr = 0;
        for (let n = 0; n < feeders.length; n++) {
          const idx = (dst.rr + n) % feeders.length;
          const { src, side } = feeders[idx];
          if (this.transferBelt(src, dst, side)) { dst.rr = (idx + 1) % feeders.length; break; }
        }
      }

      // 末端：箱子/地面堆直接卸料（非带目的地由机械臂处理）
      const head = dst.items.length ? dst.items[dst.items.length - 1] : null;
      if (head && head.pos >= 1 - EPS) {
        const v = FG.Utils.dirVec(dst.dir);
        const nx = dst.x + v.x, ny = dst.y + v.y;
        const next = m.buildingAt(nx, ny);
        if (next && next.def.beltTier === undefined) {
          if (next.type === 'chest') {
            if (this.chestAdd(next, head.type, 1)) dst.items.pop();
            else head.pos = 0.99;
          } else {
            head.pos = 0.99; // 生产/科研建筑需经机械臂放入
          }
        } else if (!next) {
          if (m.pileAt(nx, ny)) {
            // 已有地面堆时继续堆放（无堆则物品停在带端，避免凭空散落）
            const left = m.pileAdd(nx, ny, head.type, 1);
            if (left === 0) dst.items.pop();
            else head.pos = 0.99;
          } else {
            head.pos = 0.99;
          }
        }
      }

      // 状态：头部被堵住 → blocked；有物品流动 → working；空 → idle
      const h2 = dst.items.length ? dst.items[dst.items.length - 1] : null;
      dst.status = !h2 ? 'idle' : (h2.pos >= 1 - EPS && !this.canExit(dst, h2) ? 'blocked' : 'working');
    }
  }

  /** 尝试把 src 头部物品送入 dst 的 side 侧入口；成功返回 true（一个 tick 每带至多进 1 件） */
  transferBelt(src, dst, side) {
    const EPS = 0.01;
    if (!src.items.length) return false;
    const head = src.items[src.items.length - 1];
    if (head.pos < 1 - EPS) return false;
    if (!this.hasEntryRoom(dst)) return false;
    if (this.entryClaims.has(FG.Utils.key(dst.x, dst.y))) return false;
    this.entryClaims.add(FG.Utils.key(dst.x, dst.y));
    src.items.pop();
    dst.items.unshift({ type: head.type, pos: 0, from: side });
    return true;
  }

  /** 带端物品能否离开（进入下游带/箱子/地面堆，或空格） */
  canExit(b, head) {
    const v = FG.Utils.dirVec(b.dir);
    const nx = b.x + v.x, ny = b.y + v.y;
    const next = this.game.map.buildingAt(nx, ny);
    if (!next) return this.game.map.pileAt(nx, ny) !== null;
    if (next.def.beltTier !== undefined) {
      return FG.Map.beltEntrySide(next, b.x, b.y) >= 0 && this.hasEntryRoom(next);
    }
    if (next.type === 'chest') return this.chestCanAdd(next, head.type, 1);
    return false;
  }

  /** 带入口是否还有容纳空间（尾部间距），机械臂与合流共用，统一处理拥堵/在途物品 */
  hasEntryRoom(belt) {
    if (belt.items.length >= FG.Config.BELT_CAP) return false;
    const SP = 1 / FG.Config.BELT_CAP;
    for (const it of belt.items) if (it.pos < SP) return false;
    return true;
  }

  // ================= 机械臂 =================
  updateInserters() {
    for (const b of this.inserters) {
      b.timer--;
      if (b.held === null) {
        if (b.timer <= 0) {
          const item = this.pickSource(b);
          if (item) { b.held = item; b.timer = b.def.swingTime; b.status = 'working'; }
          else { b.timer = b.def.swingTime; b.status = 'idle'; }
        }
      } else if (b.timer <= 0) {
        if (this.dropHeld(b)) { b.held = null; b.timer = 4; b.status = 'working'; }
        else { b.timer = 4; b.status = 'blocked'; } // 目标满/不接受：在手中等待
      }
    }
  }

  /** 当前允许抓取的物品类型集合：null=不限，空集=都不抓，Set=白名单 */
  inserterWanted(b) {
    let want = null;
    if (b.filter) want = new Set([b.filter]);
    if (b.demandMode) {
      const v = FG.Utils.dirVec(b.dir);
      const range = b.def.range || 1;
      const demand = this.demandAt(b.x + v.x * range, b.y + v.y * range);
      if (demand === null) return want;          // 下游无需求概念（箱子/空地）：按筛选执行
      if (want) { for (const t of Array.from(want)) if (!demand.has(t)) want.delete(t); }
      else want = new Set(demand);
    }
    return want;
  }

  /** 类型是否在白名单内（want=null 表示不限） */
  static wantedHas(want, type) { return want === null || want.has(type); }

  pickSource(b) {
    const v = FG.Utils.dirVec(b.dir);
    const range = b.def.range || 1;
    const m = this.game.map;
    const sx = b.x - v.x * range, sy = b.y - v.y * range;
    if (!m.inBounds(sx, sy)) return null;
    const s = m.buildingAt(sx, sy);
    const want = this.inserterWanted(b);
    const match = (t) => FG.Sim.wantedHas(want, t);

    if (s && s.def.beltTier !== undefined) {
      if (!s.items.length) return null;
      // 机械臂位于源带的哪一侧（range=1 才可抓带）
      const sideDir = dirFromTo(b.x, b.y, s.x, s.y);
      let best = -1, bestD = FG.Config.INSERTER_PICK_REACH;
      for (let i = 0; i < s.items.length; i++) {
        const it = s.items[i];
        if (!match(it.type)) continue;
        const d = FG.Map.beltPointToEdgeDist(s, it, sideDir);
        if (d <= bestD) { bestD = d; best = i; }
      }
      if (best < 0) return null;
      return { type: s.items.splice(best, 1)[0].type };
    }
    if (s && s.type === 'chest') {
      for (const slot of s.chest) {
        if (slot.count > 0 && match(slot.type)) { slot.count--; return { type: slot.type }; }
      }
      return null;
    }
    // 地面物料堆（建筑被拆除后的保留物料）
    const pile = m.pileAt(sx, sy);
    if (pile) {
      const type = m.pileTake(sx, sy, want ? pickWantedType(want, pile) : null);
      return type ? { type } : null;
    }
    if (s) {
      // 优先取产物，其次取与当前配方无关的残留输入（拆换配方后保留的物料仍可被运走）
      const outs = s.slots && s.slots.outputs;
      if (outs) {
        for (const k of Object.keys(outs)) {
          if (outs[k].count >= 1 && match(k)) { outs[k].count--; return { type: k }; }
        }
      }
      const ins = s.slots && s.slots.inputs;
      if (ins) {
        const recipe = s.recipe ? FG.Recipes.byId(s.recipe) : null;
        const needed = new Set(recipe ? recipe.ingredients.filter(i => !FG.Items.isFluid(i.item)).map(i => i.item) : []);
        for (const k of Object.keys(ins)) {
          if (ins[k].count >= 1 && match(k) && !needed.has(k)) { ins[k].count--; return { type: k }; }
        }
      }
    }
    return null;
  }

  dropHeld(b) {
    const v = FG.Utils.dirVec(b.dir);
    const range = b.def.range || 1;
    const m = this.game.map;
    const tx = b.x + v.x * range, ty = b.y + v.y * range;
    if (!m.inBounds(tx, ty)) return false;
    const t = m.buildingAt(tx, ty);
    const type = b.held.type;
    if (t && t.def.beltTier !== undefined) {
      if (range !== 1) return false;
      const side = FG.Map.beltEntrySide(t, b.x, b.y);
      if (side < 0) return false;                 // 正面顶头不可放入
      if (!this.hasEntryRoom(t)) return false;
      if (this.entryClaims.has(FG.Utils.key(tx, ty))) return false;
      this.entryClaims.add(FG.Utils.key(tx, ty));
      t.items.unshift({ type, pos: 0, from: side });
      return true;
    }
    if (t && t.type === 'chest') return this.chestAdd(t, type, 1);
    // 放到地面堆（无建筑时只有该格已有堆才继续堆放，避免误洒）
    if (!t && m.pileAt(tx, ty)) {
      return m.pileAdd(tx, ty, type, 1) === 0;
    }
    if (t) {
      const ins = t.slots && t.slots.inputs;
      if (ins && ins[type]) {
        if (ins[type].count < ins[type].cap) { ins[type].count++; return true; }
      }
    }
    return false;
  }

  chestCanAdd(chest, type, n) {
    for (const slot of chest.chest) {
      if (slot.type === type && slot.count + n <= slot.cap) return true;
    }
    return chest.chest.some(slot => slot.count === 0);
  }

  chestAdd(chest, type, n) {
    for (const slot of chest.chest) {
      if (slot.type === type && slot.count + n <= slot.cap) { slot.count += n; return true; }
    }
    for (const slot of chest.chest) {
      if (slot.count === 0) { slot.type = type; slot.count = n; return true; }
    }
    return false;
  }

  // ================= 下游需求分析（机械臂「按需供给」） =================
  /**
   * 目标格当前需要哪些固体物品：
   *  null  = 无需求概念（箱子/空地/地面堆），按需模式不拦截
   *  Set   = 需要的物品白名单（可为空集=暂不缺料）
   */
  demandAt(x, y) {
    const m = this.game.map;
    if (!m.inBounds(x, y)) return new Set();
    const k = FG.Utils.key(x, y);
    if (this.demandCache.has(k)) return this.demandCache.get(k);
    let demand;
    const b = m.buildingAt(x, y);
    if (!b) demand = m.pileAt(x, y) ? null : new Set();
    else if (b.type === 'chest') demand = null;
    else if (b.def.beltTier !== undefined) demand = this.beltDemand(b, new Set([k]), 0);
    else if (b.def.recipeBuilding) demand = this.buildingDemand(b);
    else if (b.type === 'lab') demand = this.labDemand(b);
    else demand = new Set();
    this.demandCache.set(k, demand);
    return demand;
  }

  /** 沿传送带向下游追踪，汇总末端消费者/从该带取料机械臂的需求 */
  beltDemand(belt, seen, depth) {
    if (depth >= FG.Config.BELT_TRACE_DEPTH) return new Set();
    const m = this.game.map;
    const v = FG.Utils.dirVec(belt.dir);
    const nx = belt.x + v.x, ny = belt.y + v.y;
    const out = new Set();

    // 从该带任意侧抓取的机械臂：它们把物品送入哪里，就需要什么
    for (const ins of this.inserters) {
      const iv = FG.Utils.dirVec(ins.dir);
      const r = ins.def.range || 1;
      // 源格 = 臂位置 - 朝向×range（与 pickSource 一致），源恰为本带任意相邻位
      const srcX = ins.x - iv.x * r, srcY = ins.y - iv.y * r;
      if (srcX === belt.x && srcY === belt.y) {
        const d = this.demandAt(ins.x + iv.x * r, ins.y + iv.y * r);
        if (d) {
          let list = d;
          if (ins.filter) list = d.has(ins.filter) ? new Set([ins.filter]) : new Set();
          for (const t of list) out.add(t);
        }
      }
    }

    const next = m.buildingAt(nx, ny);
    if (next && next.def.beltTier !== undefined && FG.Map.beltEntrySide(next, belt.x, belt.y) >= 0) {
      const nk = FG.Utils.key(nx, ny);
      if (!seen.has(nk)) { seen.add(nk); for (const t of this.beltDemand(next, seen, depth + 1)) out.add(t); }
    } else if (next && next.def.recipeBuilding) {
      for (const t of this.buildingDemand(next)) out.add(t);
    } else if (next && next.type === 'lab') {
      for (const t of this.labDemand(next)) out.add(t);
    } else if (next && next.type === 'chest') {
      return null; // 终端箱子什么都收
    } else if (!next && m.pileAt(nx, ny)) {
      return null;
    }
    return out;
  }

  /** 生产建筑缺料集合：按当前配方保留约 2 轮份的缓冲 */
  buildingDemand(b) {
    if (!b.recipe) return new Set();
    if (!this.game.research.isRecipeUnlocked(b.recipe)) return new Set();
    const r = FG.Recipes.byId(b.recipe);
    const out = new Set();
    for (const ing of r.ingredients) {
      if (FG.Items.isFluid(ing.item)) continue;
      const s = b.slots.inputs[ing.item];
      const have = s ? s.count : 0;
      if (have < ing.count * 2) out.add(ing.item);
    }
    return out;
  }

  /** 实验室缺料集合：缓冲约 1 个消耗周期（10） */
  labDemand(b) {
    const tech = this.game.research.current;
    if (!tech) return new Set();
    const out = new Set();
    for (const pack of Object.keys(tech.cost)) {
      const s = b.slots.inputs[pack];
      if (!s || s.count < 10) out.add(pack);
    }
    return out;
  }

  // ================= 流体生产（水泵/抽油机） =================
  updateFluidProducers() {
    for (const b of this.fluidProducers) {
      const item = b.type === 'pump' ? 'water' : 'crudeOil';
      const cap = FG.Config.FLUID_TANK_CAP;
      const tank = b.fluidTanks[item] || 0;
      if (tank < cap) b.fluidTanks[item] = Math.min(cap, tank + b.def.fluidRate / FG.Config.TPS);
      const sent = this.pushFluid(b, item);
      b.status = (sent === 0 && (b.fluidTanks[item] || 0) >= cap - 0.1) ? 'blocked' : 'working';
    }
  }

  /** 将建筑流体缓冲罐推入相邻管道 */
  pushFluid(b, item) {
    const cap = FG.Config.FLUID_PIPE_CAP;
    let sent = 0;
    for (const v of FG.Utils.dirs) {
      if (sent >= 0.5) break;
      const nb = this.game.map.buildingAt(b.x + v.x, b.y + v.y);
      if (nb && nb.type === 'pipe' && nb.level < cap - 0.5) {
        const take = Math.min(b.fluidTanks[item] || 0, cap - nb.level, 0.5);
        if (take > 0.01) {
          b.fluidTanks[item] -= take;
          nb.level += take;
          nb.fluidType = item;
          sent += take;
        }
      }
    }
    return sent;
  }

  /** 从相邻管道抽取流体 */
  drainFluid(b, item, want) {
    const cap = FG.Config.FLUID_PIPE_CAP;
    let got = 0;
    for (const v of FG.Utils.dirs) {
      if (got >= want - 0.001) break;
      const nb = this.game.map.buildingAt(b.x + v.x, b.y + v.y);
      if (nb && nb.type === 'pipe' && nb.level > 0.5 && (!nb.fluidType || nb.fluidType === item)) {
        const take = Math.min(nb.level, want - got, 0.5);
        nb.level -= take;
        got += take;
      }
    }
    return got;
  }

  // ================= 管道扩散 =================
  flowPipes() {
    const k = 0.12;
    const moves = [];
    for (const p of this.pipes) {
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const nb = this.game.map.buildingAt(p.x + dx, p.y + dy);
        if (nb && nb.type === 'pipe') {
          const d = (p.level - nb.level) * k;
          if (Math.abs(d) > 0.005) moves.push([p, nb, d]);
        }
      }
    }
    for (const [a, b, d] of moves) {
      const cap = FG.Config.FLUID_PIPE_CAP;
      const oldA = a.fluidType;
      a.level = Math.max(0, Math.min(cap, a.level - d));
      b.level = Math.max(0, Math.min(cap, b.level + d));
      if (a.level > 0.01 && oldA) b.fluidType = oldA;
    }
  }

  // ================= 生产建筑 =================
  updateCrafters() {
    for (const b of this.crafters) {
      const recipe = b.recipe ? FG.Recipes.byId(b.recipe) : null;
      if (!recipe) { b.status = 'idle'; b.progress = 0; continue; }
      if (!this.game.research.isRecipeUnlocked(recipe.id)) { b.status = 'idle'; b.progress = 0; continue; }
      this.craftTick(b, recipe);
    }
  }

  craftTick(b, recipe) {
    const stats = this.game.stats;
    const def = b.def;

    // 1. 流体原料：从管道按 tick 均摊吸取
    let fluidOK = true;
    for (const ing of recipe.ingredients.filter(i => FG.Items.isFluid(i.item))) {
      const have = b.fluidTanks[ing.item] || 0;
      const want = Math.min(ing.count * 1.5 - have, ing.count / recipe.time);
      let got = 0;
      if (want > 0.001) got = this.drainFluid(b, ing.item, want);
      b.fluidTanks[ing.item] = Math.min(FG.Config.FLUID_TANK_CAP, have + got);
      stats.recordConsume(ing.item, got);
      if ((b.fluidTanks[ing.item] || 0) < ing.count) fluidOK = false;
    }

    // 2. 固体原料检查（残留输入槽不参与，切换配方后物料保留且不阻塞生产）
    let solidOK = true;
    for (const ing of recipe.ingredients.filter(i => !FG.Items.isFluid(i.item))) {
      const s = b.slots.inputs[ing.item];
      if (!s || s.count < ing.count) solidOK = false;
    }

    // 3. 输出检查（堵塞）
    let blocked = false;
    for (const r of recipe.results) {
      if (FG.Items.isFluid(r.item)) {
        if ((b.fluidTanks[r.item] || 0) >= FG.Config.FLUID_TANK_CAP * 0.9) blocked = true;
      } else {
        const s = b.slots.outputs[r.item] || (b.slots.outputs[r.item] = { count: 0, cap: FG.Config.SLOT_CAP });
        if (s.count >= s.cap) blocked = true;
      }
    }

    if (blocked) {
      const out = recipe.results.find(r => !FG.Items.isFluid(r.item));
      stats.mark('blocked', out ? out.item : null);
      b.status = 'blocked'; b.progress = 0;
      this.pushOutputs(b, recipe);
      return;
    }
    if (!solidOK || !fluidOK) {
      const miss = recipe.ingredients.find(i => {
        if (FG.Items.isFluid(i.item)) return (b.fluidTanks[i.item] || 0) < i.count;
        const s = b.slots.inputs[i.item];
        return !s || s.count < i.count;
      });
      stats.mark('starving', miss ? miss.item : null);
      b.status = 'starving'; b.progress = 0;
      this.pushOutputs(b, recipe);
      return;
    }

    // 4. 生产推进
    b.status = 'working';
    b.progress += def.craftSpeed || 1;
    if (b.progress >= recipe.time) {
      b.progress = 0;
      for (const ing of recipe.ingredients) {
        if (FG.Items.isFluid(ing.item)) {
          b.fluidTanks[ing.item] = Math.max(0, (b.fluidTanks[ing.item] || 0) - ing.count);
        } else {
          b.slots.inputs[ing.item].count -= ing.count;
          stats.recordConsume(ing.item, ing.count);
        }
      }
      for (const r of recipe.results) {
        if (FG.Items.isFluid(r.item)) {
          b.fluidTanks[r.item] = Math.min(FG.Config.FLUID_TANK_CAP, (b.fluidTanks[r.item] || 0) + r.count);
        } else {
          b.slots.outputs[r.item].count += r.count;
        }
        stats.recordProduce(r.item, r.count);
      }
      b.totalCrafted++;
    }
    this.pushOutputs(b, recipe);
  }

  /** 将流体产物持续推入管道 */
  pushOutputs(b, recipe) {
    for (const r of recipe.results) {
      if (FG.Items.isFluid(r.item) && (b.fluidTanks[r.item] || 0) > 0.01) {
        this.pushFluid(b, r.item);
      }
    }
  }

  // ================= 矿机 =================
  updateMiners() {
    const m = this.game.map;
    for (const b of this.miners) {
      const ore = m.ores[b.y][b.x];
      if (!ore || ore.amount <= 0) { b.status = 'empty'; b.progress = 0; b.oreType = null; continue; }
      b.oreType = ore.type;
      const out = b.slots.outputs[ore.type] || (b.slots.outputs[ore.type] = { count: 0, cap: FG.Config.SLOT_CAP });
      if (out.count >= out.cap) {
        this.game.stats.mark('blocked', ore.type);
        b.status = 'blocked'; b.progress = 0; continue;
      }
      b.status = 'working';
      b.progress++;
      if (b.progress >= 20) {
        b.progress = 0;
        out.count++;
        ore.amount -= 2;
        this.game.stats.recordProduce(ore.type, 1);
        b.totalCrafted++;
      }
    }
  }

  // ================= 实验室 =================
  updateLabs() {
    const mgr = this.game.research;
    for (const b of this.labs) {
      const tech = mgr.current;
      if (!tech) { b.status = 'idle'; b.consumeCounter = 0; continue; }
      b.consumeCounter++;
      if (b.consumeCounter < 10) { b.status = 'working'; continue; }
      b.consumeCounter = 0;
      let ok = true;
      for (const pack of Object.keys(tech.cost)) {
        const s = b.slots.inputs[pack];
        if (!s || s.count < 1) { ok = false; break; }
      }
      if (!ok) {
        const miss = Object.keys(tech.cost).find(p => !b.slots.inputs[p] || b.slots.inputs[p].count < 1);
        this.game.stats.mark('starving', miss);
        b.status = 'starving'; continue;
      }
      for (const pack of Object.keys(tech.cost)) {
        b.slots.inputs[pack].count--;
        this.game.stats.recordConsume(pack, 1);
        mgr.addPoints(pack, 1);
      }
      b.status = 'working';
    }
  }
};

// ================= 模块级几何辅助 =================
/** 物品在带路径上的弧长参数：直行=pos；转弯折线两段各 0.5，总长 1 */
function beltArcLen(belt, item) {
  if (!item.from) return item.pos;
  const pts = FG.Map.beltPath(belt, item.from);
  const p = FG.Map.beltPoint(belt, item);
  if (item.pos < 0.5) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y);
  const d0 = Math.hypot(0.5 - pts[0].x, 0.5 - pts[0].y);
  return d0 + Math.hypot(p.x - 0.5, p.y - 0.5);
}

/** 从 (fx,fy) 指向 (tx,ty) 的方向索引（相邻格） */
function dirFromTo(fx, fy, tx, ty) {
  const dx = Math.sign(tx - fx), dy = Math.sign(ty - fy);
  for (let d = 0; d < 4; d++) {
    const v = FG.Utils.dirVec(d);
    if (v.x === dx && v.y === dy) return d;
  }
  return 0;
}

/** 从地面堆中挑选白名单内第一种物品 */
function pickWantedType(want, pile) {
  for (const s of pile) if (s.count > 0 && want.has(s.type)) return s.type;
  return null;
}
