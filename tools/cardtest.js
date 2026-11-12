/* =========================================================
 * cardtest.js —— 肉鸽能力卡逐张实测
 *
 *   每张卡都造一个具体局面，选卡（或执行晋升）后检查真实数值变化：
 *   费用、棋子血量/攻击/射程、光环、免费券、障碍、断联、死亡继承……
 *
 *   跑法： node tools/cardtest.js
 * ========================================================= */
'use strict';

const ENGINE = require('../js/engine.js');
const ROGUE = require('../js/rogue.js');
const Hex = require('../js/hex.js');

let pass = 0;
let fail = 0;
const rows = [];

function t(name, fn) {
  try {
    const detail = fn();
    pass++;
    rows.push({ ok: true, name, detail: detail || '' });
  } catch (e) {
    fail++;
    rows.push({ ok: false, name, detail: (e && e.message) || String(e) });
  }
}

function ok(v, msg) { if (!v) throw new Error(msg || '断言失败'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg ? msg + '：' : '') + '期望 ' + b + '，实际 ' + a);
}
function near(a, b, msg) { eq(Number(a).toFixed(2), Number(b).toFixed(2), msg); }

function mk() {
  const g = new ENGINE.Game({ side: 5, density: 0, seed: 777, rogue: true });
  g.turn = 3;
  g.active = 0;
  g.energy = 3;
  return g;
}

// 把卡塞进本回合的三选一，再选它
function take(g, id, args, owner) {
  const o = owner == null ? 0 : owner;
  const pk = g.perksOf(o);
  pk.offer = [id];
  pk.offerTurn = g.turn;
  pk.pickedTurn = 0;
  return ROGUE.pick(g, o, id, args || {});
}

function takeOk(g, id, args, owner) {
  const r = take(g, id, args, owner);
  if (!r.ok) throw new Error('选卡失败：' + r.msg);
  return r;
}

// 找一个「己方连通块边缘」的空格
function frontierCell(g, owner) {
  const cells = [...g.legalCells(owner == null ? 0 : owner)];
  if (!cells.length) throw new Error('没有可放置的格子');
  return cells[0];
}

/* =========================================================
 * 每张卡
 * ========================================================= */

t('生产 · 本回合费用 +2', () => {
  const g = mk();
  takeOk(g, 'prod');
  eq(g.energy, 5, '费用');
  return '费用 3 → 5';
});

t('天降奇兵 · 坦克（免费券只顶一次）', () => {
  const g = mk();
  takeOk(g, 'drop-tank');
  eq(g.freeTokenLeft(0, 'tank'), 1, '券');
  const p = g.place(0, 'tank', frontierCell(g));
  eq(g.energy, 3, '第一辆不花钱');
  eq(g.freeTokenLeft(0, 'tank'), 0, '券已用掉');
  ok(p && p.kind === 'tank', '坦克已放下');
  // 第二辆要自己掏钱
  const cell2 = frontierCell(g);
  g.place(0, 'tank', cell2);
  eq(g.energy, 1, '第二辆花 2 费');
  return '第一辆 0 费、第二辆 2 费';
});

t('天降奇兵 · 炮兵', () => {
  const g = mk();
  takeOk(g, 'drop-art');
  g.place(0, 'artillery', frontierCell(g));
  eq(g.energy, 3, '费用不变');
  return '炮兵免费（原价 2）';
});

t('天降奇兵 · 指挥所', () => {
  const g = mk();
  takeOk(g, 'drop-cmd');
  g.place(0, 'command', frontierCell(g));
  eq(g.energy, 3, '费用不变');
  return '指挥所免费（原价 2）';
});

t('天降奇兵 · 狙击兵', () => {
  const g = mk();
  takeOk(g, 'drop-sni');
  const p = g.place(0, 'sniper', frontierCell(g), { dir: 0 });
  eq(g.energy, 3, '费用不变');
  eq(p.dir, 0, '方向');
  return '狙击兵免费（原价 2，带方向 0）';
});

t('天降奇兵 · 奴隶主', () => {
  const g = mk();
  takeOk(g, 'drop-slav');
  g.place(0, 'slaver', frontierCell(g));
  eq(g.energy, 3, '费用不变');
  return '奴隶主免费（原价 2）';
});

t('隐匿 · 只受相邻伤害', () => {
  const g = mk();
  const p = g.spawn(0, 'infantry', '0,-3');
  const far = g.spawn(1, 'artillery', '0,-1');   // 距离 2
  const before = g.damageMap().get(p.id);
  takeOk(g, 'hide', { key: p.key });
  ok(g.pieceAt(p.key).hidden, 'hidden 标记');
  const after = g.damageMap().get(p.id);
  eq(before, 1, '之前会被远程打到');
  eq(after, 0, '隐匿后远程打不到');
  return '远程伤害 ' + before + ' → ' + after;
});

t('晋升 · 改造后不扣费用', () => {
  const g = mk();
  const p = g.spawn(0, 'infantry', '0,-3');
  takeOk(g, 'promote');
  eq(g.perksOf(0).promoteLeft, 1, '额度');
  const r = ROGUE.promote(g, 0, p.key, 'tank');
  ok(r.ok, '晋升失败：' + r.msg);
  eq(g.energy, 3, '费用没被扣');
  eq(g.pieceAt(p.key).kind, 'tank', '兵种');
  eq(g.pieceAt(p.key).hp, 4, '血量按新兵种');
  eq(g.perksOf(0).promoteLeft, 0, '额度已用');
  const again = ROGUE.promote(g, 0, p.key, 'artillery');
  ok(!again.ok, '没有额度时应该拒绝');
  return '步兵 → 坦克，费用 3 保持 3';
});

t('晋升 · 非法目标会被拒绝', () => {
  const g = mk();
  const inf = g.spawn(0, 'infantry', '0,-3');
  const foe = g.spawn(1, 'infantry', '0,-1');
  takeOk(g, 'promote');
  ok(!ROGUE.promote(g, 0, inf.key, 'slave').ok, '不能变奴隶');
  ok(!ROGUE.promote(g, 0, g.baseOf(0).key, 'tank').ok, '不能改大本营');
  ok(!ROGUE.promote(g, 0, foe.key, 'tank').ok, '不能改敌方');
  ok(!ROGUE.promote(g, 0, '2,-2', 'tank').ok, '空格不能改');
  eq(g.energy, 3, '费用不变');
  return '奴隶/大本营/敌方/空格 全部拒绝';
});

t('坚固装甲 · 坦克 +2 血', () => {
  const g = mk();
  const p = g.spawn(0, 'tank', '0,-3');
  takeOk(g, 'armor', { key: p.key });
  eq(g.pieceAt(p.key).hp, 6, '血量');
  eq(g.pieceAt(p.key).maxHp, 6, '上限');
  eq(g.energy, 3, '费用不变');
  return '坦克 4/4 → 6/6';
});

t('小队长 · +1 攻 +1 血 + 半径 1 光环', () => {
  const g = mk();
  const p = g.spawn(0, 'infantry', '0,-3');
  const ally = g.spawn(0, 'infantry', '1,-3');
  takeOk(g, 'leader', { key: p.key });
  eq(g.pieceAt(p.key).atk, 2, '本体攻击');
  eq(g.pieceAt(p.key).maxHp, 4, '本体血量');
  eq(g.atkOf(ally), 2, '相邻友军 +1 攻');
  return '步兵 1/3 → 2/4，邻兵攻击 1 → 2';
});

t('三角贸易 · 3 个免费奴隶名额', () => {
  const g = mk();
  g.spawn(0, 'slaver', '0,-3');
  takeOk(g, 'trade');
  eq(g.freeTokenLeft(0, 'slave'), 3, '赠送额度');
  const cells = [...g.slaveCells(0)];
  eq(g.freeSlavesLeft(0), 4, '总名额 = 奴隶主 1 + 赠送 3');
  let placed = 0;
  for (let i = 0; i < 4 && placed < 4; i++) {
    const cellsNow = [...g.slaveCells(0)];
    if (!cellsNow.length) break;
    g.placeSlave(0, cellsNow[0]);
    placed++;
  }
  eq(placed, 4, '实际能召唤 4 个');
  eq(g.freeSlavesLeft(0), 0, '名额用光');
  let threw = false;
  try { g.placeSlave(0, [...g.slaveCells(0)][0] || '0,-2'); } catch (e) { threw = true; }
  ok(threw, '第 5 个应该失败');
  eq(g.energy, 3, '费用不变');
  return '1 奴隶主 + 3 赠送 = 召唤 4 个奴隶，全免费';
});

t('隐蔽战术 · 狙击兵永久隐匿', () => {
  const g = mk();
  const sni = g.spawn(0, 'sniper', '0,-3');
  takeOk(g, 'stealth');
  ok(g.hasFlag(0, 'hiddenSnipers'), '旗标');
  ok(g.pieceAt(sni.key).hidden, '已有狙击兵也隐匿');
  const p2 = g.place(0, 'sniper', frontierCell(g), { dir: 1 });
  ok(p2.hidden, '之后放的狙击兵自动隐匿');
  return '已有 + 新放的狙击兵都 hidden';
});

t('生产+ · 本回合费用 +3', () => {
  const g = mk();
  takeOk(g, 'prod-plus');
  eq(g.energy, 6, '费用');
  return '费用 3 → 6';
});

t('地形修改 · 任意空格变障碍', () => {
  const g = mk();
  const cell = '2,0';
  const before = g.board.obstacles || 0;
  takeOk(g, 'terrain', { key: cell });
  ok(g.board.cells.get(cell).obstacle, '这一格成了障碍');
  eq(g.board.obstacles || 0, before + 1, '障碍计数');
  const r = take(g, 'terrain', { key: cell });   // 同一格再放
  ok(!r.ok, '已占用/障碍格应该失败');
  return '棋盘中央 (2,0) 变成障碍';
});

t('征兵 · 每回合白嫖一个步兵', () => {
  const g = mk();
  takeOk(g, 'recruit');
  ok(g.hasFlag(0, 'recruit'), '旗标');
  eq(g.freeTokenLeft(0, 'infantry'), 0, '当回合不给');
  g.endTurn();
  g.endTurn();
  eq(g.freeTokenLeft(0, 'infantry'), 1, '下一回合自动给 1 张');
  g.endTurn();
  g.endTurn();
  eq(g.freeTokenLeft(0, 'infantry'), 2, '每回合都补');
  return '第 2、3 个回合各 +1 张步兵券';
});

t('战地晋升 · 2 次改造', () => {
  const g = mk();
  const a = g.spawn(0, 'infantry', '0,-3');
  const b = g.spawn(0, 'infantry', '1,-3');
  takeOk(g, 'promote2');
  eq(g.perksOf(0).promoteLeft, 2, '额度');
  ok(ROGUE.promote(g, 0, a.key, 'artillery').ok, '第一次');
  ok(ROGUE.promote(g, 0, b.key, 'tank').ok, '第二次');
  eq(g.pieceAt(a.key).kind, 'artillery', 'a');
  eq(g.pieceAt(b.key).kind, 'tank', 'b');
  eq(g.perksOf(0).promoteLeft, 0, '额度用光');
  ok(!ROGUE.promote(g, 0, a.key, 'sniper').ok, '第三次应该拒绝');
  eq(g.energy, 3, '两次改造都没扣费');
  return '2 个步兵分别变炮兵/坦克，费用不变';
});

t('步坦协同 · 交换位置', () => {
  const g = mk();
  const tank = g.spawn(0, 'tank', '0,-3');
  const inf = g.spawn(0, 'infantry', '1,-3');
  takeOk(g, 'tank-swap', { key: tank.key, target: inf.key });
  eq(g.pieceAt('0,-3').kind, 'infantry', '(0,-3) 现在是步兵');
  eq(g.pieceAt('1,-3').kind, 'tank', '(1,-3) 现在是坦克');
  eq(g.occupant.get('0,-3'), inf.id, '占位表同步');
  return '坦克 ⇄ 步兵';
});

t('某人的执念 · 炮兵光环可叠加', () => {
  const g = mk();
  const art = g.spawn(0, 'artillery', '0,-3');
  g.spawn(0, 'command', '1,-3');
  g.spawn(0, 'command', '-1,-2');
  eq(g.atkOf(art), 2, '没有执念时只取最高 +1');
  takeOk(g, 'obsession');
  eq(g.atkOf(art), 3, '拿到执念后两个光环都算');
  // 其他兵种不受影响：放一个够不着任何光环的步兵
  const inf = g.spawn(0, 'infantry', '0,1');
  eq(g.atkOf(inf), 1, '其他兵种仍取最高（这里够不着光环）');
  return '炮兵 1 → 3 攻（两个指挥所叠加）';
});

t('高射炮 · 射程中心偏移一格', () => {
  const g = mk();
  const art = g.spawn(0, 'artillery', '0,-3');
  const beforeSet = [...g.attackCells(g.pieceAt(art.key))].sort().join('|');
  takeOk(g, 'flak', { key: art.key, dir: 1 });
  const p = g.pieceAt(art.key);
  eq(p.shiftDir, 1, '方向记录');
  const center = Hex.neighbors(0, -3)[1];
  const selfKey = '0,-3';
  const expected = [];
  g.board.cells.forEach((c) => {
    if (c.key === selfKey) return;              // 炮自己的格子不在打击范围
    if (Hex.distance({ q: center.q, r: center.r }, { q: c.q, r: c.r }) <= p.range) expected.push(c.key);
  });
  const got = [...g.attackCells(p)].sort();
  eq(got.join('|'), expected.sort().join('|'), '打击格');
  ok(got.join('|') !== beforeSet, '和偏移前不一样');
  return '射程圆心从 (0,-3) 移到 (' + center.q + ',' + center.r + ')，覆盖 ' + got.length + ' 格';
});

t('城防炮 · 棋子消失但火力留在原地', () => {
  const g = mk();
  const art = g.spawn(0, 'artillery', '0,-3');
  const foe = g.spawn(1, 'infantry', '0,-1');    // 距离 2
  eq(g.damageMap().get(foe.id), 1, '移除前能打到');
  takeOk(g, 'fortress', { key: art.key });
  ok(!g.pieceAt(art.key), '炮没了');
  eq(g.perksOf(0).phantoms.length, 1, '留下火力');
  eq(g.damageMap().get(foe.id), 1, '火力还在打同一个敌人');
  return '炮兵消失，但 (0,-1) 的步兵仍然吃 1 点伤害';
});

t('多功能指挥 · 光环同时加攻加血', () => {
  const g = mk();
  g.spawn(0, 'command', '0,-3');
  const inf = g.spawn(0, 'infantry', '1,-3');
  eq(g.atkOf(inf), 2, '只有加攻');
  eq(g.hpOf(inf), 3, '血量没变');
  takeOk(g, 'multi');
  eq(g.atkOf(inf), 2, '攻击仍 +1');
  eq(g.hpOf(inf), 4, '血量也 +1');
  return '步兵 攻1/血3 → 攻2/血4';
});

t('临时大本营 · 光环棋子也能续接', () => {
  const g = mk();
  const cmd = g.spawn(0, 'command', '3,-1');     // 远离大本营
  const inf = g.spawn(0, 'infantry', '4,-1');
  const r1 = g.resolve();
  eq(r1.removed.filter((x) => x.reason === 'cut').length, 2, '没有临时大本营时两个都被切断');
  const g2 = mk();
  const cmd2 = g2.spawn(0, 'command', '3,-1');
  const inf2 = g2.spawn(0, 'infantry', '4,-1');
  takeOk(g2, 'temp-base');
  const r2 = g2.resolve();
  eq(r2.removed.length, 0, '有了临时大本营就不断联');
  ok(g2.pieceAt(cmd2.key) && g2.pieceAt(inf2.key), '两个都还在');
  return '断联移除 2 个 → 0 个';
});

t('解放 · 奴隶可以放任意空格', () => {
  const g = mk();
  g.spawn(0, 'slaver', '0,-3');
  takeOk(g, 'free-slave');
  const anyFar = '3,0';                          // 离奴隶主很远
  const p = g.placeSlave(0, anyFar);
  ok(p && p.kind === 'slave', '放成功了');
  eq(g.pieceAt(anyFar).owner, 0, '归属');
  return '(3,0) 远离奴隶主也能召唤';
});

t('gxyy · 狙击兵无限射程', () => {
  const g = mk();
  const sni = g.spawn(0, 'sniper', '0,-4' ? '0,-3' : '0,-3', 2, 5);
  const foe = g.spawn(1, 'infantry', '0,3');     // 同一条线上，距离 6
  eq(g.damageMap().get(foe.id), 0, '原本打不到');
  takeOk(g, 'gxyy');
  eq(g.damageMap().get(foe.id), 1, '现在能打到');
  return '距离 6 的目标：0 → 1 点伤害';
});

t('生产改造 · 每回合费用 +1', () => {
  const g = mk();
  const e0 = g.turnEnergy();
  takeOk(g, 'prod-up');
  eq(g.turnEnergy(), e0 + 1, '每回合费用');
  eq(g.perksOf(0).energyPerTurn, 1, '记录');
  return '每回合 3 → 4（永久）';
});

t('火速提拔 · 3 次改造', () => {
  const g = mk();
  takeOk(g, 'promote3');
  eq(g.perksOf(0).promoteLeft, 3, '额度');
  return '获得 3 次改造额度';
});

t('丑东西 · 加属性 + 该方向多打一格', () => {
  const g = mk();
  const tank = g.spawn(0, 'tank', '0,-3');
  const before = g.attackCells(g.pieceAt(tank.key)).size;
  takeOk(g, 'ugly', { key: tank.key, dir: 0 });
  const p = g.pieceAt(tank.key);
  eq(p.atk, 2, '攻击');
  eq(p.hp, 6, '血量');
  eq(p.uglyDir, 0, '方向');
  const cells = [...g.attackCells(p)];
  const d0 = Hex.DIRS[0];                          // 方向 0 = (+1, 0)
  const tip = Hex.key(0 + d0.q * 2, -3 + d0.r * 2);   // 射程 1 → 该方向 2 格
  ok(cells.indexOf(tip) >= 0, '指定方向多打的那一格（(2,-3)）在里面');
  ok(cells.indexOf('0,-1') < 0, '其它方向的第二格（(0,-1)）打不到');
  return '坦克 攻1/血4 → 攻2/血6，打击格 ' + before + ' → ' + cells.length;
});

t('丑东西 · 阵亡后由附近坦克/步兵继承', () => {
  const g = mk();
  const heir = g.spawn(0, 'infantry', '0,-3');    // 挨着大本营，坦克没了也不会断联
  const tank = g.spawn(0, 'tank', '1,-3');
  takeOk(g, 'ugly', { key: tank.key, dir: 2 });
  // 造死：把坦克血量压到 1，让对面炮兵打 1 点
  g.pieceAt(tank.key).hp = 1;
  g.spawn(1, 'artillery', '0,-1');
  const res = g.resolve();
  ok(!g.pieceAt(tank.key), '坦克阵亡');
  const ev = (res.perkEvents || []).filter((e) => e.type === 'inherit');
  eq(ev.length, 1, '继承事件');
  const h = g.pieceAt(heir.key);
  eq(h.atk, 2, '继承者攻击 +1');
  eq(h.maxHp, 5, '继承者血量 +2');
  eq(h.uglyDir, 2, '继承方向');
  return '步兵接手：攻 1→2、血 3→5、方向 2';
});

t('高效通信 · 光环半径 +1', () => {
  const g = mk();
  g.spawn(0, 'command', '0,-3');
  const far = g.spawn(0, 'infantry', '1,-2');    // 距离指挥所 2
  eq(g.atkOf(far), 1, '半径 1 够不着');
  takeOk(g, 'comms');
  eq(g.atkOf(far), 2, '半径 +1 后够得着');
  return '两格外的友军 攻1 → 攻2';
});

t('俘虏 · 敌方阵亡 → 奴隶升级 + 复活成我方奴隶', () => {
  const g = mk();
  g.spawn(0, 'slaver', '0,-3');
  const slave = g.spawn(0, 'slave', '0,-2');
  const foe = g.spawn(1, 'infantry', '1,-2', 1);
  g.spawn(0, 'artillery', '0,-1');
  takeOk(g, 'capture');
  const res = g.resolve();
  const ev = (res.perkEvents || []).filter((e) => e.type === 'capture');
  eq(ev.length, 1, '俘虏事件');
  eq(g.pieceAt(slave.key).kind, 'slaver', '奴隶变奴隶主');
  const reborn = g.pieceAt(foe.key);
  ok(reborn && reborn.owner === 0 && reborn.kind === 'slave', '敌人变成我的奴隶');
  return '奴隶 → 奴隶主，阵亡步兵 → 我方奴隶';
});

/* =========================================================
 * 通用行为
 * ========================================================= */

t('通用 · 选卡本身从不扣费用', () => {
  const noTarget = ['drop-tank', 'drop-art', 'drop-cmd', 'drop-sni', 'drop-slav',
    'trade', 'stealth', 'recruit', 'promote', 'promote2', 'promote3',
    'obsession', 'multi', 'temp-base', 'gxyy', 'comms', 'capture'];
  const bad = [];
  noTarget.forEach((id) => {
    const g = mk();
    const e0 = g.energy;
    const r = take(g, id);
    if (r.ok && g.energy !== e0) bad.push(id + ' 扣了 ' + (e0 - g.energy));
  });
  eq(bad.length, 0, bad.join('、'));
  return noTarget.length + ' 张无目标卡：费用全部不变';
});

t('通用 · 同一回合不能选两次', () => {
  const g = mk();
  takeOk(g, 'prod');
  const r = ROGUE.pick(g, 0, 'prod-plus', {});   // 不重置 offer，走真实路径
  ok(!r.ok, '第二次应该被拒绝');
  eq(g.energy, 5, '只生效一次');
  return '第二次返回「' + r.msg + '」';
});

t('通用 · 唯一卡拿过就不再出现', () => {
  const g = mk();
  takeOk(g, 'comms');
  const pk = g.perksOf(0);
  pk.pickedTurn = 0;
  const off = ROGUE.ensureOffer(g, 0);
  ok(off, '有新的一手牌');
  ok(off.indexOf('comms') < 0, '唯一卡不会再出现');
  return '三张：' + off.join(' / ');
});

t('通用 · 不是肉鸽模式时不能选卡', () => {
  const g = new ENGINE.Game({ side: 5, density: 0, seed: 777 });
  g.turn = 3; g.active = 0;
  const r = ROGUE.pick(g, 0, 'prod', {});
  ok(!r.ok, '应该拒绝');
  eq(r.msg, '不是肉鸽模式', '提示');
  return '返回「' + r.msg + '」';
});

t('晋升 · 改成狙击兵要带方向，改别的兵种不留方向', () => {
  const g = mk();
  g.energy = 5;
  g.perks[0].promoteLeft = 2;
  const cells = Array.from(g.legalCells(0));
  const key = cells[0];
  g.place(0, 'infantry', key);
  const id = Array.from(g.pieces.values()).find((p) => p.owner === 0 && p.kind === 'infantry').id;
  const r = ROGUE.promote(g, 0, key, 'sniper', 3);
  ok(r.ok, '晋升成功');
  eq(g.pieces.get(id).dir, 3, '狙击兵记住方向 3');
  const hit3 = Array.from(g.attackCells(g.pieces.get(id)));
  ok(hit3.length > 0, '朝左能打到东西（' + hit3.join(' ') + '）');
  const r2 = ROGUE.promote(g, 0, key, 'artillery', 3);
  ok(r2.ok, '再改成炮兵');
  eq(g.pieces.get(id).dir, null, '非直线兵种没有方向');
  return '狙击兵 dir=3 打到 ' + hit3.length + ' 格；炮兵 dir=null';
});

t('免费券 · 天降奇兵的免费部署不扣费、用一次就没了', () => {
  const g = mk();
  g.energy = 0;                        // 关键：一点费用都没有，免费券也能用
  take(g, 'drop-tank', {});            // 拿到 1 张「免费坦克」
  eq(g.freeTokenLeft(0, 'tank'), 1, '有 1 张券');
  eq(g.costFor(0, 'tank'), 0, '这时的费用是 0');
  const cells = Array.from(g.legalCells(0));
  const chk = g.canPlace(0, 'tank', cells[0]);
  ok(chk.ok, '0 费也能放（' + (chk.msg || 'ok') + '）');
  g.place(0, 'tank', cells[0]);
  eq(g.energy, 0, '能源没被扣');
  eq(g.freeTokenLeft(0, 'tank'), 0, '券用掉了');
  eq(g.costFor(0, 'tank'), 2, '恢复原价');
  const chk2 = g.canPlace(0, 'tank', cells[1]);
  ok(!chk2.ok, '第二辆就要钱了');
  return '0 费 → 放下 1 辆坦克仍 0 费，第二辆提示「' + chk2.msg + '」';
});

/* =========================================================
 * 输出
 * ========================================================= */
const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
console.log('');
console.log('  结果  卡片 / 检查点' + ' '.repeat(18) + '实测');
console.log('  ' + '-'.repeat(96));
rows.forEach((r) => {
  console.log('  ' + (r.ok ? '✓' : '✗') + '   ' + pad(r.name, 40) + pad(r.detail, 54));
});
console.log('  ' + '-'.repeat(96));
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('');
process.exit(fail ? 1 : 0);
