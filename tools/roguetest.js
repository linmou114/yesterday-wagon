const path = require('path');
const ENGINE = require('../js/engine.js');
const ROGUE = require('../js/rogue.js');
const Hex = require('../js/hex.js');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + msg); } }
function eq(a, b, msg) { ok(a === b, msg + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function section(t) { console.log('== ' + t); }

function mk(opts) {
  const g = new ENGINE.Game(Object.assign({ side: 5, density: 0, seed: 12345, rogue: true }, opts || {}));
  g.turn = 3; g.active = 0; g.energy = 3;
  return g;
}
// 强制三选一里出现想要的卡
function force(g, o, id) {
  const pk = g.perksOf(o);
  pk.offer = [id, 'prod', 'armor'];
  pk.offerTurn = g.turn;
  return pk;
}

section('1. 发牌时机');
{
  const g = mk(); g.turn = 1; g.active = 0; g.energy = 3;
  ok(!ROGUE.needsOffer(g, 0), '第 1 回合不发牌');
  g.turn = 2; ok(!ROGUE.needsOffer(g, 0), '第 2 回合不发牌');
  g.turn = 3; ok(ROGUE.needsOffer(g, 0), '第 3 回合发牌');
  const off = ROGUE.ensureOffer(g, 0);
  eq(off.length, 3, '三张卡');
  eq(new Set(off).size, 3, '三张不重复');
  const again = ROGUE.ensureOffer(g, 0);
  eq(again.join(','), off.join(','), '重复调用还是同一手牌');
}

section('2. 同种子同回合的牌一样');
{
  const a = mk(), b = mk();
  const x = ROGUE.ensureOffer(a, 0).join(',');
  b.turn = 3; b.active = 0; b.energy = 3;
  const y = ROGUE.ensureOffer(b, 0).join(',');
  eq(x, y, '确定性发牌');
}

section('3. 选卡与回合限制');
{
  const g = mk();
  force(g, 0, 'prod');
  const before = g.energy;
  const r = ROGUE.pick(g, 0, 'prod', {});
  ok(r.ok, '生产可以选');
  eq(g.energy, before + 2, '生产 +2 费');
  eq(g.perksOf(0).pickedTurn, 3, '记录已选回合');
  ok(!ROGUE.needsOffer(g, 0), '本回合不再发牌');
  const r2 = ROGUE.pick(g, 0, 'prod', {});
  ok(!r2.ok, '同回合不能选第二次');
  ok(g.perksOf(0).cards.indexOf('prod') >= 0, '记入已获能力');
}

section('4. 跳过');
{
  const g = mk();
  ROGUE.ensureOffer(g, 0);
  const r = ROGUE.skip(g, 0);
  ok(r.ok, '可以跳过');
  ok(!ROGUE.needsOffer(g, 0), '跳过后不再发牌');
  eq(ROGUE.obtained(g, 0).length, 0, '跳过不加卡');
}

section('5. 坚固装甲 / 小队长');
{
  const g = mk();
  const t = g.spawn(0, 'tank', '0,2');
  force(g, 0, 'armor');
  const hp0 = t.hp;
  ok(ROGUE.pick(g, 0, 'armor', { key: t.key }).ok, '装甲命中坦克');
  eq(g.pieceAt(t.key).hp, hp0 + 2, '坦克 +2 血');

  const g2 = mk();
  const p = g2.spawn(0, 'infantry', '0,2');
  const buddy = g2.spawn(0, 'infantry', '1,2');
  force(g2, 0, 'leader');
  const atkBuddy = g2.atkOf(buddy);
  ok(ROGUE.pick(g2, 0, 'leader', { key: p.key }).ok, '小队长命中');
  eq(g2.pieceAt(p.key).atk, 2, '小队长自己 +1 攻');
  eq(g2.atkOf(buddy), atkBuddy + 1, '邻格友军 +1 攻');
}

section('6. 地形修改');
{
  const g = mk();
  const empty = [...g.board.cells.keys()].find((k) => {
    const c = g.board.cells.get(k);
    return !c.obstacle && !g.pieceAt(k) && !g.baseOf(0).key.includes(k);
  });
  force(g, 0, 'terrain');
  ok(ROGUE.pick(g, 0, 'terrain', { key: empty }).ok, '放障碍');
  ok(g.board.cells.get(empty).obstacle, '格子变成障碍');
}

section('7. 晋升');
{
  const g = mk();
  const p = g.spawn(0, 'infantry', '0,2');
  force(g, 0, 'promote');
  ok(ROGUE.pick(g, 0, 'promote', {}).ok, '拿到晋升');
  eq(g.perksOf(0).promoteLeft, 1, '额度 1');
  const r = ROGUE.promote(g, 0, p.key, 'artillery');
  ok(r.ok, '可以晋升成炮兵');
  eq(g.pieceAt(p.key).kind, 'artillery', '兵种变了');
  eq(g.perksOf(0).promoteLeft, 0, '额度用完');
  ok(!ROGUE.promote(g, 0, p.key, 'tank').ok, '没额度不能再晋升');
}

section('8. 天降奇兵（免费部署）');
{
  const g = mk();
  force(g, 0, 'drop-tank');
  ok(ROGUE.pick(g, 0, 'drop-tank', {}).ok, '拿到免费坦克');
  eq(g.freeTokenLeft(0, 'tank'), 1, '券 1 张');
  eq(g.costFor(0, 'tank'), 0, '费用变 0');
  const before = g.energy;
  const cell = [...g.legalCells(0)][0];
  g.place(0, 'tank', cell);
  eq(g.energy, before, '不扣费');
  eq(g.freeTokenLeft(0, 'tank'), 0, '券被消费');
  eq(g.costFor(0, 'tank'), 2, '恢复原价');
}

section('9. 隐匿');
{
  const g = mk();
  const p = g.spawn(0, 'infantry', '0,0');
  const far = g.spawn(1, 'artillery', '0,2');
  const dmg0 = g.damageMap().get(p.id);
  force(g, 0, 'hide');
  ok(ROGUE.pick(g, 0, 'hide', { key: p.key }).ok, '隐匿命中');
  ok(g.pieceAt(p.key).hidden, '标记 hidden');
  ok(dmg0 > 0, '之前会被远程打到');
  ok(!(g.damageMap().get(p.id) > 0), '隐匿后远程打不到');
}

section('10. gxyy（狙击无限射程）');
{
  const g = mk();
  const s = g.spawn(0, 'sniper', '0,0', null, 0);
  const n0 = g.attackCells(g.pieceAt(s.key)).size;
  force(g, 0, 'gxyy');
  ok(ROGUE.pick(g, 0, 'gxyy', {}).ok, '拿到 gxyy');
  const n1 = g.attackCells(g.pieceAt(s.key)).size;
  ok(n1 > n0, '射程变长 (' + n0 + ' -> ' + n1 + ')');
}

section('11. 高效通信 / 多功能指挥');
{
  const g = mk();
  const cmd = g.spawn(0, 'command', '0,0');
  const near = g.spawn(0, 'infantry', '0,1');
  const far2 = g.spawn(0, 'infantry', '0,2');
  eq(g.atkOf(far2), 1, '半径 1 时两格外不加攻');
  force(g, 0, 'comms');
  ok(ROGUE.pick(g, 0, 'comms', {}).ok, '拿到通信');
  eq(g.atkOf(far2), 2, '半径 +1 后两格内也加攻');
  eq(g.atkOf(near), 2, '一格内仍然 +1');

  const g2 = mk();
  const cmd2 = g2.spawn(0, 'command', '0,0');
  const b = g2.spawn(0, 'infantry', '0,1');
  force(g2, 0, 'multi');
  ok(ROGUE.pick(g2, 0, 'multi', {}).ok, '拿到多功能');
  eq(g2.hpOf(b), b.maxHp + 1, '光环同时加血');
  eq(g2.atkOf(b), 2, '光环同时加攻');
}

section('12. 城防炮');
{
  const g = mk();
  const art = g.spawn(0, 'artillery', '0,1');
  const foe = g.spawn(1, 'infantry', '0,3');
  force(g, 0, 'fortress');
  ok(ROGUE.pick(g, 0, 'fortress', { key: art.key }).ok, '城防炮成立');
  ok(!g.pieceAt(art.key), '棋子没了');
  eq(g.perksOf(0).phantoms.length, 1, '留下火力');
  ok(g.damageMap().get(foe.id) > 0, '原地仍在打人');
}

section('13. 俘虏');
{
  const g = mk();
  // 连成一条：大本营(0,-4) <- 奴隶主(0,-3) <- 奴隶(0,-2) <- 炮兵(0,-1)
  g.spawn(0, 'slaver', '0,-3');
  const slave = g.spawn(0, 'slave', '0,-2');
  const foe = g.spawn(1, 'infantry', '1,-2', 1);   // 1 血，紧挨着奴隶
  const killer = g.spawn(0, 'artillery', '0,-1');
  force(g, 0, 'capture');
  ok(ROGUE.pick(g, 0, 'capture', {}).ok, '拿到俘虏');
  const res = g.resolve();
  const ev = (res.perkEvents || []).filter((e) => e.type === 'capture');
  ok(ev.length >= 1, '触发俘虏 (' + JSON.stringify(res.perkEvents) + ')');
  const up = g.pieceAt(slave.key);
  ok(up && up.kind === 'slaver', '奴隶升级为奴隶主');
  const reborn = g.pieceAt(foe.key);
  ok(reborn && reborn.owner === 0 && reborn.kind === 'slave', '阵亡的敌人变成我方奴隶');
}

section('14. 生产改造 / 征兵 / 临时大本营 / 解放');
{
  const g = mk();
  force(g, 0, 'prod-up');
  const e0 = g.turnEnergy();
  ok(ROGUE.pick(g, 0, 'prod-up', {}).ok, '拿到生产改造');
  eq(g.turnEnergy(), e0 + 1, '每回合费用 +1');

  const g2 = mk();
  force(g2, 0, 'recruit');
  ok(ROGUE.pick(g2, 0, 'recruit', {}).ok, '拿到征兵');
  g2.active = 0; g2.endTurn(); g2.endTurn();
  eq(g2.freeTokenLeft(0, 'infantry'), 1, '每回合白嫖步兵');

  const g3 = mk();
  g3.spawn(0, 'slaver', '0,0');
  force(g3, 0, 'free-slave');
  ok(ROGUE.pick(g3, 0, 'free-slave', {}).ok, '拿到解放');
  const anyCell = [...g3.board.cells.keys()].find((k) => {
    const c = g3.board.cells.get(k);
    return !c.obstacle && !g3.pieceAt(k);
  });
  ok(!!g3.placeSlave(0, anyCell), '奴隶可以放任意空格');
}

section('15. AI 选卡');
{
  const g = mk();
  force(g, 0, 'prod');
  const got = ROGUE.aiPick(g, 0);
  ok(!!got, 'AI 拿到一张');
  ok(g.perksOf(0).cards.length === 1, '记入 1 张');
  eq(g.perksOf(0).pickedTurn, 3, '标记已选');
}

section('16. 存档往返');
{
  const g = mk();
  const p = g.spawn(0, 'tank', '0,2');
  force(g, 0, 'armor');
  ROGUE.pick(g, 0, 'armor', { key: p.key });
  g.perksOf(0).freeDeploy.tank = 2;
  const js = JSON.parse(JSON.stringify(g.toJSON()));
  const g2 = ENGINE.Game.fromJSON(js);
  ok(g2.rogue, 'rogue 标记保留');
  eq(g2.perksOf(0).cards.length, 1, '已获能力保留');
  eq(g2.freeTokenLeft(0, 'tank'), 2, '免费券保留');
  eq(g2.pieceAt(p.key).hp, 6, '棋子加成保留');
}

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
