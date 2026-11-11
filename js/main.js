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
        pending: app.pending,
        pendingReplace: app.pendingReplace || null,
        previewCells: previewRange(),
        canAfford: !!g && selectedAffordable()
      };
    });

    bindEvents();

    var params = parseQuery();
    if (params.resume === '1' && restoreResume()) return;
    if (params.mode === 'tutorial') { startTutorial(); return; }
    if (params.mode === 'online') { openOnline(params.code); return; }
    if (params.mode === 'ai' || params.mode === 'local' || params.mode === 'rogue') {
      app.vsHuman = (params.vs === 'human');       // 肉鸽：双人轮流 还是 对 AI
      startGame(params.mode);
      return;
    }

    // 没有参数（直接打开 game.html）→ 回菜单
    location.replace('index.html');
  }

  function parseQuery() {
    var out = {};
    var q = (location.search || '').replace(/^\?/, '');
    if (!q) return out;
    q.split('&').forEach(function (pair) {
      if (!pair) return;
      var eq = pair.indexOf('=');
      var k = eq < 0 ? pair : pair.slice(0, eq);
      var v = eq < 0 ? '' : pair.slice(eq + 1);
      out[decodeURIComponent(k)] = decodeURIComponent(v);
    });
    return out;
  }

  /* ---------------- 继续上次对局（菜单页跳过来） ---------------- */

  var RESUME_KEY = 'yesterday-bus.resume.v1';

  function saveResume() {
    var g = app.game;
    if (!g || g.over || app.mode === 'online') return;
    try {
      window.sessionStorage.setItem(RESUME_KEY, JSON.stringify({
        mode: app.mode,
        vsHuman: !!app.vsHuman,
        at: Date.now(),
        game: g.toJSON()
      }));
    } catch (e) {}
  }

  function restoreResume() {
    var data = null;
    try {
      var raw = window.sessionStorage.getItem(RESUME_KEY);
      if (raw) data = JSON.parse(raw);
    } catch (e) { data = null; }
    if (!data || !data.game || data.game.over) {
      try { window.sessionStorage.removeItem(RESUME_KEY); } catch (e) {}
      return false;
    }
    try {
      app.mode = (data.mode === 'ai' || data.mode === 'rogue') ? data.mode : 'local';
      app.vsHuman = !!data.vsHuman;
      app.game = ENGINE.Game.fromJSON(data.game);
      if (isAIMode()) {
        app.humanSeat = app.game.firstPlayer;
        app.aiSeat = 1 - app.game.firstPlayer;
      } else {
        app.humanSeat = app.game.firstPlayer;
        app.aiSeat = -1;
      }
      app.renderer.setGame(app.game);
      app.selected = 'infantry';
      app.effects.length = 0;
      app.startedAt = Date.now();
      els.log.innerHTML = '';
      addLog('已恢复上次的对局（第 ' + app.game.turn + ' 回合）', 'sys');
      refresh();
      maybeAITurn();
      return true;
    } catch (e) {
      toast('恢复对局失败，已回主菜单');
      return false;
    }
  }
  // 放置前的攻击范围预览：鼠标悬停在合法格上时，算出这个兵种放这里能打到哪
  var EMPTY_PREVIEW = new Set();
  function previewRange() {
    var g = app.game;
    if (!g || g.over || !app.selected || app.selected === '__slave') return EMPTY_PREVIEW;
    if (app.pending || !app.hover) return EMPTY_PREVIEW;
    if (!app.legal || !app.legal.has(app.hover.key)) return EMPTY_PREVIEW;
    var t = typesOf()[app.selected];
    if (!t) return EMPTY_PREVIEW;
    if (t.rangeMode === 'none' || t.atk <= 0) return EMPTY_PREVIEW;
    var dir = (t.rangeMode === 'line') ? defaultDir(app.hover.key) : null;
    if (!g.attackCellsFrom) return EMPTY_PREVIEW;
    return g.attackCellsFrom(app.selected, app.hover.key, dir);
  }
  function actingSeat() {
    var g = app.game;
    if (!g) return 0;
    return (app.mode === 'online' && app.mySeat != null) ? app.mySeat : g.active;
  }
  // 实际要付的费用：肉鸽的「天降奇兵 / 三角贸易」会给免费券，这时是 0
  function costForMe(typeId) {
    var g = app.game;
    if (!g || !typeId) return 0;
    if (typeof g.costFor !== 'function') return 0;
    return g.costFor(actingSeat(), typeId);
  }
  function selectedAffordable() {
    var g = app.game;
    if (!g || g.over) return false;
    if (app.selected === '__slave') return (g.freeSlavesLeft ? g.freeSlavesLeft(g.active) : 0) > 0;
    var t = typesOf()[app.selected];
    return !!t && g.energy >= costForMe(app.selected);
  }

  /* ---------------- 设置（数据模型在 js/settings.js） ---------------- */

  var SET = window.SET;
  var DEFAULT_MAPS = SET.DEFAULT_MAPS;

  function loadSettings() { return SET.load(); }
  function saveSettings() { SET.save(app.settings); }
  function sanitizeSettings() { return SET.sanitize(app.settings); }
  function mapFromSettings() { return SET.mapOf(app.settings); }
  function rulesFromSettings() { return SET.rulesOf(app.settings); }
  function clampInt(v, a, b, f) { return SET.clampInt(v, a, b, f); }
  function clampNum(v, a, b, f) { return SET.clampNum(v, a, b, f); }
  function setPath(o, p, v) { return SET.setPath(o, p, v); }
  function getPath(o, p) { return SET.getPath(o, p); }
  /* ---------------- 自建棋子接入 ---------------- */

  // 内置数值 + 当前启用的自建兵种
  function buildTypes() {
    var t = {};
    Object.keys(app.settings && app.settings.types || {}).forEach(function (k) {
      t[k] = app.settings.types[k];
    });
    var MODS = window.MODS;
    if (MODS && typeof MODS.enabledDefs === 'function') {
      MODS.enabledDefs().forEach(function (d) {
        if (d && d.id) t[d.id] = d;
      });
    }
    return t;
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
      types: buildTypes(),
      rogue: app.mode === 'rogue'
    });
    app.mapLabel = map.label;

    // 单人模式：人执先手方，AI 执后手方；肉鸽双人则两边都由人操作
    if (isAIMode()) {
      app.humanSeat = app.game.firstPlayer;
      app.aiSeat = 1 - app.game.firstPlayer;
    } else {
      app.humanSeat = app.game.firstPlayer;
      app.aiSeat = -1;
    }

    app.selected = 'infantry';
    app.hover = null;
    app.inspect = null;
    app.effects.length = 0;
    app.stuckStamp = null;
    app.startedAt = Date.now();
    app.drawByAgreement = false;
    app.drawPending = false;
    app.pending = null;
    hideDrawBar();
    try { window.sessionStorage.removeItem('yesterday-bus.resume.v1'); } catch (e) {}

    els.log.innerHTML = '';
    app.renderer.setGame(app.game);
    hideOverlay('ovMenu');
    hideOverlay('ovSettings');
    hideOverlay('ovOver');
    hideOverlay('ovRules');
    hideOverlay('ovOnline');

    var g = app.game;
    addLog('模式：' + (app.mode === 'rogue'
      ? ('肉鸽 · ' + (isAIMode() ? ('对战 AI（你执' + g.players[app.humanSeat].name + '）') : '双人轮流（各自选卡）'))
      : (isAIMode() ? '单人 · 对战 AI（你执' + g.players[app.humanSeat].name + '）' : '本地双人')), 'sys');
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
    if (!g.over && app.selected === '__slave' && g.slaveCells) {
      app.legal = g.slaveCells(g.active);      // 奴隶只能放奴隶主周围
    }
    if (app.pendingReplace) {
      var tp = g.pieceAt(app.pendingReplace);
      if (!tp || tp.owner !== g.active || tp.kind === 'base' || g.over) app.pendingReplace = null;
    }
    app.replaceable = (g.over || !isMyTurn() || !g.replaceableCells)
      ? EMPTY_SET
      : g.replaceableCells(g.active);
    app.showLegal = isMyTurn();
    app.legalShown = app.showLegal ? app.legal : EMPTY_SET;
    renderPanels();
    renderShop();
    renderButtons();
    renderTurnUI();
    updateInspectCard();
    checkTutorial();
    maybeOfferView();

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

      // 兵种编成（按兵种表动态生成，新兵种自动出现）
      var counts = {};
      var allIds = (g.allTypeList && g.allTypeList.length) ? g.allTypeList : ENGINE.ALL_TYPE_LIST;
      allIds.forEach(function (id) { counts[id] = 0; });
      g.pieces.forEach(function (p) {
        if (p.owner === i && counts[p.kind] != null) counts[p.kind] += 1;
      });
      var comp = '<div class="comp">';
      allIds.forEach(function (id) {
        var t = typesOf()[id] || ENGINE.TYPES[id];
        var show = (id === 'slave') ? counts[id] > 0 : true;   // 没奴隶就不显示
        if (!show) return;
        comp += '<span title="' + t.name + '"><i>' + t.glyph + '</i>' + counts[id] + '</span>';
      });
      comp += '</div>';

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
          perkChips(g, i) +
          ((g.rogue && window.ROGUE && g.perksOf(i).promoteLeft > 0 && !g.over)
            ? ('<button type="button" class="perk-promote" data-promote="1">晋升 ×' +
                g.perksOf(i).promoteLeft + '</button>')
            : '') +
        '</div>' +
        '<div class="panel-state">' + stateText + '</div>';
    }
  }

  function renderShop() {
    var g = app.game;
    var html = '';
    var only = (app.mode === 'tutorial' && app.tutTypes) ? app.tutTypes : null;
    var allIds = (g.typeList && g.typeList.length) ? g.typeList : ENGINE.TYPE_LIST;
    var list = allIds.filter(function (id) { return !only || only.indexOf(id) >= 0; });
    list.forEach(function (id, idx) {
      var t = typesOf()[id];
      var cost = costForMe(id);
      var freebie = (cost === 0 && (t.cost || 0) > 0);
      var afford = g.energy >= cost && !g.over;
      var rangeTxt = (t.rangeMode === 'line') ? ('直线 ' + t.range) : ('射 ' + t.range);
      html += '<button type="button" class="card' + (app.selected === id ? ' sel' : '') +
        (afford ? '' : ' poor') +
        (freebie ? ' free' : '') +
        (app.pendingReplace && afford ? ' armed' : '') + '" data-type="' + id + '">' +
        '<span class="card-key">' + (idx + 1) + '</span>' +
        '<span class="card-name">' + t.name + '</span>' +
        '<span class="card-cost">' + (freebie ? '免费' : cost + ' 费') + '</span>' +
        '<span class="card-line">血 ' + t.hp + ' · 攻 ' + t.atk + ' · ' + rangeTxt + '</span>' +
        '</button>';
    });

    // 奴隶主的免费奴隶：只在本方还有额度时出现
    var me = (app.mode === 'online') ? app.mySeat : g.active;
    if (!g.over && typeof g.freeSlavesLeft === 'function') {
      var quota = g.freeSlavesLeft(me);
      if (quota > 0) {
        var st = typesOf().slave || ENGINE.TYPES.slave;
        // 有券但没有奴隶主时，奴隶无处可放（仍需贴着奴隶主），标出来免得玩家白点
        var noSlaver = (typeof g.slaverCount === 'function') && g.slaverCount(me) === 0;
        html += '<button type="button" class="card free' +
          (noSlaver ? ' poor' : '') +
          (app.selected === '__slave' ? ' sel' : '') + '" data-type="__slave">' +
          '<span class="card-key">F</span>' +
          '<span class="card-name">' + st.name + ' ×' + quota + '</span>' +
          '<span class="card-cost">免费</span>' +
          '<span class="card-line">血 ' + st.hp + ' · 攻 ' + st.atk + ' · 射 ' + st.range +
          (noSlaver ? ' · 还没奴隶主' : ' · 需挨着奴隶主') + '</span>' +
          '</button>';
      }
    }
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
    var armed = app.pendingReplace === p.key;
    var hpNow = (g.hpOf && !isBase) ? g.hpOf(p) : p.hp;
    var atkNow = (g.atkOf && !isBase) ? g.atkOf(p) : p.atk;
    var stat = isBase
      ? '血量 ' + p.hp + ' / ' + (g.rules ? g.rules.baseHp : 4)
      : ('血量 ' + hpNow + (hpNow !== p.hp ? '（' + p.hp + '+' + (hpNow - p.hp) + '）' : '') +
         ' · 攻击 ' + atkNow + (atkNow !== p.atk ? '（' + p.atk + '+' + (atkNow - p.atk) + '）' : '') +
         ' · 射程 ' + p.range);

    // 光环信息
    var auraLine = '';
    var aura = (g.auraOf && !isBase) ? g.auraOf(p) : null;
    if (aura) {
      var label = { atk: '己方攻击力', hp: '己方血量', enemyAtk: '敌方攻击力', enemyHp: '敌方血量' }[aura.effect];
      var sign = (aura.effect === 'enemyAtk' || aura.effect === 'enemyHp') ? ' −' : ' +';
      auraLine = '<p class="ic-aura">◎ ' + aura.radius + ' 格内 ' + label + sign + aura.amount + '</p>';
    }

    el.innerHTML =
      '<div class="ic-row">' +
        '<span class="ic-glyph" style="color:' + g.players[p.owner].color + '">' + t.glyph + '</span>' +
        '<span class="ic-who"><b>' + g.players[p.owner].name + ' · ' + t.name + '</b>' +
        '<em>' + stat + '</em></span>' +
      '</div>' +
      '<p class="ic-desc">' + (t.desc || '') + '</p>' +
      auraLine +
      (armed
        ? '<div class="ic-armed">已选中这个棋子 · 点下面任意兵种卡即可替换</div>' +
          '<button type="button" class="ic-cancel" data-cancel="1">取消选中</button>'
        : '');
    el.classList.toggle('armed', armed);
    el.classList.add('show');
  }

  /* ---------------- 模式与回合控制 ---------------- */

  // 肉鸽可以是「对 AI」也可以是「双人轮流」，由 ?vs=human 区分
  function isAIMode() { return app.mode === 'ai' || (app.mode === 'rogue' && !app.vsHuman); }

  function isMyTurn() {
    // 教学模式：永远由玩家操作
    if (app.mode === 'tutorial') return !!(app.game && !app.game.over);
    var g = app.game;
    if (!g || g.over) return false;
    if (app.mode === 'online') return g.active === app.mySeat;
    if (isAIMode()) return g.active === app.humanSeat;
    return true;
  }

  function clearAITimer() {
    if (app.aiTimer) { clearTimeout(app.aiTimer); app.aiTimer = null; }
  }

  function maybeAITurn() {
    clearAITimer();
    if (!isAIMode() || !app.game || app.game.over) return;
    if (app.game.active !== app.aiSeat) return;
    app.aiKey = null;                 // 新回合：允许重新「想」一次
    app.aiTimer = setTimeout(aiStep, 240);
  }

  // AI 的节奏：每个回合先想 1~3 秒（迭代加深就在这段时间里跑），
  // 同一回合的后续动作（补子、结算）快一些，免得一个回合等太久。
  function aiStep() {
    app.aiTimer = null;
    var g = app.game;
    if (!isAIMode() || !g || g.over || g.active !== app.aiSeat) return;

    var key = g.turn + '|' + g.active;
    var first = (app.aiKey !== key);
    if (first) {
      app.aiKey = key;
      app.aiThinkMs = 1000 + Math.floor(Math.random() * 2000);   // 1~3 秒
      toast(g.players[g.active].name + ' 思考中…');
      // 搜索是同步的，会占住主线程；先让上面这行「思考中」画到屏幕上再算
      app.aiTimer = setTimeout(aiThink, 90);
      return;
    }
    app.aiThinkMs = 430;
    aiThink();
  }

  function aiThink() {
    app.aiTimer = null;
    var g = app.game;
    if (!isAIMode() || !g || g.over || g.active !== app.aiSeat) return;

    // 肉鸽：先让电脑选一张能力卡，再算这一步
    if (g.rogue && window.ROGUE) {
      var pk = g.perksOf(app.aiSeat);
      if (g.turn >= ROGUE.FIRST_TURN && pk.pickedTurn !== g.turn) {
        var got = ROGUE.aiPick(g, app.aiSeat);
        if (got) {
          addLog(g.players[app.aiSeat].name + ' 获得能力「' + got.name + '」', 'perk');
          toast('电脑拿了「' + got.name + '」');
        }
      }
      // 有晋升额度就用掉：先把步兵/奴隶改成炮兵，有炮了再改坦克
      var guard = 0;
      while (g.perksOf(app.aiSeat).promoteLeft > 0 && guard++ < 4) {
        var pool = g.pieces.filter(function (p) {
          return p.owner === app.aiSeat && (p.kind === 'infantry' || p.kind === 'slave');
        });
        if (!pool.length) break;
        var hasArt = g.pieces.some(function (p) { return p.owner === app.aiSeat && p.kind === 'artillery'; });
        var to = hasArt ? 'tank' : 'artillery';
        if (!ROGUE.promote(g, app.aiSeat, pool[0].key, to).ok) break;
        addLog(g.players[app.aiSeat].name + ' 晋升 1 个棋子为 ' + g.types[to].name, 'perk');
      }
      refresh();
    }

    var t0 = Date.now();
    var act = null;
    if (window.AI) {
      // 预算用完就交出当前最好的一步（迭代加深），所以给多少时间就用多少
      act = window.AI.bestAction(g, { budget: Math.max(220, app.aiThinkMs - 140) });
    }
    var rest = app.aiThinkMs - (Date.now() - t0);
    app.aiTimer = setTimeout(function () { aiAct(act); }, Math.max(0, rest));
  }

  // 把 AI 选好的那一步真正执行掉，然后接着算下一步
  function aiAct(act) {
    app.aiTimer = null;
    var g = app.game;
    if (!isAIMode() || !g || g.over || g.active !== app.aiSeat) return;

    if (act && act.kind === 'place') {
      var t = g.types[act.type];
      var placed = false;
      try {
        g.place(g.active, act.type, act.cell, act.dir == null ? {} : { dir: act.dir });
        placed = true;
      } catch (e) { placed = false; }
      if (placed) {
        addLog(g.players[g.active].name + ' 部署 ' + (t ? t.name : act.type), 'place');
        refresh();
        app.aiTimer = setTimeout(aiStep, 250);
        return;
      }
    }

    if (act && act.kind === 'slave') {
      var ok = false;
      try { g.placeSlave(g.active, act.cell); ok = true; } catch (e) { ok = false; }
      if (ok) {
        addLog(g.players[g.active].name + ' 召唤 奴隶', 'place');
        refresh();
        app.aiTimer = setTimeout(aiStep, 220);
        return;
      }
    }

    if (act && act.kind === 'resolve') {
      var res;
      try { res = g.resolve(); } catch (e) { res = null; }
      if (res) {
        renderResolveResult(res);
        refresh();
        if (g.over) { setTimeout(showGameOver, 620); return; }
        app.aiTimer = setTimeout(aiStep, 430);
        return;
      }
    }

    applyEndTurn();
  }

  /* ---------------- 操作 ---------------- */

  // 狙击兵默认朝向：指着最近的敌方大本营
    // 狙击兵默认朝向：指着敌方大本营
  // 根据指针位置给「待定狙击」选方向（鼠标移动、触屏点按都走这里）
  function aimAt(clientX, clientY) {
    var pend = app.pending;
    if (!pend || !app.renderer) return;
    var from = Hex.parse(pend.cell);
    var c0 = app.renderer.cellCenter(from.q, from.r);
    var box = els.canvas.getBoundingClientRect();
    var px = clientX - box.left - c0.x;
    var py = clientY - box.top - c0.y;
    if (px * px + py * py <= 16) return;      // 点在格子里：保持原方向
    var best = pend.dir, bestD = -Infinity;
    for (var d = 0; d < 6; d++) {
      var dir = Hex.DIRS[d];
      var vx = 1.5 * dir.q;
      var vy = Math.sqrt(3) * (dir.r + dir.q / 2);
      var dot = (px * vx + py * vy) / Math.sqrt(vx * vx + vy * vy);
      if (dot > bestD) { bestD = dot; best = d; }
    }
    pend.dir = best;
  }
  function defaultDir(cellKey) {
    var g = app.game;
    if (!g) return 0;
    var base = g.baseOf ? g.baseOf(1 - g.active) : null;
    if (g.dirToward) return g.dirToward(cellKey, base ? base.key : null);
    return 0;
  }
function placePending() {
    var g = app.game;
    var pend = app.pending;
    if (!g || !pend) return;
    app.pending = null;

    if (app.mode === 'online') {
      Net.act({ kind: 'place', type: pend.type, cell: pend.cell, dir: pend.dir });
      return;
    }
    try {
      g.place(g.active, pend.type, pend.cell, { dir: pend.dir });
    } catch (e) {
      toast(e.message);
      refresh();
      return;
    }
    app.inspect = null;
    addLog(g.players[g.active].name + ' 部署 ' + typesOf()[pend.type].name +
      '（方向 ' + (pend.dir + 1) + '）', 'place');
    refresh();
  }

  function handleCellClick(cell) {
    var g = app.game;
    if (!g || g.over) return;

    // 肉鸽：正在为能力卡选目标
    if (app.perkMode) { perkClick(cell); return; }
    if (app.promoMode) { pickPromoteTarget(cell); return; }

    // 正在为狙击兵选方向：这一下是确认
    if (app.pending) {
      if (cell.key === app.pending.cell) { app.pending = null; refresh(); return; }
      placePending();
      return;
    }

    var clicked = g.pieceAt(cell.key);
    if (clicked) {
      // 自己的棋子：点一下 = 选中「待替换」，再点一下取消
      var mine = clicked.owner === g.active && clicked.kind !== 'base' && isMyTurn();
      if (mine) {
        app.pendingReplace = (app.pendingReplace === cell.key) ? null : cell.key;
        app.inspect = cell;
        if (app.pendingReplace) toast('已选中，点下面的兵种卡替换它');
      } else {
        app.pendingReplace = null;
        app.inspect = (app.inspect && app.inspect.key === cell.key) ? null : cell;
      }
      updateInspectCard();
      refresh();
      return;
    }

    // 点空格：取消待替换，回到正常放置
    if (app.pendingReplace) { app.pendingReplace = null; }
    if (!isMyTurn()) { toast('还没轮到你'); return; }

    // 免费奴隶
    if (app.selected === '__slave') {
      if (!g.freeSlavesLeft || g.freeSlavesLeft(g.active) <= 0) { toast('本回合没有可召唤的奴隶了'); return; }
      if (app.mode === 'online') { Net.act({ kind: 'slave', cell: cell.key }); return; }
      try {
        g.placeSlave(g.active, cell.key);
      } catch (e) { toast(e.message); return; }
      app.inspect = null;
      addLog(g.players[g.active].name + ' 召唤 奴隶', 'place');
      refresh();
      return;
    }

    var t = typesOf()[app.selected];
    if (!t) return;
    if (g.energy < costForMe(app.selected)) { toast('费用不足，结束回合后会恢复到 ' + g.rules.energyPerTurn + ' 点'); return; }

    // 狙击兵：先确认落点，再拖方向
    if (t.rangeMode === 'line') {
      var chk = g.canPlace(g.active, app.selected, cell.key, { dir: 0 });
      if (!chk.ok) { toast(chk.msg); return; }
      app.pending = {
        cell: cell.key, type: app.selected,
        dir: defaultDir(cell.key), len: t.range, owner: g.active
      };
      app.inspect = null;
      toast('拖动或点击选择狙击方向，再点一下确认');
      refresh();
      return;
    }

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

  // 用指定兵种替换掉「已选中」的那个己方棋子
  function replaceOwn(typeId) {
    var g = app.game;
    if (!g || g.over) return;
    if (!isMyTurn()) { toast('还没轮到你'); return; }
    var cellKey = app.pendingReplace;
    if (!cellKey) return;

    if (typeId && typeId !== '__slave') app.selected = typeId;

    var pick = typeId || app.selected;
    var isSlave = pick === '__slave';
    var t = isSlave ? (typesOf().slave || ENGINE.TYPES.slave) : typesOf()[pick];
    if (!t) { toast('先在下面选一个兵种'); return; }
    if (isSlave && (!g.freeSlavesLeft || g.freeSlavesLeft(g.active) <= 0)) {
      toast('本回合没有可召唤的奴隶了');
      return;
    }

    var opts = (t.rangeMode === 'line') ? { dir: defaultDir(cellKey) } : {};
    var chk = g.canPlace(g.active, t.id || app.selected, cellKey, opts);
    if (!chk.ok) { toast(chk.msg); return; }

    // 狙击兵：先选方向
    if (t.rangeMode === 'line') {
      app.pending = {
        cell: cellKey, type: t.id || app.selected,
        dir: opts.dir, len: t.range, owner: g.active
      };
      app.inspect = null;
      toast('选择狙击方向，再点一下确认替换');
      refresh();
      return;
    }

    if (app.mode === 'online') {
      if (isSlave) Net.act({ kind: 'slave', cell: cellKey });
      else Net.act({ kind: 'place', type: pick, cell: cellKey });
      app.pendingReplace = null;
      refresh();
      return;
    }

    try {
      if (isSlave) g.placeSlave(g.active, cellKey);
      else g.place(g.active, pick, cellKey);
    } catch (e) { toast(e.message); return; }
    app.pendingReplace = null;

    var old = (g.history[g.history.length - 1] || {}).replacedKind;
    var oldName = old && typesOf()[old] ? typesOf()[old].name : '';
    addLog(g.players[g.active].name + ' 用 ' + t.name + ' 替换了 ' + (oldName || '棋子'), 'place');
    app.inspect = null;
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

  /* ---------------- 复制邀请 ---------------- */

  // http 页面没有 navigator.clipboard，必须留 textarea 兜底
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
    var url = base + '/game.html?mode=online&code=' + code;
    return '来下「昨日圆车」：' + url + '\n房号：' + code;
  }
  /* ---------------- 联机 ---------------- */

  function openOnline(code) {
    app.mode = 'online';
    app.game = null;
    app.online = { code: null, seat: -1, seats: [false, false], started: false };
    app.mySeat = 0;
    els.log.innerHTML = '';
    showOverlay('ovOnline');
    $('onlStatus').textContent = '正在连接服务器…';
    $('onlChooser').classList.remove('hidden');
    $('onlRoom').classList.add('hidden');
    if (typeof code === 'string' && /^\d{4}$/.test(code)) {
      $('inpCode').value = code;
      app.online.pendingJoin = code;
    }
    if (!Net.start({
      status: onNetStatus,
      room: onNetRoom,
      peer: onNetPeer,
      state: onNetState,
      err: onNetError
    })) {
      $('onlStatus').textContent = '这个页面不是从服务器打开的，联机不可用';
    } else if (app.online.pendingJoin) {
      Net.join(app.online.pendingJoin);
      delete app.online.pendingJoin;
    }
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
    app.pending = null;
    hideDrawBar();
    try { window.sessionStorage.removeItem('yesterday-bus.resume.v1'); } catch (e) {}
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
    // 对手也要能看见这套规则：房主建房时确认过的就是它
    addLog('规则 · ' + g.players[g.firstPlayer].name + '先手（' + g.rules.firstTurnEnergy[g.firstPlayer] +
      ' 点）· 之后每回合 ' + g.rules.energyPerTurn + ' 点 · 大本营 ' + g.rules.baseHp + ' 血', 'sys');
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
      var extra = (ev.dir != null) ? ('（方向 ' + (ev.dir + 1) + '）') : '';
      addLog(g.players[ev.owner != null ? ev.owner : ev.active].name +
        ' 部署 ' + (tp ? tp.name : '棋子') + extra, 'place');
      return;
    }

    if (ev.kind === 'slave') {
      addLog(g.players[ev.owner != null ? ev.owner : ev.active].name + ' 召唤 奴隶', 'place');
      return;
    }

    if (ev.kind === 'perk') {
      addLog(g.players[ev.owner].name + ' 获得能力「' + (ev.name || '') + '」', 'perk');
      if (ev.owner === app.mySeat) toast('获得能力：' + (ev.name || ''));
      return;
    }

    if (ev.kind === 'perkSkip') {
      addLog(g.players[ev.owner].name + ' 这回合没有拿能力卡', 'sys');
      return;
    }

    if (ev.kind === 'promote') {
      var pt = typesOf()[ev.to];
      addLog(g.players[ev.owner].name + ' 晋升 1 个棋子为 ' + (pt ? pt.name : '新兵种'), 'perk');
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
  /* ---------------- 主菜单 / 新对局 ---------------- */

  // 回到主菜单：本地/单人先把棋局存到 sessionStorage，菜单页会显示「继续当前对局」
  function goMenu() {
    var g = app.game;
    if (g && !g.over) {
      var who = g.players[g.active] ? g.players[g.active].name : '';
      var ask = '第 ' + g.turn + ' 回合还在进行中（轮到 ' + who + '），确定回主菜单？';
      if (app.mode === 'online') ask += '\n联机对局会被退出。';
      else ask += '\n进度会保存，可以随时继续。';
      if (!window.confirm(ask)) return;
    }

    clearAITimer();
    if (app.mode === 'online') {
      Net.leave();
    } else {
      saveResume();
    }
    location.href = 'index.html';
  }
  // 按当前设置重开一局（联机不能单方面重开）
  function restartGame() {
    var mode = app.mode;
    if (mode === 'online') {
      toast('联机对局不能单方面重开，回主菜单再建一间房');
      return;
    }
    if (mode === 'tutorial') {
      loadTutorialLevel(app.tutorial ? app.tutorial.index : 0);
      toast('本关重新开始');
      return;
    }
    var g = app.game;
    if (g && !g.over) {
      if (!window.confirm('放弃当前对局，按同样的设置重开一局？')) return;
    }
    startGame(mode || 'local');
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
    location.href = 'index.html';
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
      return;
    }

    // 关卡自己判断「这步做错了」，自动重来一次
    if (typeof lv.retry === 'function' && lv.retry(app.game, app)) {
      var idx = t.index;
      toast(lv.retryMsg || '再试一次');
      setTimeout(function () {
        if (app.mode === 'tutorial' && app.tutorial && app.tutorial.index === idx &&
            app.tutorial.progress < TUT_LEVELS[idx].steps.length) {
          loadTutorialLevel(idx);
        }
      }, 1400);
    }
  }

  function showTutDone(index) {
    var lv = TUT_LEVELS[index];
    var last = index >= TUT_LEVELS.length - 1;
    $('tutDoneTitle').textContent = last ? '教学完成！' : '第 ' + (index + 1) + ' 关通过';
    $('tutDoneText').textContent = last
      ? TUT_LEVELS.length + ' 个关卡全部学完。去开一局吧——联机、单人、本地双人都能玩。'
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

    if (isAIMode()) {
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
    var ids = ['ovMenu', 'ovSettings', 'ovOnline', 'ovRoomRules', 'ovRules', 'ovOver', 'ovPerk'];
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

  /* ---------------- 设置界面 / 菜单摘要（都在菜单页 index.html 里） ---------------- */

  function renderUnitRows() {}
  function syncSettingsForm() {}
  function updateMenuSummary() {}
  function refreshStats() {}
  function updateSettingHints() {}
  function openSettings() {}
  /* ---------------- 事件绑定 ---------------- */

  // 建房前把「这一刻会发给服务端的设置」原样摊开：房建好后这些就锁死了
  function roomRulesBundle() {
    sanitizeSettings();
    var st = app.settings;
    return {
      st: st,
      mp: mapFromSettings(),
      rf: rulesFromSettings(),
      rogue: !!app.rogueToggle,
      ids: (window.MODS && window.MODS.enabledIds) ? window.MODS.enabledIds() : [],
      defs: (window.MODS && window.MODS.enabledDefs) ? window.MODS.enabledDefs() : []
    };
  }

  function roomRulesPayload(b) {
    return {
      side: b.mp.side,
      density: b.mp.density,
      seed: b.mp.seed,
      modIds: b.ids,
      lastBonus: b.st.lastBonus,
      rogue: !!b.rogue,
      rules: { firstPlayer: b.st.firstPlayer, energyPerTurn: b.st.energy, baseHp: b.st.baseHp },
      types: b.st.types
    };
  }

  function roomRulesHtml(b) {
    var st = b.st, mp = b.mp, rf = b.rf;
    var side = Math.max(3, Math.min(8, Number(mp.side) || 5));
    var cells = 3 * side * (side - 1) + 1;
    var pct = Math.round((Number(mp.density) || 0) * 100);
    var mapLine = (mp.label ? '默认地图「' + mp.label + '」' : '随机地图') +
      ' · 边长 ' + side + '（' + cells + ' 格） · 障碍' + (pct ? ' 约 ' + pct + '%' : ' 无');
    var firstIsRed = Number(st.firstPlayer) === 1;
    var firstSeat = firstIsRed ? 1 : 0;
    var first = firstIsRed ? '赤方' : '青方';
    var second = firstIsRed ? '青方' : '赤方';
    // 建房的人坐 0 号位（青方）
    var meSecond = firstSeat !== 0;
    var rows = [
      ['地图', mapLine],
      ['模式', b.rogue ? '<b class="rr-rogue">肉鸽</b>：第 2 回合起，每回合三选一能力卡'
        : '标准对战（<button type="button" class="rr-toggle" data-rogue-toggle="1">改成肉鸽</button>）'],
      ['先后手', first + '先手' + (meSecond ? '（你坐' + second + '，后手）' : '（你坐' + first + '，先手）')],
      ['费用', '每回合 ' + rf.energyPerTurn + ' 点；' + second + '首回合 ' + rf.firstTurnEnergy[1 - rf.firstPlayer] + ' 点（补偿 +' + st.lastBonus + '）'],
      ['大本营', rf.baseHp + ' 血：一次结算打满 ' + rf.baseHp + ' 点伤害才摧毁']
    ].map(function (r) {
      return '<div class="rr-row"><span class="rr-k">' + r[0] + '</span><span class="rr-v">' + r[1] + '</span></div>';
    }).join('');

    var modById = {};
    b.defs.forEach(function (d) { modById[d.id] = d; });
    var units = (ENGINE.ALL_TYPE_LIST || ENGINE.TYPE_LIST).map(function (id) {
      var base = ENGINE.TYPES[id] || {};
      var t = (st.types && st.types[id]) || base;
      var summon = !!base.noDeploy;
      return '<div class="rr-unit' + (summon ? ' summon' : '') + '"><b>' + (base.glyph || '?') +
        '</b><span>' + (base.name || id) + '</span><i>' + t.hp + '血 · ' + t.atk + '攻 · ' +
        t.range + '射 · ' + (summon ? '召唤' : t.cost + '费') + '</i></div>';
    });
    b.ids.forEach(function (id) {
      var d = modById[id];
      if (!d) return;
      units.push('<div class="rr-unit mod"><b>' + (d.glyph || '?') + '</b><span>' + d.name +
        '</span><i>' + d.hp + '血 · ' + d.atk + '攻 · ' + d.range + '射 · ' + d.cost + '费</i></div>');
    });

    return rows +
      '<div class="rr-head">兵种数值</div>' +
      '<div class="rr-units">' + units.join('') + '</div>' +
      '<p class="rr-note">联机时这些数值由服务端再校验一遍，超出范围的会被夹回合法区间；' +
      '自建棋子只传编号，定义从服务器取，所以两边看到的是同一个兵。</p>';
  }

  function openRoomRules() {
    var b = roomRulesBundle();
    $('roomRulesBody').innerHTML = roomRulesHtml(b);
    app.pendingRoom = roomRulesPayload(b);
    showOverlay('ovRoomRules');
  }

  function toggleRoomRogue() {
    app.rogueToggle = !app.rogueToggle;
    openRoomRules();
  }

  /* ---------------- 肉鸽：能力卡 ---------------- */

  function rogueOn() { return !!(app.game && app.game.rogue && window.ROGUE); }

  // 当前操作的一方（联机时是自己，其余模式是行动方）
  function seatNow() {
    var g = app.game;
    if (!g) return -1;
    if (app.mode === 'online') return app.mySeat;
    return g.active;
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function rarityOf(c) {
    var R = window.ROGUE;
    return (R && R.RARITY && R.RARITY[c.rarity]) || { label: '', weight: 0, color: '#93A4B8' };
  }

  // 轮到谁、且这回合还没选过 → 弹三选一
  function maybeOfferView() {
    if (!rogueOn() || app.game.over) return;
    var g = app.game;
    var seat = seatNow();
    if (seat < 0 || !isMyTurn() || g.active !== seat) { hideOverlay('ovPerk'); return; }
    var offer = (app.mode === 'online')
      ? (g.perksOf(seat).offer || null)
      : ROGUE.ensureOffer(g, seat);
    if (!offer || !offer.length) { hideOverlay('ovPerk'); return; }
    var stamp = seat + '|' + g.turn;
    if (app.perkStamp === stamp) {
      // 弹过一次被关掉了：留一个小入口，别让玩家忘了这回合还能选
      var ov = $('ovPerk');
      if (ov && ov.classList.contains('hidden') && !app.perkMode && !app.promoMode) {
        showPerkBar('这回合还能选一张能力卡' +
          '<button type="button" class="perk-cancel" data-reperk="1">选卡</button>');
      }
      return;
    }
    app.perkStamp = stamp;
    renderPerkModal(offer, seat);
    showOverlay('ovPerk');
  }

  function renderPerkModal(offer, seat) {
    var g = app.game;
    var sub = $('perkSub');
    if (sub) {
      sub.textContent = '第 ' + g.turn + ' 回合 · ' + g.players[seat].name +
        ' 从下面三张里选一张（选中立刻生效）';
    }
    var html = '';
    offer.forEach(function (id) {
      var c = ROGUE.card(id);
      if (!c) return;
      var r = rarityOf(c);
      var ok = ROGUE.canTake(g, seat, c);
      html += '<button type="button" class="perk-card' + (ok ? '' : ' dead') +
        (c.rarity === 'ultra' ? ' ultra' : '') + '" data-card="' + c.id + '"' +
        ' style="border-color:' + r.color + '33">' +
        '<span class="perk-rar" style="color:' + r.color + '">' + r.label + '</span>' +
        '<b class="perk-name">' + escHtml(c.name) + '</b>' +
        '<span class="perk-desc">' + escHtml(c.desc) + '</span>' +
        '<span class="perk-go">' + (ok ? '选它' : '现在没有目标') + '</span>' +
        '</button>';
    });
    var box = $('perkCards');
    if (box) box.innerHTML = html;
  }

  function perkHint(c) {
    switch (c.need) {
      case 'own': return '点一个自己的棋子';
      case 'tank': return '点一个自己的坦克';
      case 'artillery': return '点一个自己的炮兵';
      case 'cell': return '点棋盘上任意一个空格';
      case 'tankInf': return '先点自己的坦克，再点贴着它的步兵';
      case 'dir':
        var t = typesOf()[c.kind] || {};
        return '点一个自己的' + (t.name || '棋子') + '，然后选方向';
      default: return '';
    }
  }

  function choosePerk(id) {
    var g = app.game, seat = seatNow();
    var c = ROGUE.card(id);
    if (!g || seat < 0 || !c) return;
    if (!ROGUE.canTake(g, seat, c)) { toast('这张卡现在没有可选的目标'); return; }
    if (!c.need) { commitPerk(id, {}); return; }
    app.perkMode = { id: id, need: c.need, kind: c.kind || null, stage: 0, key: null };
    hideOverlay('ovPerk');
    showPerkBar(escHtml(perkHint(c)) + cancelBtnHtml());
    refresh();
  }

  function cancelBtnHtml() { return '<button type="button" class="perk-cancel" data-cancel="1">取消</button>'; }

  function dirBtnHtml() {
    var names = ['右', '右上', '左上', '左', '左下', '右下'];
    var out = '';
    for (var i = 0; i < 6; i++) {
      out += '<button type="button" class="perk-dir" data-dir="' + i + '">' + names[i] + '</button>';
    }
    return out;
  }

  function commitPerk(id, args) {
    var g = app.game, seat = seatNow();
    var c = ROGUE.card(id);
    app.perkMode = null;
    hidePerkBar();
    if (app.mode === 'online') {
      Net.act({ kind: 'perk', id: id, args: args || {} });
      return;
    }
    var res = ROGUE.pick(g, seat, id, args);
    if (!res.ok) { toast(res.msg || '无法选择这张卡'); refresh(); return; }
    addLog(g.players[seat].name + ' 获得能力「' + c.name + '」', 'perk');
    toast('获得能力：' + c.name);
    refresh();
  }

  // 能力卡要求选目标时的点击处理
  function perkClick(cell) {
    var g = app.game, seat = seatNow(), m = app.perkMode;
    if (!m || !cell) return;
    var p = g.pieceAt(cell.key);
    var mine = !!(p && p.owner === seat && p.kind !== 'base');

    if (m.need === 'cell') {
      if (p) { toast('要选一个空格'); return; }
      commitPerk(m.id, { key: cell.key });
      return;
    }

    if (m.need === 'dir') {
      if (!mine || (m.kind && p.kind !== m.kind)) { toast(perkHint(ROGUE.card(m.id))); return; }
      m.stage = 1;
      m.key = cell.key;
      showPerkBar('已选「' + escHtml(g.types[p.kind].name) + '」，选一个方向' + dirBtnHtml() + cancelBtnHtml());
      refresh();
      return;
    }

    if (m.need === 'tankInf') {
      if (m.stage === 0) {
        if (!mine || p.kind !== 'tank') { toast('先点一个自己的坦克'); return; }
        m.stage = 1; m.key = cell.key;
        showPerkBar('再点一个贴着这辆坦克的自己的步兵' + cancelBtnHtml());
        refresh();
        return;
      }
      if (!mine || p.kind !== 'infantry') { toast('第二个要选自己的步兵'); return; }
      if (Hex.distance(Hex.parse(m.key), Hex.parse(cell.key)) !== 1) { toast('步兵要贴着坦克'); return; }
      commitPerk(m.id, { key: m.key, target: cell.key });
      return;
    }

    // own / tank / artillery
    if (!mine) { toast('要选自己的棋子'); return; }
    if (m.need === 'tank' && p.kind !== 'tank') { toast('要选坦克'); return; }
    if (m.need === 'artillery' && p.kind !== 'artillery') { toast('要选炮兵'); return; }
    commitPerk(m.id, { key: cell.key });
  }

  function showPerkBar(html) {
    var bar = $('perkBar');
    var txt = $('perkBarText');
    if (!bar || !txt) return;
    txt.innerHTML = html;
    bar.classList.remove('hidden');
  }

  function hidePerkBar() {
    var bar = $('perkBar');
    if (bar) bar.classList.add('hidden');
  }

  function cancelPerk() {
    app.perkMode = null;
    app.promoMode = false;
    app.promoPick = null;
    hidePerkBar();
    refresh();
  }

  // 晋升：点己方棋子 → 点兵种卡
  function startPromote() {
    var g = app.game, seat = seatNow();
    var pk = g.perksOf(seat);
    if (!(pk.promoteLeft > 0)) { toast('没有可用的晋升次数'); return; }
    app.promoPick = null;
    app.promoMode = true;
    app.perkMode = null;
    showPerkBar('晋升 ×' + pk.promoteLeft + '：先点一个自己的棋子，再点下面的兵种卡' + cancelBtnHtml());
    refresh();
  }

  function pickPromoteTarget(cell) {
    var g = app.game, seat = seatNow();
    var p = g.pieceAt(cell.key);
    if (!p || p.owner !== seat || p.kind === 'base') { toast('要选自己的棋子'); return; }
    app.promoPick = cell.key;
    showPerkBar('已选「' + escHtml(g.types[p.kind].name) + '」，点下面的兵种卡把它改造成那个兵种' + cancelBtnHtml());
    refresh();
  }

  function commitPromote(typeId) {
    var g = app.game, seat = seatNow();
    var cell = app.promoPick;
    app.promoPick = null;
    hidePerkBar();
    if (app.mode === 'online') { Net.act({ kind: 'promote', cell: cell, to: typeId }); return; }
    var res = ROGUE.promote(g, seat, cell, typeId);
    if (!res.ok) { toast(res.msg || '无法晋升'); refresh(); return; }
    addLog(g.players[seat].name + ' 晋升 1 个棋子为 ' + (typesOf()[typeId] || {}).name, 'perk');
    refresh();
  }

  // 面板里的「已获能力」小标签
  // 侧栏：这一方已获得的能力卡（双方都显示，谁拿了一目了然）
  function perkChips(g, owner) {
    if (!g.rogue || !window.ROGUE) return '';
    var list = ROGUE.obtained(g, owner);
    var pk = g.perksOf(owner);
    var first = ROGUE.FIRST_TURN || 2;
    var pending = !g.over && g.active === owner && g.turn >= first && pk.pickedTurn !== g.turn;
    var html = '<div class="perk-chips-head">能力卡 ' + list.length +
      (pending ? ' <em>本回合待选</em>' : '') + '</div>' +
      '<div class="perk-chips">';
    if (!list.length) {
      html += '<span class="perk-chip empty">还没有</span>';
    } else {
      list.forEach(function (c) {
        var r = rarityOf(c);
        html += '<span class="perk-chip" style="border-color:' + r.color + '55;color:' + r.color +
          '" title="' + escHtml(c.desc) + '">' + escHtml(c.name) + '</span>';
      });
    }
    html += '</div>';
    return html;
  }

  function bindEvents() {

    $('btnCreateRoom').addEventListener('click', function () { openRoomRules(); });
    $('btnRoomRulesCancel').addEventListener('click', function () {
      app.pendingRoom = null;
      hideOverlay('ovRoomRules');
    });
    $('btnRoomRulesOk').addEventListener('click', function () {
      var payload = app.pendingRoom || roomRulesPayload(roomRulesBundle());
      app.pendingRoom = null;
      hideOverlay('ovRoomRules');
      Net.create(payload);
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
      app.pendingRoom = null;
      hideOverlay('ovRoomRules');
      hideOverlay('ovOnline');
      location.href = 'index.html';
    });

    $('ovRoomRules').addEventListener('click', function (e) {
      if (e.target === this) { app.pendingRoom = null; hideOverlay('ovRoomRules'); }
    });

    $('btnMenu').addEventListener('click', goMenu);
    $('btnCloseRules').addEventListener('click', function () { hideOverlay('ovRules'); });
    $('btnSettings').addEventListener('click', function () {
      hideOverlay('ovOver');
      location.href = 'index.html';
    });
    $('btnNew').addEventListener('click', restartGame);
    $('btnRules').addEventListener('click', function () { showOverlay('ovRules'); });
    $('btnCloseRules').addEventListener('click', function () { hideOverlay('ovRules'); });
    $('ovRules').addEventListener('click', function (e) {
      if (e.target === this) hideOverlay('ovRules');
    });
    $('btnAgain').addEventListener('click', function () {
      hideOverlay('ovOver');
      if (app.mode === 'online') {
        Net.leave();
        location.href = 'index.html';
        return;
      }
      if (app.mode === 'tutorial') {
        location.href = 'index.html';
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

    // 肉鸽：三选一弹层、能力卡取目标、晋升
    $('perkCards').addEventListener('click', function (e) {
      var card = e.target.closest ? e.target.closest('[data-card]') : null;
      if (!card) return;
      choosePerk(card.getAttribute('data-card'));
    });
    $('btnPerkSkip').addEventListener('click', function () {
      var g = app.game, seat = seatNow();
      if (!g || seat < 0) return;
      if (app.mode === 'online') { Net.act({ kind: 'perkSkip' }); hideOverlay('ovPerk'); return; }
      ROGUE.skip(g, seat);
      hideOverlay('ovPerk');
      addLog(g.players[seat].name + ' 这回合没有拿能力卡', 'sys');
      refresh();
    });
    $('perkBar').addEventListener('click', function (e) {
      var t = e.target;
      if (t.closest && t.closest('[data-reperk]')) {
        hidePerkBar();
        var g2 = app.game, s2 = seatNow();
        if (g2 && s2 >= 0) {
          var offer2 = (app.mode === 'online')
            ? (g2.perksOf(s2).offer || null)
            : ROGUE.ensureOffer(g2, s2);
          if (offer2 && offer2.length) { renderPerkModal(offer2, s2); showOverlay('ovPerk'); }
        }
        return;
      }
      if (t.closest && t.closest('[data-cancel]')) { cancelPerk(); return; }
      var d = t.closest ? t.closest('[data-dir]') : null;
      if (d && app.perkMode && app.perkMode.stage === 1) {
        commitPerk(app.perkMode.id, { key: app.perkMode.key, dir: Number(d.getAttribute('data-dir')) });
      }
    });
    document.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-promote]') : null;
      if (b) { e.preventDefault(); startPromote(); return; }
      var tg = e.target.closest ? e.target.closest('[data-rogue-toggle]') : null;
      if (tg) { e.preventDefault(); toggleRoomRogue(); }
    });    $('btnDrawAccept').addEventListener('click', function () { answerDraw(true); });
    $('btnDrawDecline').addEventListener('click', function () { answerDraw(false); });

    els.shop.addEventListener('click', function (e) {
      var card = e.target.closest ? e.target.closest('.card') : null;
      if (!card) return;
      var type = card.getAttribute('data-type');
      if (!type || type === '__preview') return;

      // 肉鸽「晋升」：已经选好棋子 → 这张卡就是改造目标
      if (app.promoPick && app.promoMode) {
        commitPromote(type);
        return;
      }

      // 已经选中了一个要替换的棋子 → 这张卡就是「换成它」
      if (app.pendingReplace) {
        replaceOwn(type);
        return;
      }

      app.selected = type;
      app.inspect = null;
      refresh();          // 换兵种会改变合法落点（例如奴隶）
      updateInspectCard();
    });


    els.canvas.addEventListener('pointermove', function (e) {
      var cell = app.renderer.pickCell(e.clientX, e.clientY);
      var k = cell ? cell.key : null;

      // 狙击选方向：按指针相对落点的方位取最近的 6 个方向之一
      if (app.pending) aimAt(e.clientX, e.clientY);

      if ((app.hover && app.hover.key) === k) return;
      app.hover = cell;
      updateInspectCard();
    });

    if (els.inspectCard) {
      els.inspectCard.addEventListener('click', function (e) {
        var cancel = e.target.closest ? e.target.closest('[data-cancel]') : null;
        if (cancel) {
          app.pendingReplace = null;
          refresh();
          return;
        }
        var btn = e.target.closest ? e.target.closest('[data-swap]') : null;
        if (btn) replaceOwn(btn.getAttribute('data-swap'));
      });
    }

    els.canvas.addEventListener('pointerleave', function () {
      app.hover = null;
      updateInspectCard();
    });

    els.canvas.addEventListener('pointerdown', function (e) {
      var cell = app.renderer.pickCell(e.clientX, e.clientY);
      if (!cell) return;
      // 待定方向时，触屏用户点哪儿就朝哪儿，再确认
      if (app.pending) aimAt(e.clientX, e.clientY);
      handleCellClick(cell);
    });

    document.addEventListener('keydown', function (e) {
      if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
      var key = e.key;
      if (key === 'Escape' && (app.perkMode || app.promoMode)) {
        cancelPerk();
        toast('已取消');
        return;
      }
      if (key === 'Escape' && app.pendingReplace) {
        app.pendingReplace = null;
        refresh();
        toast('已取消替换');
        return;
      }
      if (key === 'Escape' && app.pending) {
        app.pending = null;
        refresh();
        toast('已取消放置');
        return;
      }
      if (overlayOpen()) {
        if (key === 'Escape') {
          hideOverlay('ovRoomRules');
          hideOverlay('ovRules');
          hideOverlay('ovSettings');
          hideOverlay('ovOnline');
          hideOverlay('ovPerk');
          app.perkStamp = null;
        }
        return;
      }
      if (isAIMode() && !isMyTurn()) return;
      if (app.mode === 'online' && !isMyTurn()) return;
      var hot = { '1': 'infantry', '2': 'tank', '3': 'artillery', '4': 'command', '5': 'sniper', '6': 'slaver' };
      var pickId = hot[key] || ((key === 'f' || key === 'F') ? '__slave' : null);
      if (pickId) {
        if (app.pendingReplace) { replaceOwn(pickId); return; }
        app.selected = pickId;
        app.pending = null;
        renderShop();
        refresh();
      }
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
    select: function (type) { app.selected = type; if (app.game) refresh(); else renderShop(); },
    click: function (q, r) { handleCellClick({ q: q, r: r, key: Hex.key(q, r) }); },
    perk: function (id) { choosePerk(id); },
    toast: function (msg) { toast(msg); },
    save: saveResume,
    restore: restoreResume,
    tutorial: {
      start: startTutorial,
      load: loadTutorialLevel,
      next: function () { loadTutorialLevel((app.tutorial ? app.tutorial.index : 0) + 1); },
      exit: exitTutorial
    }
  };
})();
