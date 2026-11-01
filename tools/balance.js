/* 平衡性探索（Node 运行，不参与网页）
 * 用「贪心 AI」双方对打，看看能不能真的攻破防线、拿下大本营。
 */
global.window = global;
require('../js/hex.js');
require('../js/engine.js');
const Hex = global.Hex;
const ENGINE = global.ENGINE;
const T = ENGINE.TYPES;

function alive(g) { return [...g.pieces.values()]; }

function damageMap(g) {
  const all = alive(g);
  const dmg = new Map();
  for (const t of all) {
    let s = 0;
    for (const a of all) {
      if (a.owner === t.owner || a.atk <= 0) continue;
      if (Hex.distance(Hex.parse(a.key), Hex.parse(t.key)) <= a.range) s += a.atk;
    }
    dmg.set(t.id, s);
  }
  return dmg;
}

function scorePlace(g, type, cellKey) {
  const t = T[type];
  const c = Hex.parse(cellKey);
  const dmg = damageMap(g);
  const enemyBase = g.baseOf(1 - g.active);
  let score = 0;
  for (const e of alive(g)) {
    if (e.owner === g.active) continue;
    const ec = Hex.parse(e.key);
    if (Hex.distance(c, ec) > t.range) continue;
    const now = dmg.get(e.id) + t.atk;
    if (now >= e.hp) score += (e.kind === 'base' ? 400 : 60);
    else score += 4;
  }
  const eb = Hex.parse(enemyBase.key);
  score += Math.max(0, 8 - Hex.distance(c, eb)) * 1.5;
  score -= t.cost * 0.4;
  return score;
}

function previewKills(g) {
  const dmg = damageMap(g);
  let n = 0;
  for (const p of alive(g)) if (dmg.get(p.id) >= p.hp) n++;
  return n;
}

function playTurn(g) {
  for (let step = 0; step < 8 && !g.over; step++) {
    const legal = [...g.legalCells(g.active)];
    if (!legal.length) break;
    let best = null;
    for (const type of ENGINE.TYPE_LIST) {
      if (T[type].cost > g.energy) continue;
      for (const cellKey of legal) {
        const s = scorePlace(g, type, cellKey);
        if (!best || s > best.s) best = { type, cellKey, s };
      }
    }
    if (!best || best.s <= 0) break;
    g.place(g.active, best.type, best.cellKey);
  }
  if (!g.resolved && !g.over && previewKills(g) > 0) g.resolve();
}

function runGame(side, seed, density) {
  const rng = ENGINE.mulberry32(seed);
  const g = new ENGINE.Game({ side, density, seed, rng });
  let turns = 0;
  while (!g.over && turns < 200) {
    playTurn(g);
    if (g.over) break;
    g.endTurn();
    turns++;
  }
  return { over: g.over, winner: g.winner, turns, units: [...g.pieces.values()].length };
}

const SIDES = process.argv.slice(2).map(Number).filter(n => n >= 3);
for (const side of (SIDES.length ? SIDES : [4, 5, 6])) {
  let wins = [0, 0, 0], endTurns = [], stuck = 0;
  for (let i = 0; i < 40; i++) {
    const r = runGame(side, 500 + i, 0.12);
    if (r.over) { wins[r.winner === 0 ? 0 : 1]++; endTurns.push(r.turns); }
    else { stuck++; endTurns.push(r.turns); }
  }
  const avg = (endTurns.reduce((a, b) => a + b, 0) / endTurns.length).toFixed(1);
  console.log(
    `边长 ${side}: 青方胜 ${wins[0]} / 赤方胜 ${wins[1]} / 未分胜负 ${stuck}，平均 ${avg} 回合`
  );
}
