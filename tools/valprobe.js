// tools/valprobe.js —— 把 AI 的估值表打出来，方便核对「一个子到底值多少」
// 用法：node tools/valprobe.js
// 五段：兵种裸价 / 光环随人数变化 / 攻击价值随目标数变化 / 合击吃子 / 各预算下的搜索深度
const path = require('path');
const Hex = require(path.join(__dirname, '..', 'js', 'hex.js'));
const ENGINE = require(path.join(__dirname, '..', 'js', 'engine.js'));
const AI = require(path.join(__dirname, '..', 'js', 'ai.js'));

function fresh(seed) {
  const g = new ENGINE.Game({ side: 5, seed: seed || 7, density: 0 });
  return g;
}

const fmt = (n) => (Math.round(n * 100) / 100).toFixed(2);

// ---- 1. 各兵种裸价 / 中央价（无敌人，纯静态） ----
console.log('=== 1. 单棋子价值（场上无敌人，攻击价值=0）===');
const kinds = ['infantry', 'tank', 'artillery', 'command', 'sniper', 'slaver', 'slave'];
const base = {};
kinds.forEach((k) => {
  const g = fresh();
  const c = g.legalCells(g.active).values().next().value;
  const p = g.spawn(g.active, k, c, null, 0);
  const origin = Hex.key(0, 0);
  const v0 = AI.pieceValue(g, p);
  base[k] = v0;
  console.log(`${k.padEnd(10)} 费用${String(g.types[k].cost).padStart(2)} 血${g.types[k].hp} 攻${g.types[k].atk} 射${g.types[k].range}  价值 ${fmt(v0)}`);
});
const two = ['tank', 'artillery', 'command', 'sniper', 'slaver'].map((k) => base[k]);
const avg2 = two.reduce((a, b) => a + b, 0) / two.length;
console.log(`步兵 / 2费兵平均 = ${fmt(base.infantry)} / ${fmt(avg2)} = ${fmt(base.infantry / avg2)}`);

// ---- 2. 光环：罩住的人越多越值钱 ----
console.log('\n=== 2. 指挥所的价值 vs 罩住的棋子数 ===');
for (const n of [0, 1, 2, 3, 4, 5]) {
  const g = fresh();
  const cmdCell = Hex.key(0, 0);
  const cmd = g.spawn(0, 'command', cmdCell, null, 0);
  const nb = [...Hex.neighbors(0, 0)];
  let put = 0;
  for (const c of nb) {
    if (put >= n) break;
    const k = Hex.key(c.q, c.r);
    if (!g.board.cells.has(k) || g.occupant.has(k)) continue;
    g.spawn(0, 'infantry', k, null, 0);
    put++;
  }
  const a = g.auraOf(cmd);
  console.log(`罩住 ${put} 个：指挥所 ${fmt(AI.pieceValue(g, cmd))}（相邻步兵参考 ${fmt(put ? AI.pieceValue(g, g.pieces.get(g.occupant.get(Hex.key(nb[0].q, nb[0].r)))) : 0)}）`);
}

// ---- 3. 攻击价值：同一个兵，对着 0 / 1 / 3 个敌人 ----
console.log('\n=== 3. 攻击价值：炮兵对着几个敌人 ===');
function atkDemo(count, enemyKind) {
  const g = fresh();
  g.active = 0;
  const me = g.spawn(0, 'artillery', Hex.key(-2, 2), null, 0);
  const spots = [Hex.key(-1, 1), Hex.key(0, 1), Hex.key(-1, 2), Hex.key(1, 0), Hex.key(0, 2)];
  for (let i = 0; i < count; i++) {
    const k = spots[i];
    if (!g.board.cells.has(k) || g.occupant.has(k)) continue;
    g.spawn(1, enemyKind, k, null, 0);
  }
  return AI.pieceValue(g, me);
}
console.log(`炮 vs 0 个步兵: ${fmt(atkDemo(0, 'infantry'))}`);
console.log(`炮 vs 1 个步兵: ${fmt(atkDemo(1, 'infantry'))}`);
console.log(`炮 vs 3 个步兵: ${fmt(atkDemo(3, 'infantry'))}`);
console.log(`炮 vs 1 个坦克: ${fmt(atkDemo(1, 'tank'))}`);

// ---- 4. 组合：两个步兵夹一个 2 血目标（合击能杀） ----
console.log('\n=== 4. 两个步兵能不能吃到一个狙击兵 ===');
{
  const g = fresh();
  g.active = 0;
  const a = g.spawn(0, 'infantry', Hex.key(1, 1), null, 0);
  const b = g.spawn(0, 'infantry', Hex.key(2, 0), null, 0);
  g.spawn(1, 'sniper', Hex.key(1, 0), null, 0);
  console.log(`步兵A ${fmt(AI.pieceValue(g, a))}  步兵B ${fmt(AI.pieceValue(g, b))}  （合计伤害 ${g.damageMap().get(g.pieces.get(g.occupant.get(Hex.key(1, 0))).id)}）`);
}

// ---- 5. 性能 ----
console.log('\n=== 5. 搜索速度 ===');
for (const budget of [100, 300, 1000]) {
  const g = fresh(11);
  for (let t = 1; t <= 6; t++) {
    if (g.over) break;
    AI.playTurn(g, { budget: 40, maxDepth: 3 });
    g.endTurn();
  }
  const t0 = Date.now();
  const act = AI.bestAction(g, { budget, maxDepth: 8 });
  const st = AI.stats ? AI.stats() : null;
  console.log(`budget ${budget}ms → 实际 ${Date.now() - t0}ms depth=${act && act.depth} nodes=${act && act.nodes} score=${act && fmt(act.score)}`);
}
