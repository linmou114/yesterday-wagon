/* =========================================================
 * debug.js —— 对局页调试台（图形版）
 *
 *   按 ` / ~ / F9 开关。本地双人、人机、肉鸽模式可以直接改局面；
 *   联机模式只读（服务端说了算），按钮会变灰。
 *
 *   面板分四块：
 *     局面   回合 / 行动方 / 费用 / 双方大本营，都是 - + 按钮
 *     放棋子 选兵种 → 点棋盘格子就放（不扣费、不看连通）
 *     能力卡 肉鸽专用：发牌 / 直接获得 / 晋升额度 / 旗标
 *     动作   结算 / 结束回合
 *
 *   想敲命令也可以：底部「命令」一行，用法和旧版一样（run() 也还在）。
 * ========================================================= */
(function () {
  'use strict';

  var HF = null;
  var open = false;
  var root = null;
  var body = null;
  var statusEl = null;
  var input = null;
  var out = null;
  var hist = [];
  var histAt = -1;
  var armed = null;          // { type, owner } 放棋子待落点
  var lastMsg = null;        // { text, cls }

  var FLAGS = ['capture', 'gxyy', 'recruit', 'comms', 'multi',
    'temp-base', 'free-slave', 'obsession', 'stealth', 'hiddenSnipers',
    'sniperInfinite', 'auraRadius', 'auraStack', 'auraTwoAttr', 'slaveAnywhere'];

  /* ---------------- 取状态 ---------------- */

  function app() { HF = HF || window.HexFront; return (HF && HF.app) || null; }
  function G() {
    var a = app();
    return (a && a.game && !a.game.over) ? a.game : ((a && a.game) || null);
  }
  function local() {
    var a = app();
    return !!a && a.mode !== 'online';
  }
  function refresh() { HF = HF || window.HexFront; if (HF && HF.refresh) HF.refresh(); }
  function say(text, cls) {
    lastMsg = { text: String(text), cls: cls || '' };
    if (statusEl) {
      statusEl.textContent = lastMsg.text;
      statusEl.className = 'dbg-status' + (cls ? ' ' + cls : '');
    }
  }
  function fail(e) { say('出错：' + ((e && e.message) || e), 'err'); }

  /* ---------------- 小工具 ---------------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function num(str, def) {
    if (str == null || str === '') {
      if (def == null) throw new Error('少了数字');
      return def;
    }
    var n = Number(str);
    if (isNaN(n)) throw new Error('不是数字：' + str);
    return n;
  }
  function typeName(str) {
    var map = {
      '步兵': 'infantry', '兵': 'infantry', 'inf': 'infantry',
      '坦克': 'tank', '坦': 'tank',
      '炮兵': 'artillery', '炮': 'artillery', 'art': 'artillery',
      '指挥所': 'command', '指': 'command', 'cmd': 'command',
      '狙击兵': 'sniper', '狙': 'sniper',
      '奴隶主': 'slaver', '主': 'slaver',
      '奴隶': 'slave', '奴': 'slave'
    };
    var s = String(str || '').trim();
    var id = map[s] || map[s.toLowerCase()] || s;
    var g = G();
    if (!g || !g.types[id]) throw new Error('没有这个兵种：' + str);
    return id;
  }
  function cellOf(str) {
    var m = /^\(?\s*(-?\d+)\s*,\s*(-?\d+)\s*\)?$/.exec(String(str || '').trim());
    if (!m) throw new Error('格子写成 q,r 的形式，例如 0,-3');
    return { q: Number(m[1]), r: Number(m[2]), key: m[1] + ',' + m[2] };
  }
  function pieceAt(str) {
    var c = cellOf(str);
    var p = G().pieceAt(c.key);
    if (!p) throw new Error(c.key + ' 上没有棋子');
    return p;
  }

  /* ---------------- 图形界面 ---------------- */

  function sec(title) {
    return '<div class="dbg-sec"><div class="dbg-sec-h">' + esc(title) + '</div>';
  }
  function endSec() { return '</div>'; }
  function row(label, inner) {
    return '<div class="dbg-row"><span class="dbg-k">' + esc(label) + '</span><span class="dbg-v">' + inner + '</span></div>';
  }
  function btn(text, act, opts) {
    opts = opts || {};
    return '<button type="button" class="dbg-btn' + (opts.cls ? ' ' + opts.cls : '') + '"' +
      ' data-act="' + esc(act) + '"' + (opts.dis ? ' disabled' : '') +
      (opts.title ? ' title="' + esc(opts.title) + '"' : '') + '>' + text + '</button>';
  }
  function seg(items, cur, prefix, lock) {
    return items.map(function (it) {
      return '<button type="button" class="dbg-btn dbg-seg' + (String(cur) === String(it[0]) ? ' on' : '') +
        '" data-act="' + prefix + ':' + it[0] + '"' + (lock ? ' disabled' : '') + '>' + esc(it[1]) + '</button>';
    }).join('');
  }

  function render() {
    if (!body) return;
    var g = G();
    var a = app();
    if (!g) { body.innerHTML = '<div class="dbg-sec"><div class="dbg-note">还没有开局。</div></div>'; return; }
    var lock = !local();
    var h = '';

    /* —— 局面 —— */
    h += sec('局面' + (lock ? ' · 联机只读' : ''));
    h += row('回合',
      btn('−', 'turn:-1', { dis: lock }) +
      '<b class="dbg-val">' + g.turn + '</b>' +
      btn('+', 'turn:+1', { dis: lock }));
    h += row('行动方', seg([[0, '青方'], [1, '赤方']], g.active, 'seat', lock));
    h += row('费用',
      btn('−1', 'energy:-1', { dis: lock }) +
      btn('+1', 'energy:+1', { dis: lock }) +
      btn('+3', 'energy:+3', { dis: lock }) +
      btn('归零', 'energy:0', { dis: lock, cls: 'mini' }) +
      '<b class="dbg-val">' + g.energy + '</b>');
    [0, 1].forEach(function (o) {
      var b = g.baseOf(o);
      h += row((o ? '赤方大本营' : '青方大本营'),
        btn('−', 'base:' + o + ':-1', { dis: lock }) +
        btn('+', 'base:' + o + ':+1', { dis: lock }) +
        '<b class="dbg-val">' + (b ? b.hp + '/' + b.maxHp : '已毁') + '</b>');
    });
    h += row('棋子', '青 ' + g.countOf(0) + ' · 赤 ' + g.countOf(1) +
      (lock ? '' : btn('清场', 'wipe', { cls: 'mini', title: '移除双方所有棋子（保留大本营）' })));
    h += endSec();

    /* —— 放棋子 —— */
    h += sec('放棋子');
    h += '<div class="dbg-note">' + (armed
      ? '点棋盘格子放「' + esc((g.types[armed.type] || {}).name || armed.type) + '」（' + (armed.owner ? '赤方' : '青方') + '）· 再点一次兵种取消'
      : '选一个兵种，再点棋盘上的格子') + '</div>';
    h += '<div class="dbg-types">';
    (g.typeList || []).forEach(function (id) {
      var t = g.types[id] || {};
      h += '<button type="button" class="dbg-type' + (armed && armed.type === id ? ' on' : '') + '"' +
        ' data-act="arm:' + id + '"' + (lock ? ' disabled' : '') + ' title="' +
        esc(t.name + ' ' + (t.hp || '') + '血 ' + (t.atk || 0) + '攻') + '">' +
        '<i>' + esc(t.glyph || '?') + '</i><span>' + esc(t.name || id) + '</span></button>';
    });
    h += '</div>';
    h += row('放给谁', seg([[0, '青方'], [1, '赤方']], armed ? armed.owner : g.active, 'armowner', lock));
    h += endSec();

    /* —— 能力卡 —— */
    if (g.rogue && window.ROGUE) {
      var seat = g.active;
      var pk = g.perksOf(seat);
      var R = window.ROGUE;
      h += sec('能力卡 · ' + g.players[seat].name);
      h += row('已拿 ' + (pk.cards || []).length + ' 张',
        btn('发牌', 'offer', { dis: lock }) +
        btn('晋升 +1', 'promoteleft', { dis: lock }) +
        btn('跳过', 'skip', { dis: lock, cls: 'mini' }));
      h += '<div class="dbg-cards">';
      (pk.offer || []).forEach(function (id) {
        var c = R.card(id);
        if (!c) return;
        var rar = (R.RARITY && R.RARITY[c.rarity]) || { color: '#93A4B8' };
        h += '<button type="button" class="dbg-card" data-act="give:' + esc(id) + '"' +
          (lock ? ' disabled' : '') + ' title="' + esc(c.desc) + '">' +
          '<span class="dbg-card-n" style="color:' + rar.color + '">' + esc(c.name) + '</span>' +
          '<span class="dbg-card-d">' + esc(c.desc) + '</span></button>';
      });
      if (!(pk.offer || []).length) h += '<div class="dbg-note">现在没有手牌（点「发牌」）</div>';
      h += '</div>';
      h += row('任意卡', '<select class="dbg-sel" id="dbgCardSel">' +
        R.CARDS.map(function (c) {
          return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>';
        }).join('') + '</select>' + btn('获得', 'givesel', { dis: lock, cls: 'mini' }));
      h += '<div class="dbg-flags">';
      FLAGS.forEach(function (f) {
        var on = !!(pk.flags && pk.flags[f]);
        h += '<button type="button" class="dbg-flag' + (on ? ' on' : '') + '" data-act="flag:' + f + '"' +
          (lock ? ' disabled' : '') + '>' + (on ? '✓ ' : '') + esc(f) + '</button>';
      });
      h += '</div>';
      h += endSec();
    }

    /* —— 动作 —— */
    h += sec('动作');
    h += row('本回合', btn('结算', 'resolve', { dis: lock }) + btn('结束回合', 'end', { dis: lock }));
    h += endSec();

    body.innerHTML = h;
    renderBadge(a, g);
  }

  function renderBadge(a, g) {
    var b = root && root.querySelector('.dbg-badge');
    if (!b) return;
    var m = { local: '本地双人', ai: '人机', online: '联机', tutorial: '教学', rogue: '肉鸽' }[a.mode] || a.mode;
    b.textContent = m + (g ? ' · 第 ' + g.turn + ' 回合' : '');
  }

  /* ---------------- 按钮行为 ---------------- */

  function act(str) {
    var g = G();
    if (!g) return;
    if (!local()) { say('联机模式由服务端算，客户端改不了', 'err'); return; }
    var i = str.indexOf(':');
    var name = i < 0 ? str : str.slice(0, i);
    var val = i < 0 ? '' : str.slice(i + 1);

    try {
      if (name === 'turn') {
        g.turn = Math.max(1, g.turn + Number(val));
        refresh(); render(); say('回合 → ' + g.turn);
      } else if (name === 'seat') {
        g.active = Number(val);
        refresh(); render(); say('行动方 → ' + g.players[g.active].name);
      } else if (name === 'energy') {
        g.energy = Math.max(0, g.energy + Number(val));
        refresh(); render(); say('费用 → ' + g.energy);
      } else if (name === 'base') {
        var parts = val.split(':');
        var o = Number(parts[0]);
        var b = g.baseOf(o);
        if (b) {
          b.hp = Math.max(0, Math.min(b.maxHp, b.hp + Number(parts[1])));
          if (b.hp <= 0) { b.hp = 1; say('大本营至少留 1 血（要结束请用结算）'); }
        }
        refresh(); render();
        if (b) say((o ? '赤' : '青') + '方大本营 → ' + b.hp + '/' + b.maxHp);
      } else if (name === 'wipe') {
        var n = 0;
        [0, 1].forEach(function (o) {
          g.pieces.filter(function (p) { return p.owner === o && p.kind !== 'base'; })
            .forEach(function (p) { g.removeById(p.id); n++; });
        });
        refresh(); render(); say('清掉 ' + n + ' 个棋子');
      } else if (name === 'arm') {
        if (armed && armed.type === val) armed = null;
        else armed = { type: val, owner: armed ? armed.owner : g.active };
        render();
      } else if (name === 'armowner') {
        if (!armed) armed = { type: (g.typeList || [])[0], owner: Number(val) };
        else armed.owner = Number(val);
        render();
      } else if (name === 'offer') {
        var seat = g.active;
        var pk = g.perksOf(seat);
        pk.pickedTurn = 0; pk.offer = null; pk.offerTurn = 0;
        var got = window.ROGUE.ensureOffer(g, seat);
        refresh(); render();
        say('发牌 → ' + ((got || []).join(', ') || '发不出来'));
      } else if (name === 'promoteleft') {
        g.perksOf(g.active).promoteLeft = (g.perksOf(g.active).promoteLeft || 0) + 1;
        refresh(); render(); say('晋升额度 → ' + g.perksOf(g.active).promoteLeft);
      } else if (name === 'skip') {
        var p2 = g.perksOf(g.active);
        p2.pickedTurn = g.turn;
        window.ROGUE.skip(g, g.active);
        refresh(); render(); say('这回合不选卡');
      } else if (name === 'give') {
        takeCard(val);
      } else if (name === 'givesel') {
        var sel = root.querySelector('#dbgCardSel');
        takeCard(sel ? sel.value : '');
      } else if (name === 'flag') {
        var pf = g.perksOf(g.active);
        pf.flags[val] = !pf.flags[val];
        refresh(); render();
        say('旗标 ' + val + ' → ' + (pf.flags[val] ? '开' : '关'));
      } else if (name === 'resolve') {
        HF = HF || window.HexFront;
        HF.resolve();
        render(); say('已结算');
      } else if (name === 'end') {
        HF = HF || window.HexFront;
        armed = null;
        HF.endTurn();
        render(); say('已结束回合');
      }
    } catch (e) { fail(e); }
  }

  function takeCard(id) {
    var g = G();
    var R = window.ROGUE;
    if (!g.rogue || !R) { say('不是肉鸽模式', 'err'); return; }
    if (!R.card(id)) { say('没有这张卡：' + id, 'err'); return; }
    var seat = g.active;
    var pk = g.perksOf(seat);
    pk.pickedTurn = 0;
    pk.offer = [id];
    pk.offerTurn = g.turn;
    var r = R.pick(g, seat, id, {});
    refresh(); render();
    if (!r.ok) {
      say('拿不了：' + r.msg + '（这张要选目标，用界面的选卡流程）', 'err');
      return;
    }
    say('获得能力「' + r.card.name + '」');
  }

  /* ---------------- 点棋盘放子 ---------------- */

  function onBoardClick(e) {
    if (!open || !armed || !local()) return;
    if (!e.target || e.target.id !== 'board') return;
    var a = app();
    var g = G();
    if (!a || !a.renderer || !g) return;
    var c = a.renderer.pickCell(e.clientX, e.clientY);
    if (!c) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      var p = g.spawn(armed.owner, armed.type, c.key);
      if (!p) { say(c.key + ' 放不了（越界或已占用）', 'err'); return; }
      refresh(); render();
      say('放下 ' + (armed.owner ? '赤方' : '青方') + ' ' + (g.types[armed.type] || {}).name + ' @ ' + c.key);
    } catch (err) { fail(err); }
  }

  /* ---------------- 命令（高级） ---------------- */

  function print(text, cls) {
    if (!out) return;
    var d = document.createElement('div');
    if (cls) d.className = 'dbg-' + cls;
    d.textContent = text;
    out.appendChild(d);
    out.scrollTop = out.scrollHeight;
  }

  var CMDS = {
    help: function () {
      print('—— 也能直接敲命令 ——', 'dim');
      print('  state / log [n] / inspect <q,r> / cards');
      print('  turn <n> / seat <0|1> / energy <n|+n> / hp <q,r> <n>');
      print('  spawn <兵种> <q,r> [0|1] / kill <q,r>');
      print('  end / resolve / offer / give <卡id> / promote <q,r> <兵种> / flag <名称>');
    },
    state: function () {
      var g = G();
      print('回合 ' + g.turn + ' · 行动方 ' + g.players[g.active].name + ' · 模式 ' + app().mode + (g.rogue ? ' · 肉鸽' : ''));
      print('费用 ' + g.energy + ' / ' + g.turnEnergy() + ' · 棋子 青 ' + g.countOf(0) + ' / 赤 ' + g.countOf(1));
      [0, 1].forEach(function (o) {
        var b = g.baseOf(o);
        print((o ? '赤' : '青') + ' 大本营 ' + (b ? b.hp + '/' + b.maxHp : '×'));
      });
    },
    log: function (arg) {
      var n = num(arg, 10);
      var lines = [].slice.call(document.querySelectorAll('#log .log-item'));
      if (!lines.length) { print('（战报还是空的）', 'dim'); return; }
      lines.slice(-n).forEach(function (x) { print('  ' + x.textContent.trim(), 'dim'); });
    },
    inspect: function (arg) {
      var g = G();
      var p = pieceAt(arg);
      var t = g.types[p.kind] || {};
      print(p.key + ' · ' + (p.owner ? '赤方' : '青方') + ' · ' + (t.name || p.kind));
      print('血量 ' + p.hp + '/' + p.maxHp + ' → ' + g.hpOf(p) + ' · 攻击 ' + p.atk + ' → ' + g.atkOf(p) + ' · 射程 ' + p.range);
      print('打击格 ' + g.attackCells(p).size + ' 个');
    },
    cards: function () {
      var R = window.ROGUE;
      if (!R) { print('没有加载 rogue.js', 'err'); return; }
      R.CARDS.forEach(function (c) { print('  ' + c.id + '  ' + c.name + ' —— ' + c.desc); });
    },
    turn: function (arg) { G().turn = Math.max(1, Math.round(num(arg))); refresh(); render(); print('回合 → ' + G().turn); },
    seat: function (arg) { G().active = Math.round(num(arg)) ? 1 : 0; refresh(); render(); print('行动方已切换'); },
    energy: function (arg) {
      var g = G();
      var s = String(arg || '').trim();
      g.energy = Math.max(0, /^[+-]/.test(s) ? g.energy + Number(s) : Math.round(num(s)));
      refresh(); render(); print('费用 → ' + g.energy);
    },
    hp: function (arg) {
      var parts = String(arg || '').trim().split(/\s+/);
      var p = pieceAt(parts[0]);
      p.hp = Math.max(1, Math.round(num(parts[1])));
      p.maxHp = Math.max(p.maxHp, p.hp);
      refresh(); render(); print(p.key + ' 血量 → ' + p.hp + '/' + p.maxHp);
    },
    spawn: function (arg) {
      var parts = String(arg || '').trim().split(/\s+/);
      var id = typeName(parts[0]);
      var c = cellOf(parts[1]);
      var owner = parts[2] == null ? G().active : (num(parts[2]) ? 1 : 0);
      if (!G().spawn(owner, id, c.key)) throw new Error('这个格子放不了');
      refresh(); render(); print('放下 ' + id + ' @ ' + c.key);
    },
    kill: function (arg) { var p = pieceAt(arg); G().removeById(p.id); refresh(); render(); print('已移除 ' + p.key); },
    end: function () { if (!local()) throw new Error('联机模式改不了'); HF = window.HexFront; HF.endTurn(); render(); print('已结束回合'); },
    resolve: function () { if (!local()) throw new Error('联机模式改不了'); HF = window.HexFront; HF.resolve(); render(); print('已结算'); },
    offer: function () { act('offer'); },
    give: function (arg) { takeCard(String(arg || '').trim()); },
    promote: function (arg) {
      var parts = String(arg || '').trim().split(/\s+/);
      var p = pieceAt(parts[0]);
      var id = typeName(parts[1]);
      var g = G();
      var pk = g.perksOf(g.active);
      if (!(pk.promoteLeft > 0)) pk.promoteLeft = 1;
      var r = window.ROGUE.promote(g, g.active, p.key, id);
      refresh(); render();
      if (!r.ok) throw new Error(r.msg);
      print(p.key + ' → ' + id);
    },
    flag: function (arg) {
      var g = G();
      var name = String(arg || '').trim();
      if (!name) throw new Error('用法：flag capture');
      var pk = g.perksOf(g.active);
      pk.flags[name] = !pk.flags[name];
      refresh(); render();
      print('旗标 ' + name + ' → ' + (pk.flags[name] ? '开' : '关'));
    },
    clear: function () { if (out) out.innerHTML = ''; }
  };

  function run(line) {
    var text = String(line || '').trim();
    if (!text) return;
    print('> ' + text, 'in');
    var sp = text.indexOf(' ');
    var name = (sp < 0 ? text : text.slice(0, sp)).toLowerCase();
    var arg = sp < 0 ? '' : text.slice(sp + 1).trim();
    var fn = CMDS[name];
    if (!fn) { print('没有这个命令：' + name + '（help 看列表）', 'err'); return; }
    try { fn(arg); } catch (e) { print('出错：' + ((e && e.message) || e), 'err'); }
  }

  /* ---------------- 外壳 ---------------- */

  function build() {
    root = document.createElement('div');
    root.className = 'dbg';
    root.innerHTML =
      '<div class="dbg-head"><span>调试台</span>' +
      '<span class="dbg-badge"></span>' +
      '<button type="button" class="dbg-close" title="关闭">×</button></div>' +
      '<div class="dbg-body"></div>' +
      '<div class="dbg-status">就绪</div>' +
      '<details class="dbg-cmd"><summary>命令</summary>' +
      '<div class="dbg-out"></div>' +
      '<div class="dbg-line"><span>&gt;</span><input class="dbg-in" type="text" spellcheck="false" autocomplete="off" placeholder="help 看命令"></div>' +
      '</details>';
    document.body.appendChild(root);
    body = root.querySelector('.dbg-body');
    statusEl = root.querySelector('.dbg-status');
    out = root.querySelector('.dbg-out');
    input = root.querySelector('.dbg-in');

    root.querySelector('.dbg-close').addEventListener('click', function () { toggle(false); });

    root.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!t) return;
      e.preventDefault();
      act(t.getAttribute('data-act'));
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        var cmd = input.value;
        input.value = '';
        if (cmd.trim()) { hist.push(cmd); histAt = hist.length; }
        run(cmd);
        return;
      }
      if (e.key === 'ArrowUp') { e.preventDefault(); if (histAt > 0) { histAt--; input.value = hist[histAt] || ''; } return; }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (histAt < hist.length - 1) { histAt++; input.value = hist[histAt] || ''; }
        else { histAt = hist.length; input.value = ''; }
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); toggle(false); }
    });
  }

  function toggle(next) {
    if (!root) build();
    open = next == null ? !open : !!next;
    root.classList.toggle('open', open);
    if (open) {
      render();
      if (statusEl && !lastMsg) say('选兵种后点棋盘放子；联机模式只读');
    } else {
      armed = null;
    }
  }

  /* 打开时自动重画（回合推进、AI 落子后按钮上的数字要跟着变）
     正在面板里操作（焦点在输入框/下拉）时跳过，免得把选到一半的值冲掉 */
  setInterval(function () {
    if (!open || !root || !local()) return;
    if (root.contains(document.activeElement)) return;
    render();
  }, 900);

  document.addEventListener('pointerdown', onBoardClick, true);

  document.addEventListener('keydown', function (e) {
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    var isToggle = e.key === 'F9' || (typing ? false : (e.key === '`' || e.key === '~'));
    if (!isToggle) {
      if (e.key === 'Escape' && open && !typing) { e.preventDefault(); toggle(false); }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    toggle();
  }, true);

  window.DBG = {
    open: function () { toggle(true); },
    close: function () { toggle(false); },
    toggle: function () { toggle(); },
    run: function (cmd) { if (!open) toggle(true); run(cmd); return out ? out.textContent : ''; }
  };
})();
