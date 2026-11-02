/* =========================================================
 * engine.js —— 规则引擎（纯逻辑，不碰 DOM）
 *
 * 规则摘要
 *   1. 每方回合拥有 3 点费用，费用不累积，回合开始重置为 3。
 *   2. 三种棋子：步兵 / 坦克 / 炮兵（数值见 TYPES）。
 *   3. 只能把棋子放在「己方与大本营连通的棋子群」紧邻的空格上。
 *   4. 结算是一次性判定：对每个棋子，统计所有把它纳入射程的敌方棋子的
 *      攻击力之和，若 棋子血量 <= 该和，则该棋子死亡（同时判定，互不影响）。
 *      死亡结算完后，双方各自移除「与大本营断开」的棋子。
 *      回合结束前可以反复结算，不限次数。
 *   5. 大本营 4 血，同样参与受击判定（4 点攻击即可摧毁）；任一大本营死亡 -> 游戏结束。
 * ========================================================= */
(function (root, factory) {
  var HexDep = (typeof require === 'function' && typeof module === 'object' && module.exports)
    ? require('./hex.js')
    : root.Hex;
  var mod = factory(HexDep);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.ENGINE = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Hex) {
  'use strict';

  // 默认兵种数值（设置里可以改，改的是每一局的副本，不会污染这里）
  var TYPES = {
    infantry: {
      id: 'infantry', name: '步兵', glyph: '步', order: 1,
      hp: 3, atk: 1, range: 1, cost: 1,
      desc: '便宜、耐打的前排，用来铺路和占格子。'
    },
    tank: {
      id: 'tank', name: '坦克', glyph: '坦', order: 2,
      hp: 4, atk: 1, range: 1, cost: 2,
      desc: '血厚一格，需要 4 点攻击才能被结算打死。'
    },
    artillery: {
      id: 'artillery', name: '炮兵', glyph: '炮', order: 3,
      hp: 3, atk: 1, range: 2, cost: 2,
      desc: '射程 2，可隔着一排棋子输出，也是拆家的关键。'
    },
    command: {
      id: 'command', name: '指挥所', glyph: '指', order: 4,
      hp: 2, atk: 0, range: 0, cost: 2, rangeMode: 'none',
      aura: { radius: 1, effect: 'atk', amount: 1 },
      desc: '自己不能攻击；周围一圈的己方棋子攻击力 +1。'
    },
    sniper: {
      id: 'sniper', name: '狙击兵', glyph: '狙', order: 5,
      hp: 2, atk: 1, range: 3, cost: 2, rangeMode: 'line',
      desc: '部署时选定一个方向，攻击沿该方向的一条直线，最多打到 3 格外。'
    },
    slaver: {
      id: 'slaver', name: '奴隶主', glyph: '主', order: 6,
      hp: 3, atk: 1, range: 1, cost: 2,
      desc: '每回合额外免费放置一个奴隶（不花费用）。'
    },
    slave: {
      id: 'slave', name: '奴隶', glyph: '隶', order: 7,
      hp: 2, atk: 1, range: 1, cost: 0, noDeploy: true, requiresNear: 'slaver',
      desc: '只能由奴隶主免费召唤，且必须放在奴隶主周围一圈的空格上。'
    }
  };

  // 商店里可以直接买的
  var TYPE_LIST = ['infantry', 'tank', 'artillery', 'command', 'sniper', 'slaver'];
  // 全部（含召唤物），用于序列化与设置表
  var ALL_TYPE_LIST = ['infantry', 'tank', 'artillery', 'command', 'sniper', 'slaver', 'slave'];

  // 默认规则（设置里可以改）
  var DEFAULT_RULES = {
    baseHp: 4,                       // 大本营血量
    energyPerTurn: 3,                // 常规每回合费用
    firstPlayer: 1,                  // 先手：1 = 赤方（地图下方的红方）
    firstTurnEnergy: [4, 3]          // 各方第一个回合的费用（按玩家下标）：青方后手，补 4 点
  };

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), 1 | t);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 把「默认 + 传入」合并成一份单局规则
  function mergeRules(base, custom) {
    var out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    if (custom) {
      Object.keys(custom).forEach(function (k) {
        if (custom[k] !== undefined && custom[k] !== null) out[k] = custom[k];
      });
    }
    return out;
  }

  function mergeTypes(base, custom) {
    var out = {};
    Object.keys(base).forEach(function (id) {
      var def = base[id];
      var t = {};
      Object.keys(def).forEach(function (k) {
        var v = def[k];
        t[k] = (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v;
      });
      var c = custom && custom[id];
      if (c) {
        ['hp', 'atk', 'range', 'cost'].forEach(function (k) {
          var v = Number(c[k]);
          if (isFinite(v)) t[k] = v;
        });
      }
      out[id] = t;
    });
    return out;
  }

  // 自定义兵种：把外部定义归一化成安全的类型对象
  function normalizeModType(id, c, index) {
    if (!c || typeof c !== 'object') return null;
    var name = String(c.name || '').trim().slice(0, 10);
    if (!name) return null;
    var num = function (v, min, max, fb) {
      var n = Number(v);
      if (!isFinite(n)) return fb;
      return Math.min(max, Math.max(min, Math.round(n)));
    };
    var mode = c.rangeMode === 'line' ? 'line' : (c.rangeMode === 'none' ? 'none' : 'circle');
    var auraRaw = c.aura;
    var aura = null;
    if (auraRaw === true) {
      aura = { radius: 1, effect: 'atk', amount: 1 };
    } else if (auraRaw && typeof auraRaw === 'object') {
      var eff = ['atk', 'hp', 'enemyAtk', 'enemyHp'].indexOf(auraRaw.effect) >= 0 ? auraRaw.effect : 'atk';
      aura = {
        radius: num(auraRaw.radius, 1, 3, 1),
        effect: eff,
        amount: num(auraRaw.amount, 1, 5, 1)
      };
    }
    var t = {
      id: String(id),
      name: name,
      glyph: String(c.glyph || name.charAt(0)).slice(0, 2),
      order: 100 + (index || 0),
      hp: num(c.hp, 1, 30, 3),
      atk: num(c.atk, 0, 20, 1),
      range: num(c.range, 0, 6, 1),
      cost: num(c.cost, 0, 30, 2),
      rangeMode: mode,
      aura: aura,
      mod: true,
      desc: String(c.desc || '').slice(0, 120)
    };
    if (mode === 'none') t.range = 0;
    if (t.atk <= 0) t.range = 0;
    return t;
  }

  function Game(opts) {
    opts = opts || {};
    this.side = opts.side || 5;
    this.seed = (opts.seed == null ? Math.floor(Math.random() * 1e9) : opts.seed) >>> 0;
    this.rng = opts.rng || mulberry32(this.seed);
    this.density = opts.density == null ? 0.12 : opts.density;

    this.rules = mergeRules(DEFAULT_RULES, opts.rules);
    this.types = mergeTypes(TYPES, opts.types);

    // 自定义兵种（mod）：内置表里没有的键当作扩展兵种
    var extraIds = [];
    Object.keys(opts.types || {}).forEach(function (id) {
      if (TYPES[id]) return;
      var c = opts.types[id];
      if (!c || !c.name) return;
      var t = normalizeModType(id, c, extraIds.length);
      if (t) { this.types[id] = t; extraIds.push(id); }
    }, this);

    this.typeList = TYPE_LIST.concat(extraIds);
    this.allTypeList = ALL_TYPE_LIST.concat(extraIds);

    this.board = Hex.createBoard(this.side, this.density, this.rng);

    this.players = [
      { index: 0, name: '青方', color: '#2dd4bf' },
      { index: 1, name: '赤方', color: '#fb7185' }
    ];

    this.pieces = new Map();     // id -> piece
    this.occupant = new Map();   // cellKey -> id
    this.nextId = 1;
    this.kills = [0, 0];         // 各方的击杀数（含断联移除）
    this.lost = [0, 0];          // 各方的损失数
    this.maxSwing = [0, 0];      // 单次结算最多清掉对方几个棋子
    this.slavesUsed = [0, 0];    // 本回合各方已经召出的奴隶数（每回合清零）

    this.baseIds = [null, null];
    this.baseIds[0] = this.spawnBase(0, this.board.baseA).id;
    this.baseIds[1] = this.spawnBase(1, this.board.baseB).id;

    this.firstPlayer = this.rules.firstPlayer;
    this.active = this.firstPlayer;   // 当前行动方
    this.turn = 1;
    this.energy = this.turnEnergy();
    this.turnEnergyMax = this.energy;   // 本回合开局给了多少点（界面显示用）
    this.resolveCount = 0;       // 本回合已经结算过几次（结算不限次数，这里只做记录）
    this.over = false;
    this.winner = null;          // 0 / 1 / -1(同归于尽)
    this.history = [];           // 供战报使用
  }

  /* ---------------- 基础查询 ---------------- */

  Game.prototype.spawnBase = function (owner, cell) {
    var hp = this.rules.baseHp;
    var p = {
      id: this.nextId++, owner: owner, kind: 'base',
      key: Hex.key(cell.q, cell.r),
      hp: hp, maxHp: hp, atk: 0, range: 0
    };
    this.pieces.set(p.id, p);
    this.occupant.set(p.key, p.id);
    return p;
  };

  Game.prototype.pieceAt = function (cellKey) {
    var id = this.occupant.get(cellKey);
    return id == null ? null : (this.pieces.get(id) || null);
  };

  Game.prototype.baseOf = function (owner) {
    var id = this.baseIds[owner];
    return id == null ? null : (this.pieces.get(id) || null);
  };

  Game.prototype.listOf = function (owner) {
    var out = [];
    this.pieces.forEach(function (p) { if (p.owner === owner) out.push(p); });
    return out;
  };

  Game.prototype.countOf = function (owner) {
    var n = 0;
    this.pieces.forEach(function (p) { if (p.owner === owner && p.kind !== 'base') n++; });
    return n;
  };

  // 己方与大本营连通的所有棋子所在格
  Game.prototype.componentKeys = function (owner) {
    var out = new Set();
    var base = this.baseOf(owner);
    if (!base) return out;

    var seen = new Set([base.key]);
    var stack = [base.key];
    out.add(base.key);

    while (stack.length) {
      var k = stack.pop();
      var c = Hex.parse(k);
      var ns = Hex.neighbors(c.q, c.r);
      for (var i = 0; i < 6; i++) {
        var nk = Hex.key(ns[i].q, ns[i].r);
        if (seen.has(nk)) continue;
        var id = this.occupant.get(nk);
        if (id == null) continue;
        var p = this.pieces.get(id);
        if (!p || p.owner !== owner) continue;
        seen.add(nk);
        out.add(nk);
        stack.push(nk);
      }
    }
    return out;
  };

  // 合法落子点：己方连通块紧邻、非障碍、无人占据
  Game.prototype.legalCells = function (owner) {
    var out = new Set();
    var comp = this.componentKeys(owner);
    comp.forEach(function (k) {
      var c = Hex.parse(k);
      var ns = Hex.neighbors(c.q, c.r);
      for (var i = 0; i < 6; i++) {
        var nk = Hex.key(ns[i].q, ns[i].r);
        var cell = this.board.cells.get(nk);
        if (!cell || cell.obstacle) continue;
        if (this.occupant.has(nk)) continue;
        out.add(nk);
      }
    }, this);
    return out;
  };

  Game.prototype.canPlace = function (owner, typeId, cellKey, opts) {
    opts = opts || {};
    var t = this.types[typeId];
    if (!t) return { ok: false, msg: '未知兵种' };
    if (this.over) return { ok: false, msg: '对局已结束' };
    if (owner !== this.active) return { ok: false, msg: '还没轮到你' };
    if (t.noDeploy && !opts.free) return { ok: false, msg: '这个兵种只能由奴隶主召唤' };
    if (t.rangeMode === 'line' && opts.dir == null) return { ok: false, msg: '请先选择狙击方向' };
    if (opts.dir != null && (opts.dir < 0 || opts.dir > 5)) return { ok: false, msg: '方向不合法' };
    if (!opts.free && this.energy < t.cost) return { ok: false, msg: '费用不足' };
    var cell = this.board.cells.get(cellKey);
    if (!cell) return { ok: false, msg: '地图外' };
    if (cell.obstacle) return { ok: false, msg: '这里是障碍' };

    // 有些兵种必须贴着某个兵种放（例如奴隶要挨着奴隶主）
    if (t.requiresNear) {
      var need = this.types[t.requiresNear] || TYPES[t.requiresNear];
      var near = false;
      var here = Hex.parse(cellKey);
      var self = this;
      this.pieces.forEach(function (p) {
        if (p.owner !== owner || p.kind !== t.requiresNear) return;
        if (Hex.distance(Hex.parse(p.key), here) === 1) near = true;
      });
      if (!near) {
        return { ok: false, msg: '只能放在「' + ((need && need.name) || t.requiresNear) + '」周围一圈' };
      }
    }

    // 目标格上已经有棋子
    var occupiedId = this.occupant.get(cellKey);
    if (occupiedId != null) {
      var sitting = this.pieces.get(occupiedId);
      if (!sitting) return { ok: false, msg: '这里已经有棋子了' };
      if (sitting.kind === 'base') return { ok: false, msg: '大本营不能被替换' };
      if (sitting.owner !== owner) return { ok: false, msg: '这里是对面的棋子' };
      if (sitting.kind === typeId && !opts.force) {
        return { ok: false, msg: '这个位置已经是 ' + (t.name || '同类棋子') + ' 了' };
      }
      return { ok: true, msg: '', replace: sitting };
    }

    if (!this.legalCells(owner).has(cellKey)) return { ok: false, msg: '只能放在己方连通块的边缘' };
    return { ok: true, msg: '' };
  };

  // 可以被己方棋子替换掉的格子（不含大本营）
  Game.prototype.replaceableCells = function (owner) {
    var out = new Set();
    this.pieces.forEach(function (p) {
      if (p.owner === owner && p.kind !== 'base') out.add(p.key);
    });
    return out;
  };

  /* ---------------- 行动 ---------------- */

  Game.prototype.place = function (owner, typeId, cellKey, opts) {
    opts = opts || {};
    var check = this.canPlace(owner, typeId, cellKey, opts);
    if (!check.ok) {
      var e = new Error(check.msg);
      e.code = 'ILLEGAL';
      throw e;
    }
    var t = this.types[typeId];

    // 替换己方棋子：先把原来那个撤掉（不计入击杀/损失）
    var replaced = null;
    if (check.replace) {
      replaced = this.removeById(check.replace.id);
    }

    var p = {
      id: this.nextId++, owner: owner, kind: typeId, key: cellKey,
      hp: t.hp, maxHp: t.hp, atk: t.atk, range: t.range,
      dir: (t.rangeMode === 'line') ? (opts.dir == null ? 0 : opts.dir) : null
    };
    this.pieces.set(p.id, p);
    this.occupant.set(cellKey, p.id);
    if (!opts.free) this.energy -= t.cost;

    this.history.push({
      type: 'place', owner: owner, kind: typeId, key: cellKey,
      dir: p.dir, free: !!opts.free,
      replacedKind: replaced ? replaced.kind : null,
      turn: this.turn
    });
    return p;
  };

  /* ---------------- 奴隶：由奴隶主免费召唤 ---------------- */

  Game.prototype.slaverCount = function (owner) {
    var n = 0;
    this.pieces.forEach(function (p) {
      if (p.owner === owner && p.kind === 'slaver') n += 1;
    });
    return n;
  };

  // 本方本回合还能免费召唤几个奴隶
  Game.prototype.freeSlavesLeft = function (owner) {
    var used = this.slavesUsed[owner] || 0;
    return Math.max(0, this.slaverCount(owner) - used);
  };

  // 奴隶能放的格子：连通块边缘 ∩ 奴隶主周围一圈
  Game.prototype.slaveCells = function (owner) {
    var frontier = this.legalCells(owner);
    var out = new Set();
    var self = this;
    this.pieces.forEach(function (p) {
      if (p.owner !== owner || p.kind !== 'slaver') return;
      var c = Hex.parse(p.key);
      Hex.neighbors(c.q, c.r).forEach(function (n) {
        var k = Hex.key(n.q, n.r);
        if (frontier.has(k)) out.add(k);
      });
    });
    return out;
  };

  Game.prototype.placeSlave = function (owner, cellKey) {
    if (this.freeSlavesLeft(owner) <= 0) {
      var e = new Error('本回合没有可召唤的奴隶了');
      e.code = 'ILLEGAL';
      throw e;
    }
    var p = this.place(owner, 'slave', cellKey, { free: true });
    this.slavesUsed[owner] = (this.slavesUsed[owner] || 0) + 1;
    return p;
  };

  // 教学 / 测试专用：无视放置规则直接把棋子摆上去（hp 可指定，用来做残血场景）
  Game.prototype.spawn = function (owner, typeId, cellKey, hp, dir) {
    var t = this.types[typeId];
    if (!t) return null;
    if (!this.board.cells.has(cellKey)) return null;
    if (this.occupant.has(cellKey)) return null;
    var p = {
      id: this.nextId++, owner: owner, kind: typeId, key: cellKey,
      hp: (hp == null ? t.hp : hp), maxHp: t.hp, atk: t.atk, range: t.range,
      dir: (t.rangeMode === 'line') ? (dir == null ? 0 : dir) : null
    };
    this.pieces.set(p.id, p);
    this.occupant.set(cellKey, p.id);
    return p;
  };
  Game.prototype.removeById = function (id) {
    var p = this.pieces.get(id);
    if (!p) return null;
    this.pieces.delete(id);
    if (this.occupant.get(p.key) === id) this.occupant.delete(p.key);
    return p;
  };

  // 每个棋子会吃到的敌方攻击力总和（只读，不改变局面；AI 和结算共用）
  /* ---------------- 光环 ---------------- */
  // 每种兵种都可以带一个光环：{ radius, effect, amount }
  //   effect = atk      己方在范围内攻击力 +amount
  //          = hp       己方在范围内血量 +amount
  //          = enemyAtk 敌方在范围内攻击力 -amount
  //          = enemyHp  敌方在范围内血量 -amount
  var AURA_EFFECTS = ['atk', 'hp', 'enemyAtk', 'enemyHp'];

  function normAura(raw) {
    if (raw === true) return { radius: 1, effect: 'atk', amount: 1 };
    if (!raw || typeof raw !== 'object') return null;
    var eff = AURA_EFFECTS.indexOf(raw.effect) >= 0 ? raw.effect : 'atk';
    var clamp = function (v, min, max) {
      var n = Math.round(Number(v));
      if (!isFinite(n)) n = min;
      return Math.min(max, Math.max(min, n));
    };
    return {
      radius: clamp(raw.radius, 1, 3),
      effect: eff,
      amount: clamp(raw.amount, 1, 5)
    };
  }

  Game.prototype.auraOf = function (piece) {
    var t = this.types[piece.kind] || TYPES[piece.kind];
    return t ? normAura(t.aura) : null;
  };

  // 统计覆盖到 target 的某个效果的光环总量
  Game.prototype.auraSum = function (target, effect) {
    var self = this;
    var from = Hex.parse(target.key);
    var total = 0;
    this.pieces.forEach(function (o) {
      if (o.kind === 'base') return;
      var a = self.auraOf(o);
      if (!a || a.effect !== effect) return;
      if (Hex.distance(Hex.parse(o.key), from) > a.radius) return;
      var friendly = (a.effect === 'atk' || a.effect === 'hp');
      if (friendly && o.owner !== target.owner) return;
      if (!friendly && o.owner === target.owner) return;
      total += a.amount;
    });
    return total;
  };

  // 实际攻击力（受光环影响）
  Game.prototype.atkOf = function (piece) {
    var base = piece.atk || 0;
    if (base <= 0) return 0;
    var v = base + this.auraSum(piece, 'atk') - this.auraSum(piece, 'enemyAtk');
    return Math.max(0, v);
  };

  // 实际血量（受光环影响，最低 1）
  Game.prototype.hpOf = function (piece) {
    var base = piece.hp || 0;
    if (base <= 0) return 0;
    var v = base + this.auraSum(piece, 'hp') - this.auraSum(piece, 'enemyHp');
    return Math.max(1, v);
  };

  // 从 fromKey 出发，哪个方向离 target 最近（狙击兵默认朝向 / 预览用）
  Game.prototype.dirToward = function (fromKey, targetKey) {
    var from = Hex.parse(fromKey);
    var target = targetKey ? Hex.parse(targetKey) : null;
    var best = 0;
    var bestD = Infinity;
    for (var d = 0; d < 6; d++) {
      var dir = Hex.DIRS[d];
      var nq = from.q + dir.q;
      var nr = from.r + dir.r;
      if (!this.board.cells.has(Hex.key(nq, nr))) continue;
      var dist = target ? Hex.distance({ q: nq, r: nr }, target) : d;
      if (dist < bestD) { bestD = dist; best = d; }
    }
    return best;
  };

  // 假设在这个格子放一个该兵种，它能打到哪些格子（放置前预览用）
  Game.prototype.attackCellsFrom = function (typeId, cellKey, dir) {
    var t = this.types[typeId] || TYPES[typeId];
    if (!t) return new Set();
    if (!this.board.cells.has(cellKey)) return new Set();
    var fake = {
      owner: this.active,
      kind: typeId,
      key: cellKey,
      atk: t.atk,
      range: t.range,
      dir: (dir == null ? 0 : dir)
    };
    return this.attackCells(fake);
  };

  // 某个棋子能打到的格子集合
  Game.prototype.attackCells = function (piece) {
    var out = new Set();
    var t = this.types[piece.kind] || TYPES[piece.kind] || {};
    if ((piece.atk || 0) <= 0) return out;
    var from = Hex.parse(piece.key);
    var mode = t.rangeMode || 'circle';

    if (mode === 'line') {
      // 直线：沿部署时选定的方向，最多 range 格
      var d = Hex.DIRS[piece.dir == null ? 0 : piece.dir] || Hex.DIRS[0];
      var len = Math.max(1, piece.range || 1);
      for (var step = 1; step <= len; step++) {
        var k = Hex.key(from.q + d.q * step, from.r + d.r * step);
        if (this.board.cells.has(k)) out.add(k);
      }
      return out;
    }

    // 圆形：距离 <= range
    var r = Math.max(0, piece.range || 0);
    for (var dq = -r; dq <= r; dq++) {
      for (var dr = -r; dr <= r; dr++) {
        if (Math.abs(dq + dr) > r) continue;
        if (dq === 0 && dr === 0) continue;
        var key = Hex.key(from.q + dq, from.r + dr);
        if (this.board.cells.has(key)) out.add(key);
      }
    }
    return out;
  };

  Game.prototype.damageMap = function () {
    var self = this;
    var out = new Map();
    var all = [];
    this.pieces.forEach(function (p) { all.push(p); out.set(p.id, 0); });

    all.forEach(function (attacker) {
      var a = self.atkOf(attacker);
      if (a <= 0) return;
      var cells = self.attackCells(attacker);
      if (!cells.size) return;
      cells.forEach(function (key) {
        var id = self.occupant.get(key);
        if (id == null) return;
        var target = self.pieces.get(id);
        if (!target || target.owner === attacker.owner) return;
        out.set(target.id, (out.get(target.id) || 0) + a);
      });
    });
    return out;
  };

  // 结算：伤害判定 -> 死亡移除 -> 断联移除 -> 判定胜负
  // 规则：回合结束前可以随时结算，且不限次数（局面没变时重复结算不会有新结果）
  Game.prototype.resolve = function () {
    if (this.over) return null;

    var all = [];
    this.pieces.forEach(function (p) { all.push(p); });

    // 1) 伤害统计（基于结算前的局面，互不干扰）
    var damage = this.damageMap();

    // 2) 致死判定（血量 <= 攻击总和，即攻击打满血量就死）
    var killed = [];
    for (var m = 0; m < all.length; m++) {
      var p = all[m];
      var dmg = damage.get(p.id);
      if (dmg > 0 && dmg >= this.hpOf(p)) killed.push(p);
    }
    var killedIds = new Set(killed.map(function (p) { return p.id; }));

    var removed = [];
    killed.forEach(function (p) {
      var gone = this.removeById(p.id);
      if (!gone) return;
      removed.push({ piece: gone, reason: 'damage', damage: damage.get(p.id) });
      this.lost[gone.owner] += 1;
      if (gone.kind !== 'base') this.kills[1 - gone.owner] += 1;
    }, this);

    // 3) 断联移除：双方各自检查（死亡之后才检查，因此可以「切断」敌人）
    var cut = [];
    for (var owner = 0; owner < 2; owner++) {
      var base = this.baseOf(owner);
      if (!base) continue;
      var comp = this.componentKeys(owner);
      var own = this.listOf(owner);
      for (var n = 0; n < own.length; n++) {
        var q = own[n];
        if (q.kind === 'base') continue;
        if (comp.has(q.key)) continue;
        if (killedIds.has(q.id)) continue;
        cut.push(q);
      }
    }
    cut.forEach(function (p) {
      var gone = this.removeById(p.id);
      if (!gone) return;
      removed.push({ piece: gone, reason: 'cut', damage: 0 });
      this.lost[gone.owner] += 1;
      this.kills[1 - gone.owner] += 1;
    }, this);

    // 3.5) 记录「单次结算最大击杀」
    var perOwner = [0, 0];
    removed.forEach(function (r) { perOwner[r.piece.owner] += 1; });
    for (var oo = 0; oo < 2; oo++) {
      var killer = 1 - oo;
      if (perOwner[oo] > this.maxSwing[killer]) this.maxSwing[killer] = perOwner[oo];
    }

    // 4) 胜负：大本营是否死亡
    var deadBases = [this.baseOf(0) ? false : true, this.baseOf(1) ? false : true];
    if (deadBases[0] || deadBases[1]) {
      this.over = true;
      if (deadBases[0] && deadBases[1]) this.winner = -1;
      else this.winner = deadBases[0] ? 1 : 0;
    }

    this.resolveCount += 1;

    var result = {
      turn: this.turn,
      active: this.active,
      resolveCount: this.resolveCount,
      damage: damage,
      damageById: damage,
      killedByDamage: removed.filter(function (r) { return r.reason === 'damage'; }),
      removedByCut: removed.filter(function (r) { return r.reason === 'cut'; }),
      removed: removed,
      over: this.over,
      winner: this.winner,
      deadBases: deadBases
    };
    this.history.push({ type: 'resolve', owner: this.active, turn: this.turn, result: result });
    return result;
  };

  // 本回合应该给多少费用：第 1 回合是双方各自的第一个回合，后手（青方）多 1 点
  Game.prototype.turnEnergy = function () {
    if (this.turn === 1) {
      var e = this.rules.firstTurnEnergy[this.active];
      if (e != null) return e;
    }
    return this.rules.energyPerTurn;
  };

  Game.prototype.endTurn = function () {
    if (this.over) return;
    this.active = 1 - this.active;
    if (this.active === this.firstPlayer) this.turn += 1;
    this.energy = this.turnEnergy();
    this.turnEnergyMax = this.energy;
    this.resolveCount = 0;
    this.slavesUsed[this.active] = 0;     // 新回合：奴隶主的免费额度刷新
    this.history.push({ type: 'turn', owner: this.active, turn: this.turn });
  };

  Game.prototype.stats = function (owner) {
    var base = this.baseOf(owner);
    return {
      baseHp: base ? base.hp : 0,
      baseAlive: !!base,
      units: this.countOf(owner),
      kills: this.kills[owner],
      lost: this.lost[owner]
    };
  };

  /* ---------------- 复制 / 序列化（AI 推演、联机同步都用得到） ---------------- */

  // 深拷贝一份局面：棋盘只读可共享，棋子和地图状态必须复制
  Game.prototype.clone = function () {
    var g = Object.create(Game.prototype);
    g.side = this.side;
    g.seed = this.seed;
    g.rng = this.rng;
    g.density = this.density;
    g.rules = this.rules;
    g.types = this.types;
    g.typeList = this.typeList;
    g.board = this.board;
    g.players = this.players;

    g.pieces = new Map();
    this.pieces.forEach(function (p, id) {
      g.pieces.set(id, {
        id: p.id, owner: p.owner, kind: p.kind, key: p.key,
        hp: p.hp, maxHp: p.maxHp, atk: p.atk, range: p.range,
        dir: (p.dir == null ? null : p.dir)
      });
    });
    g.occupant = new Map(this.occupant);
    g.nextId = this.nextId;
    g.kills = this.kills.slice();
    g.lost = this.lost.slice();
    g.maxSwing = this.maxSwing.slice();
    g.slavesUsed = this.slavesUsed.slice();
    g.baseIds = this.baseIds.slice();
    g.firstPlayer = this.firstPlayer;
    g.active = this.active;
    g.turn = this.turn;
    g.energy = this.energy;
    g.turnEnergyMax = this.turnEnergyMax;
    g.resolveCount = this.resolveCount;
    g.over = this.over;
    g.winner = this.winner;
    g.history = [];
    return g;
  };

  // 联机用的紧凑状态：地图只传障碍坐标，客户端按同样规则重建
  Game.prototype.toJSON = function () {
    var pieces = [];
    this.pieces.forEach(function (p) {
      pieces.push({
        id: p.id, o: p.owner, k: p.kind, c: p.key,
        hp: p.hp, m: p.maxHp, a: p.atk, r: p.range,
        dir: (p.dir == null ? null : p.dir)
      });
    });
    var obstacles = [];
    this.board.cells.forEach(function (c) { if (c.obstacle) obstacles.push(c.key); });
    return {
      v: 1,
      side: this.side,
      seed: this.seed,
      density: this.density,
      rules: this.rules,
      types: this.types,
      obstacles: obstacles,
      pieces: pieces,
      nextId: this.nextId,
      kills: this.kills,
      lost: this.lost,
      maxSwing: this.maxSwing,
      slavesUsed: this.slavesUsed,
      baseIds: this.baseIds,
      firstPlayer: this.firstPlayer,
      active: this.active,
      turn: this.turn,
      energy: this.energy,
      turnEnergyMax: this.turnEnergyMax,
      resolveCount: this.resolveCount,
      over: this.over,
      winner: this.winner
    };
  };

  Game.fromJSON = function (s) {
    var g = new Game({
      side: s.side,
      density: 0,
      seed: s.seed,
      rules: s.rules,
      types: s.types
    });

    g.board.cells.forEach(function (c) { c.obstacle = false; });
    var obs = s.obstacles || [];
    obs.forEach(function (k) {
      var c = g.board.cells.get(k);
      if (c) c.obstacle = true;
    });
    g.board.obstacles = obs.length;

    g.pieces.clear();
    g.occupant.clear();
    (s.pieces || []).forEach(function (d) {
      var p = {
        id: d.id, owner: d.o, kind: d.k, key: d.c,
        hp: d.hp, maxHp: d.m != null ? d.m : d.hp,
        atk: d.a != null ? d.a : 0, range: d.r != null ? d.r : 0,
        dir: (d.dir == null ? null : d.dir)
      };
      g.pieces.set(p.id, p);
      g.occupant.set(p.key, p.id);
    });
    g.nextId = s.nextId || 1;
    g.kills = (s.kills || [0, 0]).slice();
    g.lost = (s.lost || [0, 0]).slice();
    g.maxSwing = (s.maxSwing || [0, 0]).slice();
    g.slavesUsed = (s.slavesUsed || [0, 0]).slice();
    g.baseIds = (s.baseIds || [null, null]).slice();
    g.firstPlayer = s.firstPlayer;
    g.active = s.active;
    g.turn = s.turn;
    g.energy = s.energy;
    g.turnEnergyMax = s.turnEnergyMax;
    g.resolveCount = s.resolveCount || 0;
    g.over = !!s.over;
    g.winner = s.winner;
    g.history = [];
    return g;
  };

  return {
    TYPES: TYPES,
    TYPE_LIST: TYPE_LIST,
    ALL_TYPE_LIST: ALL_TYPE_LIST,
    DEFAULT_RULES: DEFAULT_RULES,
    BASE_HP: DEFAULT_RULES.baseHp,
    ENERGY_PER_TURN: DEFAULT_RULES.energyPerTurn,
    FIRST_PLAYER: DEFAULT_RULES.firstPlayer,
    FIRST_TURN_ENERGY: DEFAULT_RULES.firstTurnEnergy,
    mulberry32: mulberry32,
    Game: Game
  };
});
