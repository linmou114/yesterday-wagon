/* =========================================================
 * ai.js —— 内置 AI 对手（纯逻辑，浏览器和 Node 都能跑）
 *
 * 估值思路（v2）
 *   1. 血量不会慢慢掉：引擎里「结算」只做致死判定，活着的人血量不变。
 *      所以「残血」在实战中几乎不出现（只有测试会手动改 hp），
 *      旧版那套 0.72 + 0.28*hp/maxHp 的折价基本是空转，这里直接删掉。
 *   2. 主要看吃子：把「这一刀能吃掉谁」当作最重要的项。
 *      必死的棋子不计入子力，另外再按被吃棋子的价值加一份吃子分
 *      （换子赚的时候加倍鼓励，亏的时候加倍劝退）。
 *   3. 中央更值钱：六边形棋盘的中央能同时罩住更多方向，
 *      所以棋子价值乘以「离中心多近」的加成，射程越长加得越多。
 *   4. 多算几层：把「放子 / 召唤 / 结算 / 结束回合」都当成一步动作，
 *      用 alpha-beta 在时间预算内迭代加深（实战给 1~3 秒）。
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

  var WIN = 1000000;
  var LOSS = -1000000;
  var DRAW = -500;
  var LINE_DIRS = [0, 1, 2, 3, 4, 5];
  var ABORT = { abort: true };

  /* ---------------- 位置：离中心多近 ---------------- */

  function boardRadius(g) {
    var n = g.side || 5;
    return Math.max(1, n - 1);
  }

  // 正中央 = 1，最外圈 = 0（按棋盘半径缓存，估值和排序里会被反复问）
  var CENTER_CACHE = {};
  function centerWeight(g, key) {
    var n = g.side || 5;
    var ck = n + '|' + key;
    var hit = CENTER_CACHE[ck];
    if (hit != null) return hit;
    var d = Hex.distance(Hex.parse(key), { q: 0, r: 0 });
    var r = Math.max(1, n - 1);
    var w = 1 - d / r;
    if (w < 0) w = 0;
    if (w > 1) w = 1;
    CENTER_CACHE[ck] = w;
    return w;
  }

  // 攻击形状：一组相对偏移（缓存，避免每次现算 HashSet）
  function shapeOf(cache, typeId, t, dir) {
    var k = typeId + '|' + dir;
    var got = cache[k];
    if (got) return got;
    var mode = t.rangeMode || 'circle';
    var range = Math.max(0, t.range || 0);
    var out = [];
    if (mode === 'line') {
      var d = Hex.DIRS[dir == null ? 0 : dir] || Hex.DIRS[0];
      for (var s = 1; s <= range; s++) out.push({ q: d.q * s, r: d.r * s });
    } else if (mode === 'circle' && (t.atk || 0) > 0) {
      for (var dq = -range; dq <= range; dq++) {
        for (var dr = -range; dr <= range; dr++) {
          if (Math.abs(dq + dr) > range) continue;
          if (dq === 0 && dr === 0) continue;
          out.push({ q: dq, r: dr });
        }
      }
    }
    cache[k] = out;
    return out;
  }

  /* ---------------- 单棋子价值 ---------------- */

  // 经济底盘：值多少钱由「花了多少费」决定，血量只作小幅修正。
  // 指数 1.22 而不是线性：格子是稀缺资源，同样占一格，2 费兵本来就该比
  // 两个 1 费兵更划算，所以贵的兵单位费用产出更高。
  var COST_UNIT = 7.0;
  var COST_EXP = 1.22;
  var HP_UNIT = 0.5;
  var SLAVE_FLOOR = 2.5;

  // 一次快照：把「谁有多少攻、多少血、能打到哪些格、每个目标吃多少伤害」都算一遍，
  // 后面估值直接查表。atkOf/hpOf 每次都要扫全场光环，重复调用是搜索变慢的主因。
  function snapshot(g) {
    var cells = new Map();
    var hp = new Map();
    var atk = new Map();
    var dmg = new Map();
    g.pieces.forEach(function (p) {
      var a = (p.atk || 0) > 0 ? g.atkOf(p) : 0;
      atk.set(p.id, a);
      hp.set(p.id, g.hpOf(p));
      dmg.set(p.id, dmg.get(p.id) || 0);
      if (a <= 0) return;
      var c = g.attackCells(p);
      if (!c.size) return;
      cells.set(p.id, c);
      c.forEach(function (k) {
        var id = g.occupant.get(k);
        if (id == null) return;
        var t = g.pieces.get(id);
        if (!t || t.owner === p.owner) return;
        dmg.set(t.id, (dmg.get(t.id) || 0) + a);
      });
    });
    return { cells: cells, hp: hp, atk: atk, dmg: dmg };
  }

  // 不吃任何加成、不算威胁的「裸价」，只由费用和血量决定（也可用来给目标定价，避免递归）
  function rawValue(g, p, ctx) {
    if (p.kind === 'base') return 16 * (ctx && ctx.hp ? ctx.hp.get(p.id) : hpOf(g, p));
    var t = (g && g.types && g.types[p.kind]) || ENGINE.TYPES[p.kind] || {};
    var cost = (t.cost == null ? 1 : t.cost);
    var hp = (ctx && ctx.hp) ? ctx.hp.get(p.id) : hpOf(g, p);
    var v = COST_UNIT * Math.pow(Math.max(0, cost), COST_EXP) + HP_UNIT * hp;
    if (p.kind === 'slave' || t.noDeploy) v = Math.max(v, SLAVE_FLOOR);
    if (p.kind === 'slaver') v += 3.0;      // 每回合白嫖一个奴隶
    return v;
  }

  // 攻击价值：不是「攻击力 × 射程」，而是「这一刀实际对着几个棋子、能参与吃掉多少」
  //   - 目标这条线已经够斩杀：按自己的伤害占比瓜分目标价值
  //   - 还不够斩杀：只给一点点施压分（打不动就是打不动）
  //   - 打大本营：每点伤害直接折分
  var KILL_CREDIT = 0.75;
  var PRESSURE = 0.28;
  var BASE_HIT = 0.7;

  function attackValue(g, p, ctx) {
    var atk = (ctx && ctx.atk) ? (ctx.atk.get(p.id) || 0)
      : ((g && g.atkOf) ? g.atkOf(p) : (p.atk || 0));
    if (!atk || atk <= 0) return 0;
    var cells = (ctx && ctx.cells) ? ctx.cells.get(p.id) : g.attackCells(p);
    if (!cells || !cells.size) return 0;
    var dmg = (ctx && ctx.dmg) || g.damageMap();
    var sum = 0;
    cells.forEach(function (k) {
      var id = g.occupant.get(k);
      if (id == null) return;
      var t = g.pieces.get(id);
      if (!t || t.owner === p.owner) return;
      if (t.kind === 'base') { sum += BASE_HIT * atk; return; }
      var tv = rawValue(g, t, ctx);
      var hp = Math.max(1, (ctx && ctx.hp) ? (ctx.hp.get(t.id) || 1) : hpOf(g, t));
      var total = dmg.get(t.id) || 0;
      if (total >= hp) {
        // 这次结算真的能吃到它：按伤害贡献分一份价值
        sum += KILL_CREDIT * tv * (atk / Math.max(1, total));
      } else {
        // 还差得远：按「我贡献了多少伤害 / 它还差多少」记一点施压，
        // 旁边友军越多（total 越大）这份施压越接近真的吃子
        sum += PRESSURE * tv * (atk / hp) * (1 + total / hp);
      }
    });
    return sum;
  }

  // 光环价值：加成到的棋子越多，这个棋子越值钱（既是收益，也是「必须保护」的理由）
  var AURA_HEAD = 1.4;    // 每罩住一个有效单位
  var AURA_POINT = 0.8;   // 每点有效加成

  function auraValue(g, p) {
    var a = (g.auraOf ? g.auraOf(p) : null);
    if (!a) return 0;
    var from = Hex.parse(p.key);
    var heads = 0;
    var pts = 0;
    g.pieces.forEach(function (o) {
      if (o.id === p.id) return;
      if (o.kind === 'base') return;              // 给大本营加攻击没意义
      if (Hex.distance(Hex.parse(o.key), from) > a.radius) return;
      var friendly = (a.effect === 'atk' || a.effect === 'hp');
      if (friendly && o.owner !== p.owner) return;
      if (!friendly && o.owner === p.owner) return;
      // 加攻类光环只有对「本身有攻击力」的棋子才有价值
      if ((a.effect === 'atk' || a.effect === 'enemyAtk') && (o.atk || 0) <= 0) return;
      // 同类光环取最高值，所以只算「我能顶上去的那部分」
      var best = 0;
      g.pieces.forEach(function (q) {
        if (q.id === p.id || q.id === o.id) return;
        var b = (g.auraOf ? g.auraOf(q) : null);
        if (!b || b.effect !== a.effect) return;
        if (Hex.distance(Hex.parse(q.key), Hex.parse(o.key)) > b.radius) return;
        var bf = (b.effect === 'atk' || b.effect === 'hp');
        if (bf && q.owner !== o.owner) return;
        if (!bf && q.owner === o.owner) return;
        if (b.amount > best) best = b.amount;
      });
      if (a.amount > best) { heads += 1; pts += a.amount - best; }
    });
    return AURA_HEAD * heads + AURA_POINT * pts;
  }

  // 单棋子价值 = 裸价 + 攻击价值 + 光环价值，再乘中央加成
  function pieceValue(g, p, ctx) {
    if (p.kind === 'base') return 16 * ((ctx && ctx.hp) ? ctx.hp.get(p.id) : hpOf(g, p));
    if (ctx && ctx.memo && ctx.memo[p.id] != null) return ctx.memo[p.id];
    var v = rawValue(g, p, ctx) + attackValue(g, p, ctx) + auraValue(g, p);
    if (g) {
      var w = centerWeight(g, p.key);
      if (w > 0) {
        var range = Math.max(1, p.range || 1);
        // 中央加成不设太大：位置的真实收益已经通过「攻击价值能罩到谁」体现，
        // 这里只补一点「站中间将来选择更多」的期权价值。
        v *= 1 + 0.15 * w * (1 + 0.18 * (range - 1));
      }
    }
    if (ctx && ctx.memo) ctx.memo[p.id] = v;
    return v;
  }

  // 兼容旧名
  function auraCoverage(g, p) { return auraValue(g, p); }

  function hpOf(g, p) {
    return (g && g.hpOf) ? g.hpOf(p) : p.hp;
  }

  /* ---------------- 局面评估 ---------------- */

  // 从 me 的视角打分（越大越有利）
  function evaluate(g, me) {
    if (me == null) me = g.active;
    if (g.over) {
      if (g.winner === me) return WIN;
      if (g.winner === -1) return DRAW;
      return LOSS;
    }

    var ctx = snapshot(g);
    var dmg = ctx.dmg;
    ctx.memo = {};
    var myBase = g.baseOf(me);
    var foeBase = g.baseOf(1 - me);

    // 下回合就能打爆对方大本营（或自己家要爆）
    if (foeBase && (dmg.get(foeBase.id) || 0) >= Math.max(1, ctx.hp.get(foeBase.id) || 1)) return WIN - 100;
    if (myBase && (dmg.get(myBase.id) || 0) >= Math.max(1, ctx.hp.get(myBase.id) || 1)) return LOSS + 100;

    var score = 0;

    g.pieces.forEach(function (p) {
      var mine = p.owner === me;
      var v = pieceValue(g, p, ctx);
      score += mine ? v : -v;

      // 推进：离对方大本营更近一点，威胁更大（权重很小，主要靠攻击价值说话）
      if (p.kind !== 'base') {
        var target = mine ? foeBase : myBase;
        if (target) {
          var dist = Hex.distance(Hex.parse(p.key), Hex.parse(target.key));
          var push = Math.max(0, 6 - dist) * 0.18;
          score += mine ? push : -push;
        }
      }
    });

    return score;
  }

  /* ---------------- 动作生成 ---------------- */

  function affordableTypes(g) {
    var types = g.typeList || ENGINE.TYPE_LIST;
    var out = [];
    for (var i = 0; i < types.length; i++) {
      var t = (g.types && g.types[types[i]]) || ENGINE.TYPES[types[i]];
      if (!t) continue;
      // 肉鸽的免费券也要算进来，否则 AI 会把「天降奇兵」的免费部署白白留着
      var cost = (typeof g.costFor === 'function') ? g.costFor(g.active, types[i]) : t.cost;
      if (cost > g.energy) continue;
      if (t.noDeploy) continue;
      out.push({ type: types[i], t: t });
    }
    return out;
  }

  // 把一个棋子放到某个格子上，这一下「吃子 + 站位」大概值多少（用于排序和剪枝）
  function placeHeuristic(g, typeId, t, cell, dir, cache) {
    var h = 0;
    var atk = t.atk || 0;
    if (atk > 0) {
      var cells = shapeOf(cache, typeId, t, dir);
      var from = Hex.parse(cell);
      for (var i = 0; i < cells.length; i++) {
        var k = Hex.key(from.q + cells[i].q, from.r + cells[i].r);
        if (!g.board.cells.has(k)) continue;
        var id = g.occupant.get(k);
        if (id == null) continue;
        var q = g.pieces.get(id);
        if (!q || q.owner === g.active) continue;
        var hp = hpOf(g, q);
        if (q.kind === 'base') {
          h += (atk >= hp) ? 900 : 2.2 * atk;
          continue;
        }
        if (atk >= hp) h += 3.2 + 1.15 * rawValue(g, q);      // 能一刀秒掉
        else h += 0.5 * atk;                                  // 打不动也算压住
      }
    }

    h += 2.4 * centerWeight(g, cell);                        // 中央更值钱

    var occ = g.occupant.get(cell);
    if (occ != null) {
      var sitting = g.pieces.get(occ);
      if (sitting) h -= rawValue(g, sitting) * 0.85;         // 替换掉自己人 = 先亏掉它
    }
    h -= 0.32 * (t.cost || 0);
    return h;
  }

  // 结算值不值：这一刀能吃到多少、掉多少
  function resolveHeuristic(g, dmg) {
    var me = g.active;
    var h = 0;
    g.pieces.forEach(function (p) {
      var d = dmg.get(p.id) || 0;
      if (d <= 0 || d < hpOf(g, p)) return;
      h += (p.owner === me) ? -rawValue(g, p) : rawValue(g, p);
    });
    return h;
  }

  // 当前行动方的所有「一步动作」
  function atoms(g, ctx) {
    var me = g.active;
    var cache = ctx.shape;
    var out = [];

    // 1) 免费奴隶（不花费用，永远值得先放）
    if (typeof g.freeSlavesLeft === 'function' && g.freeSlavesLeft(me) > 0 && g.slaveCells) {
      var sc = g.slaveCells(me);
      sc.forEach(function (k) {
        out.push({ kind: 'slave', cell: k, h: 3.0 + 2.4 * centerWeight(g, k) });
      });
    }

    // 2) 买兵 / 替换己方棋子
    var legal = g.legalCells(me);
    var buys = affordableTypes(g);
    var width = ctx.width || 3;
    buys.forEach(function (b) {
      var t = b.t;
      var dirs = (t.rangeMode === 'line') ? LINE_DIRS : [null];
      var cand = [];
      legal.forEach(function (cell) {
        for (var i = 0; i < dirs.length; i++) {
          cand.push({
            kind: 'place', type: b.type, cell: cell, dir: dirs[i],
            h: placeHeuristic(g, b.type, t, cell, dirs[i], cache)
          });
        }
      });
      cand.sort(function (x, y) { return y.h - x.h; });
      for (var i = 0; i < cand.length && i < width; i++) out.push(cand[i]);
    });

    // 3) 结算（只有真的会死人时才值得算一步）
    var dmg = g.damageMap();
    var total = 0;
    dmg.forEach(function (v) { total += v; });
    if (total > 0) out.push({ kind: 'resolve', h: resolveHeuristic(g, dmg) });

    // 4) 结束回合（永远可选，排最后）
    out.push({ kind: 'end', h: -1 });

    out.sort(function (x, y) { return y.h - x.h; });
    return out;
  }

  // 在克隆局面上执行一步；没进展（例如结算没人死）就返回 null
  function applyAtom(g, atom) {
    var sim = g.clone();
    try {
      if (atom.kind === 'place') {
        sim.place(sim.active, atom.type, atom.cell, atom.dir == null ? {} : { dir: atom.dir });
      } else if (atom.kind === 'slave') {
        sim.placeSlave(sim.active, atom.cell);
      } else if (atom.kind === 'resolve') {
        var r = sim.resolve();
        if (!r || !r.removed || !r.removed.length) return null;
      } else if (atom.kind === 'end') {
        sim.endTurn();
      } else {
        return null;
      }
    } catch (e) {
      return null;
    }
    return sim;
  }

  /* ---------------- 搜索 ---------------- */

  // 返回 rootSeat 视角的分数；同一方连续动作时都是「取最大」
  function search(g, depth, alpha, beta, ctx, rootSeat) {
    ctx.nodes += 1;
    if ((ctx.nodes & 63) === 0 && Date.now() > ctx.deadline) throw ABORT;

    var me = g.active;
    var mine = (me === rootSeat);

    if (g.over) {
      if (g.winner === rootSeat) return WIN;
      if (g.winner === -1) return DRAW;
      return LOSS;
    }
    if (depth <= 0) return (mine ? 1 : -1) * evaluate(g, me);

    ctx.width = depth >= 4 ? ctx.baseWidth : Math.max(2, ctx.baseWidth - 1);
    var list = atoms(g, ctx);
    if (!list.length) return (mine ? 1 : -1) * evaluate(g, me);

    var best = mine ? -Infinity : Infinity;
    for (var i = 0; i < list.length; i++) {
      var child = applyAtom(g, list[i]);
      if (!child) continue;
      var val = search(child, depth - 1, alpha, beta, ctx, rootSeat);
      if (mine) {
        if (val > best) best = val;
        if (best > alpha) alpha = best;
      } else {
        if (val < best) best = val;
        if (best < beta) beta = best;
      }
      if (alpha >= beta) break;
    }
    if (best === Infinity || best === -Infinity) return (mine ? 1 : -1) * evaluate(g, me);
    return best;
  }

  /* ---------------- 对外：选一步 ---------------- */

  // opts: { budget: 毫秒, maxDepth: 层数, width: 每类保留几个候选, filter: 只考虑某些动作 }
  function bestAction(g, opts) {
    opts = opts || {};
    if (!g || g.over) return null;

    var budget = opts.budget == null ? 600 : Math.max(1, opts.budget);
    var ctx = {
      shape: {},
      nodes: 0,
      deadline: Date.now() + budget,
      baseWidth: opts.width || 3,
      width: opts.width || 3
    };

    var rootSeat = g.active;
    var moves = atoms(g, ctx);
    if (opts.filter) moves = moves.filter(opts.filter);
    if (!moves.length) return null;

    var best = null;
    var bestVal = -Infinity;
    var reached = 0;
    var maxDepth = opts.maxDepth || 8;
    var t0 = Date.now();

    for (var d = 1; d <= maxDepth; d++) {
      var localBest = null;
      var localVal = -Infinity;
      var alpha = -Infinity;
      var complete = true;
      try {
        for (var i = 0; i < moves.length; i++) {
          var child = applyAtom(g, moves[i]);
          if (!child) continue;
          var val = search(child, d - 1, alpha, Infinity, ctx, rootSeat);
          if (val > localVal) { localVal = val; localBest = moves[i]; }
          if (val > alpha) alpha = val;
        }
      } catch (e) {
        if (e !== ABORT) throw e;
        complete = false;
      }
      if (!complete) break;
      if (localBest) {
        best = localBest;
        bestVal = localVal;
        reached = d;
        // 把上一轮最好的动作提到最前面，下一轮剪枝更快
        var idx = moves.indexOf(localBest);
        if (idx > 0) { moves.splice(idx, 1); moves.unshift(localBest); }
      }
      if (Date.now() > ctx.deadline && d >= 1) {
        // 已经超预算：至少保证有一层完整结果
        if (reached > 0) break;
      }
      if (bestVal >= WIN - 1000) break;   // 已经赢了就别再算
    }

    ctx.ms = Date.now() - t0;
    ctx.depth = reached;
    ctx.score = bestVal;
    lastStats = ctx;
    if (!best) return null;

    var out = { kind: best.kind, score: bestVal, depth: reached, ms: ctx.ms, nodes: ctx.nodes };
    if (best.kind === 'place') { out.type = best.type; out.cell = best.cell; out.dir = best.dir; }
    if (best.kind === 'slave') { out.cell = best.cell; }
    return out;
  }

  var lastStats = null;

  /* ---------------- 兼容旧接口 ---------------- */

  // 选一个最划算的落子（只考虑放子，给测试和老代码用）
  function chooseMove(g, opts) {
    var o = opts || {};
    var act = bestAction(g, {
      budget: o.budget == null ? 150 : o.budget,
      maxDepth: o.maxDepth || 4,
      width: o.width || 3,
      filter: function (a) { return a.kind === 'place'; }
    });
    if (!act) return null;
    return { type: act.type, cell: act.cell, dir: act.dir, score: act.score, depth: act.depth };
  }

  // 免费奴隶：只要还有额度就用掉（不花费用）
  function chooseSlave(g, opts) {
    var o = opts || {};
    var act = bestAction(g, {
      budget: o.budget == null ? 60 : o.budget,
      maxDepth: o.maxDepth || 3,
      width: o.width || 3,
      filter: function (a) { return a.kind === 'slave'; }
    });
    if (!act) return null;
    return { cell: act.cell, score: act.score };
  }

  // 现在结算划不划算：在「结算」和「结束回合」之间二选一
  function shouldResolve(g, opts) {
    if (!g || g.over) return false;
    var o = opts || {};
    var act = bestAction(g, {
      budget: o.budget == null ? 120 : o.budget,
      maxDepth: o.maxDepth || 4,
      width: o.width || 2,
      filter: function (a) { return a.kind === 'resolve' || a.kind === 'end'; }
    });
    return !!(act && act.kind === 'resolve');
  }

  // 对手来求和：落后或势均力敌就接受，明显领先就拒绝
  function acceptsDraw(g, seat) {
    if (g.over) return true;
    var me = (seat == null) ? g.active : seat;
    return evaluate(g, me) < 25;
  }

  // 整个回合打完（服务器 / 测试用，预算小一点）
  // 注意：这里只把「本回合能做的事」做完，结束回合交给调用方（和旧版一致）
  function playTurn(g, opts) {
    var o = opts || {};
    var me = g.active;
    var budget = o.budget == null ? 8 : o.budget;
    var guard = 0;

    while (!g.over && g.active === me && guard++ < 24) {
      var act = bestAction(g, { budget: budget, maxDepth: o.maxDepth || 4, width: 3 });
      if (!act || act.kind === 'end') break;
      if (act.kind === 'place') {
        try { g.place(me, act.type, act.cell, act.dir == null ? {} : { dir: act.dir }); }
        catch (e) { break; }
      } else if (act.kind === 'slave') {
        try { g.placeSlave(me, act.cell); } catch (e) { break; }
      } else if (act.kind === 'resolve') {
        var r = null;
        try { r = g.resolve(); } catch (e) { r = null; }
        // 结算没有新结果（局面没变），别再空转
        if (!r || !r.removed || !r.removed.length) break;
      } else break;
    }
    return g;
  }

  return {
    evaluate: evaluate,
    chooseMove: chooseMove,
    chooseSlave: chooseSlave,
    shouldResolve: shouldResolve,
    bestAction: bestAction,
    playTurn: playTurn,
    pieceValue: pieceValue,
    centerWeight: centerWeight,
    acceptsDraw: acceptsDraw,
    stats: function () { return lastStats; }
  };
});
