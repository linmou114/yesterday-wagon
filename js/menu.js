/* =========================================================
 * menu.js —— 开始菜单页（index.html）
 *
 *   只负责：模式选择（跳转到 game.html）、设置编辑、规则、
 *   服务器状态与房间数、快速加入、继续上次对局。
 *   对局逻辑全在 main.js（game.html）。
 * ========================================================= */
(function () {
  'use strict';

  var ENGINE = window.ENGINE;
  var Hex = window.Hex;
  var MAPS = window.MAPS || {};
  var SET = window.SET;
  var $ = function (id) { return document.getElementById(id); };

  var settings = null;

  var RESUME_KEY = 'yesterday-bus.resume.v1';
  var CODE_KEY = 'yesterday-bus.lastcode';

  /* ---------------- 页面跳转 ---------------- */

  function play(params) {
    var qs = [];
    Object.keys(params || {}).forEach(function (k) {
      if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
        qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
      }
    });
    window.location.href = 'game.html' + (qs.length ? ('?' + qs.join('&')) : '');
  }

  function startMode(mode) {
    SET.save(settings);
    if (mode === 'tutorial') { play({ mode: 'tutorial' }); return; }
    play({ mode: mode });
  }

  function joinRoom(code) {
    if (!/^\d{4}$/.test(code)) {
      flash('请输入 4 位房号');
      var el = $('menuCode');
      if (el) el.focus();
      return;
    }
    try { window.localStorage.setItem(CODE_KEY, code); } catch (e) {}
    SET.save(settings);
    play({ mode: 'online', code: code });
  }

  function flash(msg) {
    var el = $('menuStats');
    if (!el) return;
    el.textContent = msg;
  }

  /* ---------------- 服务器状态 / 房间数 ---------------- */

  function checkServer() {
    var tag = $('srvTag');
    if (tag) { tag.textContent = '检测中'; tag.className = 'mode-tag'; }
    if (location.protocol === 'file:') {
      if (tag) { tag.textContent = '本地模式'; tag.className = 'mode-tag'; }
      return;
    }
    var done = false;
    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      if (tag) { tag.textContent = '连接超时'; tag.className = 'mode-tag bad'; }
    }, 4000);

    fetch(location.origin + '/health', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (txt) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (txt && txt.trim() === 'ok') {
          if (tag) { tag.textContent = '在线'; tag.className = 'mode-tag ok'; }
          refreshStats();
        } else if (tag) {
          tag.textContent = '不支持联机';
          tag.className = 'mode-tag bad';
        }
      })
      .catch(function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (tag) { tag.textContent = '离线'; tag.className = 'mode-tag bad'; }
      });
  }

  function refreshStats() {
    var el = $('menuStats');
    if (!el || location.protocol === 'file:') return;
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

  /* ---------------- 继续上次对局 ---------------- */

  function readResume() {
    try {
      var raw = window.sessionStorage.getItem(RESUME_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || !data.game || data.game.over) return null;
      return data;
    } catch (e) { return null; }
  }

  function syncResumeButton() {
    var btn = $('btnResume');
    if (!btn) return;
    var data = readResume();
    btn.style.display = data ? '' : 'none';
    if (data) {
      var label = (data.mode === 'ai' ? '单人' : '本地双人');
      btn.textContent = '继续当前对局（' + label + ' · 第 ' + (data.game.turn || 1) + ' 回合）';
    }
  }

  /* ---------------- 设置界面 ---------------- */

  var SET_FIELDS = { hp: [1, 30], atk: [0, 20], range: [0, 6], cost: [1, 30] };
  var clampInt = function (v, a, b, f) { return SET.clampInt(v, a, b, f); };
  var DEFAULT_MAPS = SET.DEFAULT_MAPS;

  function renderUnitRows() {
    var html = '';
    (ENGINE.ALL_TYPE_LIST || ENGINE.TYPE_LIST).forEach(function (id) {
      var def = ENGINE.TYPES[id];
      html += '<tr><td><b>' + def.name + '</b></td>';
      ['hp', 'atk', 'range', 'cost'].forEach(function (f) {
        html += '<td><input class="num" type="number" step="1" inputmode="numeric"' +
          ' data-path="types.' + id + '.' + f + '"' +
          ' min="' + SET_FIELDS[f][0] + '" max="' + SET_FIELDS[f][1] + '" /></td>';
      });
      html += '</tr>';
    });
    $('setUnitRows').innerHTML = html;
  }

  function syncSettingsForm() {
    if (!settings) return;
    var root = $('ovSettings');
    Array.prototype.forEach.call(root.querySelectorAll('[data-path]'), function (el) {
      var v = SET.getPath(settings, el.getAttribute('data-path'));
      if (document.activeElement !== el) el.value = (v == null ? '' : String(v));
    });

    Array.prototype.forEach.call($('setDensity').querySelectorAll('button'), function (b) {
      b.classList.toggle('on', Number(b.getAttribute('data-d')) === Number(settings.density));
    });
    Array.prototype.forEach.call($('setFirst').querySelectorAll('button'), function (b) {
      b.classList.toggle('on', Number(b.getAttribute('data-p')) === Number(settings.firstPlayer));
    });

    var isDefault = settings.mapMode === 'default';
    Array.prototype.forEach.call($('setMapMode').querySelectorAll('button'), function (b) {
      b.classList.toggle('on', (b.getAttribute('data-m') === 'default') === isDefault);
    });
    $('mapBasic').classList.toggle('hidden', isDefault);
    $('mapPicker').classList.toggle('hidden', !isDefault);
    if (isDefault) renderMapPicker();

    updateSettingHints();
  }

  function updateSettingHints() {
    var side = clampInt(settings.side, 3, 8, 5);
    var e = clampInt(settings.energy, 1, 9, 3);
    var bonus = clampInt(settings.lastBonus, 0, 8, 1);
    var baseHp = clampInt(settings.baseHp, 1, 20, 4);
    $('setSideHint').textContent = '共 ' + Hex.cellCount(side) + ' 格';
    $('setEnergyHint').textContent = '第 1 回合：先手 ' + e + ' 点 / 后手 ' + (e + bonus) +
      ' 点；之后每回合 ' + e + ' 点。';
    $('setBaseHint').textContent = '攻击合计满 ' + baseHp + ' 点被摧毁';
  }

  // 小地图预览：用同一套 Hex 数学画一遍
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
        (settings.defaultMap === i ? ' on' : '') +
        '" data-i="' + i + '" title="' + m.name + '">' + (i + 1) + '</button>';
    });
    btns.innerHTML = html;

    var idx = clampInt(settings.defaultMap, 0, DEFAULT_MAPS.length - 1, 0);
    var cur = DEFAULT_MAPS[idx];
    $('mapNote').textContent = '地图 ' + (idx + 1) + '「' + cur.name + '」— ' + cur.desc;
    drawMapPreview($('mapPreview'), MAPS.SIDE || 5, cur.density, cur.seed);
  }

  function updateSummary() {
    if (!settings) return;
    var isDefault = settings.mapMode === 'default';
    var idx = clampInt(settings.defaultMap, 0, DEFAULT_MAPS.length - 1, 0);
    var dm = DEFAULT_MAPS[idx];
    var side = isDefault ? (MAPS.SIDE || 5) : clampInt(settings.side, 3, 8, 5);
    var density = isDefault ? dm.density : Number(settings.density);
    var dens = { 0: '无', 0.08: '低', 0.1: '低', 0.14: '中', 0.18: '高', 0.22: '高' };
    var dl = dens[density];
    if (!dl) dl = Math.round((density || 0) * 100) + '%';
    var names = ['青方', '赤方'];
    var fp = Number(settings.firstPlayer) === 1 ? 1 : 0;

    var mapChip = isDefault
      ? '<span class="hi">地图 ' + (idx + 1) + '「' + dm.name + '」</span>'
      : '<span>随机地图</span>';

    $('menuSummary').innerHTML =
      mapChip +
      '<span>边长 ' + side + ' · ' + Hex.cellCount(side) + ' 格</span>' +
      '<span>障碍 ' + dl + '</span>' +
      '<span>每回合 ' + clampInt(settings.energy, 1, 9, 3) + ' 费</span>' +
      '<span>' + names[fp] + '先手</span>' +
      '<span>后手 +' + clampInt(settings.lastBonus, 0, 8, 1) + ' 费</span>' +
      '<span>基地 ' + clampInt(settings.baseHp, 1, 20, 4) + ' 血</span>';
  }

  function openSettings() {
    syncSettingsForm();
    show('ovSettings');
  }

  /* ---------------- 弹层 ---------------- */

  function show(id) { var el = $(id); if (el) el.classList.remove('hidden'); }
  function hide(id) { var el = $(id); if (el) el.classList.add('hidden'); }

  /* ---------------- 事件 ---------------- */

  function bind() {
    $('btnModeLocal').addEventListener('click', function () { startMode('local'); });
    $('btnModeAI').addEventListener('click', function () { startMode('ai'); });
    $('btnModeOnline').addEventListener('click', function () { startMode('online'); });
    $('btnModeTutorial').addEventListener('click', function () { startMode('tutorial'); });

    $('menuJoinBtn').addEventListener('click', function () {
      joinRoom(String($('menuCode').value || '').trim());
    });
    $('menuCode').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') joinRoom(String($('menuCode').value || '').trim());
    });

    $('btnResume').addEventListener('click', function () {
      play({ resume: '1' });
    });

    $('btnOpenSettings').addEventListener('click', openSettings);
    $('btnRules2').addEventListener('click', function () { show('ovRules'); });
    $('btnCloseRules').addEventListener('click', function () { hide('ovRules'); });

    // 设置：输入 / 分段按钮
    $('ovSettings').addEventListener('input', function (e) {
      var el = e.target;
      if (!el || !el.getAttribute) return;
      var path = el.getAttribute('data-path');
      if (!path) return;
      SET.setPath(settings, path, el.value === '' ? '' : Number(el.value));
      SET.save(settings);
      updateSummary();
      updateSettingHints();
    });

    $('ovSettings').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('button') : null;
      if (!btn) return;
      var d = btn.getAttribute('data-d');
      var p = btn.getAttribute('data-p');
      var m = btn.getAttribute('data-m');
      var i = btn.getAttribute('data-i');
      if (d !== null) { settings.density = Number(d); }
      else if (p !== null) { settings.firstPlayer = Number(p); }
      else if (m !== null) { settings.mapMode = (m === 'default') ? 'default' : 'random'; }
      else if (i !== null) { settings.defaultMap = Number(i); }
      else return;

      SET.save(settings);
      syncSettingsForm();
      updateSummary();
    });

    $('btnSetReset').addEventListener('click', function () {
      settings = SET.defaults();
      SET.save(settings);
      syncSettingsForm();
      updateSummary();
      flash('已恢复默认设置');
    });

    $('btnSetDone').addEventListener('click', function () {
      SET.sanitize(settings);
      SET.save(settings);
      syncSettingsForm();
      updateSummary();
      hide('ovSettings');
    });

    // 遮罩点击关闭
    ['ovSettings', 'ovRules'].forEach(function (id) {
      $(id).addEventListener('click', function (e) {
        if (e.target === this) hide(id);
      });
    });

    window.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      hide('ovSettings');
      hide('ovRules');
    });
  }

  /* ---------------- 启动 ---------------- */

  function boot() {
    settings = SET.sanitize(SET.load());
    renderUnitRows();
    syncSettingsForm();
    updateSummary();
    syncResumeButton();
    bind();

    // 邀请链接带 ?room=1234 时自动填好
    var m = /[?&]room=(\d{4})/.exec(window.location.search || '');
    if (m) {
      $('menuCode').value = m[1];
      flash('已填入房号 ' + m[1] + '，点「加入房间」就能进');
    } else {
      try {
        var last = window.localStorage.getItem(CODE_KEY);
        if (last && /^\d{4}$/.test(last)) $('menuCode').value = last;
      } catch (e) {}
    }

    checkServer();
    setInterval(refreshStats, 15000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
