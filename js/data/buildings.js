/**
 * FG.Buildings —— 建筑定义注册表
 * 扩展方式：添加新条目即可；渲染图标在 renderer.js 的 drawBuilding 中按 type 分支
 */
FG.Buildings = (() => {
  const DEFS = {
    // ================= 采集 =================
    miner: {
      id: 'miner', name: '矿机', cat: 'extraction',
      desc: '放置在矿石矿脉上，自动采集对应矿石。需要机械臂取走产出。',
      unlockedBy: null, onTerrain: 'ore',
    },
    pump: {
      id: 'pump', name: '水泵', cat: 'extraction',
      desc: '放置在水域旁，将水抽入管道网络。',
      unlockedBy: null, onTerrain: 'water', fluid: true, fluidRate: 6,
    },
    pumpjack: {
      id: 'pumpjack', name: '抽油机', cat: 'extraction',
      desc: '放置在油田上，抽取原油到管道网络。',
      unlockedBy: 'oilProcessing', onTerrain: 'oil', fluid: true, fluidRate: 4,
    },

    // ================= 生产 =================
    furnace: {
      id: 'furnace', name: '石炉', cat: 'production',
      desc: '冶炼矿石为金属板。可切换配方。',
      unlockedBy: null, recipeBuilding: true, craftSpeed: 1,
    },
    steelFurnace: {
      id: 'steelFurnace', name: '钢炉', cat: 'production',
      desc: '冶炼速度 2 倍的高级熔炉。',
      unlockedBy: 'steelSmelting', recipeBuilding: true, recipeGroup: 'furnace', craftSpeed: 2,
    },
    assembler: {
      id: 'assembler', name: '组装机', cat: 'production',
      desc: '将零件组装为更高级的物品。可切换配方。',
      unlockedBy: null, recipeBuilding: true, craftSpeed: 1,
    },
    assembler2: {
      id: 'assembler2', name: '二级组装机', cat: 'production',
      desc: '组装速度 2 倍。',
      unlockedBy: 'advancedElectronics', recipeBuilding: true, recipeGroup: 'assembler', craftSpeed: 2,
    },
    chemPlant: {
      id: 'chemPlant', name: '化工厂', cat: 'production',
      desc: '处理含流体的复杂配方（固体+流体）。',
      unlockedBy: 'chemicalScience', recipeBuilding: true, craftSpeed: 1, fluid: true,
    },
    refinery: {
      id: 'refinery', name: '炼油厂', cat: 'production',
      desc: '将原油+水裂解为石油气与润滑油。',
      unlockedBy: 'oilProcessing', recipeBuilding: true, craftSpeed: 1, fluid: true,
    },

    // ================= 科研 =================
    lab: {
      id: 'lab', name: '实验室', cat: 'science',
      desc: '消耗科学包为当前研究提供点数。',
      unlockedBy: null, science: true,
    },

    // ================= 物流 =================
    belt: {
      id: 'belt', name: '传送带', cat: 'logistics',
      desc: '沿箭头方向运输物品。按住拖动可拉出直线并自动定向。',
      unlockedBy: null, beltTier: 0, beltSpeed: 0.125,
    },
    fastBelt: {
      id: 'fastBelt', name: '快速传送带', cat: 'logistics',
      desc: '速度 2 倍的传送带。',
      unlockedBy: 'logistics2', beltTier: 1, beltSpeed: 0.25,
    },
    expressBelt: {
      id: 'expressBelt', name: '极速传送带', cat: 'logistics',
      desc: '速度 3 倍的传送带。',
      unlockedBy: 'logistics3', beltTier: 2, beltSpeed: 0.375,
    },
    inserter: {
      id: 'inserter', name: '机械臂', cat: 'logistics',
      desc: '从身后一格抓取物品放入前方一格。R 旋转。',
      unlockedBy: null, inserterTier: 0, swingTime: 10, range: 1,
    },
    fastInserter: {
      id: 'fastInserter', name: '快速机械臂', cat: 'logistics',
      desc: '动作更快的机械臂。',
      unlockedBy: 'logistics2', inserterTier: 1, swingTime: 6, range: 1,
    },
    longInserter: {
      id: 'longInserter', name: '长臂机械臂', cat: 'logistics',
      desc: '可从 2 格外抓取/放置物品。',
      unlockedBy: 'logistics2', inserterTier: 2, swingTime: 10, range: 2,
    },
    pipe: {
      id: 'pipe', name: '管道', cat: 'logistics',
      desc: '输送流体。连接产液与用液建筑。',
      unlockedBy: null, fluid: true,
    },
    chest: {
      id: 'chest', name: '箱子', cat: 'logistics',
      desc: '4 格存储，每格 1000。缓冲与终端存储。',
      unlockedBy: null, storage: true,
    },
  };

  const byId = (id) => DEFS[id];
  const list = () => Object.values(DEFS);
  const byCat = (cat) => Object.values(DEFS).filter(b => b.cat === cat);

  const CATS = [
    { id: 'extraction', name: '采集' },
    { id: 'production', name: '生产' },
    { id: 'logistics',  name: '物流' },
    { id: 'science',    name: '科研' },
  ];

  return { DEFS, byId, list, byCat, CATS };
})();
