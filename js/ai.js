/* =========================================================
 * ai.js —— 内置 AI 对手（纯逻辑，浏览器和 Node 都能跑）
 *
 * 思路：一步前瞻 + 局面评估
 *   1. 评估函数：双方棋子价值（血量/攻击/射程/推进距离/是否已被打残）
 *      + 大本营血量，从「我」的视角打分
 *   2. 放置：把每种合法(兵种,格子)都放到克隆局面上试一遍，取评估最高
 *   3. 结算：先克隆一份结算，评估变好才真的执行（结算对双方同时生效，
 *      所以要算清楚"这刀砍下去是我亏还是它亏"）
 * ========================================================= */
(function (root, factory) {
  var deps = (typeof require === 'function' && typeof module === 'object' && module.exports)
    ? { Hex: require('./hex.js'), ENGINE: require('./engine.js') }
    : { Hex: root.Hex, ENGINE: root.ENGINE };
  var mod = factory(deps.Hex, deps.ENGINE);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.AI = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Hex, ENGINE) {
  'use strict';

  var WIN = 100000;
  var LOSS = -100000;
  var DRAW = -500;

  function pieceValue(p) {
    if (p.kind === 'base') return 15 * p.hp;
    if (p.kind === 'command') return 2.4 * p.hp + 5.5;      // 光环价值按「半个攻击点」折算
    if (p.kind === 'sniper') return 2.4 * p.hp + 3.2 * 3 * 0.62 + 2.0;
    if (p.kind === 'slave') return 1.6 * p.hp + 1.4;
    return 2.4 * p.hp + 3.2 * p.atk * Math.max(1, p.range) + 2.0;
  }

  // 从 me 的视角评估局面（越大越有利）
  function evaluate(g, me) {
    if (g.over) {
      if (g.winner === me) return WIN;
      if (g.winner === -1) return DRAW;
      return LOSS;
    }
    var dmg = g.damageMap();
    var myBase = g.baseOf(me);
    var foeBase = g.baseOf(1 - me);
    var score = 0;

    // 施压度：每个棋子能打到几个敌人（鼓励贴身接触，别一直龟缩）
    var all = [];
    g.pieces.forEach(function (p) { all.push(p); });
    var cells = all.map(function (p) { return Hex.parse(p.key); });
    var pressure = new Map();
    for (var i = 0; i < all.length; i++) {
      var n = 0;
      for (var j = 0; j < all.length; j++) {
        if (all[j].owner === all[i].owner) continue;
        if (Hex.distance(cells[i], cells[j]) <= Math.max(1, all[i].range)) n++;
      }
      pressure.set(all[i].id, n);
    }

    g.pieces.forEach(function (p) {
      var v = pieceValue(p);
      var mine = p.owner === me;

      // 已经挨到致死线的棋子，价值大打折扣（下轮就要没了）
      var d = dmg.get(p.id) || 0;
      if (d >= p.hp) v *= 0.35;
      else if (d > 0) v *= 1 - 0.12 * Math.min(d, p.hp);

      // 推进：离「对方的基地」越近越有价值
      var target = mine ? foeBase : myBase;
      if (target && p.kind !== 'base') {
        var dist = Hex.distance(Hex.parse(p.key), Hex.parse(target.key));
        v += Math.max(0, 7 - dist) * 0.55;
        v += (pressure.get(p.id) || 0) * 0.45;
      }
      score += mine ? v : -v;
    });

    return score;
  }

  // 选一个最划算的落子；没有可放的返回 null
  function chooseMove(g) {
    var me = g.active;
    var legal = Array.from(g.legalCells(me));
    if (!legal.length) return null;

    var types = g.typeList || ENGINE.TYPE_LIST;
    var best = null;

    for (var i = 0; i < types.length; i++) {
      var type = types[i];
      var t = g.types ? g.types[type] : ENGINE.TYPES[type];
      if (!t || t.cost > g.energy) continue;
      var dirs = (t.rangeMode === 'line') ? [0, 1, 2, 3, 4, 5] : [null];
      for (var j = 0; j < legal.length; j++) {
        for (var d = 0; d < dirs.length; d++) {
          var sim = g.clone();
          try {
            if (dirs[d] == null) sim.place(me, type, legal[j]);
            else sim.place(me, type, legal[j], { dir: dirs[d] });
          } catch (e) { continue; }
          var score = evaluate(sim, me);
          if (!best || score > best.score) {
            best = { type: type, cell: legal[j], dir: dirs[d], score: score };
          }
        }
      }
    }
    return best;
  }

  // 免费奴隶：只要还有额度就尽量用掉（不花费用）
  function chooseSlave(g) {
    var me = g.active;
    if (typeof g.freeSlavesLeft !== 'function' || g.freeSlavesLeft(me) <= 0) return null;
    var legal = g.slaveCells ? Array.from(g.slaveCells(me)) : Array.from(g.legalCells(me));
    if (!legal.length) return null;
    var best = null;
    for (var j = 0; j < legal.length; j++) {
      var sim = g.clone();
      try { sim.placeSlave(me, legal[j]); } catch (e) { continue; }
      var score = evaluate(sim, me);
      if (!best || score > best.score) best = { cell: legal[j], score: score };
    }
    return best;
  }

  // 现在结算到底划不划算
  function shouldResolve(g) {
    if (g.over) return false;
    var me = g.active;
    var before = evaluate(g, me);
    var sim = g.clone();
    sim.resolve();
    var after = evaluate(sim, me);
    return after > before + 0.001;
  }

  // 对手来求和：落后或势均力敌就接受，明显领先就拒绝
  function acceptsDraw(g, seat) {
    if (g.over) return true;
    var me = (seat == null) ? g.active : seat;
    return evaluate(g, me) < 20;
  }

  // 整个回合打完（服务器 / 测试用）
  function playTurn(g) {
    var me = g.active;
    var guard = 0;

    // 先把免费的奴隶用掉（不花费用）
    while (!g.over && guard++ < 16) {
      var sv = chooseSlave(g);
      if (!sv) break;
      try { g.placeSlave(me, sv.cell); } catch (e) { break; }
    }

    // 再用费用买兵
    guard = 0;
    while (!g.over && g.energy > 0 && guard++ < 16) {
      var mv = chooseMove(g);
      if (!mv) break;
      var before = g.energy;
      try {
        if (mv.dir == null) g.place(me, mv.type, mv.cell);
        else g.place(me, mv.type, mv.cell, { dir: mv.dir });
      } catch (e) { break; }
      if (g.energy >= before) break;
    }

    if (!g.over && shouldResolve(g)) g.resolve();
    return g;
  }

  return {
    evaluate: evaluate,
    chooseMove: chooseMove,
    shouldResolve: shouldResolve,
    playTurn: playTurn,
    pieceValue: pieceValue,
    chooseSlave: chooseSlave,
    acceptsDraw: acceptsDraw
  };
});
