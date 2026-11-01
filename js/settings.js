/* =========================================================
 * settings.js —— 设置的数据模型（菜单页与对局页共用）
 *
 *   菜单页负责「编辑」，对局页只负责「读取」，
 *   两边都通过 localStorage 里的同一份 JSON。
 * ========================================================= */
(function (root) {
  'use strict';

  var ENGINE = root.ENGINE;
  var STORE_KEY = 'yesterday-bus.settings.v1';
  var DEFAULT_MAPS = (root.MAPS && root.MAPS.DEFAULT_MAPS) || [{ name: '随机', density: 0.14, seed: 1 }];

  function cloneType(t) { return { hp: t.hp, atk: t.atk, range: t.range, cost: t.cost }; }

  function clampNum(v, min, max, fallback) {
    var n = Number(v);
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }
  function clampInt(v, min, max, fallback) {
    return Math.round(clampNum(v, min, max, fallback));
  }

  function defaults() {
    return {
      mapMode: 'random',
      defaultMap: 0,
      side: 5,
      density: 0.14,
      energy: ENGINE.DEFAULT_RULES.energyPerTurn,
      firstPlayer: ENGINE.DEFAULT_RULES.firstPlayer,
      lastBonus: 1,
      baseHp: ENGINE.DEFAULT_RULES.baseHp,
      types: {
        infantry: cloneType(ENGINE.TYPES.infantry),
        tank: cloneType(ENGINE.TYPES.tank),
        artillery: cloneType(ENGINE.TYPES.artillery)
      }
    };
  }

  // 把设置修正到合法范围（就地修改并返回）
  function sanitize(s) {
    s = s || defaults();
    s.side = clampInt(s.side, 3, 8, 5);
    s.density = clampNum(s.density, 0, 0.4, 0.14);
    s.energy = clampInt(s.energy, 1, 9, 3);
    s.firstPlayer = Number(s.firstPlayer) === 1 ? 1 : 0;
    s.lastBonus = clampInt(s.lastBonus, 0, 8, 1);
    s.baseHp = clampInt(s.baseHp, 1, 20, 4);
    s.mapMode = (s.mapMode === 'default') ? 'default' : 'random';
    s.defaultMap = clampInt(s.defaultMap, 0, DEFAULT_MAPS.length - 1, 0);
    if (!s.types) s.types = {};
    ENGINE.TYPE_LIST.forEach(function (id) {
      if (!s.types[id]) s.types[id] = cloneType(ENGINE.TYPES[id]);
      var t = s.types[id];
      t.hp = clampInt(t.hp, 1, 30, ENGINE.TYPES[id].hp);
      t.atk = clampInt(t.atk, 0, 20, ENGINE.TYPES[id].atk);
      t.range = clampInt(t.range, 0, 6, ENGINE.TYPES[id].range);
      t.cost = clampInt(t.cost, 1, 30, ENGINE.TYPES[id].cost);
    });
    return s;
  }

  // 地图来源：默认图用固定 边长/密度/种子；随机图交给随机种子
  function mapOf(s) {
    s = sanitize(s || defaults());
    if (s.mapMode === 'default') {
      var m = DEFAULT_MAPS[s.defaultMap] || DEFAULT_MAPS[0];
      return {
        side: (root.MAPS && root.MAPS.SIDE) || 5,
        density: m.density,
        seed: m.seed,
        label: m.name
      };
    }
    return { side: s.side, density: s.density, seed: null, label: null };
  }

  // 设置 -> 单局规则
  function rulesOf(s) {
    s = sanitize(s || defaults());
    var fe = [s.energy, s.energy];
    fe[1 - s.firstPlayer] = s.energy + s.lastBonus;
    return {
      baseHp: s.baseHp,
      energyPerTurn: s.energy,
      firstPlayer: s.firstPlayer,
      firstTurnEnergy: fe
    };
  }

  function load() {
    var base = defaults();
    var raw = null;
    try { raw = root.localStorage.getItem(STORE_KEY); } catch (e) { raw = null; }
    if (!raw) return base;
    var saved = null;
    try { saved = JSON.parse(raw); } catch (e) { saved = null; }
    if (!saved || typeof saved !== 'object') return base;
    ['side', 'density', 'energy', 'firstPlayer', 'lastBonus', 'baseHp',
      'mapMode', 'defaultMap'].forEach(function (k) {
      if (saved[k] !== undefined) base[k] = saved[k];
    });
    ENGINE.TYPE_LIST.forEach(function (id) {
      var st = saved.types && saved.types[id];
      if (!st) return;
      ['hp', 'atk', 'range', 'cost'].forEach(function (f) {
        if (st[f] !== undefined) base.types[id][f] = st[f];
      });
    });
    return base;
  }

  function save(s) {
    try { root.localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) {}
  }

  function setPath(obj, path, value) {
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]]) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  function getPath(obj, path) {
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  root.SET = {
    STORE_KEY: STORE_KEY,
    DEFAULT_MAPS: DEFAULT_MAPS,
    defaults: defaults,
    sanitize: sanitize,
    mapOf: mapOf,
    rulesOf: rulesOf,
    load: load,
    save: save,
    setPath: setPath,
    getPath: getPath,
    clampNum: clampNum,
    clampInt: clampInt,
    cloneType: cloneType
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
