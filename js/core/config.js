/**
 * FG = Factory Game 全局命名空间
 * 核心常量与全局配置
 */
window.FG = window.FG || {};

FG.Config = {
  VERSION: '1.2.0',

  // 仿真节拍：每秒 20 tick
  TPS: 20,

  // 地图瓦片像素
  TILE: 32,

  // 游戏速度倍率（每档每秒仿真 tick 数由主循环换算）
  SPEEDS: [0.5, 1, 2, 4],

  // 传送带每格容量（物品数）
  BELT_CAP: 4,

  // 地面物料堆：拆除建筑后物料落地保留，每种物品上限
  GROUND_PILE_CAP: 200,
  // 机械臂「按需供给」向下游追踪传送带的最大格数
  BELT_TRACE_DEPTH: 8,
  // 需求追踪可访问的带/臂节点上限（环路保护：预算封顶，避免环路无界遍历）
  BELT_TRACE_NODES: 64,
  // 在途预留的最长存活 tick 数（安全网：消费者消失/绕环卡死时自动释放预留）
  RESV_TTL: 600,
  // 生产线供料优先级（数值越大越优先，缺料时高优先级先得料；同级轮转公平）
  PRIORITIES: { low: 1, normal: 2, high: 3 },
  // 机械臂从传送带上抓取时，夹爪到物品的最大距离（格，0~1）
  INSERTER_PICK_REACH: 0.8,

  // 各类建筑槽位容量
  SLOT_CAP: 100,          // 生产建筑输入/输出槽
  CHEST_SLOTS: 4,         // 箱子槽位数
  CHEST_SLOT_CAP: 1000,   // 箱子单槽容量
  FLUID_PIPE_CAP: 100,    // 管道单格流体容量
  FLUID_TANK_CAP: 500,    // 生产建筑流体缓冲罐容量

  // 统计窗口（秒）
  STAT_BUCKET_SEC: 1,      // 每多少秒采样一次
  STAT_HISTORY: 240,       // 保存的采样点数（4 分钟）
  RATE_WINDOW: 30,         // 计算速率的窗口（秒）

  // 地图尺寸档位
  MAP_SIZES: {
    small:  { w: 40,  h: 30,  label: '小' },
    medium: { w: 56,  h: 40,  label: '中' },
    large:  { w: 80,  h: 52,  label: '大' },
  },

  // 存档
  SAVE_PREFIX: 'fg.save.',
  SAVE_SLOTS: ['1', '2', '3'],
  AUTOSAVE_SEC: 60,

  // 颜色主题
  COLORS: {
    grass:   '#3d5a36',
    grass2:  '#46653e',
    sand:    '#c9b07c',
    sand2:   '#d6bd8a',
    stone:   '#6d6f78',
    stone2:  '#787a84',
    water:   '#2f6fae',
    water2:  '#387fc0',
    grid:    'rgba(255,255,255,0.06)',
    overlayRed:   'rgba(224,92,92,0.55)',
    overlayOrange:'rgba(232,163,61,0.5)',
    overlayGreen: 'rgba(88,194,111,0.25)',
  },
};
