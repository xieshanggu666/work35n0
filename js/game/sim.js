/**
 * FG.Sim —— 仿真核心
 * 每 tick 依次处理：预留调度 → 传送带 → 机械臂 → 流体生产 → 管道扩散 → 生产建筑 → 矿机 → 实验室
 * 物流模型：
 *  - 传送带物品带「进料侧」，直行/转弯/多路汇入共用同一套路径与间距规则；
 *  - 合流采用目标带轮转（round-robin）选择上游，统一解决抢料与一侧饿死；
 *  - 每个 tick 重置入口占用表，机械臂/合流共用 hasEntryRoom，统一处理拥堵与在途物品；
 *  - 按需物流调度（FG.Sim#schedule）：
 *      1) 每个消费者（熔炉/组装机/实验室等）按当前配方算出「目标缓冲数量」；
 *      2) 槽内已有 + 带面/臂上「预留」(item.resv=cid) 抵作在途，得到净需求；
 *      3) 无主在途物品沿供料带反向追踪，按供料优先级（0 高 > 1 普通 > 2 低）预打标，
 *         同级轮转公平；多个消费者争料、环路、跨机械臂桥接由此统一裁决；
 *      4) 按需机械臂只搬运「净需求仍未被在途覆盖」的物品，从源头杜绝过量供给与环路循环堆积；
 *      5) 配方切换/拆建时预留自动释放或重判，读档后随物品一并恢复。
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
    // ---- 按需调度（每 tick 重建） ----
    this.armPlans = new Map();    // 机械臂 -> 取放计划 {dead,free,wanted,typeCid,beltRule}
    this.cDemand = new Map();     // cid -> Map(itemType -> {target,have,resv,need})
    this.feeders = new Map();     // cid -> Set(带key)：该消费者的机械臂供料带
    this.reachCache = new Map();  // 带key -> 正向可达消费者 cid 集合（本 tick）
    this.resvHeld = new Map();    // cid -> Map(type -> n)：直喂臂手中物品按消费者计（本 tick）
    this.schedRound = 0;          // 同级轮转基准（每 tick 自增）
    this._anyDemandArm = false;
  }

  init(game) { this.game = game; }
  reset() {
    this.belts.length = 0; this.inserters.length = 0; this.pipes.length = 0;
    this.chests.length = 0; this.fluidProducers.length = 0; this.crafters.length = 0;
    this.miners.length = 0; this.labs.length = 0;
    this.entryClaims.clear();
    this.armPlans.clear(); this.cDemand.clear(); this.feeders.clear();
    this.reachCache.clear(); this.resvHeld.clear();
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
    this.schedule();          // 按需调度：需求 × 在途预留联动（必须先于机械臂）
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
    dst.items.unshift({ type: head.type, pos: 0, from: side, resv: head.resv || null });
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

  /** 本 tick 该臂的取放计划（schedule 阶段生成；非按需臂/异常时返回 null） */
  planOf(b) { return this.armPlans.get(b) || null; }

  /**
   * 当前允许抓取的物品类型集合：null=不限，空集=都不抓，Set=白名单。
   * 非按需臂仅受 filter 约束；按需臂由 schedule 计划的净需求决定。
   */
  inserterWanted(b) {
    let want = null;
    if (b.filter) want = new Set([b.filter]);
    if (b.demandMode) {
      const plan = this.planOf(b);
      if (!plan) return want ? intersectWant(want, new Set()) : new Set();
      if (plan.free) return want;              // 终端箱子/空地：无需求概念，按筛选自由取放
      if (!plan.wanted.size) return want ? intersectWant(want, new Set()) : new Set();
      want = want ? intersectWant(want, plan.wanted) : new Set(plan.wanted);
    }
    return want;
  }

  /** 静态：类型是否在白名单内（want=null 表示不限） */
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
    // 取到物品后要盖的预留章：{typeCid}（直喂消费者）或 'belt'（注入带网，由带面调度打标）
    const stamp = b.demandMode ? this.resvStampForPick(b) : null;

    if (s && s.def.beltTier !== undefined) {
      if (!s.items.length) return null;
      if (b.demandMode && !this.armMayPickFromBelt(b, s)) return null;
      // 机械臂位于源带的哪一侧（range=1 才可抓带）
      const sideDir = dirFromTo(b.x, b.y, s.x, s.y);
      let best = -1, bestD = FG.Config.INSERTER_PICK_REACH;
      for (let i = 0; i < s.items.length; i++) {
        const it = s.items[i];
        if (!match(it.type)) continue;
        if (!this.beltItemPickable(b, it)) continue;
        const d = FG.Map.beltPointToEdgeDist(s, it, sideDir);
        if (d <= bestD) { bestD = d; best = i; }
      }
      if (best < 0) return null;
      const it = s.items.splice(best, 1)[0];
      return { type: it.type, resv: stamp ? this.pickResv(b, stamp, it.type, it.resv) : (it.resv || null) };
    }
    if (s && s.type === 'chest') {
      for (const slot of s.chest) {
        if (slot.count > 0 && match(slot.type)) {
          slot.count--;
          return { type: slot.type, resv: stamp ? this.pickResv(b, stamp, slot.type, null) : null };
        }
      }
      return null;
    }
    // 地面物料堆（建筑被拆除后的保留物料；堆里的物品不带预留）
    const pile = m.pileAt(sx, sy);
    if (pile) {
      const type = m.pileTake(sx, sy, want ? pickWantedType(want, pile) : null);
      return type ? { type, resv: stamp ? this.pickResv(b, stamp, type, null) : null } : null;
    }
    if (s) {
      // 优先取产物，其次取与当前配方无关的残留输入（拆换配方后保留的物料仍可被运走）
      const outs = s.slots && s.slots.outputs;
      if (outs) {
        for (const k of Object.keys(outs)) {
          if (outs[k].count >= 1 && match(k)) {
            outs[k].count--;
            return { type: k, resv: stamp ? this.pickResv(b, stamp, k, null) : null };
          }
        }
      }
      const ins = s.slots && s.slots.inputs;
      if (ins) {
        const recipe = s.recipe ? FG.Recipes.byId(s.recipe) : null;
        const needed = new Set(recipe ? recipe.ingredients.filter(i => !FG.Items.isFluid(i.item)).map(i => i.item) : []);
        for (const k of Object.keys(ins)) {
          if (ins[k].count >= 1 && match(k) && !needed.has(k)) {
            ins[k].count--;
            return { type: k, resv: stamp ? this.pickResv(b, stamp, k, null) : null };
          }
        }
      }
    }
    return null;
  }

  /** 按需臂计划里记录的抓取盖章方式 */
  resvStampForPick(b) {
    const plan = this.planOf(b);
    if (!plan) return null;
    return plan.typeCid ? { kind: 'consumer', cid: plan.typeCid } : { kind: 'belt' };
  }

  /** 决定抓到手上的物品最终 resv：
   *  直喂消费者 → 抓取即盖其 cid；注入带网 → 抓取时无章，上带后由调度打标（dropHeld 写 null） */
  pickResv(b, stamp, type, oldResv) {
    if (!stamp) return oldResv || null;
    if (stamp.kind === 'belt') return null;
    return stamp.cid;
  }

  /** 按需臂是否允许从该带取料（计划要求源格是带且在可达网内） */
  armMayPickFromBelt(b, belt) {
    const plan = this.planOf(b);
    return !!(plan && plan.beltRule && plan.beltRule.has(FG.Utils.key(belt.x, belt.y)));
  }

  /** 带面上的该物品能否被此按需臂取走：直喂消费者只能取打给自己标 / 无主且净需求未满足的物品 */
  beltItemPickable(b, it) {
    if (!b.demandMode) return true; // 普通臂不参与预留裁决
    const plan = this.planOf(b);
    if (!plan) return false;
    if (plan.typeCid) return it.resv === plan.typeCid;   // 直喂：只拿属于自己的
    // 注入带网：只取无主物品（有主的是别人的在途预留）
    return !it.resv;
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
      // 预留章随物品上带（直喂臂把物品交给带网后，章由本 tick 调度裁决是否保留）
      t.items.unshift({ type, pos: 0, from: side, resv: b.held.resv || null });
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
        if (ins[type].count < ins[type].cap) {
          if (b.demandMode) {
            // 仍在当前配方需求内：受目标缓冲门控；
            // 配方切换后手中旧料 / 失效预留：作为「残留料」放入残留槽（物料保留，不阻塞臂继续工作）
            if (!this.dropConsumerAccepts(b, t, type) && !this.dropConsumerResidual(b, t, type)) return false;
          }
          ins[type].count++; return true;
        }
      }
    }
    return false;
  }

  /** 直喂型按需臂向消费者槽位放入时的最终校验：槽位尚未达到目标缓冲（实时槽位判定，杜绝过量） */
  dropConsumerAccepts(b, consumer, type) {
    const plan = this.planOf(b);
    if (!plan) return false;
    if (plan.typeCid !== consumer.cid) return false;
    const dm = this.cDemand.get(consumer.cid);
    const d = dm && dm.get(type);
    if (!d) return false;
    const s = consumer.slots.inputs[type];
    const have = s ? s.count : 0;
    return have < d.target;
  }

  /** 是否允许作为「配方切换后的残留料」放入：消费者仍是计划目标，但该物品已不在当前配方需求里 */
  dropConsumerResidual(b, consumer, type) {
    const plan = this.planOf(b);
    if (!plan || plan.typeCid !== consumer.cid) return false;
    const dm = this.cDemand.get(consumer.cid);
    if (!dm) return false;
    return !dm.has(type); // 非当前配方固体原料 → 残留槽（syncRecipeSlots 未建槽则 ins[type] 不存在，自然放不下）
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

  // ================= 按需调度：需求数量 × 在途预留 =================
  /**
   * 每个 tick 先于机械臂执行：
   *  A. 建立「按需消费者」索引（所有被按需臂服务的熔炉/组装机/实验室）；
   *  B. 算每个消费者每种固体原料的 目标/已有/在途预留/净需求；
   *  C. 把无主在途物品沿供料带反向打标（优先级 0→1→2，同级轮转），环路用 visited 收敛；
   *  D. 为每条按需臂生成取放计划（白名单 / 直喂 cid / 注入带网规则）。
   */
  schedule() {
    this.armPlans.clear();
    this.cDemand.clear();
    this.feeders.clear();
    this.reachCache.clear();
    this.resvHeld = new Map();
    this._rotList = null;
    this._anyDemandArm = this.inserters.some(i => i.demandMode);
    if (!this._anyDemandArm) return;
    this.schedRound++;

    // A. 发现全部「按需消费者」：直喂目标 + 注入型臂落点带网正向可达的消费者
    const managed = new Set();
    const dropConsumers = new Map(); // 臂 -> 直喂消费者（可能为 null）
    const dropBelts = new Map();     // 臂 -> 落点带（可能为 null）
    for (const ins of this.inserters) {
      if (!ins.demandMode) continue;
      const { tx, ty } = this.insDropTile(ins);
      const c = this.consumerAt(tx, ty);
      const drop = !c ? this.game.map.buildingAt(tx, ty) : null;
      const dropBelt = drop && drop.def.beltTier !== undefined ? drop : null;
      dropConsumers.set(ins, c);
      dropBelts.set(ins, dropBelt);
      if (c) managed.add(c.cid);
      else if (dropBelt) {
        for (const cid of this.reachableConsumers(dropBelt, new Set([FG.Utils.key(dropBelt.x, dropBelt.y)]))) {
          managed.add(cid);
        }
      }
    }

    // B. 需求表 + 供料带索引（直喂臂的源带）
    for (const cid of managed) {
      const c = this.buildingByCid(cid);
      if (c) this.cDemand.set(cid, this.consumerDemand(c));
    }
    for (const ins of this.inserters) {
      if (!ins.demandMode) continue;
      const c = dropConsumers.get(ins);
      if (!c) continue;
      const src = this.insSourceBelt(ins);
      if (src) this.addFeeder(c.cid, src);
    }

    // 清理失效预留（消费者消失 / 配方切换）；统计打标前的有效预留
    this.reapReservations(managed);

    // C. 在途物品打标：按优先级分组，同级轮转（含饱和者在途的改判）
    this.allocateReservations(managed);
    // 物品会沿带流过 feeder 继续向下（岔路/死路），那些标签虽配方仍有效但物理上已不可达：
    // 释放它们，避免占住额度抑制源头注入（释放后若下游还有别的消费者，下一 tick 重新打标）。
    this.releaseUnreachableTags(managed);
    // 打标/改判/释放全部结束后，按带面真实标签重算计数，保证账物一致
    this.recountBeltResv();

    // D. 每条按需臂的取放计划
    for (const ins of this.inserters) {
      if (!ins.demandMode) continue;
      this.armPlans.set(ins, this.buildArmPlan(ins, dropConsumers.get(ins), dropBelts.get(ins)));
    }
    // E. 非带面直供臂（箱/建筑/地面堆→消费者）争用同一源格时，按优先级做数量分配：
    //    高优先级消费者的未覆盖缺口先占用源存量，低优先级只拿剩余（多个消费者争料）。
    this.allocateDirectGrants(dropConsumers);
  }

  /** 同优先级排序键（cid 稳定次序 + tick 轮转） */
  cidOrder(cid) {
    const c = this.buildingByCid(cid);
    return c ? (c.priority == null ? 1 : c.priority) : 1;
  }

  /** 为共享非带面源格的直供臂计算本 tick 实际可取的物品集合（grants） */
  allocateDirectGrants(dropConsumers) {
    // 源格 key -> [{ins,cid}]
    const groups = new Map();
    for (const ins of this.inserters) {
      if (!ins.demandMode) continue;
      const c = dropConsumers.get(ins);
      if (!c) continue;
      if (this.insSourceBelt(ins)) continue; // 带面源由预留打标裁决
      const t = this.insSourceTile(ins);
      if (!this.game.map.inBounds(t.x, t.y)) continue;
      const k = FG.Utils.key(t.x, t.y);
      let g = groups.get(k);
      if (!g) { g = []; groups.set(k, g); }
      g.push({ ins, cid: c.cid, tile: t });
    }
    for (const [, members] of groups) {
      if (members.length < 2) continue;
      // 源格各物品当前存量（箱/地面堆）
      const stock = (tile, type) => {
        const bld = this.game.map.buildingAt(tile.x, tile.y);
        if (bld && bld.type === 'chest') {
          const slot = bld.chest.find(s => s.type === type);
          return slot ? slot.count : 0;
        }
        const pile = this.game.map.pileAt(tile.x, tile.y);
        if (pile) { const s = pile.find(x => x.type === type); return s ? s.count : 0; }
        return 0;
      };
      const types = new Set();
      for (const { cid } of members) {
        const dm = this.cDemand.get(cid);
        if (dm) for (const t of dm.keys()) types.add(t);
      }
      for (const type of types) {
        // 参与分配者按优先级（同级 cid 轮转）排序
        const ordered = members
          .filter(({ cid }) => {
            const d = this.cDemand.get(cid) && this.cDemand.get(cid).get(type);
            return d && (d.need - this.heldCountFor(cid, type) > 0);
          })
          .sort((a, b) => (this.cidOrder(a.cid) - this.cidOrder(b.cid)) ||
            (this.rotCmp(a.cid, b.cid)));
        let available = stock(ordered[0] ? ordered[0].tile : members[0].tile, type);
        // 各臂已抓在手里、正送往各自消费者的也算已分配
        const heldByCid = new Map();
        for (const { cid } of members) heldByCid.set(cid, this.heldCountFor(cid, type));
        const granted = new Map(); // ins -> 件数（本拍计划允许抓取的数量上限）
        for (const { ins, cid } of ordered) {
          const d = this.cDemand.get(cid).get(type);
          const unmet = Math.max(0, d.need - (heldByCid.get(cid) || 0));
          const take = Math.min(unmet, available); // 臂每拍只抓 1 件，但额度可预占其手中周转
          if (take > 0) { granted.set(ins, take); available -= take; heldByCid.set(cid, (heldByCid.get(cid) || 0) + take); }
        }
        // 未分到额度的成员从计划白名单移除该类型；分到额度者保留（每拍实际仍只抓 1 件）
        for (const { ins } of members) {
          if (!granted.has(ins)) {
            const plan = this.armPlans.get(ins);
            if (plan) plan.wanted.delete(type);
          }
        }
      }
    }
  }

  /** 同级消费者轮转比较（随 tick 轮换起点，保证公平） */
  rotCmp(a, b) {
    const ra = this.rotRank(a), rb = this.rotRank(b);
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  }
  rotRank(cid) {
    if (!this._rotList) {
      this._rotList = Array.from(this.cDemand.keys()).sort();
      this._rotMap = new Map(this._rotList.map((c, i) => [c, i]));
    }
    const n = this._rotList.length || 1;
    const i = this._rotMap.get(cid) ?? 0;
    return (i - (this.schedRound % n) + n) % n;
  }

  /** 机械臂放置格（面前 range 格） */
  insDropTile(ins) {
    const v = FG.Utils.dirVec(ins.dir);
    const r = ins.def.range || 1;
    return { tx: ins.x + v.x * r, ty: ins.y + v.y * r };
  }

  /** 机械臂源格（身后 range 格）上的带，没有则 null */
  insSourceBelt(ins) {
    const t = this.insSourceTile(ins);
    const b = this.game.map.buildingAt(t.x, t.y);
    return b && b.def.beltTier !== undefined ? b : null;
  }

  /** 机械臂源格（身后 range 格）坐标 */
  insSourceTile(ins) {
    const v = FG.Utils.dirVec(ins.dir);
    const r = ins.def.range || 1;
    return { x: ins.x - v.x * r, y: ins.y - v.y * r };
  }

  /** 某臂本 tick 的直喂消费者（计划目标） */
  planConsumerOf(ins) {
    const { tx, ty } = this.insDropTile(ins);
    return this.consumerAt(tx, ty);
  }

  /** 该格是否是「消费者」（吃固体配方的建筑/实验室） */
  consumerAt(x, y) {
    const b = this.game.map.buildingAt(x, y);
    return b && (b.def.recipeBuilding || b.type === 'lab') ? b : null;
  }

  buildingByCid(cid) {
    for (const b of this.crafters) if (b.cid === cid) return b;
    for (const b of this.labs) if (b.cid === cid) return b;
    return null;
  }

  addFeeder(cid, belt) {
    let set = this.feeders.get(cid);
    if (!set) { set = new Set(); this.feeders.set(cid, set); }
    set.add(FG.Utils.key(belt.x, belt.y));
  }

  /** 消费者固体原料需求明细 Map(item -> {target,have,resv,need})；need 随调度递减可变 */
  consumerDemand(b) {
    const out = new Map();
    const add = (item, target) => {
      if (FG.Items.isFluid(item)) return;
      const s = b.slots.inputs[item];
      const have = s ? s.count : 0;
      out.set(item, { target, have, resv: 0, need: Math.max(0, target - have) });
    };
    if (b.type === 'lab') {
      const tech = this.game.research.current;
      if (tech) for (const pack of Object.keys(tech.cost)) add(pack, 10);
    } else if (b.recipe && this.game.research.isRecipeUnlocked(b.recipe)) {
      const r = FG.Recipes.byId(b.recipe);
      for (const ing of r.ingredients) add(ing.item, ing.count * 2);
    }
    return out;
  }

  /** 清理失效预留；统计各消费者当前有效的在途预留数量（带面 + 臂上） */
  reapReservations(managed) {
    // 失效条件：消费者消失，或配方切换后该物品不再是当前配方原料。
    // 注意：消费者槽位饱和时不释放其「够不到的上游在途」——那些物品物理上正流向它，
    // 一旦释放会在 feeder 上占堵且无法被重新打标（调度只给够得到的物品打标）。
    // 够得到的物品饱和后会被打给其他缺料消费者（allocateReservations 覆盖打标）。
    const valid = (cid, type) => {
      if (!managed.has(cid)) return false;
      const dm = this.cDemand.get(cid);
      return !!(dm && dm.has(type));
    };
    for (const belt of this.belts) {
      for (const it of belt.items) {
        if (it.resv && !valid(it.resv, it.type)) it.resv = null;
      }
    }
    for (const ins of this.inserters) {
      const h = ins.held;
      if (h && h.resv && !valid(h.resv, h.type)) h.resv = null;
    }
    // 统计（resvHeld 已在 schedule 开头清空）
    for (const belt of this.belts) {
      for (const it of belt.items) this.tallyResv(it.resv, it.type);
    }
    for (const ins of this.inserters) {
      if (ins.held) this.tallyResv(ins.held.resv, ins.held.type, this.resvHeld);
    }
  }

  tallyResv(cid, type, heldMap) {
    if (!cid) return;
    if (heldMap) {
      let mm = heldMap.get(cid);
      if (!mm) { mm = new Map(); heldMap.set(cid, mm); }
      mm.set(type, (mm.get(type) || 0) + 1);
      return;
    }
    const dm = this.cDemand.get(cid);
    const d = dm && dm.get(type);
    if (d) d.resv++;
  }

  /** 打标/改判结束后按带面真实标签重算每个消费者的在途预留计数（账物一致） */
  recountBeltResv() {
    for (const dm of this.cDemand.values()) for (const d of dm.values()) d.resv = 0;
    for (const belt of this.belts) {
      for (const it of belt.items) {
        if (!it.resv) continue;
        const dm = this.cDemand.get(it.resv);
        const d = dm && dm.get(it.type);
        if (d) d.resv++;
      }
    }
  }

  /**
   * 释放「物理上已无法到达消费者」的标签：
   * 物品沿带流过 feeder 进入岔路/死路后，标签虽配方有效但该臂永远抓不到它，
   * 不释放就会虚占在途额度、反向饿死注入。判定：带格须在该消费者某 feeder 的上游（含 feeder）。
   */
  releaseUnreachableTags(managed) {
    // 每个消费者的可达供料带集合（从全部 feeder 反向 BFS，与 tagFromFeeder 同构）
    const reachableBelts = new Map(); // cid -> Set(beltKey)
    const build = (cid) => {
      if (reachableBelts.has(cid)) return reachableBelts.get(cid);
      const set = new Set();
      reachableBelts.set(cid, set);
      const fset = this.feeders.get(cid);
      if (!fset) return set;
      const q = [];
      for (const fk of fset) {
        const [fx, fy] = fk.split(',').map(Number);
        const fb = this.game.map.buildingAt(fx, fy);
        if (fb && fb.def.beltTier !== undefined) { set.add(fk); q.push(fb); }
      }
      let guard = FG.Config.RESERVE_SCAN_BUDGET;
      while (q.length && guard-- > 0) {
        const belt = q.shift();
        for (const side of [0, 2, 3]) {
          const sv = FG.Map.beltSideVec(belt.dir, side);
          const pre = this.game.map.buildingAt(belt.x + sv.x, belt.y + sv.y);
          if (pre && pre.def.beltTier !== undefined && FG.Map.beltFeedsInto(pre, belt)) {
            const pk = FG.Utils.key(pre.x, pre.y);
            if (!set.has(pk)) { set.add(pk); q.push(pre); }
          }
        }
        for (const ins of this.inserters) {
          if (ins.demandMode) continue;
          const v = FG.Utils.dirVec(ins.dir);
          const r = ins.def.range || 1;
          if (ins.x + v.x * r !== belt.x || ins.y + v.y * r !== belt.y) continue;
          const src = this.game.map.buildingAt(ins.x - v.x * r, ins.y - v.y * r);
          if (src && src.def.beltTier !== undefined) {
            const sk = FG.Utils.key(src.x, src.y);
            if (!set.has(sk)) { set.add(sk); q.push(src); }
          }
        }
      }
      return set;
    };
    for (const cid of managed) build(cid);
    for (const belt of this.belts) {
      const bk = FG.Utils.key(belt.x, belt.y);
      for (const it of belt.items) {
        if (!it.resv || !managed.has(it.resv)) continue;
        const set = reachableBelts.get(it.resv);
        if (!set || !set.has(bk)) it.resv = null;
      }
    }
  }

  /** 直喂臂手中正送往该消费者的物品数（防止多条直供臂重复供料） */
  heldCountFor(cid, type) {
    const mm = this.resvHeld && this.resvHeld.get(cid);
    return mm ? (mm.get(type) || 0) : 0;
  }

  /** 在途无主物品按消费者优先级打标；高优先级消费者还可接收「够得到但原消费者已饱和」的在途 */
  allocateReservations(managed) {
    // 优先级 0/1/2，同级按 (cid 轮转序 + 稳定次序) 公平
    const tiers = [[], [], []];
    for (const cid of managed) {
      const b = this.buildingByCid(cid);
      if (!b) continue;
      tiers[Math.max(0, Math.min(2, b.priority || 1))].push(cid);
    }
    let budget = FG.Config.RESERVE_SCAN_BUDGET;
    for (const tier of tiers) {
      if (!tier.length) continue;
      // 轮转起点每 tick 轮换，避免固定排序饿死同优先级消费者
      const off = this.schedRound % tier.length;
      for (let n = 0; n < tier.length; n++) {
        const cid = tier[(off + n) % tier.length];
        const c = this.buildingByCid(cid);
        if (!c) continue;
        const fset = this.feeders.get(cid);
        if (!fset) continue;
        for (const fk of fset) {
          if (budget <= 0) return;
          budget = this.tagFromFeeder(cid, fk, budget);
        }
      }
    }
  }

  /** 从某条供料带向上游扫描，把无主且仍需的物品打给 cid；返回剩余预算 */
  tagFromFeeder(cid, feederKey, budget) {
    const dm = this.cDemand.get(cid);
    if (!dm) return budget;
    const [fx, fy] = feederKey.split(',').map(Number);
    const start = this.game.map.buildingAt(fx, fy);
    if (!start || start.def.beltTier === undefined) return budget;

    // BFS 向上游（物品流动的反方向）：前驱带 + 非按需桥接臂（普通臂会把物品原样搬过来）
    // 注意：只允许预留消费者的臂「实际够得到」的物品，否则远处在途被记账却抓不到，
    // 会反向抑制源头注入（缺料消费者永远补不齐缓冲）。
    const reachSidesOf = (belt) => {
      const sides = new Set();
      for (const ins of this.inserters) {
        if (!ins.demandMode) continue;
        const v = FG.Utils.dirVec(ins.dir);
        const r = ins.def.range || 1;
        if (ins.x - v.x * r !== belt.x || ins.y - v.y * r !== belt.y) continue;
        const c = this.consumerAt(ins.x + v.x * r, ins.y + v.y * r);
        if (!c || c.cid !== cid) continue;
        sides.add(dirFromTo(ins.x, ins.y, belt.x, belt.y));
      }
      return sides;
    };
    const itemReachable = (belt, it, sides) => {
      for (const sd of sides) {
        if (FG.Map.beltPointToEdgeDist(belt, it, sd) <= FG.Config.INSERTER_PICK_REACH) return true;
      }
      return false;
    };
    const visited = new Set([feederKey]);
    const queue = [{ belt: start, depth: 0 }];
    while (queue.length && budget-- > 0) {
      const { belt, depth } = queue.shift();
      if (depth >= FG.Config.BELT_TRACE_DEPTH) continue;

      // 供料带本带：只有消费者的臂够得到的物品才算在途预留（避免远处物品占额抑制注入）；
      // 更上游的带（depth>0）：物品尚在管道中必然流向 feeder，整条都可预留。
      const sides = depth === 0 ? reachSidesOf(belt) : null;
      for (let i = belt.items.length - 1; i >= 0; i--) {
        const it = belt.items[i];
        if (sides && !itemReachable(belt, it, sides)) continue;
        const d = dm.get(it.type);
        if (!d || d.need - d.resv <= 0) continue;
        if (it.resv === cid) continue;
        if (!it.resv) { it.resv = cid; d.resv++; continue; }
        // 已有他主预留：仅当本消费者的臂够得到（feeder 本带）且原主槽位已饱和时，
        // 才改判给当前缺料消费者（高优先级先分到，同级由外层轮转公平裁决）；
        // 上游管道里的他主预留保持粘性，避免抢注导致来回跳票。
        if (depth !== 0) continue;
        const odm = this.cDemand.get(it.resv);
        const od = odm && odm.get(it.type);
        if (od && od.have >= od.target) {
          if (od.resv > 0) od.resv--;
          it.resv = cid;
          d.resv++;
        }
      }

      // 前驱：可汇入本带的三条侧上的带
      for (const side of [0, 2, 3]) {
        const sv = FG.Map.beltSideVec(belt.dir, side);
        const pre = this.game.map.buildingAt(belt.x + sv.x, belt.y + sv.y);
        if (pre && pre.def.beltTier !== undefined && FG.Map.beltFeedsInto(pre, belt)) {
          const pk = FG.Utils.key(pre.x, pre.y);
          if (!visited.has(pk)) { visited.add(pk); queue.push({ belt: pre, depth: depth + 1 }); }
        }
      }
      // 桥接：非按需臂从另一条带抓到本带（它不认预留章，物品会原样过来）
      for (const ins of this.inserters) {
        if (ins.demandMode) continue; // 按需桥只搬运净需求物品，不参与在途抢料
        const v = FG.Utils.dirVec(ins.dir);
        const r = ins.def.range || 1;
        const tx2 = ins.x + v.x * r, ty2 = ins.y + v.y * r;
        if (tx2 !== belt.x || ty2 !== belt.y) continue;
        const src = this.game.map.buildingAt(ins.x - v.x * r, ins.y - v.y * r);
        if (src && src.def.beltTier !== undefined) {
          const sk = FG.Utils.key(src.x, src.y);
          if (!visited.has(sk)) { visited.add(sk); queue.push({ belt: src, depth: depth + 1 }); }
        }
      }
    }
    return budget;
  }

  /** 从某条带（含转弯/合流/非按需桥接）正向可达的按需消费者 cid 集合 */
  reachableConsumers(belt, seen) {
    const cached = this.reachCache.get(FG.Utils.key(belt.x, belt.y));
    if (cached) return cached;
    const out = new Set();
    const walk = (b, depth) => {
      if (depth > FG.Config.BELT_TRACE_DEPTH) return;
      const m = this.game.map;
      // 从该带侧取、直喂消费者的按需臂
      for (const ins of this.inserters) {
        if (!ins.demandMode) continue;
        const v = FG.Utils.dirVec(ins.dir);
        const r = ins.def.range || 1;
        if (ins.x - v.x * r === b.x && ins.y - v.y * r === b.y) {
          const c = this.consumerAt(ins.x + v.x * r, ins.y + v.y * r);
          if (c) out.add(c.cid);
        }
      }
      const v = FG.Utils.dirVec(b.dir);
      const nx = b.x + v.x, ny = b.y + v.y;
      const next = m.buildingAt(nx, ny);
      if (next && next.def.beltTier !== undefined && FG.Map.beltEntrySide(next, b.x, b.y) >= 0) {
        const nk = FG.Utils.key(nx, ny);
        if (!seen.has(nk)) { seen.add(nk); walk(next, depth + 1); }
      }
      // 非按需桥接臂把带面物品搬到另一条带：跨过去继续找
      for (const ins of this.inserters) {
        if (ins.demandMode) continue;
        const iv = FG.Utils.dirVec(ins.dir);
        const r = ins.def.range || 1;
        if (ins.x - iv.x * r !== b.x || ins.y - iv.y * r !== b.y) continue;
        const dst = m.buildingAt(ins.x + iv.x * r, ins.y + iv.y * r);
        if (dst && dst.def.beltTier !== undefined) {
          const dk = FG.Utils.key(dst.x, dst.y);
          if (!seen.has(dk)) { seen.add(dk); walk(dst, depth + 1); }
        }
      }
    };
    walk(belt, 0);
    this.reachCache.set(FG.Utils.key(belt.x, belt.y), out);
    return out;
  }

  /** 生成单条按需臂的取放计划 */
  buildArmPlan(ins, directC, dropBelt) {
    const wanted = new Set();
    let typeCid = null;
    let beltRule = null;

    // 直喂消费者（从带面/箱子取料直接喂入）：
    //  带面供料臂：只要消费者有物理缺口（need），就允许取走调度打给自己的在途预留；
    //    （打给本消费者的章本身就代表「该补这件」，无需再扣在途，否则自己的预留会饿死自己）
    //  箱/建筑/地面堆直供臂：按物理缺口 need 供料，避免与带面在途重复供给
    if (directC) {
      const srcBelt = this.insSourceBelt(ins);
      const dm = this.cDemand.get(directC.cid);
      if (dm) {
        for (const [type, d] of dm) {
          // 其他直喂臂手中正送往此消费者的物品（自己手中的那件不计——它正在放下的途中，
          // 允许它随后继续抓下一件保持流水线不空转）
          const heldOthers = Math.max(0, this.heldCountFor(directC.cid, type) -
            (ins.held && ins.held.resv === directC.cid && ins.held.type === type ? 1 : 0));
          // 非带面源的多消费者争料由 allocateDirectGrants 按优先级二次裁决（可能从 wanted 移除）
          if (d.need - heldOthers > 0) wanted.add(type);
        }
      }
      typeCid = directC.cid;
      beltRule = srcBelt ? new Set([FG.Utils.key(srcBelt.x, srcBelt.y)]) : null;
    } else if (dropBelt) {
      // 注入带网：只补足「尚未被在途预留覆盖」的缺口（need − resv − 其他注入臂手持）。
      // 物品无主上带，下一个 tick 起由带面调度按当前优先级/缺口打标；
      // 无缺口即不注入，环路因此不会循环堆积。
      const cids = this.reachableConsumers(dropBelt, new Set([FG.Utils.key(dropBelt.x, dropBelt.y)]));
      // 其他正把同类型物品注入该带网的臂（手中无主物品也算即将上线）
      const heldIntoNet = new Map(); // type -> n（不含本臂）
      for (const other of this.inserters) {
        if (other === ins || !other.demandMode || !other.held) continue;
        const ot = other.held;
        if (ot.resv) continue;
        const ot2 = this.insDropTile(other);
        const db = this.game.map.buildingAt(ot2.tx, ot2.ty);
        if (db && db.def.beltTier !== undefined) {
          const rc = this.reachableConsumers(db, new Set([FG.Utils.key(db.x, db.y)]));
          for (const cid of rc) if (cids.has(cid)) { heldIntoNet.set(ot.type, (heldIntoNet.get(ot.type) || 0) + 1); break; }
        }
      }
      for (const cid of cids) {
        const dm = this.cDemand.get(cid);
        if (!dm) continue;
        for (const [type, d] of dm) {
          const incoming = heldIntoNet.get(type) || 0;
          if (d.need - d.resv - incoming > 0) wanted.add(type);
        }
      }
      // 注入臂一律无主上带（抓取瞬间盖章可能因配方切换/优先级调整而过期）
      typeCid = null;
      beltRule = null; // 源可以是箱子/建筑/地面堆
    }
    return { wanted, typeCid, beltRule, free: !directC && !dropBelt };
  }

  /** 供 UI/判定使用：某按需臂面向终端（箱子/空地）时按 filter 自由取放 */
  armTerminalFree(b) {
    const plan = this.planOf(b);
    return !!(plan && plan.free);
  }

  /** 供 UI：按需臂当前净需求明细 [{item,need,resv,priority,cid}] */
  armDemandDetails(b) {
    if (!b.demandMode) return null;
    const plan = this.planOf(b);
    if (!plan) return null;
    if (plan.free) return [];
    const out = [];
    const { tx, ty } = this.insDropTile(b);
    const direct = this.consumerAt(tx, ty);
    let cids = [];
    if (direct) cids = [direct.cid];
    else {
      const drop = this.game.map.buildingAt(tx, ty);
      if (drop && drop.def.beltTier !== undefined) {
        cids = Array.from(this.reachableConsumers(drop, new Set([FG.Utils.key(drop.x, drop.y)])));
      }
    }
    for (const cid of cids) {
      const dm = this.cDemand.get(cid);
      if (!dm) continue;
      const c = this.buildingByCid(cid);
      for (const [item, d] of dm) {
        if (d.need > 0) out.push({ item, need: Math.max(0, d.need - d.resv), resv: d.resv, priority: c ? c.priority : 1, cid });
      }
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

/** 两个白名单取交集（null 表示不限） */
function intersectWant(a, b) {
  const out = new Set();
  for (const t of a) if (b.has(t)) out.add(t);
  return out;
}
