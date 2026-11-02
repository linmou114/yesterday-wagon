/* AI 自检：能不能合法落子、会不会卡死、打得过乱下的人吗 */
const ENGINE = require('../js/engine.js');
const AI = require('../js/ai.js');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.log('  ✗ ' + msg); }
}

console.log('== 1. AI 落子合法 ==');
{
  for (const side of [3, 4, 5, 6]) {
    const g = new ENGINE.Game({ side, density: 0.12, seed: 700 + side });
    let moves = 0;
    for (let turn = 0; turn < 8 && !g.over; turn++) {
      AI.playTurn(g);
      ok(g.pieces.size >= 2, `边长 ${side} 回合 ${turn}：双方基地都应该还在`);
      const ps = [...g.pieces.values()];
      let bad = 0;
      for (const p of ps) {
        const cell = g.board.cells.get(p.key);
        if (!cell || cell.obstacle) bad++;
        if (g.occupant.get(p.key) !== p.id) bad++;
      }
      ok(bad === 0, `边长 ${side} 回合 ${turn}：棋子都在合法格子上`);
      moves++;
      if (g.over) break;
      g.endTurn();
    }
    ok(moves > 0, `边长 ${side}：AI 能行动`);
  }
}

console.log('== 2. AI 对局能推进 / 不崩 ==');
{
  let finished = 0;
  let turns = 0;
  const N = 12;
  for (let i = 0; i < N; i++) {
    const g = new ENGINE.Game({ side: 5, density: 0.12, seed: 2000 + i });
    let t = 0;
    while (!g.over && t < 120) {
      AI.playTurn(g);
      if (g.over) break;
      g.endTurn();
      t++;
    }
    turns += t;
    if (g.over) finished++;
    ok(g.occupant.size === g.pieces.size, `seed ${2000 + i} 状态一致`);
  }
  console.log(`  ${N} 局中 ${finished} 局分出胜负，平均 ${(turns / N).toFixed(1)} 回合`);
  ok(finished >= 1, 'AI 之间至少能打出一局胜负');
}

console.log('== 3. AI vs 随机乱下 ==');
{
  // 青方 = AI，赤方 = 随机；打 20 局看 AI 胜率
  let aiWin = 0, randomWin = 0, draw = 0, stall = 0;
  for (let i = 0; i < 20; i++) {
    const seed = 3000 + i;
    const rng = ENGINE.mulberry32(seed * 7 + 1);
    const g = new ENGINE.Game({ side: 4, density: 0.1, seed });
    let t = 0;
    while (!g.over && t < 200) {
      if (g.active === 0) {
        AI.playTurn(g);
      } else {
        // 随机：能放就随便放，随机决定要不要结算
        let guard = 0;
        while (g.energy > 0 && guard++ < 8) {
          const legal = [...g.legalCells(1)];
          const types = ENGINE.TYPE_LIST.filter((k) => g.types[k].cost <= g.energy);
          if (!legal.length || !types.length) break;
          const pk = types[Math.floor(rng() * types.length)];
          const pc = legal[Math.floor(rng() * legal.length)];
          if (g.types[pk].rangeMode === 'line') g.place(1, pk, pc, { dir: Math.floor(rng() * 6) });
          else g.place(1, pk, pc);
        }
        if (rng() < 0.5) g.resolve();
      }
      if (g.over) break;
      g.endTurn();
      t++;
    }
    if (!g.over) stall++;
    else if (g.winner === 0) aiWin++;
    else if (g.winner === 1) randomWin++;
    else draw++;
  }
  console.log(`  AI ${aiWin} 胜 / 随机 ${randomWin} 胜 / 平 ${draw} / 未分 ${stall}`);
  ok(aiWin > randomWin, 'AI 应该打得过乱下的一方');
}

console.log('== 4. 速度 ==');
{
  const g = new ENGINE.Game({ side: 7, density: 0.12, seed: 4242 });
  // 先铺一些棋子，模拟中局
  for (let i = 0; i < 6 && !g.over; i++) {
    AI.playTurn(g);
    g.endTurn();
  }
  const t0 = Date.now();
  const mv = AI.chooseMove(g);
  const dt = Date.now() - t0;
  console.log(`  边长 7 中局选点耗时 ${dt}ms`);
  ok(dt < 1500, '单次选点应在 1.5 秒内完成');
  ok(!!mv, '中局应该还有可落子的点');
}

console.log('== 5. 光环 / 新规则感知 ==');
{
  const mk = (types) => new ENGINE.Game({
    side: 5, density: 0, seed: 31,
    rules: { baseHp: 4, energyPerTurn: 9, firstPlayer: 1, firstTurnEnergy: [9, 9] },
    types: types || {}
  });

  const g1 = mk();
  const alone = AI.pieceValue(g1, g1.spawn(1, 'command', '-2,3'));
  const g2 = mk();
  g2.spawn(1, 'infantry', '0,2');
  g2.spawn(1, 'infantry', '1,2');
  g2.spawn(1, 'infantry', '-1,2');
  const covered = AI.pieceValue(g2, g2.spawn(1, 'command', '0,3'));
  ok(covered > alone + 1, '光环覆盖 3 个友军时估值更高（' + alone.toFixed(1) + ' → ' + covered.toFixed(1) + '）');

  const auraT = { radius: 2, effect: 'enemyHp', amount: 2 };
  const g3 = mk({ debuff: { name: '腐蚀', hp: 2, atk: 0, range: 0, cost: 1, rangeMode: 'none', aura: auraT } });
  g3.spawn(0, 'infantry', '0,0');
  g3.spawn(0, 'infantry', '1,0');
  const dBuff = AI.pieceValue(g3, g3.spawn(1, 'debuff', '0,1'));
  const g4 = mk({ debuff: { name: '腐蚀', hp: 2, atk: 0, range: 0, cost: 1, rangeMode: 'none', aura: auraT } });
  const dAlone = AI.pieceValue(g4, g4.spawn(1, 'debuff', '0,1'));
  ok(dBuff > dAlone, '削弱敌人的光环也算价值');

  const g5 = mk();
  g5.spawn(1, 'slaver', '0,3');
  g5.spawn(1, 'infantry', '0,2');
  g5.spawn(1, 'infantry', '0,1');
  const sv = AI.chooseSlave(g5);
  ok(!!sv, '有奴隶主时 AI 想召唤奴隶');
  const dd = Hex.distance(Hex.parse(sv.cell), Hex.parse('0,3'));
  ok(dd === 1, 'AI 选的奴隶位置紧贴奴隶主（距离 ' + dd + '）');

  const g6 = mk({ mod_x: { name: '重炮', glyph: '重', hp: 3, atk: 2, range: 2, cost: 2, rangeMode: 'circle' } });
  g6.spawn(1, 'infantry', '0,2');
  ok(!!AI.chooseMove(g6), '带自定义兵种时 AI 也能选点');

  const g8 = mk();
  const a = g8.spawn(1, 'tank', '0,2');
  const healthy = AI.pieceValue(g8, a);
  a.hp = 1;
  ok(AI.pieceValue(g8, a) < healthy, '残血棋子估值更低');

  const g9 = mk();
  g9.spawn(1, 'infantry', '0,2');
  ok(g9.legalCells(1).size > 0, '正常情况下有合法落点');
  const mv9 = AI.chooseMove(g9);
  ok(mv9 && typeof mv9.cell === 'string' && typeof mv9.score === 'number', 'AI 返回可用的选点结果');
}
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
