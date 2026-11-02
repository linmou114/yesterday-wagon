/* 规则引擎自检（Node 运行，不参与网页） */
global.window = global;
require('../js/hex.js');
require('../js/engine.js');
require('../js/maps.js');
require('../js/tutorial.js');

const Hex = global.Hex;
const ENGINE = global.ENGINE;
const MAPS = global.MAPS;

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.log('  ✗ ' + msg); }
}
function eq(a, b, msg) { ok(a === b, msg + ' (期望 ' + b + '，实际 ' + a + ')'); }

// 直接摆一个棋子（跳过放置规则，用于构造局面）
function force(g, owner, kind, q, r) {
  const t = kind === 'base'
    ? { hp: (g.rules ? g.rules.baseHp : ENGINE.BASE_HP), atk: 0, range: 0 }
    : (g.types ? g.types[kind] : ENGINE.TYPES[kind]);
  const key = Hex.key(q, r);
  if (g.occupant.has(key)) throw new Error('格子已被占用 ' + key);
  const p = {
    id: g.nextId++, owner, kind, key,
    hp: t.hp, maxHp: t.hp, atk: t.atk, range: t.range
  };
  g.pieces.set(p.id, p);
  g.occupant.set(key, p.id);
  return p;
}
function clearBoard(g) {
  g.pieces.clear();
  g.occupant.clear();
  g.baseIds = [null, null];
  g.baseIds[0] = g.spawnBase(0, g.board.baseA).id;
  g.baseIds[1] = g.spawnBase(1, g.board.baseB).id;
}
function near(g, a, b) { return Hex.distance(a, b); }

console.log('== 1. 地图生成 ==');
for (let side = 3; side <= 7; side++) {
  for (let trial = 0; trial < 20; trial++) {
    const seed = 1000 + trial;
    const rng = ENGINE.mulberry32(seed);
    const g = new ENGINE.Game({ side, density: 0.14, seed, rng });
    eq(g.board.count, Hex.cellCount(side), `边长 ${side} 的格子数`);

    // 中心对称（旋转 180°）
    let symOK = true;
    g.board.cells.forEach((c) => {
      const m = Hex.mirror(c.q, c.r);
      const mc = g.board.cells.get(Hex.key(m.q, m.r));
      if (!mc || mc.obstacle !== c.obstacle) symOK = false;
    });
    ok(symOK, `边长 ${side} 障碍物中心对称`);

    // 基地及其邻格不被障碍占
    let baseOK = true;
    [g.board.baseA, g.board.baseB].forEach((b) => {
      const bc = g.board.cells.get(Hex.key(b.q, b.r));
      if (!bc || bc.obstacle) baseOK = false;
      Hex.neighbors(b.q, b.r).forEach((n) => {
        const nc = g.board.cells.get(Hex.key(n.q, n.r));
        if (nc && nc.obstacle) baseOK = false;
      });
    });
    ok(baseOK, `边长 ${side} 基地周围干净`);

    // 两个基地必须连通
    const seen = new Set([Hex.key(g.board.baseA.q, g.board.baseA.r)]);
    const stack = [Hex.key(g.board.baseA.q, g.board.baseA.r)];
    while (stack.length) {
      const k = stack.pop();
      const c = Hex.parse(k);
      const ns = Hex.neighbors(c.q, c.r);
      for (let ni = 0; ni < ns.length; ni++) {
        const nk = Hex.key(ns[ni].q, ns[ni].r);
        if (seen.has(nk)) continue;
        const nc = g.board.cells.get(nk);
        if (!nc || nc.obstacle) continue;
        seen.add(nk); stack.push(nk);
      }
    }
    ok(seen.has(Hex.key(g.board.baseB.q, g.board.baseB.r)), `边长 ${side} 双基地连通`);
  }
}
console.log('== 2. 放置规则与费用（赤方先手） ==');
{
  const g = new ENGINE.Game({ side: 5, density: 0, seed: 42 });
  eq(g.firstPlayer, 1, '先手是赤方');
  eq(g.active, 1, '第一个行动的是赤方');
  eq(g.energy, 3, '赤方首回合 3 点费用');
  eq(g.turnEnergyMax, 3, '本回合费用上限记录为 3');

  const legal = g.legalCells(1);
  eq(legal.size, 3, '开局只有基地的 3 个邻格可放');
  const first = [...legal][0];
  g.place(1, 'infantry', first);
  eq(g.energy, 2, '步兵花 1 费');
  ok(!g.legalCells(1).has(first), '已占格不再是落点');
  g.place(1, 'tank', [...g.legalCells(1)][0]);
  eq(g.energy, 0, '坦克花 2 费');
  let threw = false;
  try { g.place(1, 'infantry', [...g.legalCells(1)][0]); } catch (e) { threw = true; }
  ok(threw, '费用不足时不能放置');
  threw = false;
  try { g.place(0, 'infantry', [...g.legalCells(0)][0]); } catch (e) { threw = true; }
  ok(threw, '不是自己回合不能放置');

  g.endTurn();
  eq(g.active, 0, '轮到青方');
  eq(g.energy, 4, '青方首回合 4 点费用（后手补偿）');
  eq(g.turnEnergyMax, 4, '青方首回合费用上限为 4');
  eq(g.resolveCount, 0, '换人后结算次数重置');
  g.endTurn();
  eq(g.turn, 2, '双方各走一次后进入第 2 回合');
  eq(g.active, 1, '第 2 回合仍然赤方先动');
  eq(g.energy, 3, '第 2 回合回到常规 3 点');
  eq(g.turnEnergyMax, 3, '第 2 回合费用上限为 3');
}
console.log('== 3. 结算伤害判定（血量 ≤ 攻击之和 就死） ==');
{
  // 2 点打 3 血步兵：不死
  const g = new ENGINE.Game({ side: 5, density: 0, seed: 7 });
  clearBoard(g);
  const t1 = force(g, 0, 'infantry', 1, -4);
  force(g, 1, 'infantry', 2, -4);
  force(g, 1, 'infantry', 0, -3);
  let res = g.resolve();
  eq(res.damage.get(t1.id), 2, '2 个相邻敌人 = 2 点伤害');
  eq(res.killedByDamage.length, 0, '3 血吃 2 点：不死');

  // 3 点打 3 血：恰好等于血量，死亡
  const g2 = new ENGINE.Game({ side: 5, density: 0, seed: 8 });
  clearBoard(g2);
  const t2 = force(g2, 0, 'infantry', 1, -4);
  force(g2, 1, 'infantry', 2, -4);
  force(g2, 1, 'infantry', 0, -3);
  force(g2, 1, 'infantry', 1, -3);
  res = g2.resolve();
  eq(res.damage.get(t2.id), 3, '3 个相邻敌人 = 3 点伤害');
  eq(res.killedByDamage.length, 1, '3 血吃 3 点：死亡（血量 = 攻击）');
  eq(res.killedByDamage[0].piece.id, t2.id, '死的就是那个步兵');

  // 坦克 4 血：3 点不死，4 点死
  const g3 = new ENGINE.Game({ side: 5, density: 0, seed: 9 });
  clearBoard(g3);
  const tk = force(g3, 0, 'tank', 1, -4);
  force(g3, 1, 'infantry', 2, -4);
  force(g3, 1, 'infantry', 0, -3);
  force(g3, 1, 'infantry', 1, -3);
  res = g3.resolve();
  eq(res.damage.get(tk.id), 3, '坦克吃到 3 点');
  eq(res.killedByDamage.length, 0, '4 血坦克吃 3 点不死');

  const g4 = new ENGINE.Game({ side: 5, density: 0, seed: 10 });
  clearBoard(g4);
  const tk2 = force(g4, 0, 'tank', 1, -4);
  force(g4, 1, 'infantry', 2, -4);
  force(g4, 1, 'infantry', 0, -3);
  force(g4, 1, 'infantry', 1, -3);
  force(g4, 1, 'artillery', 3, -4);      // 距离 2，射程 2
  res = g4.resolve();
  eq(res.damage.get(tk2.id), 4, '坦克吃到 4 点');
  eq(res.killedByDamage.length, 1, '4 血坦克吃 4 点：死亡');

  // 炮兵的射程 2 确实够得着
  const g5 = new ENGINE.Game({ side: 5, density: 0, seed: 17 });
  clearBoard(g5);
  const t5 = force(g5, 0, 'infantry', 1, -4);
  force(g5, 1, 'artillery', 3, -4);
  res = g5.resolve();
  eq(res.damage.get(t5.id), 1, '射程 2 的炮兵打得到距离 2 的目标');
}
console.log('== 4. 断联移除 ==');
{
  const g = new ENGINE.Game({ side: 5, density: 0, seed: 11 });
  clearBoard(g);
  // 一条从基地向下的链：base(0,-4) - (0,-3) - (0,-2) - (0,-1)
  const a = force(g, 0, 'infantry', 0, -3);
  const b = force(g, 0, 'infantry', 0, -2);
  const c = force(g, 0, 'infantry', 0, -1);
  ok(g.componentKeys(0).size === 4, '基地 + 3 个棋子同属一个连通块');

  // 赤方用 3 点攻击打断中间的 b；c 只吃到 2 点，活着但会断联
  force(g, 1, 'infantry', 1, -2);
  force(g, 1, 'infantry', -1, -1);
  force(g, 1, 'infantry', -1, -2);
  const res = g.resolve();
  ok(res.killedByDamage.some((r) => r.piece.id === b.id), '中间的棋子被打死');
  ok(res.removedByCut.some((r) => r.piece.id === c.id), '断开的尾兵被移除');
  ok(!g.pieces.has(c.id) && g.pieces.has(a.id), 'a 仍连着基地、c 已消失');
  eq(g.maxSwing[1], 2, '赤方单次结算清掉 2 个（1 击杀 + 1 断联），maxSwing 记录正确');
  eq(g.maxSwing[0], 3, '赤方那 3 个孤立棋子也被断联移除，青方 maxSwing 记为 3');
}
console.log('== 5. 大本营与胜负 ==');
{
  // 3 点打 4 血基地：不死
  const g = new ENGINE.Game({ side: 5, density: 0, seed: 13 });
  clearBoard(g);
  force(g, 1, 'infantry', 1, -4);
  force(g, 1, 'infantry', 0, -3);
  force(g, 1, 'infantry', -1, -3);
  const res = g.resolve();
  eq(res.damage.get(g.baseOf(0).id), 3, '基地吃到 3 点');
  eq(res.deadBases[0], false, '4 血基地吃 3 点不死');
  ok(!g.over, '还没结束');

  // 4 点：直接摧毁
  const g2 = new ENGINE.Game({ side: 5, density: 0, seed: 14 });
  clearBoard(g2);
  force(g2, 1, 'infantry', 1, -4);
  force(g2, 1, 'infantry', 0, -3);
  force(g2, 1, 'infantry', -1, -3);
  force(g2, 1, 'artillery', 2, -4);      // 距离 2
  const res2 = g2.resolve();
  ok(res2.deadBases[0], '4 点攻击打爆 4 血基地');
  ok(g2.over && g2.winner === 1, '赤方获胜');
}
console.log('== 6. 随机对局压力测试 ==');
{
  let games = 0, actions = 0, overCount = 0;
  for (let side = 3; side <= 7; side++) {
    for (let trial = 0; trial < 12; trial++) {
      const seed = side * 1000 + trial;
      const rng = ENGINE.mulberry32(seed);
      const g = new ENGINE.Game({ side, density: 0.1 + (trial % 4) * 0.05, seed, rng });
      games++;
      let guard = 0;
      while (!g.over && guard < 500) {
        guard++;
        // 随机放置
        let placed = 0;
        while (placed < 6) {
          const legal = [...g.legalCells(g.active)];
          const afford = ENGINE.TYPE_LIST.filter((t) => ENGINE.TYPES[t].cost <= g.energy);
          if (!legal.length || !afford.length) break;
          const type = afford[Math.floor(rng() * afford.length)];
          const cell = legal[Math.floor(rng() * legal.length)];
          const tt = ENGINE.TYPES[type];
          if (tt.rangeMode === 'line') g.place(g.active, type, cell, { dir: Math.floor(rng() * 6) });
          else g.place(g.active, type, cell);
          actions++;
          placed++;
          if (rng() < 0.15) break;
        }
        if (rng() < 0.8 && !g.resolved) { g.resolve(); actions++; }
        if (g.over) { overCount++; break; }
        g.endTurn();
        actions++;

        // 不变量
        let bad = 0;
        g.pieces.forEach((p) => {
          const cell = g.board.cells.get(p.key);
          if (!cell || cell.obstacle) bad++;
          if (g.occupant.get(p.key) !== p.id) bad++;
        });
        if (g.occupant.size !== g.pieces.size) bad++;
        if (bad) { fail++; console.log('  ✗ 状态不一致，坏点数 ' + bad); break; }
      }
      // 每个棋子都必须在合法格子上
      ok(g.occupant.size === g.pieces.size, `seed ${seed} 占位表一致`);
    }
  }
  console.log(`  随机对局 ${games} 局、${actions} 次操作，其中 ${overCount} 局分出胜负`);
}
console.log('== 7. 中心对称的公平性 ==');
{
  // 同一个种子下，双方开局可放格数应相同
  for (let side = 3; side <= 7; side++) {
    const g = new ENGINE.Game({ side, density: 0.14, seed: 99 });
    eq(g.legalCells(0).size, g.legalCells(1).size, `边长 ${side} 双方开局落点数相同`);
  }
}

console.log('== 7.5 8 张默认地图 ==');
{
  eq(MAPS.DEFAULT_MAPS.length, 8, '默认地图共 8 张');
  MAPS.DEFAULT_MAPS.forEach((m, i) => {
    const g = new ENGINE.Game({ side: MAPS.SIDE, density: m.density, seed: m.seed });
    let sym = true;
    g.board.cells.forEach((c) => {
      const mm = Hex.mirror(c.q, c.r);
      const mc = g.board.cells.get(Hex.key(mm.q, mm.r));
      if (!mc || mc.obstacle !== c.obstacle) sym = false;
    });
    ok(sym, `默认地图 ${i + 1}「${m.name}」中心对称`);
    eq(g.legalCells(0).size, 3, `默认地图 ${i + 1} 青方开局 3 个落点`);
    eq(g.legalCells(1).size, 3, `默认地图 ${i + 1} 赤方开局 3 个落点`);
    const again = new ENGINE.Game({ side: MAPS.SIDE, density: m.density, seed: m.seed });
    let same = true;
    g.board.cells.forEach((c, k) => {
      if (c.obstacle !== again.board.cells.get(k).obstacle) same = false;
    });
    ok(same, `默认地图 ${i + 1} 同种子可复现`);
  });
}
console.log('== 7.8 新手教学关卡 ==');
{
  const TUT = global.TUTORIAL;
  const byKey = {};
  TUT.LEVELS.forEach((lv, i) => { byKey[lv.key] = i; });
  eq(TUT.LEVELS.length, 7, '教学共 7 关');

  TUT.LEVELS.forEach((lv, i) => {
    const g = TUT.buildLevel(ENGINE, i);
    eq(g.pieces.size - 2, (lv.spawn || []).length, `第 ${i + 1} 关（${lv.key}）预置棋子全部落地`);
    eq(g.energy, lv.energy, `第 ${i + 1} 关初始费用 ${lv.energy}`);
    ok(lv.steps.length >= 1 && lv.steps.every((s) => typeof s.done === 'function'),
      `第 ${i + 1} 关每步都有完成判定`);
  });

  // 坦克关：放坦克挨 3 点不死，放步兵会被打死
  {
    const g = TUT.buildLevel(ENGINE, byKey.tank);
    ok(g.canPlace(1, 'tank', '0,0').ok, '坦克关：三个敌人正下方可以放子');
    g.place(1, 'tank', '0,0');
    eq(g.damageMap().get(TUT.findPiece(g, 1, 'tank').id), 3, '坦克关：坦克会挨 3 点');
    g.resolve();
    const tank = TUT.findPiece(g, 1, 'tank');
    ok(!!tank, '坦克关：坦克活下来了');
    eq(tank.hp, 4, '坦克关：伤害不累积，没到 4 点就满血');
    eq(TUT.units(g, 1), 2, '坦克关：我方 2 个棋子都在');

    const g2 = TUT.buildLevel(ENGINE, byKey.tank);
    g2.place(1, 'infantry', '0,0');
    g2.resolve();
    eq(TUT.units(g2, 1), 1, '坦克关：同样位置放步兵会被 3 点打死');
  }

  // 炮兵关：满血敌人 + 3 门炮，靠伤害叠加才打死（不是一炮秒杀）
  {
    const g = TUT.buildLevel(ENGINE, byKey.range);
    const foe = [...g.pieces.values()].find((p) => p.owner === 0 && p.kind === 'infantry');
    eq(foe.hp, 3, '炮兵关：敌人是满血 3 点（教学里不再用残血作弊）');
    const mine = [...g.pieces.values()].filter((p) => p.owner === 1 && p.kind !== 'base');
    eq(mine.length, 4, '炮兵关：我方 3 门炮 + 1 个步兵');
    ok(mine.every((p) => Hex.distance(Hex.parse(p.key), Hex.parse(foe.key)) === 2),
      '炮兵关：所有棋子都距敌 2 格（可比性）');
    const art = mine.filter((p) => p.kind === 'artillery');
    eq(art.length, 3, '炮兵关：3 门炮');
    eq(art.reduce((s, p) => s + p.atk, 0), 3, '炮兵关：三门炮合计 3 点，正好等于敌兵血量');
    eq(g.damageMap().get(foe.id), 3, '炮兵关：敌兵实际吃到 3 点');
    g.resolve();
    eq(TUT.units(g, 0), 0, '炮兵关：结算后敌兵被击杀');
    eq(TUT.units(g, 1), 4, '炮兵关：我方毫发无伤');
  }

  // 断联关 / 拆基地关
  {
    const g = TUT.buildLevel(ENGINE, byKey.cut);
    g.resolve();
    eq(TUT.units(g, 0), 1, '断联关：断联后只剩 1 个敌兵');
  }
  {
    const g = TUT.buildLevel(ENGINE, byKey.base);
    const base = g.board.baseA;
    const spot = [...g.legalCells(1)].find((k) => {
      const c = Hex.parse(k);
      return Hex.distance(c, base) <= 2 && g.canPlace(1, 'artillery', k).ok;
    });
    ok(!!spot, '拆基地关：存在射程内的落炮点');
    g.place(1, 'artillery', spot);
    g.resolve();
    ok(g.over && g.winner === 1, '拆基地关：结算后赤方获胜');
  }
}
console.log('== 8. 结算不限次数 ==');
{
  const g = new ENGINE.Game({ side: 5, density: 0, seed: 21 });
  const first = [...g.legalCells(g.active)][0];
  g.place(g.active, 'infantry', first);
  const r1 = g.resolve();
  eq(r1.resolveCount, 1, '第一次结算');
  // 连续结算不应报错，也不应改变局面
  const before = g.pieces.size;
  const r2 = g.resolve();
  ok(!!r2, '同一回合可以再结算');
  eq(r2.resolveCount, 2, '结算次数累加');
  eq(g.pieces.size, before, '没有新棋子时重复结算不改变局面');
  // 结算后还能继续放棋子，再结算
  const r3 = g.resolve();
  eq(r3.resolveCount, 3, '可以连续结算多次');
  let threw = false;
  try { g.place(g.active, 'infantry', [...g.legalCells(g.active)][0]); } catch (e) { threw = true; }
  ok(!threw, '结算之后仍然可以继续放置棋子');
  const r4 = g.resolve();
  eq(r4.resolveCount, 4, '放置之后再次结算');
  g.endTurn();
  eq(g.resolveCount, 0, '换人后结算次数归零');
}

console.log('== 9. 自定义数值（设置项） ==');
{
  const g = new ENGINE.Game({
    side: 4, density: 0, seed: 31,
    rules: { baseHp: 6, energyPerTurn: 5, firstPlayer: 0, firstTurnEnergy: [5, 7] },
    types: { infantry: { hp: 2, atk: 2, range: 1, cost: 3 } }
  });
  eq(g.rules.baseHp, 6, '自定义大本营血量');
  eq(g.rules.energyPerTurn, 5, '自定义每回合费用');
  eq(g.firstPlayer, 0, '自定义先手方');
  eq(g.active, 0, '先手方先行动');
  eq(g.energy, 5, '先手首回合费用');
  eq(g.baseOf(0).hp, 6, '基地按自定义血量生成');
  eq(g.types.infantry.hp, 2, '自定义步兵血量');
  eq(g.types.infantry.atk, 2, '自定义步兵攻击');
  eq(g.types.infantry.cost, 3, '自定义步兵费用');
  eq(g.types.infantry.name, '步兵', '自定义数值不影响名称/字形');
  eq(g.types.tank.hp, 4, '未自定义的坦克保留默认值');

  g.endTurn();
  eq(g.energy, 7, '后手首回合按 firstTurnEnergy 给费用');
  g.endTurn();
  eq(g.energy, 5, '第二回合回到每回合费用');

  // 2 血步兵吃 2 点就死
  const g2 = new ENGINE.Game({
    side: 5, density: 0, seed: 32,
    rules: { baseHp: 4, energyPerTurn: 3, firstPlayer: 1, firstTurnEnergy: [3, 3] },
    types: { infantry: { hp: 2, atk: 1, range: 1, cost: 1 } }
  });
  clearBoard(g2);
  const t = force(g2, 0, 'infantry', 1, -4);
  force(g2, 1, 'infantry', 2, -4);
  force(g2, 1, 'infantry', 0, -3);
  const res = g2.resolve();
  eq(res.damage.get(t.id), 2, '两个敌人 2 点伤害');
  eq(res.killedByDamage.length, 1, '2 血步兵吃 2 点死亡');
}
console.log('== 10. 新兵种：指挥所 / 狙击兵 / 奴隶主 ==');
{
  const mk = (energy) => new ENGINE.Game({
    side: 5, density: 0, seed: 41,
    rules: { baseHp: 4, energyPerTurn: energy || 20, firstPlayer: 1, firstTurnEnergy: [energy || 20, energy || 20] }
  });

  // 指挥所光环
  {
    const g = mk();
    clearBoard(g);
    const foe = force(g, 0, 'infantry', 0, 0);
    const inf = force(g, 1, 'infantry', 0, 1);
    eq(g.atkOf(inf), 1, '指挥所：无光环时攻击力为 1');
    const cmd = force(g, 1, 'command', 1, 1);
    eq(g.atkOf(inf), 2, '指挥所：相邻己方 +1 攻');
    eq(g.damageMap().get(foe.id), 2, '指挥所：敌人实际吃到 2 点');
    eq(g.atkOf(cmd), 0, '指挥所：自身不能攻击');
    eq(g.attackCells(cmd).size, 0, '指挥所：攻击范围为空');
    force(g, 1, 'command', -1, 1);
    eq(g.atkOf(inf), 3, '指挥所：两个光环可以叠加');
  }

  // 狙击兵直线
  {
    const g = mk();
    clearBoard(g);
    const sn = g.spawn(1, 'sniper', '0,2', 2, 2);   // 方向 2 = (0,-1)
    const cells = [...g.attackCells(sn)].sort();
    eq(cells.length, 3, '狙击兵：直线正好 3 格');
    ok(cells.every((k) => { const c = Hex.parse(k); return c.q === 0 && c.r < 2; }), '狙击兵：3 格都在选定方向上');
    sn.dir = 0;
    const cells2 = [...g.attackCells(sn)];
    ok(cells2.every((k) => { const c = Hex.parse(k); return c.q > 0; }), '狙击兵：换方向后改打 +q 一侧');
    const bad = g.canPlace(1, 'sniper', [...g.legalCells(1)][0]);
    ok(!bad.ok && /方向/.test(bad.msg), '狙击兵：部署必须带方向');
  }

  // 狙击兵只能打到直线上的人
  {
    const g = mk();
    clearBoard(g);
    g.spawn(1, 'sniper', '0,2', 2, 2);
    const onLine = force(g, 0, 'infantry', 0, 0);
    const offLine = force(g, 0, 'infantry', 1, 0);
    const dm = g.damageMap();
    eq(dm.get(onLine.id), 1, '狙击兵：直线上的敌人挨打');
    eq(dm.get(offLine.id), 0, '狙击兵：线外的敌人不挨打');
  }

  // 奴隶主
  {
    const g = mk(3);
    clearBoard(g);
    eq(g.freeSlavesLeft(1), 0, '奴隶主：没有奴隶主就没有免费奴隶');
    g.spawn(1, 'slaver', '0,2');
    eq(g.freeSlavesLeft(1), 1, '奴隶主：本回合 1 个免费奴隶');
    const before = g.energy;
    const legal = [...g.legalCells(1)][0];
    g.placeSlave(1, legal);
    eq(g.energy, before, '奴隶主：召唤奴隶不花费用');
    eq(g.freeSlavesLeft(1), 0, '奴隶主：用掉后额度归零');
    let threw = false;
    try { g.placeSlave(1, [...g.legalCells(1)][0]); } catch (e) { threw = true; }
    ok(threw, '奴隶主：额度用完不能再召唤');
    const cant = g.canPlace(1, 'slave', [...g.legalCells(1)][0]);
    ok(!cant.ok, '奴隶：不能直接用费用部署');
    g.endTurn(); g.endTurn();
    eq(g.freeSlavesLeft(1), 1, '奴隶主：新回合额度刷新');
  }

  // 序列化保留方向与配额
  {
    const g = mk();
    clearBoard(g);
    const sn = g.spawn(1, 'sniper', '0,2', 2, 4);
    g.slavesUsed[1] = 1;
    const back = ENGINE.Game.fromJSON(g.toJSON());
    const sn2 = [...back.pieces.values()].find((p) => p.kind === 'sniper');
    eq(sn2.dir, 4, '序列化：狙击方向保留');
    eq(back.slavesUsed[1], 1, '序列化：奴隶配额保留');
  }
}
console.log('== 11. 棋子替换 ==');
{
  const g = new ENGINE.Game({
    side: 4, density: 0, seed: 51,
    rules: { baseHp: 4, energyPerTurn: 6, firstPlayer: 1, firstTurnEnergy: [6, 6] }
  });
  clearBoard(g);
  force(g, 1, 'infantry', 0, 2);

  // 空格 → 己方棋子
  const tankCell = '0,2';
  eq(g.canPlace(1, 'tank', tankCell).ok, true, '替换：己方棋子所在格可以放新棋子');
  const energy0 = g.energy;
  const size0 = g.pieces.size;
  g.place(1, 'tank', tankCell);
  const now = g.pieces.get(g.occupant.get(tankCell));
  eq(now.kind, 'tank', '替换：格子上变成了坦克');
  eq(g.pieces.size, size0, '替换：棋子总数不变');
  eq(g.energy, energy0 - 2, '替换：只扣新棋子的费用');
  eq(g.kills[0] + g.kills[1], 0, '替换：不计入击杀');
  eq(g.history[g.history.length - 1].replacedKind, 'infantry', '替换：战报记录了被替换的兵种');

  // 同类替换被拒绝
  const same = g.canPlace(1, 'tank', tankCell);
  ok(!same.ok, '替换：同兵种原地替换会被拒绝');

  // 大本营不可替换
  const base = [...g.pieces.values()].find((p) => p.owner === 1 && p.kind === 'base');
  const onBase = g.canPlace(1, 'infantry', base.key);
  ok(!onBase.ok && /大本营/.test(onBase.msg), '替换：大本营不能替换');

  // 敌方棋子所在格不可替换
  force(g, 0, 'infantry', 1, 2);
  const onFoe = g.canPlace(1, 'infantry', '1,2');
  ok(!onFoe.ok, '替换：敌方棋子所在格不能直接放');

  // 可替换格集合
  const set = g.replaceableCells(1);
  ok(set.has(tankCell), '替换：己方格子在可替换集合里');
  ok(!set.has(base.key), '替换：大本营不在可替换集合里');
  ok(!set.has('1,2'), '替换：敌方棋子不在可替换集合里');

  // 狙击兵替换也要方向
  const noDir = g.canPlace(1, 'sniper', tankCell);
  ok(!noDir.ok && /方向/.test(noDir.msg), '替换：狙击兵替换同样要选方向');
  g.place(1, 'sniper', tankCell, { dir: 2 });
  eq(g.pieces.get(g.occupant.get(tankCell)).kind, 'sniper', '替换：可以换成狙击兵');
}
console.log('== 12. 可配置光环 ==');
{
  const mk = (types) => new ENGINE.Game({
    side: 5, density: 0, seed: 61,
    rules: { baseHp: 4, energyPerTurn: 20, firstPlayer: 1, firstTurnEnergy: [20, 20] },
    types: types || {}
  });

  // 内置指挥所仍是 1 格 +1 攻
  {
    const g = mk();
    clearBoard(g);
    force(g, 1, 'infantry', 0, 2);
    force(g, 1, 'command', 0, 3);
    const inf = [...g.pieces.values()].find((p) => p.owner === 1 && p.kind === 'infantry');
    eq(g.atkOf(inf), 2, '光环：指挥所相邻 +1 攻');
    const au = g.auraOf([...g.pieces.values()].find((p) => p.kind === 'command'));
    eq(au.radius, 1, '光环：指挥所半径 1');
    eq(au.effect, 'atk', '光环：指挥所效果是加攻');
  }

  // 加血光环 + 半径 2
  {
    const g = mk({ guard: { name: '卫兵', hp: 2, atk: 0, range: 0, cost: 1, rangeMode: 'none',
                            aura: { radius: 2, effect: 'hp', amount: 2 } } });
    clearBoard(g);
    const inf = force(g, 1, 'infantry', 0, 2);
    force(g, 1, 'guard', 1, 3);          // 距离 2
    eq(g.hpOf(inf), 5, '光环：半径 2 的加血 +2 → 5 血');
    const far = force(g, 1, 'infantry', -2, 3);
    eq(g.hpOf(far), 3, '光环：超出半径不吃光环');
  }

  // 敌方减攻 / 减血
  {
    const g = mk({
      weak: { name: '虚弱', hp: 2, atk: 0, range: 0, cost: 1, rangeMode: 'none',
              aura: { radius: 2, effect: 'enemyAtk', amount: 1 } },
      frail: { name: '易碎', hp: 2, atk: 0, range: 0, cost: 1, rangeMode: 'none',
               aura: { radius: 2, effect: 'enemyHp', amount: 2 } }
    });
    clearBoard(g);
    const foe = force(g, 0, 'infantry', 0, 0);
    eq(g.atkOf(foe), 1, '光环：敌方基础攻击 1');
    force(g, 1, 'weak', 0, 1);
    eq(g.atkOf(foe), 0, '光环：敌方减攻让攻击归零');
    force(g, 1, 'frail', 1, 0);
    eq(g.hpOf(foe), 1, '光环：敌方减血 -2 → 1 血');
    g.resolve();
    ok(!g.pieces.has(foe.id), '光环：被减血的敌人 1 点伤害就死');
  }

  // 减攻不会出现负伤害
  {
    const g = mk({ weak2: { name: '虚弱2', hp: 2, atk: 0, range: 0, cost: 1, rangeMode: 'none',
                            aura: { radius: 2, effect: 'enemyAtk', amount: 3 } } });
    clearBoard(g);
    const foe = force(g, 0, 'infantry', 0, 0);
    force(g, 1, 'weak2', 0, 1);
    eq(g.atkOf(foe), 0, '光环：减攻到 0 后不再变负');
    ok(g.attackCells(foe).size > 0, '光环：攻击力 0 时依然不会误伤（范围还在但伤害为 0）');
  }

  // 序列化保留光环结构
  {
    const g = mk({ modx: { name: '自定义', hp: 3, atk: 1, range: 1, cost: 2,
                           aura: { radius: 3, effect: 'enemyHp', amount: 4 } } });
    const back = ENGINE.Game.fromJSON(g.toJSON());
    const t = back.types.modx;
    ok(!!t, '光环：自定义兵种序列化后还在');
    eq(t.aura.radius, 3, '光环：序列化保留半径');
    eq(t.aura.effect, 'enemyHp', '光环：序列化保留效果类型');
    eq(t.aura.amount, 4, '光环：序列化保留数值');
  }
}
console.log('== 13. 狙击兵朝向 ==');
{
  const g = new ENGINE.Game({
    side: 5, density: 0, seed: 71,
    rules: { baseHp: 4, energyPerTurn: 9, firstPlayer: 1, firstTurnEnergy: [9, 9] }
  });
  const enemyBase = g.baseOf(0);
  eq(enemyBase.key, '0,-4', '敌方大本营在地图上方');
  const d = g.dirToward('0,2', enemyBase.key);
  eq(d, 2, 'dirToward：赤方棋子默认朝上（方向 2）');
  const from = Hex.parse('0,2');
  const next = { q: from.q + Hex.DIRS[d].q, r: from.r + Hex.DIRS[d].r };
  ok(Hex.distance(next, Hex.parse(enemyBase.key)) < Hex.distance(from, Hex.parse(enemyBase.key)),
    'dirToward：选出的方向确实更靠近敌营');

  // 沿这个方向放一个狙击兵，能打到自己正上方的敌人
  const sn = g.spawn(1, 'sniper', '0,2', 2, d);
  const cells = [...g.attackCells(sn)].sort();
  eq(cells.length, 3, '沿默认方向的狙击兵有 3 格直线');
  ok(cells.indexOf('0,-1') >= 0, '直线覆盖正上方 3 格');

  // 换个方位也对
  const d2 = g.dirToward('2,1', enemyBase.key);
  const f2 = Hex.parse('2,1');
  const n2 = { q: f2.q + Hex.DIRS[d2].q, r: f2.r + Hex.DIRS[d2].r };
  ok(Hex.distance(n2, Hex.parse(enemyBase.key)) < Hex.distance(f2, Hex.parse(enemyBase.key)),
    'dirToward：边缘位置的朝向也正确');

  // 方向不同 → 打到的格子不同
  const sn2 = g.spawn(1, 'sniper', '1,1', 2, 3);   // 朝左
  const c2 = [...g.attackCells(sn2)];
  ok(c2.every((k) => Hex.parse(k).q < 1), '方向 3 的狙击兵只打左侧');
}
console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);

