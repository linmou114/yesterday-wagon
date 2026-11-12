/* =========================================================
 * rogue.js —— 肉鸽模式的能力卡
 *
 * 规则
 *   · 只有肉鸽模式（game.rogue = true）才会发牌。
 *   · 第 2 回合起，每一方的回合开始时发 3 张卡，玩家选 1 张。
 *   · 稀有度权重 普通:稀有:超稀有 = 7:2:1，同一批 3 张不重复。
 *   · 部分卡是「唯一」的（once），拿过就不再出现。
 *
 * 状态存在 game.perks[owner]（引擎里定义），这里的 apply 只负责改它。
 * ========================================================= */
(function (root, factory) {
  var isNode = (typeof require === 'function' && typeof module === 'object' && module.exports);
  var HexDep = isNode ? require('./hex.js') : root.Hex;
  var EngineDep = isNode ? require('./engine.js') : root.ENGINE;
  var mod = factory(HexDep, EngineDep);
  if (isNode) module.exports = mod;
  root.ROGUE = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Hex, ENGINE) {
  'use strict';

  var RARITY = {
    common: { id: 'common', label: '普通', weight: 7, color: '#93A4B8' },
    rare: { id: 'rare', label: '稀有', weight: 2, color: '#A78BFA' },
    ultra: { id: 'ultra', label: '超稀有', weight: 1, color: '#FBBF24' }
  };
  var RARITY_ORDER = ['ultra', 'rare', 'common'];

  // 还没到第 2 回合不发牌
  var FIRST_TURN = 2;

  /* ---------------- 工具 ---------------- */
  function ownPieces(g, owner, kind) {
    var out = [];
    g.pieces.forEach(function (p) {
      if (p.owner !== owner) return;
      if (p.kind === 'base') return;
      if (kind && p.kind !== kind) return;
      out.push(p);
    });
    return out;
  }

  function emptyCells(g) {
    var out = [];
    g.board.cells.forEach(function (c) {
      if (c.obstacle) return;
      if (g.occupant.has(c.key)) return;
      out.push(c.key);
    });
    return out;
  }

  function adjPair(g, owner) {
    // 找一对相邻的「坦克 + 步兵」，返回 [tankKey, infKey]
    var tanks = ownPieces(g, owner, 'tank');
    var infs = ownPieces(g, owner, 'infantry');
    for (var i = 0; i < tanks.length; i++) {
      var a = Hex.parse(tanks[i].key);
      for (var j = 0; j < infs.length; j++) {
        if (Hex.distance(a, Hex.parse(infs[j].key)) === 1) {
          return [tanks[i].key, infs[j].key];
        }
      }
    }
    return null;
  }

  function dirToFoe(g, owner, fromKey) {
    var base = g.baseOf(1 - owner);
    if (!base) return 0;
    return g.dirToward(fromKey, base.key);
  }

  /* ---------------- 卡牌表 ----------------
   * need: null | 'own' | 'tank' | 'artillery' | 'cell' | 'tankInf' | 'dir'
   *   'dir' 表示先选棋子（key）再给方向（dir）
   */
  var CARDS = [
    /* ---- 普通 ---- */
    {
      id: 'prod', name: '生产', rarity: 'common',
      desc: '本回合费用 +2。',
      apply: function (g, o) { g.energy += 2; }
    },
    {
      id: 'drop-tank', name: '天降奇兵 · 坦克', rarity: 'common',
      desc: '本局获得一次免费部署坦克的机会。',
      apply: function (g, o) { var pk = g.perksOf(o); pk.freeDeploy.tank = (pk.freeDeploy.tank || 0) + 1; }
    },
    {
      id: 'drop-art', name: '天降奇兵 · 炮兵', rarity: 'common',
      desc: '本局获得一次免费部署炮兵的机会。',
      apply: function (g, o) { var pk = g.perksOf(o); pk.freeDeploy.artillery = (pk.freeDeploy.artillery || 0) + 1; }
    },
    {
      id: 'drop-cmd', name: '天降奇兵 · 指挥所', rarity: 'common',
      desc: '本局获得一次免费部署指挥所的机会。',
      apply: function (g, o) { var pk = g.perksOf(o); pk.freeDeploy.command = (pk.freeDeploy.command || 0) + 1; }
    },
    {
      id: 'drop-sni', name: '天降奇兵 · 狙击兵', rarity: 'common',
      desc: '本局获得一次免费部署狙击兵的机会。',
      apply: function (g, o) { var pk = g.perksOf(o); pk.freeDeploy.sniper = (pk.freeDeploy.sniper || 0) + 1; }
    },
    {
      id: 'drop-slav', name: '天降奇兵 · 奴隶主', rarity: 'common',
      desc: '本局获得一次免费部署奴隶主的机会。',
      apply: function (g, o) { var pk = g.perksOf(o); pk.freeDeploy.slaver = (pk.freeDeploy.slaver || 0) + 1; }
    },
    {
      id: 'hide', name: '隐匿', rarity: 'common', need: 'own',
      desc: '选择己方一个棋子：它只受到相邻（距离 1）单位的伤害。',
      can: function (g, o) { return ownPieces(g, o).length > 0; },
      apply: function (g, o, a) { var p = g.pieceAt(a.key); if (p && p.owner === o) p.hidden = true; else return '目标不合法'; }
    },
    {
      id: 'promote', name: '晋升', rarity: 'common',
      desc: '本回合可以把 1 个己方棋子改造成任意兵种。',
      apply: function (g, o) { var pk = g.perksOf(o); pk.promoteLeft = (pk.promoteLeft || 0) + 1; }
    },
    {
      id: 'armor', name: '坚固装甲', rarity: 'common', need: 'tank',
      desc: '选择己方一名坦克，血量 +2。',
      can: function (g, o) { return ownPieces(g, o, 'tank').length > 0; },
      apply: function (g, o, a) {
        var p = g.pieceAt(a.key);
        if (!p || p.owner !== o || p.kind !== 'tank') return '请选择己方坦克';
        p.maxHp += 2; p.hp += 2;
      }
    },
    {
      id: 'leader', name: '小队长', rarity: 'common', need: 'own',
      desc: '选择己方一个棋子：+1 攻 / +1 血，并获得半径 1 的加攻光环。',
      can: function (g, o) { return ownPieces(g, o).length > 0; },
      apply: function (g, o, a) {
        var p = g.pieceAt(a.key);
        if (!p || p.owner !== o) return '目标不合法';
        p.atk += 1; p.maxHp += 1; p.hp += 1;
        p.auraBonus = { radius: 1, effect: 'atk', amount: 1 };
      }
    },
    {
      id: 'trade', name: '三角贸易', rarity: 'common',
      desc: '立刻获得 3 个可免费召唤的奴隶（仍需贴着奴隶主）。',
      apply: function (g, o) { var pk = g.perksOf(o); pk.freeDeploy.slave = (pk.freeDeploy.slave || 0) + 3; }
    },
    {
      id: 'stealth', name: '隐蔽战术', rarity: 'common', once: true,
      desc: '你的狙击兵永久获得隐匿：只受相邻单位的伤害。',
      apply: function (g, o) {
        var pk = g.perksOf(o);
        pk.flags.hiddenSnipers = true;
        ownPieces(g, o, 'sniper').forEach(function (p) { p.hidden = true; });
      }
    },

    /* ---- 稀有 ---- */
    {
      id: 'prod-plus', name: '生产+', rarity: 'rare',
      desc: '本回合费用 +3。',
      apply: function (g, o) { g.energy += 3; }
    },
    {
      id: 'terrain', name: '地形修改', rarity: 'rare', once: true, need: 'cell',
      desc: '在棋盘任意空格放一个障碍（每方一局一次）。',
      can: function (g, o) { return emptyCells(g).length > 0; },
      apply: function (g, o, a) { if (!g.placeObstacle(a.key)) return '这里不能放障碍'; }
    },
    {
      id: 'recruit', name: '征兵', rarity: 'rare', once: true,
      desc: '之后每回合开始时，获得一次免费部署步兵的机会。',
      apply: function (g, o) { g.perksOf(o).flags.recruit = true; }
    },
    {
      id: 'promote2', name: '战地晋升', rarity: 'rare',
      desc: '本回合可以把 2 个己方棋子改造成任意兵种。',
      apply: function (g, o) { var pk = g.perksOf(o); pk.promoteLeft = (pk.promoteLeft || 0) + 2; }
    },
    {
      id: 'tank-swap', name: '步坦协同', rarity: 'rare', need: 'tankInf',
      desc: '选择相邻的己方坦克与步兵，立刻交换两者的位置。',
      can: function (g, o) { return !!adjPair(g, o); },
      apply: function (g, o, a) {
        var t = g.pieceAt(a.key), i = g.pieceAt(a.target);
        if (!t || !i) return '目标不合法';
        if (t.owner !== o || i.owner !== o) return '只能交换自己的棋子';
        if (t.kind !== 'tank' || i.kind !== 'infantry') return '需要坦克与步兵';
        if (Hex.distance(Hex.parse(t.key), Hex.parse(i.key)) !== 1) return '两个棋子必须相邻';
        if (!g.swapCells(t.key, i.key)) return '交换失败';
      }
    },
    {
      id: 'obsession', name: '某人的执念', rarity: 'rare', once: true,
      desc: '你的炮兵可以叠加享受多个光环（其余兵种仍取最高）。',
      apply: function (g, o) { g.perksOf(o).flags.auraStack = true; }
    },
    {
      id: 'flak', name: '高射炮', rarity: 'rare', need: 'dir', kind: 'artillery',
      desc: '选择己方一门炮并指定方向：它的射程中心整体偏移一格。',
      can: function (g, o) { return ownPieces(g, o, 'artillery').length > 0; },
      apply: function (g, o, a) {
        var p = g.pieceAt(a.key);
        if (!p || p.owner !== o || p.kind !== 'artillery') return '请选择己方炮兵';
        var d = Math.round(Number(a.dir));
        if (!(d >= 0 && d <= 5)) return '方向不合法';
        p.shiftDir = d;
      }
    },
    {
      id: 'fortress', name: '城防炮', rarity: 'rare', need: 'artillery',
      desc: '选择己方一门炮：棋子消失，但它的火力永久留在原地。',
      can: function (g, o) { return ownPieces(g, o, 'artillery').length > 0; },
      apply: function (g, o, a) {
        var p = g.pieceAt(a.key);
        if (!p || p.owner !== o || p.kind !== 'artillery') return '请选择己方炮兵';
        var atk = g.atkOf(p);
        var key = p.key;
        var range = p.range;
        g.removeById(p.id);
        g.perksOf(o).phantoms.push({ key: key, atk: atk, range: range });
      }
    },
    {
      id: 'multi', name: '多功能指挥', rarity: 'rare', once: true,
      desc: '你的光环棋子同时提供「加攻」与「加血」两种效果。',
      apply: function (g, o) { g.perksOf(o).flags.auraTwoAttr = true; }
    },
    {
      id: 'temp-base', name: '临时大本营', rarity: 'rare', once: true,
      desc: '你的光环棋子也算连通源：挨着它的棋子不会因为断开大本营而被移除。',
      apply: function (g, o) { g.perksOf(o).flags.tempBase = true; }
    },
    {
      id: 'free-slave', name: '解放', rarity: 'rare', once: true,
      desc: '你的奴隶可以放在棋盘上任意空格（不再需要贴着奴隶主）。',
      apply: function (g, o) { g.perksOf(o).flags.slaveAnywhere = true; }
    },
    {
      id: 'gxyy', name: 'gxyy', rarity: 'rare', once: true,
      desc: '你的狙击兵射程变为无限，一直打到地图边缘。',
      apply: function (g, o) { g.perksOf(o).flags.sniperInfinite = true; }
    },

    /* ---- 超稀有 ---- */
    {
      id: 'prod-up', name: '生产改造', rarity: 'ultra',
      desc: '之后每回合的费用 +1（永久，可叠加）。',
      apply: function (g, o) { var pk = g.perksOf(o); pk.energyPerTurn = (pk.energyPerTurn || 0) + 1; }
    },
    {
      id: 'promote3', name: '火速提拔', rarity: 'ultra',
      desc: '本回合可以把 3 个己方棋子改造成任意兵种。',
      apply: function (g, o) { var pk = g.perksOf(o); pk.promoteLeft = (pk.promoteLeft || 0) + 3; }
    },
    {
      id: 'ugly', name: '丑东西', rarity: 'ultra', need: 'dir', kind: 'tank',
      desc: '选择己方一台坦克并指定方向：+2 血 / +1 攻，该方向再 +1 射程；它阵亡时由附近的坦克或步兵继承。',
      can: function (g, o) { return ownPieces(g, o, 'tank').length > 0; },
      apply: function (g, o, a) {
        var p = g.pieceAt(a.key);
        if (!p || p.owner !== o || p.kind !== 'tank') return '请选择己方坦克';
        var d = Math.round(Number(a.dir));
        if (!(d >= 0 && d <= 5)) return '方向不合法';
        p.atk += 1; p.maxHp += 2; p.hp += 2;
        p.uglyDir = d;
      }
    },
    {
      id: 'comms', name: '高效通信', rarity: 'ultra', once: true,
      desc: '你的光环棋子的光环半径 +1。',
      apply: function (g, o) { g.perksOf(o).flags.auraRadius = true; }
    },
    {
      id: 'capture', name: '俘虏', rarity: 'ultra', once: true,
      desc: '结算时，若敌方棋子阵亡在你奴隶旁边，该奴隶升为奴隶主，阵亡的棋子变成你的奴隶。',
      apply: function (g, o) { g.perksOf(o).flags.capture = true; }
    }
  ];

  var BY_ID = {};
  CARDS.forEach(function (c) { BY_ID[c.id] = c; });

  function card(id) { return BY_ID[id] || null; }

  /* ---------------- 发牌 ---------------- */

  function taken(g, owner) {
    var pk = g.perksOf(owner);
    var set = {};
    (pk.cards || []).forEach(function (id) { set[id] = 1; });
    return set;
  }

  // 卡池：去掉唯一卡里已经拿走的
  // onlyUsable=true 时再剔除「现在没有合法目标」的卡（例如场上没有坦克时的「坚固装甲」）
  function pool(g, owner, rarity, onlyUsable) {
    var set = taken(g, owner);
    return CARDS.filter(function (c) {
      if (rarity && c.rarity !== rarity) return false;
      if (c.once && set[c.id]) return false;
      if (onlyUsable && c.can && !c.can(g, owner)) return false;
      return true;
    });
  }

  function pickRarity(rnd) {
    var total = 0;
    RARITY_ORDER.forEach(function (r) { total += RARITY[r].weight; });
    var x = rnd() * total;
    for (var i = 0; i < RARITY_ORDER.length; i++) {
      x -= RARITY[RARITY_ORDER[i]].weight;
      if (x <= 0) return RARITY_ORDER[i];
    }
    return 'common';
  }

  // 按 (seed, turn, owner) 派生的确定性随机，客户端与服务端各算一次结果相同
  function makeRnd(g, owner) {
    var s = (g.seed ^ (g.turn * 7919) ^ (owner * 104729) ^ ((g.perksOf(owner).cards || []).length * 15485863)) >>> 0;
    return ENGINE.mulberry32(s);
  }

  function rollOffer(g, owner) {
    var rnd = makeRnd(g, owner);
    var out = [];
    var guard = 0;
    while (out.length < 3 && guard++ < 200) {
      var r = pickRarity(rnd);
      // 优先发「现在用得上」的卡，避免一手全是没目标的空牌
      var list = pool(g, owner, r, true);
      if (!list.length) list = pool(g, owner, r, false);
      if (!list.length) {
        // 这一档已经拿空，退到别的档
        list = pool(g, owner, null, true);
        if (!list.length) list = pool(g, owner, null, false);
        if (!list.length) break;
      }
      var c = list[Math.floor(rnd() * list.length) % list.length];
      if (out.indexOf(c.id) >= 0) continue;
      out.push(c.id);
    }
    return out;
  }

  // 该不该发牌 / 有没有还没选的牌
  function needsOffer(g, owner) {
    if (!g || !g.rogue || g.over) return false;
    if (g.active !== owner) return false;
    if (g.turn < FIRST_TURN) return false;
    var pk = g.perksOf(owner);
    if (pk.pickedTurn === g.turn) return false;
    return true;
  }

  // 确保当前行动方手上有一份三选一（返回数组）
  function ensureOffer(g, owner) {
    if (!needsOffer(g, owner)) return null;
    var pk = g.perksOf(owner);
    if (!pk.offer || !pk.offer.length || pk.offerTurn !== g.turn) {
      pk.offer = rollOffer(g, owner);
      pk.offerTurn = g.turn;
    }
    return pk.offer.length ? pk.offer : null;
  }

  /* ---------------- 选卡 ---------------- */

  function canTake(g, owner, def) {
    if (!def) return false;
    if (typeof def.can === 'function') return !!def.can(g, owner);
    return true;
  }

  // args: { key, target, dir, type }
  function pick(g, owner, cardId, args) {
    args = args || {};
    var pk = g.perksOf(owner);
    if (!g.rogue) return { ok: false, msg: '不是肉鸽模式' };
    if (g.over) return { ok: false, msg: '对局已结束' };
    if (g.active !== owner) return { ok: false, msg: '还没轮到你' };
    if (pk.pickedTurn === g.turn) return { ok: false, msg: '这一回合已经选过了' };
    if (pk.offer && pk.offer.indexOf(cardId) < 0) return { ok: false, msg: '这张卡不在本次三选一里' };
    var def = card(cardId);
    if (!def) return { ok: false, msg: '没有这张卡' };
    if (!canTake(g, owner, def)) return { ok: false, msg: '当前没有符合条件的目标' };

    var err = null;
    try {
      err = def.apply(g, owner, args) || null;
    } catch (e) {
      err = (e && e.message) || '使用失败';
    }
    if (err) return { ok: false, msg: err };

    pk.cards.push(cardId);
    pk.pickedTurn = g.turn;
    pk.offer = null;
    pk.offerTurn = 0;
    g.history.push({ type: 'perk', owner: owner, card: cardId, turn: g.turn });
    return { ok: true, msg: '', card: def };
  }

  // 三张都选不了时跳过这一回合的三选一
  function skip(g, owner) {
    var pk = g.perksOf(owner);
    if (g.active !== owner) return { ok: false, msg: '还没轮到你' };
    pk.pickedTurn = g.turn;
    pk.offer = null;
    pk.offerTurn = 0;
    return { ok: true, msg: '' };
  }

  // 晋升：把某个己方棋子改成指定兵种，消耗一次额度
  function promote(g, owner, cellKey, typeId, dir) {
    var pk = g.perksOf(owner);
    if (!g.rogue) return { ok: false, msg: '不是肉鸽模式' };
    if (g.active !== owner) return { ok: false, msg: '还没轮到你' };
    if (!(pk.promoteLeft > 0)) return { ok: false, msg: '没有可用的晋升次数' };
    var p = g.pieceAt(cellKey);
    if (!p || p.owner !== owner || p.kind === 'base') return { ok: false, msg: '只能选择己方棋子' };
    if (!g.types[typeId] || typeId === 'slave') return { ok: false, msg: '不能改造成这个兵种' };
    if (!g.transform(p.id, typeId, dir)) return { ok: false, msg: '改造失败' };
    pk.promoteLeft -= 1;
    g.history.push({ type: 'promote', owner: owner, key: cellKey, to: typeId, dir: (p.dir == null ? null : p.dir), turn: g.turn });
    return { ok: true, msg: '', piece: p };
  }

  /* ---------------- 给界面用 ---------------- */

  function obtained(g, owner) {
    var pk = g.perksOf(owner);
    return (pk.cards || []).map(function (id) {
      var d = card(id);
      return d ? { id: id, name: d.name, rarity: d.rarity, desc: d.desc } : null;
    }).filter(Boolean);
  }

  // AI：先挑稀有度最高的，同级随机；再按简单规则补目标
  function aiPick(g, owner) {
    var offer = ensureOffer(g, owner);
    if (!offer || !offer.length) return null;
    var cands = offer.map(card).filter(function (c) { return c && canTake(g, owner, c); });
    if (!cands.length) {
      // 都不满足条件，随便挑一张能通过的；都没有就跳过
      var pk = g.perksOf(owner);
      pk.pickedTurn = g.turn; pk.offer = null; pk.offerTurn = 0;
      return null;
    }
    cands.sort(function (a, b) {
      var wa = RARITY[a.rarity].weight, wb = RARITY[b.rarity].weight;
      if (wa !== wb) return wb - wa;
      return Math.random() - 0.5;
    });
    var best = cands[0];
    var args = aiArgs(g, owner, best);
    var res = pick(g, owner, best.id, args);
    if (!res.ok) {
      // 目标没挑好，退而求其次：把这张卡标成已选，避免卡死
      var p2 = g.perksOf(owner);
      p2.pickedTurn = g.turn; p2.offer = null; p2.offerTurn = 0;
      return null;
    }
    return best;
  }

  function aiArgs(g, owner, def) {
    if (!def.need) return {};
    if (def.need === 'own') {
      var list = ownPieces(g, owner).filter(function (p) { return !p.hidden; });
      list.sort(function (a, b) { return g.hpOf(b) - g.hpOf(a); });
      return { key: (list[0] || ownPieces(g, owner)[0]).key };
    }
    if (def.need === 'tank') {
      var t = ownPieces(g, owner, 'tank');
      return { key: t[0].key };
    }
    if (def.need === 'artillery') {
      var a = ownPieces(g, owner, 'artillery');
      return { key: a[0].key };
    }
    if (def.need === 'cell') {
      var cells = emptyCells(g);
      var foe = g.baseOf(1 - owner);
      if (foe) {
        cells.sort(function (k1, k2) {
          return Hex.distance(Hex.parse(k1), Hex.parse(foe.key)) - Hex.distance(Hex.parse(k2), Hex.parse(foe.key));
        });
      }
      return { key: cells[0] };
    }
    if (def.need === 'tankInf') {
      var pair = adjPair(g, owner);
      return pair ? { key: pair[0], target: pair[1] } : {};
    }
    if (def.need === 'dir') {
      var list2 = ownPieces(g, owner, def.kind || 'tank');
      var p = list2[0];
      return p ? { key: p.key, dir: dirToFoe(g, owner, p.key) } : {};
    }
    return {};
  }

  return {
    RARITY: RARITY,
    RARITY_ORDER: RARITY_ORDER,
    FIRST_TURN: FIRST_TURN,
    CARDS: CARDS,
    card: card,
    pool: pool,
    rollOffer: rollOffer,
    needsOffer: needsOffer,
    ensureOffer: ensureOffer,
    canTake: canTake,
    pick: pick,
    skip: skip,
    promote: promote,
    obtained: obtained,
    aiPick: aiPick
  };
});
