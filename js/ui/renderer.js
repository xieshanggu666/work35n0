/**
 * FG.Renderer —— Canvas 渲染：地形/矿脉/建筑/传送带物品/流体/状态高亮
 */
FG.Renderer = (() => {
  let canvas = null, ctx = null, game = null;
  const C = () => FG.Config;
  const T = () => C().TILE;

  const iconCache = {};   // 'type_dir_size' -> canvas
  const itemCache = {};   // 'item_size' -> canvas

  function init(c, g) {
    canvas = c;
    ctx = c.getContext('2d');
    game = g;
    resize();
  }

  function resize() {
    const wrap = canvas.parentElement;
    canvas.width = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
  }

  function screenToTile(sx, sy) {
    const cam = game.camera;
    return {
      x: Math.floor(cam.x + sx / (T() * cam.zoom)),
      y: Math.floor(cam.y + sy / (T() * cam.zoom)),
    };
  }

  // ==================== 主渲染 ====================
  function render() {
    if (!game || game.state !== 'playing' || !game.map) return;
    const w = canvas.width, h = canvas.height;
    const cam = game.camera;
    const t = T();
    ctx.fillStyle = '#0d0f14';
    ctx.fillRect(0, 0, w, h);

    const x0 = Math.max(0, Math.floor(cam.x) - 1);
    const y0 = Math.max(0, Math.floor(cam.y) - 1);
    const x1 = Math.min(game.map.w - 1, Math.ceil(cam.x + w / (t * cam.zoom)) + 1);
    const y1 = Math.min(game.map.h - 1, Math.ceil(cam.y + h / (t * cam.zoom)) + 1);

    ctx.save();
    ctx.translate(-cam.x * t * cam.zoom, -cam.y * t * cam.zoom);
    ctx.scale(cam.zoom, cam.zoom);

    drawTerrain(x0, y0, x1, y1);
    drawOre(x0, y0, x1, y1);
    drawGrid(x0, y0, x1, y1);
    drawBuildings(x0, y0, x1, y1);
    drawGhost();

    ctx.restore();
  }

  function tileColor(tx, ty) {
    const terr = game.map.terrain[ty][tx];
    const alt = (tx + ty) % 2 === 0;
    const cols = C().COLORS;
    if (terr === 'water') return alt ? cols.water : cols.water2;
    if (terr === 'sand') return alt ? cols.sand : cols.sand2;
    if (terr === 'stone') return alt ? cols.stone : cols.stone2;
    return alt ? cols.grass : cols.grass2;
  }

  function drawTerrain(x0, y0, x1, y1) {
    const t = T();
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        ctx.fillStyle = tileColor(x, y);
        ctx.fillRect(x * t, y * t, t, t);
      }
    }
  }

  function drawOre(x0, y0, x1, y1) {
    const t = T();
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const ore = game.map.ores[y][x];
        if (ore) {
          const def = FG.Items.byId(ore.type);
          const cx = x * t + t / 2, cy = y * t + t / 2;
          ctx.beginPath();
          ctx.arc(cx, cy, t * 0.44, 0, Math.PI * 2);
          ctx.fillStyle = def.color;
          ctx.globalAlpha = 0.55;
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.strokeStyle = 'rgba(0,0,0,0.35)';
          ctx.lineWidth = 1;
          ctx.stroke();
          // 少量装饰点
          ctx.fillStyle = 'rgba(255,255,255,0.18)';
          ctx.fillRect(cx - 3, cy - 3, 2.5, 2.5);
          ctx.fillRect(cx + 2, cy + 2, 2.5, 2.5);
        }
        if (game.map.isOil(x, y)) {
          const cx = x * t + t / 2, cy = y * t + t / 2;
          ctx.beginPath();
          ctx.arc(cx, cy, t * 0.42, 0, Math.PI * 2);
          ctx.fillStyle = '#241f1a';
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,200,100,0.25)';
          ctx.stroke();
        }
      }
    }
  }

  function drawGrid(x0, y0, x1, y1) {
    if (game.camera.zoom < 1.1) return;
    const t = T();
    ctx.strokeStyle = C().COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = x0; x <= x1 + 1; x++) { ctx.moveTo(x * t + 0.5, y0 * t); ctx.lineTo(x * t + 0.5, (y1 + 1) * t); }
    for (let y = y0; y <= y1 + 1; y++) { ctx.moveTo(x0 * t, y * t + 0.5); ctx.lineTo((x1 + 1) * t, y * t + 0.5); }
    ctx.stroke();
  }

  function drawBuildings(x0, y0, x1, y1) {
    const t = T();
    // 先画传送带（物品画在建筑之上）
    const belts = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const b = game.map.buildingAt(x, y);
        if (!b) continue;
        const px = x * t, py = y * t;
        if (b.def.beltTier !== undefined) {
          drawBelt(b, px, py, t);
          belts.push(b);
        } else {
          drawBuilding(b, px, py, t);
        }
      }
    }
    // 传送带物品：按转弯/直行折线路径定位
    for (const b of belts) {
      const p0x = b.x * t, p0y = b.y * t;
      for (const it of b.items) {
        const p = FG.Map.beltPoint(b, it);
        const ix = p0x + p.x * t, iy = p0y + p.y * t;
        drawItem(ctx, it.type, ix, iy, t * 0.5, 0.95);
        if (it.tag) drawReservedRing(ctx, ix, iy, t * 0.28);
      }
    }
    // 地面物料堆（拆除保留的物料）
    drawPiles(x0, y0, x1, y1);
    // 选中高亮
    if (game.selection) {
      const b = game.selection;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(b.x * t + 1, b.y * t + 1, t - 2, t - 2);
    }
  }

  /** 在途预留标记：青色小环（已被某生产线预定的货物） */
  function drawReservedRing(ct, x, y, r) {
    ct.strokeStyle = '#37e0d2';
    ct.lineWidth = 1.4;
    ct.beginPath(); ct.arc(x, y, r, 0, Math.PI * 2); ct.stroke();
  }

  function drawPiles(x0, y0, x1, y1) {
    const t = T();
    for (const [k, pile] of game.map.piles) {
      const [x, y] = k.split(',').map(Number);
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      // 地面暗圈
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.ellipse((x + 0.5) * t, (y + 0.62) * t, t * 0.32, t * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();
      pile.slice(0, 4).forEach((s, i) => {
        const ox = (i % 2) * 7 - 3.5, oy = Math.floor(i / 2) * 6 - 3;
        drawItem(ctx, s.type, (x + 0.5) * t + ox, (y + 0.5) * t + oy, 9, 0.95);
      });
    }
  }

  function drawBelt(b, px, py, t) {
    // 底座
    ctx.fillStyle = '#262b36';
    ctx.fillRect(px + 2, py + 2, t - 4, t - 4);
    const tierCol = b.def.beltTier === 2 ? '#b04848' : b.def.beltTier === 1 ? '#4d7fd9' : '#4a5161';
    const arrowCol = b.def.beltTier === 2 ? '#d86a5a' : b.def.beltTier === 1 ? '#6fa0ef' : '#5d6578';

    // 实际存在的汇入侧（世界模式下检测相邻带；图标渲染无邻居）
    const sides = [0];
    const inWorld = !!(game && game.map && game.state === 'playing'
      && game.map.inBounds(b.x, b.y) && game.map.buildingAt(b.x, b.y) === b);
    if (inWorld) {
      for (const side of [2, 3]) {
        const sv = FG.Map.beltSideVec(b.dir, side);
        const nb = game.map.buildingAt(b.x + sv.x, b.y + sv.y);
        if (nb && nb.def.beltTier !== undefined && FG.Map.beltFeedsInto(nb, b)) sides.push(side);
      }
    }

    // 轨道面 + 双轨（直行/转弯折线）
    ctx.lineCap = 'round';
    for (const from of sides) {
      const pts = FG.Map.beltPath(b, from).map(p => ({ x: px + p.x * t, y: py + p.y * t }));
      ctx.strokeStyle = '#353c4b';
      ctx.lineWidth = 9;
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.stroke();
      ctx.strokeStyle = tierCol;
      ctx.lineWidth = 2;
      for (const off of [-3.2, 3.2]) {
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
          const seg = i === 0 ? [pts[0], pts[1]] : null;
          if (!seg) break;
          const dx = seg[1].x - seg[0].x, dy = seg[1].y - seg[0].y;
          const len = Math.hypot(dx, dy) || 1;
          const nx = -dy / len * off, ny = dx / len * off;
          ctx.moveTo(seg[0].x + nx, seg[0].y + ny);
          ctx.lineTo(seg[1].x + nx, seg[1].y + ny);
        }
        ctx.stroke();
      }
      // 汇入侧小箭头（合流提示）
      if (from !== 0) {
        const c = pts[0], mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        const dx = mid.x - c.x, dy = mid.y - c.y, len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len, tip = { x: c.x + ux * 7, y: c.y + uy * 7 };
        const px2 = -uy, py2 = ux;
        ctx.fillStyle = arrowCol;
        ctx.beginPath();
        ctx.moveTo(tip.x, tip.y);
        ctx.lineTo(tip.x - ux * 5 + px2 * 3, tip.y - uy * 5 + py2 * 3);
        ctx.lineTo(tip.x - ux * 5 - px2 * 3, tip.y - uy * 5 - py2 * 3);
        ctx.fill();
      }
    }

    // 主方向箭头
    const v = FG.Utils.dirVec(b.dir);
    const arrowCol2 = arrowCol;
    const cx = px + t / 2 + v.x * t * 0.14, cy = py + t / 2 + v.y * t * 0.14;
    drawArrowHead(cx, cy, v, t * 0.22, arrowCol2);

    // 状态覆盖：头部堵塞
    if (inWorld && game.showStatus && b.status === 'blocked') {
      ctx.fillStyle = 'rgba(232,163,61,0.18)';
      ctx.fillRect(px + 2, py + 2, t - 4, t - 4);
    }
    ctx.lineCap = 'butt';
  }

  function drawArrowHead(cx, cy, v, s, col) {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(cx + v.x * s, cy + v.y * s);
    ctx.lineTo(cx - v.x * s * 0.5 - v.y * s * 0.6, cy - v.y * s * 0.5 - v.x * s * 0.6);
    ctx.lineTo(cx - v.x * s * 0.5 + v.y * s * 0.6, cy - v.y * s * 0.5 + v.x * s * 0.6);
    ctx.closePath();
    ctx.fill();
  }

  function drawBuilding(b, px, py, t) {
    // 底座
    ctx.fillStyle = '#2b3140';
    ctx.fillRect(px + 1, py + 1, t - 2, t - 2);
    ctx.strokeStyle = '#3c4456';
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 1.5, py + 1.5, t - 3, t - 3);

    const cx = px + t / 2, cy = py + t / 2;
    const type = b.type;
    const col = '#0d0f14';

    if (type === 'miner') {
      ctx.fillStyle = '#6d7486';
      ctx.fillRect(px + 7, py + 8, t - 14, 5);
      ctx.beginPath();
      ctx.moveTo(cx, py + 5); ctx.lineTo(cx - 8, py + 13); ctx.lineTo(cx + 8, py + 13);
      ctx.closePath(); ctx.fillStyle = '#98a0b2'; ctx.fill();
      ctx.fillStyle = '#5a6174';
      ctx.fillRect(cx - 2, py + 13, 4, 8);
      ctx.fillStyle = '#8d94a6';
      ctx.beginPath(); ctx.arc(cx, cy + 6, 4, 0, Math.PI * 2); ctx.fill();
    } else if (type === 'pump') {
      ctx.fillStyle = '#4da3ff';
      ctx.fillRect(px + 6, py + 10, t - 12, 6);
      ctx.fillStyle = '#7ab8ff';
      ctx.fillRect(cx - 3, py + 6, 6, 12);
      ctx.beginPath(); ctx.arc(cx - 3, cy - 5, 3.5, 0, Math.PI * 2); ctx.fillStyle = '#cfe6ff'; ctx.fill();
    } else if (type === 'pumpjack') {
      ctx.fillStyle = '#8a7a5a';
      ctx.fillRect(px + 6, py + 14, t - 12, 5);
      ctx.strokeStyle = '#b0a080';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx - 10, py + 12);
      ctx.lineTo(cx + 10, py + 5);
      ctx.lineTo(cx + 14, py + 5);
      ctx.stroke();
      ctx.fillStyle = '#d8c8a0';
      ctx.beginPath(); ctx.arc(cx - 10, py + 12, 2.5, 0, Math.PI * 2); ctx.fill();
    } else if (type === 'furnace') {
      ctx.fillStyle = '#8a6a4a';
      ctx.fillRect(px + 5, py + 5, t - 10, t - 10);
      ctx.fillStyle = '#a88860';
      ctx.fillRect(px + 7, py + 7, t - 14, t - 14);
      // 火焰
      ctx.fillStyle = '#e8953d';
      ctx.beginPath();
      ctx.moveTo(cx, py + 20);
      ctx.quadraticCurveTo(cx - 5, py + 14, cx - 2, py + 10);
      ctx.quadraticCurveTo(cx + 2, py + 8, cx + 2, py + 12);
      ctx.quadraticCurveTo(cx + 6, py + 12, cx + 4, py + 16);
      ctx.quadraticCurveTo(cx + 6, py + 18, cx, py + 20);
      ctx.fill();
    } else if (type === 'steelFurnace') {
      ctx.fillStyle = '#5d6a80';
      ctx.fillRect(px + 4, py + 4, t - 8, t - 8);
      ctx.fillStyle = '#6f7d96';
      ctx.fillRect(px + 6, py + 6, t - 12, t - 12);
      ctx.fillStyle = '#4da3ff';
      ctx.beginPath(); ctx.arc(cx, cy + 4, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#a8c8f0'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx, cy + 4, 2.5, 0, Math.PI * 2); ctx.stroke();
    } else if (type === 'assembler' || type === 'assembler2') {
      ctx.fillStyle = type === 'assembler2' ? '#4d6a8a' : '#3d4a5f';
      ctx.fillRect(px + 4, py + 4, t - 8, t - 8);
      ctx.fillStyle = type === 'assembler2' ? '#5f7f9f' : '#4d5c74';
      ctx.fillRect(px + 7, py + 7, t - 14, t - 14);
      drawGear(ctx, cx, cy, 7, type === 'assembler2' ? '#c0c8d8' : '#98a2b8');
      ctx.strokeStyle = type === 'assembler2' ? '#a0c0e0' : '#7a8aa0';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx + 5, cy + 6);
      ctx.lineTo(cx + 9, cy + 10);
      ctx.stroke();
    } else if (type === 'chemPlant') {
      ctx.fillStyle = '#5a4d6a';
      ctx.fillRect(px + 4, py + 4, t - 8, t - 8);
      ctx.fillStyle = '#7a6d8a';
      ctx.fillRect(px + 7, py + 7, t - 14, t - 14);
      ctx.fillStyle = '#b09ac9';
      ctx.beginPath(); ctx.arc(cx - 6, cy - 2, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#9a6ad9';
      ctx.beginPath(); ctx.arc(cx + 6, cy - 2, 4, 0, Math.PI * 2); ctx.fill();
    } else if (type === 'refinery') {
      ctx.fillStyle = '#4a5a4d';
      ctx.fillRect(px + 4, py + 4, t - 8, t - 8);
      ctx.fillStyle = '#6a7a6d';
      ctx.fillRect(px + 7, py + 7, t - 14, t - 14);
      ctx.fillStyle = '#4a3a2e';
      ctx.beginPath(); ctx.arc(cx - 5, cy - 3, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#e8c84f';
      ctx.beginPath(); ctx.arc(cx + 6, cy + 2, 4, 0, Math.PI * 2); ctx.fill();
    } else if (type === 'lab') {
      ctx.fillStyle = '#3a4a5f';
      ctx.fillRect(px + 4, py + 4, t - 8, t - 8);
      ctx.fillStyle = '#5f7f9f';
      ctx.fillRect(px + 7, py + 7, t - 14, t - 14);
      // 烧瓶
      ctx.fillStyle = '#bfe0ff';
      ctx.fillRect(cx - 2.5, py + 6, 5, 6);
      ctx.beginPath();
      ctx.moveTo(cx - 5, py + 22); ctx.lineTo(cx - 5, py + 18);
      ctx.lineTo(cx + 5, py + 18); ctx.lineTo(cx + 5, py + 22);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#4da3ff';
      ctx.beginPath();
      ctx.moveTo(cx - 4, py + 20); ctx.lineTo(cx + 4, py + 20);
      ctx.lineTo(cx + 2, py + 14); ctx.lineTo(cx - 2, py + 14);
      ctx.closePath(); ctx.fill();
    } else if (type === 'inserter' || type === 'fastInserter' || type === 'longInserter') {
      // 底座
      ctx.fillStyle = '#4a5161';
      ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2); ctx.fill();
      // 手臂（朝向：抓取时向后，放置时向前）
      const v = FG.Utils.dirVec(b.dir);
      const grab = b.held === null;
      const ang = Math.atan2(v.y, v.x) + (grab ? Math.PI : 0);
      const len = (type === 'longInserter' ? 13 : 10);
      const tipX = cx + Math.cos(ang) * len, tipY = cy + Math.sin(ang) * len;
      ctx.strokeStyle = type === 'fastInserter' ? '#4d9f5f' : type === 'longInserter' ? '#d9a04d' : '#7a8aa0';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
      // 夹爪
      ctx.fillStyle = '#c0c8d8';
      ctx.beginPath(); ctx.arc(tipX, tipY, 2.5, 0, Math.PI * 2); ctx.fill();
      if (b.held) {
        drawItem(ctx, b.held.type, tipX, tipY, 7, 1);
        if (b.held.tag) drawReservedRing(ctx, tipX, tipY, 5);
      }
      // 方向标记
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.beginPath(); ctx.arc(cx + v.x * 5, cy + v.y * 5, 1.8, 0, Math.PI * 2); ctx.fill();
    } else if (type === 'pipe') {
      ctx.fillStyle = '#333a4a';
      ctx.fillRect(px + 4, py + 4, t - 8, t - 8);
      // 法兰
      ctx.fillStyle = '#4a5161';
      ctx.fillRect(px + 3, py + 3, 3, t - 6);
      ctx.fillRect(px + t - 6, py + 3, 3, t - 6);
      ctx.fillRect(px + 3, py + 3, t - 6, 3);
      ctx.fillRect(px + 3, py + t - 6, t - 6, 3);
      // 流体
      const ratio = Math.min(1, b.level / C().FLUID_PIPE_CAP);
      if (ratio > 0.02) {
        const fcolor = b.fluidType ? FG.Items.byId(b.fluidType).color : '#4da3ff';
        ctx.fillStyle = fcolor;
        ctx.globalAlpha = 0.75;
        ctx.fillRect(px + 6, py + 6, (t - 12) * ratio, t - 12);
        ctx.globalAlpha = 1;
      }
    } else if (type === 'chest') {
      ctx.fillStyle = '#8a6a3a';
      ctx.fillRect(px + 5, py + 8, t - 10, t - 14);
      ctx.fillStyle = '#a88850';
      ctx.fillRect(px + 5, py + 8, t - 10, 5);
      ctx.fillStyle = '#e8c84f';
      ctx.fillRect(cx - 2, py + 8, 4, 5);
      // 物品预览
      const items = b.chest.filter(s => s.count > 0);
      if (items.length) {
        const first = items[0];
        drawItem(ctx, first.type, cx, cy + 4, 9, 1);
      }
    }

    // 生产线供料优先级角标（非普通时显示）
    if (b.priority && b.priority !== 'normal' && (b.def.recipeBuilding || b.type === 'lab')) {
      const col = b.priority === 'high' ? '#d96a5a' : '#8b93a8';
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(px + t - 5, py + 5, 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#10141c';
      ctx.font = 'bold 6px Consolas';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(b.priority === 'high' ? 'H' : 'L', px + t - 5, py + 5.5);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }

    // 状态覆盖层
    if (game.showStatus && b.status) {
      const col = b.status === 'starving' ? C().COLORS.overlayRed
        : b.status === 'blocked' ? C().COLORS.overlayOrange
        : b.status === 'working' ? C().COLORS.overlayGreen : null;
      if (col) {
        ctx.fillStyle = col;
        ctx.fillRect(px + 1, py + 1, t - 2, t - 2);
      }
    }

    // 生产进度条
    if (b.recipe && b.status === 'working' && b.def.recipeBuilding) {
      const r = FG.Recipes.byId(b.recipe);
      const p = Math.min(1, b.progress / r.time);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(px + 4, py + t - 6, t - 8, 3);
      ctx.fillStyle = '#58c26f';
      ctx.fillRect(px + 4, py + t - 6, (t - 8) * p, 3);
    }
  }

  function drawGear(ctx, cx, cy, r, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    const teeth = 8;
    for (let i = 0; i < teeth * 2; i++) {
      const a = (i / (teeth * 2)) * Math.PI * 2;
      const rr = i % 2 === 0 ? r : r * 0.7;
      const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#2b3140';
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.35, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // ==================== 幽灵预览 ====================
  function drawGhost() {
    const g = game.ghost;
    if (!g) return;
    const t = T();
    const { x, y } = lastMouseTile;
    if (!x) return;
    const ok = game.canPlace(g.type, x, y);
    const px = x * t, py = y * t;
    ctx.fillStyle = ok ? 'rgba(88,194,111,0.18)' : 'rgba(224,92,92,0.2)';
    ctx.fillRect(px, py, t, t);
    ctx.strokeStyle = ok ? '#58c26f' : '#e05c5c';
    ctx.lineWidth = 2;
    ctx.strokeRect(px + 1, py + 1, t - 2, t - 2);
    ctx.globalAlpha = 0.5;
    const tmp = { def: FG.Buildings.byId(g.type), type: g.type, x, y, dir: g.dir, items: [], held: null, level: 0, fluidType: null, status: 'idle', slots: { inputs: {}, outputs: {} }, chest: [], rr: 0 };
    if (tmp.def.beltTier !== undefined) drawBelt(tmp, px, py, t);
    else drawBuilding(tmp, px, py, t);
    ctx.globalAlpha = 1;
  }

  let lastMouseTile = { x: null, y: null };
  function setMouseTile(x, y) { lastMouseTile = { x, y }; }

  // ==================== 物品图标 ====================
  function drawItem(ct, id, x, y, s, alpha) {
    const def = FG.Items.byId(id);
    if (!def) return;
    ct.save();
    ct.globalAlpha = alpha !== undefined ? alpha : 1;
    ct.fillStyle = def.color;
    const h = s / 2;
    switch (def.shape) {
      case 'square':
        ct.fillRect(x - h * 0.7, y - h * 0.7, s * 0.7, s * 0.7);
        ct.fillStyle = 'rgba(255,255,255,0.35)';
        ct.fillRect(x - h * 0.7, y - h * 0.7, s * 0.7, s * 0.18);
        break;
      case 'circle':
        ct.beginPath(); ct.arc(x, y, h * 0.7, 0, Math.PI * 2); ct.fill();
        break;
      case 'beam':
        ct.fillRect(x - h * 0.8, y - h * 0.25, s * 0.8, s * 0.25);
        break;
      case 'wire':
        ct.translate(x, y);
        ct.rotate(Math.PI / 4);
        ct.fillRect(-h * 0.75, -h * 0.2, s * 0.75, s * 0.2);
        break;
      case 'gear':
        drawGear(ct, x, y, h * 0.75, def.color);
        break;
      case 'board':
        ct.fillRect(x - h * 0.75, y - h * 0.55, s * 0.75, s * 0.55);
        ct.fillStyle = 'rgba(0,0,0,0.35)';
        for (let i = -1; i <= 1; i++) ct.fillRect(x - h * 0.6 + i * 3, y + h * 0.05, 1.5, 3);
        break;
      case 'flask':
        ct.fillRect(x - h * 0.22, y - h * 0.7, s * 0.22, s * 0.35);
        ct.beginPath();
        ct.moveTo(x - h * 0.5, y + h * 0.7); ct.lineTo(x - h * 0.5, y + h * 0.2);
        ct.lineTo(x + h * 0.5, y + h * 0.2); ct.lineTo(x + h * 0.5, y + h * 0.7);
        ct.closePath(); ct.fill();
        break;
      case 'engine':
        ct.fillRect(x - h * 0.6, y - h * 0.5, s * 0.6, s * 0.5);
        ct.fillStyle = '#e05c5c';
        ct.fillRect(x - h * 0.6, y - h * 0.5, s * 0.2, s * 0.5);
        break;
      case 'drill':
        ct.beginPath();
        ct.moveTo(x - h * 0.55, y + h * 0.6); ct.lineTo(x - h * 0.55, y - h * 0.2);
        ct.lineTo(x + h * 0.55, y + h * 0.6); ct.closePath(); ct.fill();
        break;
      case 'panel':
        ct.fillRect(x - h * 0.75, y - h * 0.5, s * 0.75, s * 0.5);
        ct.fillStyle = 'rgba(255,255,255,0.25)';
        ct.strokeStyle = 'rgba(255,255,255,0.25)';
        ct.lineWidth = 1;
        ct.beginPath();
        for (let i = -1; i <= 1; i++) { ct.moveTo(x + i * 4, y - h * 0.45); ct.lineTo(x + i * 4, y + h * 0.45); }
        ct.stroke();
        break;
      case 'rocket':
        ct.beginPath();
        ct.moveTo(x, y - h * 0.8); ct.lineTo(x - h * 0.4, y + h * 0.4); ct.lineTo(x + h * 0.4, y + h * 0.4);
        ct.closePath(); ct.fill();
        ct.fillStyle = '#e05c5c';
        ct.fillRect(x - h * 0.1, y + h * 0.4, s * 0.1, s * 0.3);
        break;
      case 'drop':
        ct.beginPath();
        ct.moveTo(x, y - h * 0.75);
        ct.quadraticCurveTo(x + h * 0.7, y + h * 0.1, x, y + h * 0.75);
        ct.quadraticCurveTo(x - h * 0.7, y + h * 0.1, x, y - h * 0.75);
        ct.fill();
        break;
      case 'sat':
        ct.fillRect(x - h * 0.8, y - h * 0.2, s * 0.8, s * 0.2);
        ct.fillStyle = '#4da3ff';
        ct.fillRect(x - h * 0.5, y - h * 0.5, s * 0.3, s * 0.3);
        break;
      default:
        ct.fillRect(x - h * 0.5, y - h * 0.5, s * 0.5, s * 0.5);
    }
    ct.restore();
  }

  // ==================== 缓存小图标（UI 用） ====================
  function itemIcon(id, size) {
    const k = id + '_' + size;
    if (itemCache[k]) return itemCache[k];
    const cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    const c2 = cv.getContext('2d');
    drawItem(c2, id, size / 2, size / 2, size * 0.8, 1);
    itemCache[k] = cv;
    return cv;
  }

  function buildingIcon(type, size, dir) {
    const k = type + '_' + size + '_' + (dir || 0);
    if (iconCache[k]) return iconCache[k];
    const cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    const c2 = cv.getContext('2d');
    const tmp = { def: FG.Buildings.byId(type), type, x: -1, y: -1, dir: dir || 0, items: [], held: null, level: 0, fluidType: null, status: 'idle', slots: { inputs: {}, outputs: {} }, chest: [], rr: 0 };
    // 等比缩放到图标尺寸
    const scale = size / 32;
    c2.save();
    c2.scale(scale, scale);
    c2.translate(0, 0);
    if (tmp.def.beltTier !== undefined) drawBelt(tmp, 0, 0, 32);
    else drawBuilding(tmp, 0, 0, 32);
    c2.restore();
    iconCache[k] = cv;
    return cv;
  }

  return { init, resize, render, screenToTile, setMouseTile, drawItem, itemIcon, buildingIcon, drawGear };
})();
