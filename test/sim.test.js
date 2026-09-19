/**
 * 无头仿真测试：node test/sim.test.js
 * 加载全部数据/核心/逻辑脚本（跳过 UI），验证物流迭代项
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
global.window = global;
global.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] !== undefined ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};

const files = [
  'js/core/config.js', 'js/core/utils.js',
  'js/data/items.js', 'js/data/recipes.js', 'js/data/buildings.js',
  'js/data/research.js', 'js/data/maps.js',
  'js/game/map.js', 'js/game/sim.js', 'js/game/researchmgr.js',
  'js/game/stats.js', 'js/game/save.js', 'js/game/game.js',
];
for (const f of files) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
}

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗ FAIL:', msg); }
}
function ticks(g, n) { for (let i = 0; i < n; i++) g.tickOnce(); }

const game = new FG.Game();
const gen = FG.Maps.generate(FG.Maps.getPreset('greenfield'), 12345, 'medium');
game.startWithMap(gen, null, 'test');
const m = game.map, sim = game.sim;

function place(type, x, y, dir) {
  const b = FG.Map.create(type, x, y, dir || 0);
  m.register(b); sim.register(b);
  return b;
}
function remove(b) { sim.unregister(b); m.unregister(b); }
function fillBelt(b, type) {
  b.items.length = 0;
  for (let i = 0; i < FG.Config.BELT_CAP; i++) b.items.push({ type, pos: 1 - i * 0.25, from: 0 });
}
function chestCount(b, type) {
  const s = b.chest.find(x => x.type === type);
  return s ? s.count : 0;
}
function pileCountAt(x, y, type) {
  const p = m.pileAt(x, y);
  if (!p) return 0;
  const s = p.find(x => x.type === type);
  return s ? s.count : 0;
}
function beltCount(b, t) { return b.items.filter(i => i.type === t).length; }
function shallowGen() {
  return {
    presetId: 'greenfield', biome: 'grass', w: gen.w, h: gen.h, seed: 1, sizeId: 'medium',
    terrain: gen.terrain,
    ores: gen.ores.map(row => row.map(c => c ? { type: c.type, amount: c.amount } : null)),
    water: gen.water, oil: gen.oil,
  };
}

console.log('\n[1] 传送带转弯 + 侧入合流：物品沿折线走通');
{
  const b1 = place('belt', 5, 5, 1);   // 向东
  const b2 = place('belt', 6, 5, 0);   // 向北（b1 从右侧转弯汇入）
  const b3 = place('belt', 6, 4, 1);   // 向东接走
  const chest = place('chest', 7, 4);
  fillBelt(b1, 'ironOre');
  ok(FG.Map.beltFeedsInto(b1, b2), 'b1 允许汇入 b2');
  ok(FG.Map.beltEntrySide(b2, 5, 5) === 2, '西向汇入边识别正确（side=2）');
  ticks(game, 400);
  ok(chestCount(chest, 'ironOre') > 0, '物品经转弯带送达末端箱子（' + chestCount(chest, 'ironOre') + ' 件）');
  const total = b1.items.length + b2.items.length + b3.items.length
    + chest.chest.reduce((n, s) => n + s.count, 0);
  ok(total === 4, '转弯全程物品守恒（4 件，实际 ' + total + '）');
}

console.log('\n[2] 多路汇入：轮转公平合流，一侧不会被饿死');
{
  const feedBack = place('belt', 8, 10, 1);  // 背部直入 dst
  const feedSide = place('belt', 9, 11, 0);  // 侧入 dst（向北）
  const dst = place('belt', 9, 10, 1);       // 向东
  const tail = place('belt', 10, 10, 1);
  const chest = place('chest', 11, 10);
  fillBelt(feedBack, 'ironOre');
  fillBelt(feedSide, 'coal');
  ticks(game, 500);
  const nOre = chestCount(chest, 'ironOre'), nCoal = chestCount(chest, 'coal');
  console.log('    合流结果：铁矿', nOre, '煤', nCoal);
  ok(nOre > 0 && nCoal > 0, '两路都通过（无一侧饿死）');
  ok(Math.abs(nOre - nCoal) <= 2, '两路流量均衡（轮转）');
  const total = nOre + nCoal + feedBack.items.length + feedSide.items.length
    + dst.items.length + tail.items.length;
  ok(total === 8, '合流全程物品守恒（8 件，实际 ' + total + '）');
}

console.log('\n[3] 拥堵：封闭端堵满后状态 blocked，物品不丢不增');
{
  const b1 = place('belt', 15, 15, 1);
  const b2 = place('belt', 16, 15, 1); // 前端(17,15)为空
  fillBelt(b1, 'stone');
  ticks(game, 300);
  const total = b1.items.length + b2.items.length;
  ok(total === 4, '封闭端物品守恒（4 件，实际 ' + total + '）');
  ok(b2.status === 'blocked' && b2.items.length === FG.Config.BELT_CAP, '最前端堵点 blocked 且装满（b2=' + b2.status + '）');
  const b3 = place('chest', 17, 15);
  ticks(game, 200);
  ok(chestCount(b3, 'stone') > 0, '打通后堵塞解除、物品继续流动');
}

console.log('\n[4] 机械臂筛选条件');
{
  const chest = place('chest', 20, 20);
  sim.chestAdd(chest, 'ironOre', 20);
  sim.chestAdd(chest, 'copperOre', 20);
  const arm = place('inserter', 21, 20, 1);   // 朝东：箱子(20,20)→箱子(22,20)
  const out = place('chest', 22, 20);
  arm.filter = 'ironOre';
  ticks(game, 300);
  ok(chestCount(out, 'ironOre') > 0, '筛选物品被搬运（铁矿 ' + chestCount(out, 'ironOre') + '）');
  ok(chestCount(out, 'copperOre') === 0, '未筛选物品不搬运（铜矿 0）');
}

console.log('\n[5] 机械臂按下游缺料取放（需求驱动）');
{
  // 供应链：箱子(30,25) →臂A(31,25)朝东→ 带(32,25)→(33,25)
  // (33,25)为向南转弯带，接到 (33,26)
  // 臂B(33,27)朝南(dir=2)：源=身后(33,26)带，目标=面前(33,28)熔炉
  const chest = place('chest', 30, 25);
  sim.chestAdd(chest, 'ironOre', 30);
  sim.chestAdd(chest, 'copperOre', 30);
  const armA = place('inserter', 31, 25, 1);
  armA.demandMode = true;

  // 5a 死路：只铺到 (32,25)
  const belt0 = place('belt', 32, 25, 1);
  ticks(game, 80);
  ok(belt0.items.length === 0, '下游无消费者时不抓取（死路带保持空）');

  // 5b 延长：(33,25)为向南转弯带，再接南向带与熔炉
  const corner = place('belt', 33, 25, 2);
  const beltS = place('belt', 33, 26, 2);
  const furnace = place('furnace', 33, 28);
  furnace.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(furnace);
  const armB = place('inserter', 33, 27, 2); // 朝南：源(33,26)，目标(33,28)
  armB.demandMode = true;
  ticks(game, 300);
  const lineOre = beltCount(belt0, 'ironOre') + beltCount(corner, 'ironOre') + beltCount(beltS, 'ironOre');
  ok(furnace.totalCrafted > 0, '缺料时铁矿被沿带（含转弯）追踪并送入熔炉，持续冶炼（' + furnace.totalCrafted + ' 次）');
  // 在途预留联动：带面或臂B手中的铁矿应预留给该熔炉（resv=cid）
  let taggedOre = 0;
  for (const b of [belt0, corner, beltS]) for (const it of b.items) if (it.type === 'ironOre' && it.resv === furnace.cid) taggedOre++;
  if (armB.held && armB.held.type === 'ironOre' && armB.held.resv === furnace.cid) taggedOre++;
  ok(taggedOre > 0, '在途铁矿带熔炉预留标记（需求×在途预留联动，' + taggedOre + ' 件）');
  ok(furnace.slots.inputs.ironOre.count + lineOre <= 3,
    '在途+槽位仅保留约 1 轮份（' + (furnace.slots.inputs.ironOre.count + lineOre) + '），无过量供给');
  const copperOnLine = beltCount(belt0, 'copperOre') + beltCount(corner, 'copperOre')
    + beltCount(beltS, 'copperOre') + (furnace.slots.inputs.copperOre ? furnace.slots.inputs.copperOre.count : 0);
  ok(copperOnLine === 0, '下游不需要的铜矿不会被按需臂投放到线上');

  // 5c 需求门控：熔炉持续生产期间，铁矿按消耗补料，缓冲始终不超过 2 件（不堆积）
  furnace.slots.inputs.ironOre.count = 2;
  let overflow = 0;
  for (let i = 0; i < 200; i++) {
    game.tickOnce();
    if (furnace.slots.inputs.ironOre.count > 2) overflow++;
  }
  ok(overflow === 0, '持续生产时按缺料补充，缓冲始终 ≤2（无过量堆积）');
  ok(furnace.totalCrafted > 0, '熔炉正常完成冶炼（' + furnace.totalCrafted + ' 次）');
}


console.log('\n[6] 切换配方：物料保留、不阻塞生产、残留可被运走');
{
  const f = place('furnace', 40, 30);
  f.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(f);
  f.slots.inputs.ironOre.count = 5;
  game.setRecipe(f, 'smelt:copper');
  ok(f.slots.inputs.ironOre && f.slots.inputs.ironOre.count === 5, '旧配方铁矿槽保留');
  ok(!!f.slots.inputs.copperOre, '新配方铜矿槽建立');
  f.slots.inputs.copperOre.count = 3;
  ticks(game, 30);
  ok(f.status === 'working', '残留槽不阻塞新配方生产（状态=' + f.status + '）');
  const chest = place('chest', 42, 30);
  const arm = place('inserter', 41, 30, 1); // 朝东：源(40,30)熔炉 → (42,30)箱子
  ticks(game, 300);
  ok(chestCount(chest, 'ironOre') === 5, '残留铁矿全部运出（5 件，实际 ' + chestCount(chest, 'ironOre') + '）');
}

console.log('\n[7] 拆除建筑：物料落地；重建回收；在途物品不丢');
{
  const f = place('furnace', 50, 40);
  f.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(f);
  f.slots.inputs.ironOre.count = 7;
  f.slots.outputs.ironPlate.count = 4;
  game.removeBuilding(f);
  const pile = m.pileAt(50, 40);
  ok(!!pile, '拆除后出现地面物料堆');
  ok(pileCountAt(50, 40, 'ironOre') === 7 && pileCountAt(50, 40, 'ironPlate') === 4, '地面物料数量正确（7+4）');

  const belt = place('belt', 51, 40, 1);
  belt.items.push({ type: 'gear', pos: 0.4, from: 3 });
  game.removeBuilding(belt);
  ok(pileCountAt(51, 40, 'gear') === 1, '传送带上在途齿轮落地');

  const arm = place('inserter', 52, 40, 1);
  arm.held = { type: 'circuit' };
  game.removeBuilding(arm);
  ok(pileCountAt(52, 40, 'circuit') === 1, '机械臂手中物品落地');

  const chest = FG.Map.create('chest', 50, 40, 0);
  m.register(chest); sim.register(chest);
  game.absorbPile(chest);
  const got = chest.chest.reduce((n, s) => n + s.count, 0);
  ok(got === 11, '重建后回收全部物料（11 件，实际 ' + got + '）');
  ok(!m.pileAt(50, 40), '回收后地面堆清空');
}

console.log('\n[8] 存档恢复：全部调度状态随存档还原');
{
  const g2 = new FG.Game();
  g2.startWithMap(shallowGen(), null, 'save-test');
  const belt = FG.Map.create('belt', 3, 3, 1);
  belt.items.push({ type: 'circuit', pos: 0.42, from: 3 });
  belt.rr = 2; belt.status = 'working';
  const ins = FG.Map.create('fastInserter', 4, 3, 0);
  ins.filter = 'gear'; ins.demandMode = true; ins.held = { type: 'gear' }; ins.timer = 3;
  const pipe = FG.Map.create('pipe', 5, 3, 0);
  pipe.level = 40; pipe.fluidType = 'water';
  for (const b of [belt, ins, pipe]) { g2.map.register(b); g2.sim.register(b); }
  g2.map.pileAdd(6, 6, 'coal', 9);

  const data = JSON.parse(JSON.stringify(g2.serialize()));
  const g3 = new FG.Game();
  g3.deserialize(data);

  const b3 = g3.map.buildingAt(3, 3);
  const i3 = g3.map.buildingAt(4, 3);
  const p3 = g3.map.buildingAt(5, 3);
  ok(b3.items.length === 1 && b3.items[0].type === 'circuit'
     && Math.abs(b3.items[0].pos - 0.42) < 1e-9 && b3.items[0].from === 3, '在途物品（类型/位置/进料侧）恢复');
  ok(b3.rr === 2, '合流轮转游标恢复');
  ok(i3.filter === 'gear' && i3.demandMode === true && i3.held.type === 'gear' && i3.timer === 3,
     '机械臂筛选/按需/手持/计时恢复');
  ok(Math.abs(p3.level - 40) < 1e-9 && p3.fluidType === 'water', '管道液位与流体类型恢复');
  const pile = g3.map.pileAt(6, 6);
  ok(pile && pile[0].type === 'coal' && pile[0].count === 9, '地面物料堆恢复');
  let err = null;
  try { ticks(g3, 30); } catch (e) { err = e; }
  ok(!err, '恢复后仿真正常推进' + (err ? '：' + err.stack : ''));
}


// 机械臂几何约定：dir0 北(取南/放北) dir1 东(取西/放东) dir2 南(取北/放南) dir3 西(取东/放西)
// 侧取公式：臂在带西侧一格朝西(dir3) → 源=带、目标=更西一格；臂在带东侧朝东(dir1) → 源=带、目标=更东。

console.log('\n[9] 环路：按需注入不循环堆积，带圈消费者可持续取料');
{
  // 2x2 环：(20,15)东→(21,15)→南(21,16)→西(20,16)→北回
  place('belt', 20, 15, 1); place('belt', 21, 15, 2);
  place('belt', 21, 16, 3); place('belt', 20, 16, 0);
  // 熔炉在环角(20,15)西侧：臂(19,15)朝西 → 源(20,15) 目标(18,15)
  const fur = place('furnace', 18, 15);
  fur.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(fur);
  const pull = place('inserter', 19, 15, 3); pull.demandMode = true;
  // 注入：箱子(20,13) 臂(20,14)朝南 → 源(20,13) 目标(20,15)
  const chest = place('chest', 20, 13);
  sim.chestAdd(chest, 'ironOre', 100);
  const inj = place('inserter', 20, 14, 2); inj.demandMode = true;

  let err = null, maxLine = 0, maxFur = 0;
  try {
    for (let i = 0; i < 1200; i++) {
      game.tickOnce();
      let n = 0;
      for (const c of [[20,15],[21,15],[21,16],[20,16]]) n += m.buildingAt(c[0], c[1]).items.length;
      if (n > maxLine) maxLine = n;
      if (fur.slots.inputs.ironOre.count > maxFur) maxFur = fur.slots.inputs.ironOre.count;
    }
  } catch (e) { err = e; }
  ok(!err, '环路 1200 tick 无异常、不死循环' + (err ? '：' + err.stack : ''));
  ok(fur.totalCrafted > 0, '环内铁矿被熔炉取走并冶炼（' + fur.totalCrafted + ' 次）');
  ok(maxFur <= 2, '熔炉缓冲不超过 2（峰值 ' + maxFur + '）');
  ok(maxLine <= 16, '环路在途不超过总带容（峰值 ' + maxLine + '/16）');
  ok(chestCount(chest, 'ironOre') > 50,
     '需求被在途覆盖后停止注入，绝大多数铁矿仍在箱内（剩 ' + chestCount(chest, 'ironOre') + '）');
}

console.log('\n[10] 多消费者争料：同级轮转公平，高优先级生产线先补');
{
  // 公共南北带：箱子(34,18) 臂(34,19)南→ 带(34,20)(34,21)(34,22)
  const chest = place('chest', 34, 18);
  sim.chestAdd(chest, 'ironOre', 400);
  const inj = place('inserter', 34, 19, 2); inj.demandMode = true;
  place('belt', 34, 20, 2); place('belt', 34, 21, 2); place('belt', 34, 22, 2);
  // 炉A 西侧：臂(33,21)朝西 → 源(34,21) 目标(32,21)
  const furA = place('furnace', 32, 21);
  furA.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(furA);
  const armA = place('inserter', 33, 21, 3); armA.demandMode = true;
  // 炉B 东侧：臂(35,21)朝东 → 源(34,21) 目标(36,21)
  const furB = place('furnace', 36, 21);
  furB.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(furB);
  const armB = place('inserter', 35, 21, 1); armB.demandMode = true;

  furA.priority = 1; furB.priority = 1;
  ticks(game, 400);
  console.log('    同级两炉产量：A', furA.totalCrafted, 'B', furB.totalCrafted);
  ok(furA.totalCrafted > 0 && furB.totalCrafted > 0, '同级两座熔炉都得到供料（无一侧饿死）');
  ok(Math.abs(furA.totalCrafted - furB.totalCrafted) <= 4,
     '同级产量接近（轮转公平，差 ' + Math.abs(furA.totalCrafted - furB.totalCrafted) + '）');

  furA.priority = 0; furB.priority = 2;
  const ba = furA.totalCrafted, bb = furB.totalCrafted;
  ticks(game, 600);
  const da = furA.totalCrafted - ba, db = furB.totalCrafted - bb;
  console.log('    提级后增量：A(高)', da, 'B(低)', db);
  ok(da > db, '高优先级生产线供料优先（高 ' + da + ' > 低 ' + db + '）');
}

console.log('\n[11] 配方切换：在途预留随新配方改判，按需臂改供新原料');
{
  // 直供：箱子(40,26) 臂(41,26)朝东 → 熔炉(42,26)
  const chest = place('chest', 40, 26);
  sim.chestAdd(chest, 'ironOre', 50);
  sim.chestAdd(chest, 'copperOre', 50);
  const arm = place('inserter', 41, 26, 1); arm.demandMode = true;
  const fur = place('furnace', 42, 26);
  fur.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(fur);
  ticks(game, 60);
  ok(fur.slots.inputs.ironOre.count > 0 || (arm.held && arm.held.type === 'ironOre'),
     '铁矿已被按需臂抓起/送入（切配方前）');

  game.setRecipe(fur, 'smelt:copper');
  const beforeCopper = fur.totalCrafted;
  let copperPeak = 0, ironAfter = fur.slots.inputs.ironOre.count;
  for (let i = 0; i < 500; i++) {
    game.tickOnce();
    if (fur.slots.inputs.copperOre) copperPeak = Math.max(copperPeak, fur.slots.inputs.copperOre.count);
  }
  const copperMade = fur.totalCrafted - beforeCopper;
  ok(copperMade > 0, '切换后按需臂改供新配方铜矿并即时冶炼（铜板 ' + copperMade + ' 次，铜矿缓冲峰值 ' + copperPeak + '）');
  ok(fur.totalCrafted > 0, '按铜板配方持续冶炼（' + fur.totalCrafted + ' 次）');
  ok(fur.slots.inputs.ironOre.count <= ironAfter + 1,
     '旧铁矿不再被按需供给线追加新矿（仅手中那一件转为残留，共 ' + fur.slots.inputs.ironOre.count + '）');
}

console.log('\n[12] 拆建：拆除消费者后预留释放，重建的新消费者接管在途');
{
  // 注入：箱子(46,24) 臂(46,25)朝南 → 带(46,26)东；炉在西侧 臂(45,26)朝西 → 源(46,26) 目标(44,26)
  const src = place('chest', 46, 24);
  sim.chestAdd(src, 'ironOre', 100);
  const inj = place('inserter', 46, 25, 2); inj.demandMode = true;
  const belt = place('belt', 46, 26, 1);
  const fur = place('furnace', 44, 26);
  fur.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(fur);
  const pull = place('inserter', 45, 26, 3); pull.demandMode = true;
  ticks(game, 200);
  ok(fur.totalCrafted > 0, '拆除前熔炉正常供料（' + fur.totalCrafted + '）');
  const oldCid = fur.cid;

  game.removeBuilding(pull);
  game.removeBuilding(fur);
  ticks(game, 2);
  let stale = 0;
  for (const bb of sim.belts) for (const it of bb.items) if (it.resv === oldCid) stale++;
  ok(stale === 0, '消费者拆除后其全部在途预留已释放');

  const fur2 = place('furnace', 44, 26);
  fur2.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(fur2);
  const pull2 = place('inserter', 45, 26, 3); pull2.demandMode = true;
  ticks(game, 500);
  ok(fur2.totalCrafted > 0, '新消费者接管带网并恢复供料（冶炼 ' + fur2.totalCrafted + ' 次）');
  let dangling = 0;
  for (const bb of sim.belts) for (const it of bb.items) {
    if (it.resv && !sim.buildingByCid(it.resv)) dangling++;
  }
  for (const ins of sim.inserters) if (ins.held && ins.held.resv && !sim.buildingByCid(ins.held.resv)) dangling++;
  ok(dangling === 0, '不存在悬空预留（全部指向现存消费者）');
}

console.log('\n[13] 直供多臂防重 + 多消费者争料优先级 + 守恒');
{
  // 稀缺料：一只箱子只有 2 铁矿，两侧两座熔炉各一条按需直供臂（A 高 / B 低）
  const chest = place('chest', 52, 30);
  sim.chestAdd(chest, 'ironOre', 2);
  const furA = place('furnace', 50, 30);
  furA.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(furA); furA.priority = 0;
  const armA = place('inserter', 51, 30, 3); armA.demandMode = true;
  const furB = place('furnace', 54, 30);
  furB.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(furB); furB.priority = 2;
  const armB = place('inserter', 53, 30, 1); armB.demandMode = true;
  ticks(game, 240);
  const plateA = furA.slots.outputs.ironPlate.count, plateB = furB.slots.outputs.ironPlate.count;
  const oreA = furA.slots.inputs.ironOre.count, oreB = furB.slots.inputs.ironOre.count;
  console.log('    2 铁矿稀缺分配：A(高) 铁板', plateA, '铁矿', oreA, '| B(低) 铁板', plateB, '铁矿', oreB);
  ok(plateA >= 2, '稀缺料优先满足高优先级生产线（高得 ' + plateA + ' 件铁板）');
  ok(plateB === 0 && oreB === 0, '料不足时低优先级一件不争抢（低得 0）');
  ok(oreA <= 2, '高优先级也不超量供料（槽位 ≤2）');
  const total = plateA + plateB + oreA + oreB + chestCount(chest, 'ironOre')
    + (armA.held ? 1 : 0) + (armB.held ? 1 : 0);
  ok(total === 2, '稀缺料分配全程守恒（2，实际 ' + total + '）');

  // 料变充裕：补到 8 矿，低优先级也应开工
  sim.chestAdd(chest, 'ironOre', 8);
  ticks(game, 400);
  ok(furB.totalCrafted > 0, '料源补充后低优先级生产线恢复供料（低冶炼 ' + furB.totalCrafted + ' 次）');
  ok(furA.slots.inputs.ironOre.count <= 2 && furB.slots.inputs.ironOre.count <= 2,
     '充裕料下两条直供臂也不会重复超量供料（槽位 ≤2）');
}

console.log('\n[14] 存档：预留/优先级随档恢复，且兼容无这些字段的旧存档');
{
  // ---- 14a 新字段完整往返（独立游戏，坐标在 56x40 内）----
  const g2 = new FG.Game();
  g2.startWithMap(shallowGen(), null, 'save-new');
  const furHi = FG.Map.create('furnace', 50, 34);
  furHi.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(furHi); furHi.priority = 0;
  const beltHi = FG.Map.create('belt', 51, 34, 1);
  beltHi.items.push({ type: 'ironOre', pos: 0.5, from: 0, resv: furHi.cid });
  const armHi = FG.Map.create('inserter', 49, 34, 1);
  armHi.demandMode = true; armHi.held = { type: 'ironOre', resv: furHi.cid };
  for (const b of [furHi, beltHi, armHi]) { g2.map.register(b); g2.sim.register(b); }
  const data = JSON.parse(JSON.stringify(g2.serialize()));
  const g3 = new FG.Game();
  g3.deserialize(data);
  const f3 = g3.map.buildingAt(50, 34), b3 = g3.map.buildingAt(51, 34), a3 = g3.map.buildingAt(49, 34);
  ok(f3.cid === furHi.cid && f3.priority === 0, '消费者 cid 与高优先级随档恢复');
  ok(b3.items[0].resv === furHi.cid, '带面在途预留归属随档恢复');
  ok(a3.held.resv === furHi.cid, '机械臂手中物品预留随档恢复');
  const nextNew = FG.Map.create('chest', 52, 34);
  ok(nextNew.cid !== furHi.cid, '新建筑 cid 不与存档内 cid 冲突');

  // ---- 14b 旧存档（1.1.0：无 cid/priority/resv）----
  const g4 = new FG.Game();
  g4.startWithMap(shallowGen(), null, 'legacy');
  // 箱子(40,36) 臂(41,36)朝东 → 熔炉(42,36)
  const oldChest = FG.Map.create('chest', 40, 36);
  const oldArm = FG.Map.create('inserter', 41, 36, 1);
  oldArm.demandMode = true;
  const oldFur = FG.Map.create('furnace', 42, 36);
  oldFur.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(oldFur);
  delete oldFur.cid; delete oldFur.priority;
  for (const b of [oldChest, oldArm, oldFur]) { g4.map.register(b); g4.sim.register(b); }
  g4.sim.chestAdd(oldChest, 'ironOre', 20);
  const raw = JSON.parse(JSON.stringify(g4.serialize()));
  for (const sb of raw.buildings) { delete sb.cid; delete sb.priority; }
  for (const sb of raw.buildings) for (const it of (sb.items || [])) delete it.resv;

  const g5 = new FG.Game();
  let err = null;
  try { g5.deserialize(raw); for (let i = 0; i < 400; i++) g5.tickOnce(); }
  catch (e) { err = e; }
  ok(!err, '旧存档读取并推进 400 tick 无异常' + (err ? '：' + err.stack : ''));
  const f5 = g5.map.buildingAt(42, 36);
  ok(typeof f5.cid === 'string' && f5.cid.length > 0 && f5.priority === 1,
     '旧建筑补登 cid 且默认普通优先级');
  ok(f5.totalCrafted > 0, '旧存档读入后按需调度立即恢复工作（冶炼 ' + f5.totalCrafted + ' 次）');
}

console.log('\n结果：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
