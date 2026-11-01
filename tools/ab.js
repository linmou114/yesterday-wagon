global.window = global;
require("../js/hex.js");
require("../js/engine.js");
const Hex = global.Hex;
const ENGINE = global.ENGINE;
const T = ENGINE.TYPES;
const alive = (g) => [...g.pieces.values()];

function damageMap(g) {
  const all = alive(g), dmg = new Map();
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
  const t = T[type], c = Hex.parse(cellKey), dmg = damageMap(g);
  const eb = Hex.parse(g.baseOf(1 - g.active).key);
  let score = 0;
  for (const e of alive(g)) {
    if (e.owner === g.active) continue;
    if (Hex.distance(c, Hex.parse(e.key)) > t.range) continue;
    const now = dmg.get(e.id) + t.atk;
    if (now >= e.hp) score += (e.kind === "base" ? 400 : 60);
    else score += 4;
  }
  score += Math.max(0, 8 - Hex.distance(c, eb)) * 1.5;
  return score - t.cost * 0.4;
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
  if (!g.over) {
    const dmg = damageMap(g);
    if (alive(g).some((p) => dmg.get(p.id) >= p.hp && dmg.get(p.id) > 0)) g.resolve();
  }
}
function run(side, seed, bonus) {
  const g = new ENGINE.Game({
    side, density: 0.12, seed, rng: ENGINE.mulberry32(seed),
    firstTurnEnergy: bonus ? [4, 3] : [3, 3]
  });
  let t = 0;
  while (!g.over && t < 200) { playTurn(g); if (g.over) break; g.endTurn(); t++; }
  return { over: g.over, winner: g.winner, turns: t };
}
for (const side of [4, 5]) {
  for (const bonus of [true, false]) {
    let a = 0, b = 0, draw = 0, stall = 0;
    const N = 60;
    for (let i = 0; i < N; i++) {
      const r = run(side, 900 + i, bonus);
      if (!r.over) stall++;
      else if (r.winner === 0) a++;
      else if (r.winner === 1) b++;
      else draw++;
    }
    console.log(`边长 ${side} ${bonus ? "后手青方首回合4点" : "双方都3点"}  : 青方 ${a} / 赤方 ${b} / 平 ${draw} / 未分 ${stall}  (共 ${N} 局)`);
  }
}
