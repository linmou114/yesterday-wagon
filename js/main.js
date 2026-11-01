/* =========================================================
 * main.js —— 界面与交互
 * ========================================================= */
(function () {
  'use strict';

  var ENGINE = window.ENGINE;
  var Hex = window.Hex;
  var $ = function (id) { return document.getElementById(id); };

  var app = {
    game: null,
    renderer: null,
    mode: 'local',          // 'local' | 'ai' | 'online'
    mySeat: 0,              // 联机时自己坐哪
    humanSeat: 0,           // 单人时人坐哪
    aiSeat: 1,
    aiTimer: null,
    online: { code: null, seat: -1, seats: [false, false] },
    selected: 'infantry',
    legal: new Set(),
    hover: null,
    inspect: null,
    effects: [],
    settings: null
  };

  var els = {};
  var toastTimer = null;
  var EMPTY_SET = new Set();

  // 当前对局的兵种表与规则（没有对局时用默认值）
  function typesOf() { return (app.game && app.game.types) || ENGINE.TYPES; }
  function rulesOf() { return (app.game && app.game.rules) || ENGINE.DEFAULT_RULES; }

  /* ---------------- 启动 ---------------- */

  function boot() {
    app.settings = loadSettings();
    els.canvas = $('board');
    els.shop = $('shop');
    els.log = $('log');
    els.toast = $('toast');
    els.inspectCard = $('inspect');
    els.turnChip = $('turnChip');
    els.btnResolve = $('btnResolve');
    els.btnEnd = $('btnEnd');
    els.setUnitRows = $('setUnitRows');
    els.shop = els.shop || $('shop');
    els.dockActions = $('dockActions');
    els.waitBar = $('waitBar');
    els.drawBar = $('drawBar');
    els.overTitle = $('overTitle');
    els.overSub = $('overSub');

    app.renderer = new Renderer(els.canvas);
    app.renderer.start(function () {
      var g = app.game;
      return {
        legal: app.legalShown || EMPTY_SET,
        selected: app.selected,
        hover: app.hover,
        inspect: app.inspect,
        effects: app.effects,
        canAfford: !!g && selectedAffordable()
      };
    });

    renderUnitRows();
    bindEvents();
    syncSettingsForm();
    updateMenuSummary();
    prefillRoomCode();
    checkServerStatus();
    showOverlay('ovMenu');
  }

  function selectedAffordable() {
    var g = app.game;
    if (!g || g.over) return false;
    var t = typesOf()[app.selected];
    return !!t && g.energy >= t.cost;
  }

  /* ---------------- 设置 ---------------- */

  var STORE_KEY = 'yesterday-bus.settings.v1';

  function defaultSettings() {
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

  function cloneType(t) {
    return { hp: t.hp, atk: t.atk, range: t.range, cost: t.cost };
  }

  function clampNum(v, min, max, fallback) {
    var n = Number(v);
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function clampInt(v, min, max, fallback) {
    return Math.round(clampNum(v, min, max, fallback));
  }

  // 把设置修正到合法范围（开局前跑一次，避免手输奇怪的值）
  function sanitizeSettings() {
    var s = app.settings;
    s.side = clampInt(s.side, 3, 8, 5);
    s.density = clampNum(s.density, 0, 0.4, 0.14);
    s.energy = clampInt(s.energy, 1, 9, 3);
    s.firstPlayer = Number(s.firstPlayer) === 1 ? 1 : 0;
    s.lastBonus = clampInt(s.lastBonus, 0, 8, 1);
    s.baseHp = clampInt(s.baseHp, 1, 20, 4);
    s.mapMode = (s.mapMode === 'default') ? 'default' : 'random';
    s.defaultMap = clampInt(s.defaultMap, 0, DEFAULT_MAPS.length - 1, 0);
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

  var DEFAULT_MAPS = (window.MAPS && window.MAPS.DEFAULT_MAPS) || [{ name: '随机', density: 0.14, seed: 1 }];

  // 地图来源：默认图用固定 边长/密度/种子；随机图交给随机种子
  function mapFromSettings() {
    var s = sanitizeSettings();
    if (s.mapMode === 'default') {
      var m = DEFAULT_MAPS[s.defaultMap] || DEFAULT_MAPS[0];
      return {
        side: (window.MAPS && window.MAPS.SIDE) || 5,
        density: m.density,
        seed: m.seed,
        label: m.name
      };
    }
    return { side: s.side, density: s.density, seed: null, label: null };
  }

  // 设置 -> 单局规则
  function rulesFromSettings() {
    var s = sanitizeSettings();
    var fe = [s.energy, s.energy];
    fe[1 - s.firstPlayer] = s.energy + s.lastBonus;
    return {
      baseHp: s.baseHp,
      energyPerTurn: s.energy,
      firstPlayer: s.firstPlayer,
      firstTurnEnergy: fe
    };
  }

  function loadSettings() {
    var base = defaultSettings();
    var raw = null;
    try { raw = window.localStorage.getItem(STORE_KEY); } catch (e) { raw = null; }
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

  function saveSettings() {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(app.settings)); } catch (e) {}
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

  /* ---------------- 开局 ---------------- */

  function startGame(mode) {
    app.mode = mode || app.mode || 'local';
    if (app.mode === 'online') return;   // 联机由服务端开局

    var map = mapFromSettings();
    if (map.seed == null) map.seed = Math.floor(Math.random() * 1e9) >>> 0;
    var rng = ENGINE.mulberry32(map.seed);
    var rules = rulesFromSettings();
    app.game = new ENGINE.Game({
      side: map.side,
      density: map.density,
      seed: map.seed,
      rng: rng,
      rules: rules,
      types: app.settings.types
    });
    app.mapLabel = map.label;

    // 单人模式：人执先手方，AI 执后手方
    if (app.mode === 'ai') {
      app.humanSeat = app.game.firstPlayer;
      app.aiSeat = 1 - app.game.firstPlayer;
    }

    app.selected = 'infantry';
    app.hover = null;
    app.inspect = null;
    app.effects.length = 0;
    app.stuckStamp = null;
    app.startedAt = Date.now();
    app.drawByAgreement = false;
    app.drawPending = false;
    hideDrawBar();

    els.log.innerHTML = '';
    app.renderer.setGame(app.game);
    hideOverlay('ovMenu');
    hideOverlay('ovSettings');
    hideOverlay('ovOver');
    hideOverlay('ovRules');
    hideOverlay('ovOnline');

    var g = app.game;
    addLog('模式：' + (app.mode === 'ai' ? '单人 · 对战 AI（你执' + g.players[app.humanSeat].name + '）' : '本地双人'), 'sys');
    addLog('地图：' + (map.label ? ('默认地图「' + map.label + '」') : '随机地图') +
      ' · 边长 ' + g.side + '（' + g.board.count + ' 格 / ' + g.board.obstacles + ' 处障碍）', 'sys');
    addLog('先手：' + g.players[g.firstPlayer].name +
      '（' + g.rules.firstTurnEnergy[g.firstPlayer] + ' 点）· 后手：' +
      g.players[1 - g.firstPlayer].name +
      '（' + g.rules.firstTurnEnergy[1 - g.firstPlayer] + ' 点）· 之后每回合 ' +
      g.rules.energyPerTurn + ' 点', 'sys');
    addLog('第 1 回合 · ' + g.players[g.active].name + ' 行动', 'turn');
    refresh();
    maybeAITurn();
  }

  /* ---------------- 刷新界面 ---------------- */

  function refresh() {
    var g = app.game;
    if (!g) return;
    app.legal = g.over ? new Set() : g.legalCells(g.active);
    app.showLegal = isMyTurn();
    app.legalShown = app.showLegal ? app.legal : EMPTY_SET;
    renderPanels();
    renderShop();
    renderButtons();
    renderTurnUI();
    updateInspectCard();
    checkTutorial();

    // 被完全堵死时提醒一下，别让人干坐着
    var stamp = g.turn + ':' + g.active;
    if (!g.over && app.legal.size === 0 && app.stuckStamp !== stamp) {
      app.stuckStamp = stamp;
      toast('没有可放置的格子了，点「结束回合」交给对手');
    }
  }

  function renderPanels() {
    var g = app.game;
    for (var i = 0; i < 2; i++) {
      var el = $('panel-' + i);
      if (!el) continue;
      var st = g.stats(i);
      var active = !g.over && g.active === i;
      var energy = active ? g.energy : 0;
      var maxEnergy = active ? (g.turnEnergyMax || g.rules.energyPerTurn) : g.rules.energyPerTurn;
      var pips = '';
      for (var k = 0; k < maxEnergy; k++) {
        pips += '<i class="pip' + (k < energy ? ' on' : '') + '"></i>';
      }

      // 兵种编成
      var counts = { infantry: 0, tank: 0, artillery: 0 };
      g.pieces.forEach(function (p) {
        if (p.owner === i && counts[p.kind] != null) counts[p.kind] += 1;
      });
      var comp = '<div class="comp">' +
        '<span><i>步</i>' + counts.infantry + '</span>' +
        '<span><i>坦</i>' + counts.tank + '</span>' +
        '<span><i>炮</i>' + counts.artillery + '</span>' +
        '</div>';

      var stateText = g.over
        ? (g.winner === -1 ? '平局' : (g.winner === i ? '胜利' : '失败'))
        : (active ? '行动中' : '等待中');
      el.className = 'panel panel-p' + i + (active ? ' active' : '') +
        (g.over && g.winner === i ? ' winner' : '');

      el.innerHTML =
        '<div class="panel-head">' +
          '<span class="dot"></span>' +
          '<div class="who"><b>' + g.players[i].name + '</b><span>' + (i === g.firstPlayer ? '先手' : '后手') + '</span></div>' +
        '</div>' +
        '<div class="panel-body">' +
          '<div class="stat"><span>大本营</span><b>' + (st.baseAlive ? st.baseHp + ' / ' + g.rules.baseHp : '已摧毁') + '</b></div>' +
          '<div class="stat"><span>本回合费用</span><b class="energy">' + (active ? energy + ' / ' + maxEnergy : '—') + '</b></div>' +
          '<div class="stat"><span>棋子数</span><b>' + st.units + '</b></div>' +
          '<div class="stat"><span>战果</span><b>' + st.kills + ' 杀 · ' + st.lost + ' 损</b></div>' +
          '<div class="pips">' + pips + '</div>' +
          comp +
        '</div>' +
        '<div class="panel-state">' + stateText + '</div>';
    }
  }

  function renderShop() {
    var g = app.game;
    var html = '';
    var only = (app.mode === 'tutorial' && app.tutTypes) ? app.tutTypes : null;
    ENGINE.TYPE_LIST.forEach(function (id, idx) {
      if (only && only.indexOf(id) < 0) return;
      var t = typesOf()[id];
      var afford = g.energy >= t.cost && !g.over;
      html += '<button type="button" class="card' + (app.selected === id ? ' sel' : '') +
        (afford ? '' : ' poor') + '" data-type="' + id + '">' +
        '<span class="card-key">' + (idx + 1) + '</span>' +
        '<span class="card-name">' + t.name + '</span>' +
        '<span class="card-cost">' + t.cost + ' 费</span>' +
        '<span class="card-line">血 ' + t.hp + ' · 攻 ' + t.atk + ' · 射 ' + t.range + '</span>' +
        '</button>';
    });
    els.shop.innerHTML = html;
  }

  // 非己方回合：藏掉「放置棋子 + 结束回合」整块，只留等待提示
  function renderTurnUI() {
    var g = app.game;
    if (!g) return;
    var mine = isMyTurn();
    var waiting = !mine && !g.over && app.mode !== 'local';
    var noShop = (app.mode === 'tutorial' && app.tutTypes && app.tutTypes.length === 0);
    if (els.shop) els.shop.classList.toggle('hidden', waiting || noShop);
    if (els.dockActions) els.dockActions.classList.toggle('hidden', waiting);
    if (els.waitBar) {
      els.waitBar.classList.toggle('hidden', !waiting);
      if (waiting) {
        els.waitBar.textContent = (app.mode === 'online')
          ? ('等待 ' + g.players[g.active].name + ' 行动…')
          : '电脑正在思考…';
      }
    }
  }
  function renderButtons() {
    var g = app.game;
    els.btnResolve.disabled = !g || g.over;
    els.btnResolve.textContent = '结算';
    els.btnResolve.title = g && !g.over
      ? '回合结束前可以反复结算（本回合已结算 ' + (g.resolveCount || 0) + ' 次）'
      : '';
    els.btnEnd.disabled = !g || g.over;
    if (els.btnDraw) els.btnDraw.disabled = !g || g.over || !!app.drawPending;
    els.turnChip.textContent = g ? ('第 ' + g.turn + ' 回合 · ' + g.players[g.active].name) : '—';
  }

  function updateInspectCard() {
    var g = app.game;
    var el = els.inspectCard;
    if (!g || !el) return;
    var cell = app.hover || app.inspect;
    var p = cell ? g.pieceAt(cell.key) : null;
    if (!p) { el.classList.remove('show'); return; }

    var isBase = p.kind === 'base';
    var t = isBase
      ? { glyph: '基', name: '大本营', desc: '血量 4。被敌方攻击合计满 4 点就会被摧毁。' }
      : typesOf()[p.kind];
    el.innerHTML =
      '<div class="ic-row">' +
        '<span class="ic-glyph" style="color:' + g.players[p.owner].color + '">' + t.glyph + '</span>' +
        '<span class="ic-who"><b>' + g.players[p.owner].name + ' · ' + t.name + '</b>' +
        '<em>' + (isBase ? '基地' : ('血量 ' + p.hp + ' · 攻击 ' + p.atk + ' · 射程 ' + p.range)) + '</em></span>' +
      '</div>' +
      '<p class="ic-desc">' + (t.desc || '') + '</p>';
    el.classList.add('show');
  }

  /* ---------------- 模式与回合控制 ---------------- */

  function isMyTurn() {
    // 教学模式：永远由玩家操作
    if (app.mode === 'tutorial') return !!(app.game && !app.game.over);
    var g = app.game;
    if (!g || g.over) return false;
    if (app.mode === 'online') return g.active === app.mySeat;
    if (app.mode === 'ai') return g.active === app.humanSeat;
    return true;
  }

  function clearAITimer() {
    if (app.aiTimer) { clearTimeout(app.aiTimer); app.aiTimer = null; }
  }

  function maybeAITurn() {
    clearAITimer();
    if (app.mode !== 'ai' || !app.game || app.game.over) return;
    if (app.game.active !== app.aiSeat) return;
    app.aiTimer = setTimeout(aiStep, 500);
  }

  // AI 一次只做一件事，这样每一步都看得见
  function aiStep() {
    app.aiTimer = null;
    var g = app.game;
    if (app.mode !== 'ai' || !g || g.over || g.active !== app.aiSeat) return;

    if (g.energy > 0 && window.AI) {
      var mv = window.AI.chooseMove(g);
      if (mv) {
        var t = g.types[mv.type];
        if (t && g.energy >= t.cost) {
          try {
            g.place(g.active, mv.type, mv.cell);
            addLog(g.players[g.active].name + ' 部署 ' + t.name, 'place');
            refresh();
            app.aiTimer = setTimeout(aiStep, 320);
            return;
          } catch (e) { /* 落子失败就走下一步 */ }
        }
      }
    }

    if (window.AI && window.AI.shouldResolve(g)) {
      var res;
      try { res = g.resolve(); } catch (e) { res = null; }
      if (res) {
        renderResolveResult(res);
        refresh();
        if (g.over) { setTimeout(showGameOver, 620); return; }
        app.aiTimer = setTimeout(aiStep, 460);
        return;
      }
    }

    applyEndTurn();
  }

  /* ---------------- 操作 ---------------- */

  function handleCellClick(cell) {
    var g = app.game;
    if (!g || g.over) return;

    if (g.pieceAt(cell.key)) {
      app.inspect = (app.inspect && app.inspect.key === cell.key) ? null : cell;
      updateInspectCard();
      return;
    }
    if (!isMyTurn()) { toast('还没轮到你'); return; }
    var t = typesOf()[app.selected];
    if (!t) return;
    if (g.energy < t.cost) { toast('费用不足，结束回合后会恢复到 ' + g.rules.energyPerTurn + ' 点'); return; }
    var check = g.canPlace(g.active, app.selected, cell.key);
    if (!check.ok) { toast(check.msg); return; }

    if (app.mode === 'online') {
      Net.act({ kind: 'place', type: app.selected, cell: cell.key });
      return;                                   // 等服务端广播新状态
    }

    g.place(g.active, app.selected, cell.key);
    app.inspect = null;
    addLog(g.players[g.active].name + ' 部署 ' + t.name, 'place');
    refresh();
  }

  function doResolve() {
    var g = app.game;
    if (!g || g.over) return;
    if (!isMyTurn()) { toast('还没轮到你'); return; }

    if (app.mode === 'online') {
      Net.act({ kind: 'resolve' });
      return;
    }

    var res;
    try { res = g.resolve(); } catch (err) { toast(err.message); return; }
    if (!res) return;
    renderResolveResult(res);
    refresh();
    if (g.over) setTimeout(showGameOver, 620);
  }

  // 结算表现：飘字 + 战报 + 提示（单机/联机共用）
  function renderResolveResult(res) {
    var g = app.game;
    var survivors = [];
    res.damage.forEach(function (dmg, id) {
      if (dmg <= 0) return;
      var p = g.pieces.get(id);
      if (!p) return;
      survivors.push({ piece: p, dmg: dmg });
    });

    var now = performance.now();
    res.killedByDamage.forEach(function (r) {
      var c = Hex.parse(r.piece.key);
      app.effects.push({ q: c.q, r: c.r, text: '✖', color: '#fda4af', born: now, life: 1100 });
      app.effects.push({ q: c.q, r: c.r, text: '-' + r.damage, color: '#fee2e2', born: now + 90, life: 900 });
    });
    res.removedByCut.forEach(function (r) {
      var c = Hex.parse(r.piece.key);
      app.effects.push({ q: c.q, r: c.r, text: '断', color: '#94a3b8', born: now, life: 1100 });
    });
    survivors.forEach(function (sv, i) {
      var c = Hex.parse(sv.piece.key);
      app.effects.push({
        q: c.q, r: c.r,
        text: sv.dmg + '/' + sv.piece.hp,
        color: '#fcd34d',
        lift: 0.55,
        born: now + 60 + i * 30,
        life: 1400
      });
    });

    logResolve(res);

    if (res.over) return;

    var unitKills = res.killedByDamage.filter(function (r) { return r.piece.kind !== 'base'; }).length;
    var bases = res.killedByDamage.filter(function (r) { return r.piece.kind === 'base'; }).length;
    var cuts = res.removedByCut.length;
    if (bases) toast('大本营被摧毁！');
    else if (unitKills || cuts) {
      toast('结算：' + [unitKills ? '击杀 ' + unitKills : '', cuts ? '断联 ' + cuts : '']
        .filter(Boolean).join('，'));
    } else if (survivors.length) {
      toast('结算：' + survivors.length + ' 个棋子被攻击，都没到致死线');
    } else {
      toast('结算：没有棋子被攻击到');
    }
  }
  function labelOf(p) {
    var g = app.game;
    var name = g.players[p.owner].name;
    if (p.kind === 'base') return name + '大本营';
    var t = typesOf()[p.kind];
    return name + (t ? t.name : '棋子');
  }

  function logResolve(res) {
    var g = app.game;
    var who = g.players[res.active].name;

    var survivors = [];
    res.damage.forEach(function (dmg, id) {
      if (dmg <= 0) return;
      var p = g.pieces.get(id);
      if (!p) return;
      survivors.push({ piece: p, dmg: dmg });
    });

    var unitKills = res.killedByDamage.filter(function (r) { return r.piece.kind !== 'base'; }).length;
    var baseKills = res.killedByDamage.filter(function (r) { return r.piece.kind === 'base'; }).length;
    var head = [];
    if (unitKills) head.push('击杀 ' + unitKills + ' 个');
    if (res.removedByCut.length) head.push('断联 ' + res.removedByCut.length + ' 个');
    if (baseKills) head.push('摧毁大本营');
    if (!head.length) head.push('无阵亡');

    addLog(who + ' 结算' + (res.resolveCount > 1 ? '（本回合第 ' + res.resolveCount + ' 次）' : '') +
      ' · ' + head.join('，'), 'resolve');

    res.killedByDamage.forEach(function (r) {
      if (r.piece.kind === 'base') {
        addLog('　↳ ' + labelOf(r.piece) + ' 被摧毁（受 ' + r.damage + ' 点 / 血 ' + r.piece.hp + '）', 'big');
      } else {
        addLog('　↳ ' + labelOf(r.piece) + ' 阵亡（受 ' + r.damage + ' 点 / 血 ' + r.piece.hp + '）', 'detail');
      }
    });
    if (res.removedByCut.length) {
      addLog('　↳ ' + res.removedByCut.map(function (r) { return labelOf(r.piece); }).join('、') +
        ' 断联移除', 'detail');
    }
    survivors.slice(0, 6).forEach(function (sv) {
      addLog('　↳ ' + labelOf(sv.piece) + ' 受 ' + sv.dmg + ' 点 / 需 ' + sv.piece.hp + ' 点，存活', 'detail');
    });
    if (survivors.length > 6) {
      addLog('　↳ 另有 ' + (survivors.length - 6) + ' 个棋子受击但存活', 'detail');
    }
  }
  // 真正的换手（不做权限判断，AI 也走这里）
  function applyEndTurn() {
    var g = app.game;
    if (!g || g.over) return;
    var spent = (g.turnEnergyMax || g.rules.energyPerTurn) - g.energy;
    g.endTurn();
    app.hover = null;
    app.inspect = null;
    if (spent === 0) addLog('（' + g.players[1 - g.active].name + ' 未花费用就结束了回合）', 'sys');
    addLog('第 ' + g.turn + ' 回合 · ' + g.players[g.active].name + ' 行动', 'turn');
    refresh();
    maybeAITurn();
  }

  function endTurn() {
    var g = app.game;
    if (!g || g.over) return;
    if (!isMyTurn()) { toast('还没轮到你'); return; }
    if (app.mode === 'online') {
      Net.act({ kind: 'end' });
      return;
    }
    applyEndTurn();

    if (app.mode === 'tutorial' && app.game && !app.game.over &&
        app.game.active !== app.humanSeat) {
      setTimeout(function () {
        if (app.mode !== 'tutorial' || !app.game || app.game.over) return;
        if (app.tutorial && app.tutorial.finished) return;   // 这关已经过了，别再动局面
        app.game.endTurn();
        refresh();
        toast('对手放弃回合（教学模式）');
      }, 800);
    }
  }

  function resign() {
    var g = app.game;
    if (!g || g.over) return;
    if (!isMyTurn()) { toast('还没轮到你'); return; }
    var who = g.players[g.active].name;
    if (!window.confirm(who + ' 确定认输？对手将直接获胜。')) return;

    if (app.mode === 'online') {
      Net.act({ kind: 'resign' });
      return;
    }

    clearAITimer();
    g.over = true;
    g.winner = 1 - g.active;
    addLog(who + ' 认输', 'big');
    refresh();
    showGameOver();
  }

  /* ---------------- 入口页：服务器状态 / 快速加入 ---------------- */

  var CODE_KEY = 'yesterday-bus.lastcode';

  function checkServerStatus() {
    var tag = $('srvTag');
    if (!tag) return;
    if (typeof location !== 'undefined' && location.protocol === 'file:') {
      tag.textContent = '本地模式';
      tag.className = 'mode-tag';
      return;
    }
    tag.textContent = '检测中';
    tag.className = 'mode-tag';

    var done = false;
    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      tag.textContent = '连接超时';
      tag.className = 'mode-tag bad';
    }, 4000);

    fetch(location.origin + '/health', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (txt) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (txt && txt.trim() === 'ok') {
          tag.textContent = '在线';
          tag.className = 'mode-tag ok';
          refreshStats();
        } else {
          tag.textContent = '不支持联机';
          tag.className = 'mode-tag bad';
        }
      })
      .catch(function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        tag.textContent = '离线';
        tag.className = 'mode-tag bad';
      });
  }

  function prefillRoomCode() {
    var el = $('menuCode');
    if (!el) return;
    // 邀请链接带 ?room=1234 时优先用它
    var m = /[?&]room=(\d{4})/.exec(window.location.search || '');
    if (m) {
      el.value = m[1];
      setTimeout(function () {
        toast('已填入房号 ' + m[1] + '，点「加入房间」就能进');
        el.focus();
      }, 600);
      return;
    }
    try {
      var v = window.localStorage.getItem(CODE_KEY);
      if (v && /^\d{4}$/.test(v)) el.value = v;
    } catch (e) {}
  }

  // 首页显示「当前几局在打」
  function refreshStats() {
    var el = $('menuStats');
    if (!el) return;
    if (typeof location === 'undefined' || location.protocol === 'file:') return;
    fetch(location.origin + '/stats', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (st) {
        if (!st) { el.textContent = ''; return; }
        if (!st.rooms && !st.waiting) {
          el.innerHTML = '<span class="live">●</span> 服务器在线 · 现在没有房间，来开第一局';
          return;
        }
        var parts = [];
        if (st.rooms) parts.push(st.rooms + ' 局正在对战');
        if (st.waiting) parts.push(st.waiting + ' 个房间在等人');
        parts.push(st.players + ' 人在线');
        el.innerHTML = '<span class="live">●</span> ' + parts.join(' · ');
      })
      .catch(function () { el.textContent = ''; });
  }

  // 复制邀请：http 页面没有 navigator.clipboard，必须留 textarea 兜底
  function copyText(text, okMsg) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      toast(ok ? (okMsg || '已复制') : '复制失败，请手动选中房号');
    }
    if (window.navigator && navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () {
        toast(okMsg || '已复制');
      }, fallback);
      return;
    }
    fallback();
  }

  function inviteText() {
    var code = app.online.code || $('roomCode').textContent || '';
    var base = (typeof location !== 'undefined' && location.origin) ? location.origin : '';
    var url = base + '/?room=' + code;
    return '来下「昨日圆车」：' + url + '\n房号：' + code;
  }

  function menuJoin() {
    var el = $('menuCode');
    var code = el ? String(el.value || '').trim() : '';
    if (!/^\d{4}$/.test(code)) {
      toast('请输入 4 位房号');
      if (el) el.focus();
      return;
    }
    openOnline();
    Net.join(code);
  }
  /* ---------------- 联机 ---------------- */

  function openOnline() {
    app.online.started = false;
    app.online.code = null;
    app.online.seat = -1;
    $('onlChooser').classList.remove('hidden');
    $('onlRoom').classList.add('hidden');
    $('onlStatus').textContent = '正在连接服务器…';
    $('onlStatus').className = 'onl-status';
    showOverlay('ovOnline');

    Net.start({
      status: onNetStatus,
      room: onNetRoom,
      state: onNetState,
      peer: onNetPeer,
      error: onNetError
    });
  }

  function onNetStatus(st) {
    var el = $('onlStatus');
    if (!el) return;
    el.textContent = st.text;
    el.className = 'onl-status' + (st.ok === true ? ' ok' : (st.ok === false ? ' bad' : ''));
  }

  function onNetRoom(msg) {
    app.online.code = msg.code;
    app.online.seat = msg.seat;
    app.mySeat = msg.seat;
    app.online.started = false;
    $('onlChooser').classList.add('hidden');
    $('onlRoom').classList.remove('hidden');
    $('roomCode').textContent = msg.code;
    $('roomHint').textContent = msg.resumed
      ? '已重连回房间…'
      : '把房号发给朋友；两人都在线后自动开局';
  }

  function onNetPeer(msg) {
    app.online.seats[msg.seat] = msg.online;
    if (app.online.started) {
      toast(msg.online ? '对手已重新连接' : '对手掉线了，等待重连…');
    } else if (msg.online) {
      $('roomHint').textContent = '对手来了，正在开局…';
    }
  }

  function onNetError(msg) {
    toast(msg);
  }

  function onNetState(msg) {
    var seats = msg.seats || [false, false];
    app.online.seats = seats;
    var both = seats[0] && seats[1];

    if (!app.online.started) {
      if (!both) {
        $('roomHint').textContent = '等待对手加入…（对方到齐后自动开局）';
        return;
      }
      startOnlineGame(msg);
      return;
    }
    applyOnlineState(msg);
  }

  function startOnlineGame(msg) {
    app.mode = 'online';
    app.online.started = true;
    app.startedAt = Date.now();
    app.drawByAgreement = false;
    app.drawPending = false;
    hideDrawBar();
    app.mySeat = app.online.seat;
    app.game = ENGINE.Game.fromJSON(msg.state);
    app.selected = 'infantry';
    app.hover = null;
    app.inspect = null;
    app.effects.length = 0;

    els.log.innerHTML = '';
    app.renderer.setGame(app.game);
    hideOverlay('ovOnline');
    hideOverlay('ovMenu');

    var g = app.game;
    addLog('联机对局 · 房号 ' + app.online.code + ' · 你是 ' + g.players[app.mySeat].name, 'sys');
    addLog('地图 · 边长 ' + g.side + '（' + g.board.count + ' 格 / ' + g.board.obstacles + ' 处障碍）', 'sys');
    addLog('第 ' + g.turn + ' 回合 · ' + g.players[g.active].name + ' 行动', 'turn');

    if (msg.event) applyRemoteEvent(msg.event);
    refresh();
    if (g.over) setTimeout(showGameOver, 400);
  }

  function applyOnlineState(msg) {
    var prevTurn = app.game ? app.game.turn : 0;
    app.game = ENGINE.Game.fromJSON(msg.state);
    app.renderer.setGame(app.game);
    app.mySeat = app.online.seat;

    if (msg.event) applyRemoteEvent(msg.event);
    else if (app.game.turn !== prevTurn) {
      addLog('第 ' + app.game.turn + ' 回合 · ' + app.game.players[app.game.active].name + ' 行动', 'turn');
    }

    refresh();
    if (app.game.over) setTimeout(showGameOver, 400);
  }

  // 把服务端发来的事件还原成和本地一样的效果
  function applyRemoteEvent(ev) {
    var g = app.game;
    if (!g || !ev) return;

    if (ev.kind === 'place') {
      var tp = typesOf()[ev.type];
      addLog(g.players[ev.owner != null ? ev.owner : ev.active].name +
        ' 部署 ' + (tp ? tp.name : '棋子'), 'place');
      return;
    }

    if (ev.kind === 'end') {
      var ended = ev.active;
      if (ev.next != null && ev.next === app.mySeat) toast('轮到你了');
      else if (ev.next != null) toast('对手回合');
      if (ended != null) { /* 战报由 turn 变化补 */ }
      addLog('第 ' + ev.turn + ' 回合 · ' + g.players[ev.next].name + ' 行动', 'turn');
      return;
    }

    if (ev.kind === 'resign') {
      addLog(g.players[ev.active].name + ' 认输', 'big');
      return;
    }

    if (ev.kind === 'drawOffer') {
      if (ev.from !== app.mySeat) {
        showDrawBar(g.players[ev.from].name + ' 请求和棋');
        toast('对手请求和棋');
      }
      return;
    }

    if (ev.kind === 'drawResult') {
      app.drawPending = false;
      hideDrawBar();
      if (ev.accepted) {
        app.drawByAgreement = true;
        addLog('双方同意和棋', 'big');
      } else {
        addLog('和棋被拒绝', 'sys');
        toast('对手拒绝了和棋');
      }
      return;
    }

    if (ev.kind === 'resolve') {
      var damage = new Map();
      Object.keys(ev.damage || {}).forEach(function (k) {
        damage.set(Number(k), ev.damage[k]);
      });
      var removed = (ev.removed || []).map(function (r) {
        return { piece: { owner: r.owner, kind: r.kind, key: r.key, hp: r.hp || 0 }, damage: r.damage, reason: r.reason };
      });
      var res = {
        active: ev.active,
        resolveCount: ev.resolveCount,
        damage: damage,
        removed: removed,
        killedByDamage: removed.filter(function (r) { return r.reason === 'damage'; }),
        removedByCut: removed.filter(function (r) { return r.reason === 'cut'; }),
        over: !!ev.over,
        winner: ev.winner
      };
      renderResolveResult(res);
    }
  }
  /* ---------------- 新手教学 ---------------- */

  var TUT = (typeof window !== 'undefined' && window.TUTORIAL) || null;
  var TUT_LEVELS = (TUT && TUT.LEVELS) || [];

  function startTutorial() {
    if (!TUT) { toast('教学模块没加载'); return; }
    app.mode = 'tutorial';
    app.humanSeat = 1;
    app.aiSeat = -1;
    app.tutorial = { index: 0, progress: 0, finished: false };
    loadTutorialLevel(0);
  }

  function loadTutorialLevel(index) {
    var lv = TUT_LEVELS[index];
    if (!lv) { exitTutorial(); return; }

    clearAITimer();
    app.tutorial = app.tutorial || {};
    app.tutorial.index = index;
    app.tutorial.progress = 0;
    app.tutorial.finished = false;

    app.game = TUT.buildLevel(ENGINE, index);
    app.selected = null;
    app.hover = null;
    app.inspect = null;
    app.effects.length = 0;
    app.stuckStamp = null;
    app.startedAt = Date.now();
    app.drawByAgreement = false;
    app.drawPending = false;
    app.tutTypes = (lv.types || []).slice();

    hideOverlay('ovMenu');
    hideOverlay('ovSettings');
    hideOverlay('ovOver');
    hideOverlay('ovRules');
    hideOverlay('ovOnline');
    hideOverlay('ovTutDone');
    $('tutPanel').classList.remove('hidden');
    if ($('quickRef')) $('quickRef').classList.add('hidden');
    els.log.innerHTML = '';
    app.renderer.setGame(app.game);
    refresh();
    renderTutorial();
    addLog('【第 ' + (index + 1) + ' / ' + TUT_LEVELS.length + ' 关】' + lv.title, 'big');
  }

  function exitTutorial() {
    app.tutorial = null;
    app.tutTypes = null;
    $('tutPanel').classList.add('hidden');
    if ($('quickRef')) $('quickRef').classList.remove('hidden');
    hideOverlay('ovTutDone');
    app.game = null;
    refresh();
    updateMenuSummary();
    showOverlay('ovMenu');
  }

  function renderTutorial() {
    var t = app.tutorial;
    if (!t) return;
    var lv = TUT_LEVELS[t.index];
    if (!lv) return;

    $('tutLevel').textContent = '第 ' + (t.index + 1) + ' / ' + TUT_LEVELS.length + ' 关';
    $('tutTitle').textContent = lv.title;

    var step = lv.steps[t.progress];
    $('tutText').textContent = step ? step.text : '这一关完成了。';

    var html = '';
    lv.steps.forEach(function (s, i) {
      var cls = i < t.progress ? 'done' : (i === t.progress ? 'now' : '');
      html += '<span class="tut-dot ' + cls + '">' + (i < t.progress ? '✓' : (i + 1)) + '</span>';
    });
    $('tutSteps').innerHTML = html;
  }

  function checkTutorial() {
    var t = app.tutorial;
    if (!t || !app.game || t.finished) return;
    var lv = TUT_LEVELS[t.index];
    if (!lv) return;

    var moved = false;
    while (t.progress < lv.steps.length && lv.steps[t.progress].done(app.game, app)) {
      t.progress += 1;
      moved = true;
    }
    if (moved) renderTutorial();

    if (t.progress >= lv.steps.length && !t.finished) {
      t.finished = true;
      setTimeout(function () { showTutDone(t.index); }, 450);
    }
  }

  function showTutDone(index) {
    var lv = TUT_LEVELS[index];
    var last = index >= TUT_LEVELS.length - 1;
    $('tutDoneTitle').textContent = last ? '教学完成！' : '第 ' + (index + 1) + ' 关通过';
    $('tutDoneText').textContent = last
      ? '6 个关卡全部学完。去开一局吧——联机、单人、本地双人都能玩。'
      : '「' + lv.title + '」学会了。下一关：' + TUT_LEVELS[index + 1].title;
    $('btnTutNext').textContent = last ? '回到菜单' : '下一关';
    app.tutDoneIndex = index;
    showOverlay('ovTutDone');
  }
  /* ---------------- 求和 ---------------- */

  function showDrawBar(text) {
    var bar = els.drawBar;
    if (!bar) return;
    $('drawText').textContent = text;
    bar.classList.remove('hidden');
  }
  function hideDrawBar() {
    if (els.drawBar) els.drawBar.classList.add('hidden');
  }

  function offerDraw() {
    var g = app.game;
    if (!g || g.over) return;
    if (!isMyTurn()) { toast('还没轮到你'); return; }

    if (app.mode === 'online') {
      app.drawPending = true;
      Net.act({ kind: 'draw' });
      toast('求和请求已发出，等对手回应');
      renderTurnUI();
      return;
    }

    if (app.mode === 'ai') {
      var accept = window.AI ? window.AI.acceptsDraw(g, app.aiSeat) : true;
      if (accept) {
        clearAITimer();
        app.drawByAgreement = true;
        g.over = true;
        g.winner = -1;
        addLog('AI 接受了和棋', 'big');
        refresh();
        showGameOver();
      } else {
        addLog('AI 拒绝了和棋', 'sys');
        toast('AI 拒绝了和棋');
      }
      return;
    }

    // 本地双人：同一台设备，确认一次即可
    if (!window.confirm('双方都同意和棋？（确定即判平局）')) return;
    app.drawByAgreement = true;
    g.over = true;
    g.winner = -1;
    addLog('双方同意和棋', 'big');
    refresh();
    showGameOver();
  }

  function answerDraw(accept) {
    hideDrawBar();
    if (app.mode !== 'online') return;
    Net.act({ kind: 'drawAnswer', accept: !!accept });
  }
  /* ---------------- 弹窗 / 提示 ---------------- */

  function showOverlay(id) { var el = $(id); if (el) el.classList.remove('hidden'); }
  function hideOverlay(id) { var el = $(id); if (el) el.classList.add('hidden'); }

  function overlayOpen() {
    var ids = ['ovMenu', 'ovSettings', 'ovOnline', 'ovRules', 'ovOver'];
    for (var i = 0; i < ids.length; i++) {
      var el = $(ids[i]);
      if (el && !el.classList.contains('hidden')) return true;
    }
    return false;
  }

  function showGameOver() {
    var g = app.game;
    if (!g) return;
    var again = $('btnAgain');
    if (again) again.textContent = (app.mode === 'online') ? '返回主菜单' : '再来一局';
    if (g.winner === -1) {
      els.overTitle.textContent = app.drawByAgreement ? '平局（和棋）' : '同归于尽';
      els.overTitle.className = 'over-title draw';
      els.overSub.textContent = app.drawByAgreement
        ? '双方同意和棋，本局平局。'
        : '双方大本营在同一轮结算中同时被摧毁，本局平局。';
    } else {
      var name = g.players[g.winner].name;
      els.overTitle.textContent = name + ' 胜利';
      els.overTitle.className = 'over-title win-p' + g.winner;
      els.overSub.textContent = '对手的大本营被摧毁。';
    }
    renderOverStats(g);
    showOverlay('ovOver');
  }

  // 结束时的小战绩表
  function renderOverStats(g) {
    var el = $('overStats');
    if (!el || !g) return;
    var s0 = g.stats(0);
    var s1 = g.stats(1);
    var swing = g.maxSwing || [0, 0];
    var rows = [
      ['击杀', s0.kills, s1.kills],
      ['损失', s0.lost, s1.lost],
      ['剩余棋子', s0.units, s1.units],
      ['单次最大击杀', swing[0], swing[1]]
    ];
    var html = '<table><thead><tr><th>对比</th>' +
      '<th style="color:var(--p0)">青方</th><th style="color:var(--p1)">赤方</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      var a = r[1], b = r[2];
      var ca = a > b ? 'p0' : (a < b ? 'dim' : '');
      var cb = b > a ? 'p1' : (b < a ? 'dim' : '');
      html += '<tr><td>' + r[0] + '</td><td class="' + ca + '">' + a +
        '</td><td class="' + cb + '">' + b + '</td></tr>';
    });
    html += '</tbody></table>';

    var mins = 0;
    if (app.startedAt) mins = Math.max(1, Math.round((Date.now() - app.startedAt) / 60000));
    html += '<p class="over-meta">共 ' + g.turn + ' 回合' +
      (mins ? ' · 约 ' + mins + ' 分钟' : '') +
      ' · 边长 ' + g.side + '（' + g.board.count + ' 格）</p>';
    el.innerHTML = html;
  }

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.remove('show'); }, 1600);
  }

  function addLog(text, kind) {
    var li = document.createElement('li');
    li.className = 'log-item' + (kind ? ' ' + kind : '');
    li.textContent = text;
    els.log.appendChild(li);
    while (els.log.children.length > 120) els.log.removeChild(els.log.firstChild);
    els.log.scrollTop = els.log.scrollHeight;
  }

  /* ---------------- 设置界面 ---------------- */

  var SET_FIELDS = {
    hp: [1, 30], atk: [0, 20], range: [0, 6], cost: [1, 30]
  };

  function renderUnitRows() {
    var html = '';
    ENGINE.TYPE_LIST.forEach(function (id) {
      var def = ENGINE.TYPES[id];
      html += '<tr><td><b>' + def.name + '</b></td>';
      ['hp', 'atk', 'range', 'cost'].forEach(function (f) {
        html += '<td><input class="num" type="number" step="1" inputmode="numeric"' +
          ' data-path="types.' + id + '.' + f + '"' +
          ' min="' + SET_FIELDS[f][0] + '" max="' + SET_FIELDS[f][1] + '" /></td>';
      });
      html += '</tr>';
    });
    els.setUnitRows.innerHTML = html;
  }

  function syncSettingsForm() {
    if (!app.settings) return;
    var root = $('ovSettings');
    Array.prototype.forEach.call(root.querySelectorAll('[data-path]'), function (el) {
      var v = getPath(app.settings, el.getAttribute('data-path'));
      if (document.activeElement !== el) el.value = (v == null ? '' : String(v));
    });
    var dens = $('setDensity');
    Array.prototype.forEach.call(dens.querySelectorAll('button'), function (b) {
      b.classList.toggle('on', Number(b.getAttribute('data-d')) === Number(app.settings.density));
    });
    var first = $('setFirst');
    Array.prototype.forEach.call(first.querySelectorAll('button'), function (b) {
      b.classList.toggle('on', Number(b.getAttribute('data-p')) === Number(app.settings.firstPlayer));
    });

    var isDefault = app.settings.mapMode === 'default';
    Array.prototype.forEach.call($('setMapMode').querySelectorAll('button'), function (b) {
      b.classList.toggle('on', (b.getAttribute('data-m') === 'default') === isDefault);
    });
    $('mapBasic').classList.toggle('hidden', isDefault);
    $('mapPicker').classList.toggle('hidden', !isDefault);
    if (isDefault) renderMapPicker();

    updateSettingHints();
  }

  // 小地图预览：直接用同一套 Hex 数学画一遍
  function drawMapPreview(canvas, side, density, seed) {
    if (!canvas) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = 240, h = 200;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var g;
    try { g = new ENGINE.Game({ side: side, density: density, seed: seed }); }
    catch (e) { return; }

    var s = Math.min((w - 16) / (3 * side - 1), (h - 16) / (Math.sqrt(3) * (2 * side - 1)));
    var cx = w / 2, cy = h / 2;

    g.board.order.forEach(function (c) {
      var p = Hex.toPixel(c.q, c.r, s);
      var x = cx + p.x, y = cy + p.y;
      ctx.beginPath();
      for (var i = 0; i < 6; i++) {
        var a = Math.PI / 3 * i;
        var px = x + s * 0.9 * Math.cos(a);
        var py = y + s * 0.9 * Math.sin(a);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = c.obstacle ? 'rgba(104,126,158,0.75)' : 'rgba(45,212,191,0.12)';
      ctx.fill();
      ctx.lineWidth = 0.7;
      ctx.strokeStyle = c.obstacle ? 'rgba(12,18,28,0.7)' : 'rgba(45,212,191,0.3)';
      ctx.stroke();
    });

    // 标出两个基地
    [{ c: g.board.baseA, col: g.players[0].color }, { c: g.board.baseB, col: g.players[1].color }]
      .forEach(function (b) {
        var p = Hex.toPixel(b.c.q, b.c.r, s);
        ctx.beginPath();
        ctx.arc(cx + p.x, cy + p.y, s * 0.42, 0, Math.PI * 2);
        ctx.fillStyle = b.col;
        ctx.fill();
      });
  }

  function renderMapPicker() {
    var btns = $('mapBtns');
    if (!btns) return;
    var html = '';
    DEFAULT_MAPS.forEach(function (m, i) {
      html += '<button type="button" class="map-btn' +
        (app.settings.defaultMap === i ? ' on' : '') +
        '" data-i="' + i + '" title="' + m.name + '">' + (i + 1) + '</button>';
    });
    btns.innerHTML = html;

    var idx = clampInt(app.settings.defaultMap, 0, DEFAULT_MAPS.length - 1, 0);
    var cur = DEFAULT_MAPS[idx];
    $('mapNote').textContent = '地图 ' + (idx + 1) + '「' + cur.name + '」— ' + cur.desc;
    drawMapPreview($('mapPreview'), (window.MAPS && window.MAPS.SIDE) || 5, cur.density, cur.seed);
  }
  function updateSettingHints() {
    var s = app.settings;
    if (!s) return;
    var side = clampInt(s.side, 3, 8, 5);
    var e = clampInt(s.energy, 1, 9, 3);
    var bonus = clampInt(s.lastBonus, 0, 8, 1);
    var baseHp = clampInt(s.baseHp, 1, 20, 4);
    setSideHint.textContent = '共 ' + Hex.cellCount(side) + ' 格';
    setEnergyHint.textContent = '第 1 回合：先手 ' + e + ' 点 / 后手 ' + (e + bonus) +
      ' 点；之后每回合 ' + e + ' 点。';
    setBaseHint.textContent = '攻击合计满 ' + baseHp + ' 点被摧毁';
  }

  function updateMenuSummary() {
    var s = app.settings;
    if (!s) return;
    var isDefault = s.mapMode === 'default';
    var idx = clampInt(s.defaultMap, 0, DEFAULT_MAPS.length - 1, 0);
    var dm = DEFAULT_MAPS[idx];
    var side = isDefault ? ((window.MAPS && window.MAPS.SIDE) || 5) : clampInt(s.side, 3, 8, 5);
    var density = isDefault ? dm.density : Number(s.density);
    var dens = { 0: '无', 0.08: '低', 0.1: '低', 0.14: '中', 0.18: '高', 0.22: '高' };
    var dl = dens[density];
    if (!dl) dl = Math.round((density || 0) * 100) + '%';
    var names = ['青方', '赤方'];
    var fp = Number(s.firstPlayer) === 1 ? 1 : 0;

    var mapChip = isDefault
      ? '<span class="hi">地图 ' + (idx + 1) + '「' + dm.name + '」</span>'
      : '<span>随机地图</span>';

    var el = $('menuSummary');
    if (!el) return;
    el.innerHTML =
      mapChip +
      '<span>边长 ' + side + ' · ' + Hex.cellCount(side) + ' 格</span>' +
      '<span>障碍 ' + dl + '</span>' +
      '<span>每回合 ' + clampInt(s.energy, 1, 9, 3) + ' 费</span>' +
      '<span>' + names[fp] + '先手</span>' +
      '<span>后手 +' + clampInt(s.lastBonus, 0, 8, 1) + ' 费</span>' +
      '<span>基地 ' + clampInt(s.baseHp, 1, 20, 4) + ' 血</span>';
  }
  function openSettings() {
    syncSettingsForm();
    showOverlay('ovSettings');
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindMenuAndSettings() {
    btnOpenSettings.addEventListener('click', openSettings);
    btnSetDone.addEventListener('click', function () {
      sanitizeSettings();
      saveSettings();
      updateMenuSummary();
      hideOverlay('ovSettings');
    });
    btnSetReset.addEventListener('click', function () {
      app.settings = defaultSettings();
      sanitizeSettings();
      saveSettings();
      syncSettingsForm();
      updateMenuSummary();
      toast('已恢复默认设置');
    });
    $('setDensity').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      app.settings.density = Number(b.getAttribute('data-d'));
      saveSettings();
      syncSettingsForm();
      updateMenuSummary();
    });
    $('setMapMode').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      app.settings.mapMode = (b.getAttribute('data-m') === 'default') ? 'default' : 'random';
      saveSettings();
      syncSettingsForm();
      updateMenuSummary();
    });
    $('mapBtns').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.map-btn') : null;
      if (!b) return;
      app.settings.defaultMap = Number(b.getAttribute('data-i'));
      saveSettings();
      syncSettingsForm();
      updateMenuSummary();
    });
    $('setFirst').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      app.settings.firstPlayer = Number(b.getAttribute('data-p'));
      saveSettings();
      syncSettingsForm();
      updateMenuSummary();
    });
    $('ovSettings').addEventListener('input', function (e) {
      var el = e.target;
      var path = el.getAttribute ? el.getAttribute('data-path') : null;
      if (!path) return;
      var v = Number(el.value);
      if (el.value === '' || !isFinite(v)) return;
      setPath(app.settings, path, v);
      saveSettings();
      updateSettingHints();
      updateMenuSummary();
    });
    $('ovSettings').addEventListener('change', function (e) {
      var el = e.target;
      var path = el.getAttribute ? el.getAttribute('data-path') : null;
      if (!path) return;
      sanitizeSettings();
      saveSettings();
      syncSettingsForm();
      updateMenuSummary();
    });
    $('ovSettings').addEventListener('click', function (e) {
      if (e.target === this) hideOverlay('ovSettings');
    });
  }
  /* ---------------- 事件绑定 ---------------- */

  function bindEvents() {
    bindMenuAndSettings();
    $('btnModeLocal').addEventListener('click', function () { startGame('local'); });
    $('menuJoinBtn').addEventListener('click', menuJoin);
    $('menuCode').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') menuJoin();
    });
    $('btnModeAI').addEventListener('click', function () { startGame('ai'); });
    $('btnModeOnline').addEventListener('click', openOnline);

    $('btnCreateRoom').addEventListener('click', function () {
      sanitizeSettings();
      var st = app.settings;
      var mp = mapFromSettings();
      Net.create({
        side: mp.side,
        density: mp.density,
        seed: mp.seed,
        lastBonus: st.lastBonus,
        rules: { firstPlayer: st.firstPlayer, energyPerTurn: st.energy, baseHp: st.baseHp },
        types: st.types
      });
    });
    $('btnJoinRoom').addEventListener('click', function () { Net.join($('inpCode').value); });
    $('inpCode').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') Net.join(this.value);
    });
    $('btnCopyInvite').addEventListener('click', function () {
      copyText(inviteText(), '邀请已复制，发给朋友吧');
    });
    $('btnOnlineBack').addEventListener('click', function () {
      Net.leave();
      app.game = null;
      hideOverlay('ovOnline');
      updateMenuSummary();
      showOverlay('ovMenu');
    });

    $('btnNew').addEventListener('click', function () {
      if (app.mode === 'online') { Net.leave(); app.game = null; app.mode = 'local'; }
      clearAITimer();
      $('btnResume').style.display = (app.game && !app.game.over) ? '' : 'none';
      updateMenuSummary();
      refreshStats();
      showOverlay('ovMenu');
    });
    $('btnResume').addEventListener('click', function () { hideOverlay('ovMenu'); });
    $('btnRules').addEventListener('click', function () { showOverlay('ovRules'); });
    $('btnRules2').addEventListener('click', function () { showOverlay('ovRules'); });
    $('btnCloseRules').addEventListener('click', function () { hideOverlay('ovRules'); });
    $('ovRules').addEventListener('click', function (e) {
      if (e.target === this) hideOverlay('ovRules');
    });
    $('btnAgain').addEventListener('click', function () {
      hideOverlay('ovOver');
      if (app.mode === 'online') {
        Net.leave();
        app.game = null;
        app.mode = 'local';
        updateMenuSummary();
        showOverlay('ovMenu');
        return;
      }
      startGame(app.mode);
    });
    $('btnSettings').addEventListener('click', function () {
      hideOverlay('ovOver');
      if (app.mode === 'online') { Net.leave(); app.game = null; app.mode = 'local'; }
      openSettings();
    });

    els.btnResolve.addEventListener('click', doResolve);
    els.btnEnd.addEventListener('click', endTurn);
    $('btnResign').addEventListener('click', resign);
    $('btnModeTutorial').addEventListener('click', startTutorial);
    $('btnTutNext').addEventListener('click', function () {
      var i = (typeof app.tutDoneIndex === 'number') ? app.tutDoneIndex : 0;
      if (i >= TUT_LEVELS.length - 1) { exitTutorial(); return; }
      loadTutorialLevel(i + 1);
    });
    $('btnTutQuit').addEventListener('click', exitTutorial);
    $('btnTutExit').addEventListener('click', exitTutorial);
    $('btnTutSkip').addEventListener('click', function () {
      var t = app.tutorial;
      if (!t) return;
      if (t.index >= TUT_LEVELS.length - 1) { exitTutorial(); return; }
      loadTutorialLevel(t.index + 1);
      toast('已跳到下一关');
    });
    $('btnDraw').addEventListener('click', offerDraw);
    $('btnDrawAccept').addEventListener('click', function () { answerDraw(true); });
    $('btnDrawDecline').addEventListener('click', function () { answerDraw(false); });

    els.shop.addEventListener('click', function (e) {
      var card = e.target.closest ? e.target.closest('.card') : null;
      if (!card) return;
      var type = card.getAttribute('data-type');
      if (!type) return;
      app.selected = type;
      app.inspect = null;
      renderShop();
      updateInspectCard();
      checkTutorial();
    });


    els.canvas.addEventListener('pointermove', function (e) {
      var cell = app.renderer.pickCell(e.clientX, e.clientY);
      var k = cell ? cell.key : null;
      if ((app.hover && app.hover.key) === k) return;
      app.hover = cell;
      updateInspectCard();
    });

    els.canvas.addEventListener('pointerleave', function () {
      app.hover = null;
      updateInspectCard();
    });

    els.canvas.addEventListener('pointerdown', function (e) {
      var cell = app.renderer.pickCell(e.clientX, e.clientY);
      if (cell) handleCellClick(cell);
    });

    document.addEventListener('keydown', function (e) {
      if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
      var key = e.key;
      if (overlayOpen()) {
        if (key === 'Escape') { hideOverlay('ovRules'); hideOverlay('ovSettings'); hideOverlay('ovOnline'); }
        return;
      }
      if (app.mode === 'ai' && !isMyTurn()) return;
      if (app.mode === 'online' && !isMyTurn()) return;
      if (key === '1') { app.selected = 'infantry'; renderShop(); }
      else if (key === '2') { app.selected = 'tank'; renderShop(); }
      else if (key === '3') { app.selected = 'artillery'; renderShop(); }
      else if (key === 'r' || key === 'R') { doResolve(); }
      else if (key === ' ' || key === 'Enter') {
        if (els.btnEnd.disabled) return;
        e.preventDefault();
        endTurn();
      } else if (key === 'Escape') {
        hideOverlay('ovRules');
        hideOverlay('ovOver');
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* 调试入口：浏览器控制台里可以直接查看/操作对局状态 */
  window.HexFront = {
    app: app,
    start: startGame,
    refresh: refresh,
    resolve: doResolve,
    endTurn: endTurn,
    resign: resign,
    select: function (type) { app.selected = type; if (app.game) renderShop(); checkTutorial(); },
    click: function (q, r) { handleCellClick({ q: q, r: r, key: Hex.key(q, r) }); },
    toast: function (msg) { toast(msg); },
    tutorial: {
      start: startTutorial,
      load: loadTutorialLevel,
      next: function () { loadTutorialLevel((app.tutorial ? app.tutorial.index : 0) + 1); },
      exit: exitTutorial
    }
  };
})();
