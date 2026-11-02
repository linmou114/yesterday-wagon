/* =========================================================
 * mods.js —— 自建兵种（mod）的公共逻辑
 *
 *   · 定义校验与归一化
 *   · 本地「我的兵种」（localStorage）
 *   · 与服务器 /api/mods 通信
 *
 *   菜单页与对局页都会加载它。
 * ========================================================= */
(function (root) {
  'use strict';

  var STORE_KEY = 'yesterday-bus.mods.v1';   // 我发布/收藏过的定义 + secret
  var PICK_KEY = 'yesterday-bus.modpick.v1'; // 启用了哪些
  var REMOTE_KEY = 'yesterday-bus.modremote.v1'; // 从服务器拉到的定义缓存（不含 secret）

  var MAX_NAME = 10;
  var MAX_DESC = 120;
  var MAX_MODS = 8;                          // 一局最多带几个

  function clamp(v, min, max, fb) {
    var n = Number(v);
    if (!isFinite(n)) return fb;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  // 把任意输入洗成安全、完整的兵种定义
  var AURA_EFFECTS = ['atk', 'hp', 'enemyAtk', 'enemyHp'];

  function normalizeAura(raw) {
    if (raw === true) return { radius: 1, effect: 'atk', amount: 1 };
    if (!raw || typeof raw !== 'object') return null;
    return {
      radius: clamp(raw.radius, 1, 3, 1),
      effect: AURA_EFFECTS.indexOf(raw.effect) >= 0 ? raw.effect : 'atk',
      amount: clamp(raw.amount, 1, 5, 1)
    };
  }

  function normalize(raw) {
    raw = raw || {};
    var name = String(raw.name || '').trim().slice(0, MAX_NAME);
    var mode = raw.rangeMode === 'line' ? 'line' : (raw.rangeMode === 'none' ? 'none' : 'circle');
    var out = {
      name: name,
      glyph: String(raw.glyph || name.charAt(0) || '兵').slice(0, 2),
      hp: clamp(raw.hp, 1, 30, 3),
      atk: clamp(raw.atk, 0, 20, 1),
      range: clamp(raw.range, 0, 6, 1),
      cost: clamp(raw.cost, 0, 30, 2),
      rangeMode: mode,
      aura: normalizeAura(raw.aura),
      desc: String(raw.desc || '').slice(0, MAX_DESC)
    };
    if (mode === 'none') out.range = 0;
    if (out.atk <= 0) out.range = 0;
    if (raw.id) out.id = String(raw.id);
    return out;
  }

  function validate(raw) {
    var n = normalize(raw);
    if (!n.name) return { ok: false, msg: '请先给棋子起个名字' };
    if (n.rangeMode !== 'none' && n.atk > 0 && n.range <= 0) {
      return { ok: false, msg: '攻击力大于 0 时射程至少为 1（或把攻击力设为 0）' };
    }
    return { ok: true, mod: n, msg: '' };
  }

  /* ---------------- 本地存储 ---------------- */

  function readJson(key, fb) {
    try {
      var raw = root.localStorage.getItem(key);
      if (!raw) return fb;
      var v = JSON.parse(raw);
      return v == null ? fb : v;
    } catch (e) { return fb; }
  }

  function writeJson(key, v) {
    try { root.localStorage.setItem(key, JSON.stringify(v)); } catch (e) {}
  }

  // 我保存过的定义：{ [id]: {def..., secret?} }
  function myMods() { return readJson(STORE_KEY, {}); }

  function saveMine(def, secret) {
    var all = myMods();
    var id = def.id || ('local_' + Date.now().toString(36));
    all[id] = Object.assign({}, normalize(def), { id: id, savedAt: Date.now() });
    if (secret) all[id].secret = secret;
    writeJson(STORE_KEY, all);
    return id;
  }

  function removeMine(id) {
    var all = myMods();
    delete all[id];
    writeJson(STORE_KEY, all);

    var cache = readJson(REMOTE_KEY, {});
    delete cache[id];
    writeJson(REMOTE_KEY, cache);

    var pick = picks();
    delete pick[id];
    writeJson(PICK_KEY, pick);
  }

  // 启用了哪些（按 id）
  function picks() { return readJson(PICK_KEY, {}); }

  function setPick(id, on) {
    var p = picks();
    if (on) p[id] = true; else delete p[id];
    var ids = Object.keys(p);
    while (ids.length > MAX_MODS) { delete p[ids.pop()]; }
    writeJson(PICK_KEY, p);
  }

  // 服务器上拉到的定义缓存
  function remoteCache() { return readJson(REMOTE_KEY, {}); }

  // 我是不是这个棋子的作者（有 secret 才算）
  function isMine(id) {
    var mine = myMods()[id];
    return !!(mine && mine.secret);
  }

  function cacheRemote(list) {
    var cache = {};
    (list || []).forEach(function (m) {
      if (!m || !m.id) return;
      var d = normalize(m);
      d.id = String(m.id);
      d.remote = true;
      cache[d.id] = d;
    });
    writeJson(REMOTE_KEY, cache);
    return cache;
  }

  // 本地 + 缓存的全部可用定义，合并成一个 id -> def
  function allDefs() {
    var out = {};
    var rc = remoteCache();
    Object.keys(rc).forEach(function (id) { out[id] = normalize(Object.assign({}, rc[id], { id: id })); });
    var mine = myMods();
    Object.keys(mine).forEach(function (id) {
      out[id] = normalize(Object.assign({}, mine[id], { id: id }));
      out[id].mine = true;
    });
    return out;
  }

  // 当前启用的定义（本地 + 服务器缓存都能用）
  function enabledDefs() {
    var all = allDefs();
    var p = picks();
    var out = [];
    Object.keys(p).forEach(function (id) {
      if (all[id]) out.push(Object.assign({}, all[id], { id: id }));
    });
    return out.slice(0, MAX_MODS);
  }

  function enabledIds() {
    return enabledDefs().map(function (d) { return d.id; });
  }

  /* ---------------- 服务器通信 ---------------- */

  function apiUrl(pathname) {
    if (typeof location === 'undefined') return '';
    if (location.protocol === 'file:') return '';
    return location.origin + pathname;
  }

  function listRemote() {
    var url = apiUrl('/api/mods');
    if (!url) return Promise.resolve([]);
    return fetch(url, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : { mods: [] }; })
      .then(function (j) { return (j && j.mods) || []; })
      .catch(function () { return []; });
  }

  // 本机身份（用于统计免费额度），生成一次后一直复用
  function clientId() {
    var KEY = 'yesterday-bus.client.v1';
    var v = null;
    try { v = localStorage.getItem(KEY); } catch (e) {}
    if (!v) {
      v = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      try { localStorage.setItem(KEY, v); } catch (e) {}
    }
    return v;
  }

  function quota() {
    var url = apiUrl('/api/mods/quota?client=' + encodeURIComponent(clientId()));
    if (!url) return Promise.resolve({ used: 0, limit: 4 });
    return fetch(url, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : { used: 0, limit: 4 }; })
      .catch(function () { return { used: 0, limit: 4 }; });
  }

  function publish(def, key) {
    var url = apiUrl('/api/mods');
    if (!url) return Promise.reject(new Error('这个页面不是从服务器打开的，无法上传'));
    var body = JSON.stringify({
      mod: normalize(def),
      client: clientId(),
      key: String(key || '')
    });
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || '上传失败');
        return j;      // { mod, secret }
      });
    });
  }

  function removeRemote(id, secret) {
    var url = apiUrl('/api/mods/' + encodeURIComponent(id));
    if (!url) return Promise.reject(new Error('离线状态'));
    return fetch(url, {
      method: 'DELETE',
      headers: { 'x-mod-secret': secret || '' }
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || '删除失败');
        return j;
      });
    });
  }

  var AURA_LABEL = {
    atk: '己方攻击力',
    hp: '己方血量',
    enemyAtk: '敌方攻击力',
    enemyHp: '敌方血量'
  };

  function auraText(a) {
    if (!a) return '';
    var sign = (a.effect === 'enemyAtk' || a.effect === 'enemyHp') ? ' -' : ' +';
    return '光环：' + a.radius + ' 格内 ' + AURA_LABEL[a.effect] + sign + a.amount;
  }

  root.MODS = {
    AURA_EFFECTS: AURA_EFFECTS,
    AURA_LABEL: AURA_LABEL,
    auraText: auraText,
    MAX_NAME: MAX_NAME,
    MAX_DESC: MAX_DESC,
    MAX_MODS: MAX_MODS,
    normalize: normalize,
    validate: validate,
    myMods: myMods,
    saveMine: saveMine,
    removeMine: removeMine,
    isMine: isMine,
    picks: picks,
    setPick: setPick,
    allDefs: allDefs,
    remoteCache: remoteCache,
    cacheRemote: cacheRemote,
    enabledDefs: enabledDefs,
    enabledIds: enabledIds,
    listRemote: listRemote,
    clientId: clientId,
    quota: quota,
    publish: publish,
    removeRemote: removeRemote
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
