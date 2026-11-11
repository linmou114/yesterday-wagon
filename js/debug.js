/* =========================================================
 * debug.js —— 对局页调试控制台
 *
 *   按 ` 或 ~ 或 F9 打开 / 关闭。只在本地双人、人机、肉鸽模式下能改局面；
 *   联机模式是服务端说了算，这里只能看，改不动。
 *
 *   命令（大小写不敏感，tab 不补全）：
 *     help                 列出命令
 *     state                当前局面摘要
 *     log [n]              最近 n 条战报
 *     turn <n>             设置回合数
 *     seat <0|1>           切换行动方
 *     energy <n|+n|-n>     改费用
 *     hp <q,r> <n>         改棋子血量
 *     spawn <兵种> <q,r> [方]  放一个棋子（不扣费、不看连通）
 *     kill <q,r>           移除一个棋子
 *     end                  结束当前回合（会触发 AI）
 *     resolve              结算
 *     offer                重发三张卡（肉鸽）
 *     cards                列出所有能力卡 id
 *     give <卡id>          直接获得一张能力卡（肉鸽）
 *     promote <q,r> <兵种> 直接改造棋子（肉鸽）
 *     flag <名称>          加一个肉鸽旗标（capture / gxyy …）
 *     inspect <q,r>        看这一格的详细数值
 *     clear                清屏
 * ========================================================= */
(function () {
  'use strict';

  var HF = null;
  var open = false;
  var el = null;          // 面板根节点
  var out = null;         // 输出区
  var input = null;       // 输入框
  var hist = [];
  var histAt = -1;

  /* ---------------- DOM ---------------- */

  function build() {
    el = document.createElement('div');
    el.className = 'dbg';
    el.innerHTML =
      '<div class="dbg-head"><span>调试控制台</span>' +
      '<span class="dbg-hint">` / F9 开关 · help 看命令</span>' +
      '<button type="button" class="dbg-close" title="关闭">×</button></div>' +
      '<div class="dbg-out"></div>' +
      '<div class="dbg-line"><span>&gt;</span><input class="dbg-in" type="text" spellcheck="false" autocomplete="off"></div>';
    document.body.appendChild(el);
    out = el.querySelector('.dbg-out');
    input = el.querySelector('.dbg-in');
    el.querySelector('.dbg-close').addEventListener('click', function () { toggle(false); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        var cmd = input.value;
        input.value = '';
        if (cmd.trim()) { hist.push(cmd); histAt = hist.length; }
        run(cmd);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (histAt > 0) { histAt--; input.value = hist[histAt] || ''; }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (histAt < hist.length - 1) { histAt++; input.value = hist[histAt] || ''; }
        else { histAt = hist.length; input.value = ''; }
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); toggle(false); }
    });
    // 点输出区把焦点交回输入框（main.js 的热键已经会跳过 input/textarea，不用再拦事件）
    out.addEventListener('mousedown', function () { setTimeout(function () { input.focus(); }, 0); });
  }

  function print(text, cls) {
    var d = document.createElement('div');
    if (cls) d.className = 'dbg-' + cls;
    d.textContent = text;
    out.appendChild(d);
    out.scrollTop = out.scrollHeight;
  }

  function toggle(next) {
    if (!el) build();
    open = next == null ? !open : !!next;
    el.classList.toggle('open', open);
    if (open) {
      setTimeout(function () { input.focus(); }, 0);
      if (!out.childNodes.length) print('调试控制台已就绪，输入 help 看命令。', 'dim');
    } else {
      input.blur();
    }
  }

  /* ---------------- 小工具 ---------------- */

  function game() {
    HF = HF || window.HexFront;
    var g = HF && HF.app && HF.app.game;
    if (!g) throw new Error('现在没有进行中的对局');
    return g;
  }
  function me() {
    HF = HF || window.HexFront;
    return HF.app.humanSeat == null ? 0 : HF.app.humanSeat;
  }
  function online() {
    HF = HF || window.HexFront;
    return HF.app.mode === 'online';
  }
  function needLocal() {
    if (online()) throw new Error('联机模式由服务端算，客户端改不了（可以看 state / log / inspect）');
  }
  function refresh() { HF = HF || window.HexFront; if (HF) HF.refresh(); }
  function cellOf(str) {
    var m = /^\(?\s*(-?\d+)\s*,\s*(-?\d+)\s*\)?$/.exec(String(str || '').trim());
    if (!m) throw new Error('格子写成 q,r 的形式，例如 0,-3');
    return { q: Number(m[1]), r: Number(m[2]), key: m[1] + ',' + m[2] };
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
    var g = game();
    if (!g.types[id]) throw new Error('没有这个兵种：' + str + '（可用：' + Object.keys(g.types).join(' / ') + '）');
    return id;
  }
  function pieceAt(str) {
    var c = cellOf(str);
    var p = game().pieceAt(c.key);
    if (!p) throw new Error(c.key + ' 上没有棋子');
    return p;
  }

  /* ---------------- 命令 ---------------- */

  var CMDS = {
    help: function () {
      print('—— 查看 ——', 'dim');
      print('  state            局面摘要');
      print('  log [n]          最近 n 条战报（默认 12）');
      print('  inspect <q,r>    这一格的棋子详细数值（含光环后的实际值）');
      print('  cards            列出全部能力卡 id');
      print('—— 修改（仅本地 / 人机 / 肉鸽）——', 'dim');
      print('  turn <n>         设回合数');
      print('  seat <0|1>       切换行动方');
      print('  energy <n|+n>    改费用');
      print('  hp <q,r> <n>     改血量');
      print('  spawn <兵种> <q,r> [0|1]   放棋子（不扣费、不看连通）');
      print('  kill <q,r>       移除棋子');
      print('  end              结束回合（会触发 AI）');
      print('  resolve          结算');
      print('—— 肉鸽 ——', 'dim');
      print('  offer            重发三张卡');
      print('  give <卡id>      直接获得一张能力卡');
      print('  promote <q,r> <兵种>       直接改造');
      print('  flag <名称>      加旗标：capture / gxyy / recruit / comms / multi / temp-base / free-slave / obsession / stealth');
      print('  clear            清屏');
    },

    state: function () {
      var g = game();
      var s = [];
      s.push('回合 ' + g.turn + ' · 行动方 ' + (g.active === 0 ? '青方(0)' : '赤方(1)') +
        ' · 模式 ' + HF.app.mode + (g.rogue ? ' · 肉鸽' : '') +
        (online() ? ' · 联机（只能看，改不动）' : ''));
      s.push('本回合费用：' + g.energy + ' / ' + g.turnEnergy() + '（行动方可用）');
      var bases = [0, 1].map(function (o) {
        var b = g.baseOf(o);
        return (o === 0 ? '青' : '赤') + ' 大本营 ' + (b ? b.hp + '/' + b.maxHp : '×');
      });
      s.push(bases.join('   ') + '   棋子：青 ' + g.countOf(0) + ' / 赤 ' + g.countOf(1));
      if (g.rogue) {
        [0, 1].forEach(function (o) {
          var pk = g.perksOf(o);
          s.push((o === 0 ? '青' : '赤') + ' 已拿 ' + (pk.cards || []).length + ' 张：' +
            ((pk.cards || []).join(', ') || '—') +
            ' · 本回合已选 ' + (pk.pickedTurn === g.turn ? '是' : '否') +
            ' · 当前手牌 ' + ((pk.offer || []).join(', ') || '—') +
            ' · 晋升 ' + (pk.promoteLeft || 0) + ' 次');
        });
      }
      s.forEach(function (x) { print(x); });
    },

    log: function (arg) {
      var n = num(arg, 12);
      var lines = [].slice.call(document.querySelectorAll('#log .log-item'));
      if (!lines.length) { print('（战报还是空的）', 'dim'); return; }
      lines.slice(-n).forEach(function (x) { print('  ' + x.textContent.trim(), 'dim'); });
    },

    inspect: function (arg) {
      var g = game();
      var p = pieceAt(arg);
      var t = g.types[p.kind] || {};
      var rows = [
        '位置 ' + p.key + ' · ' + (p.owner === 0 ? '青方' : '赤方') + ' · ' + (t.name || p.kind) + '（' + p.kind + '）',
        '血量 ' + p.hp + '/' + p.maxHp + ' → 实际 ' + g.hpOf(p),
        '攻击 ' + p.atk + ' → 实际 ' + g.atkOf(p) + ' · 射程 ' + p.range + ' · 方式 ' + (t.rangeMode || '-') + (p.dir == null ? '' : ' · 方向 ' + p.dir),
        '打击格 ' + g.attackCells(p).size + ' 个' + (g.attackCells(p).size ? '：' + [...g.attackCells(p)].slice(0, 8).join(' ') : ''),
        '标记 ' + ['hidden', 'shiftDir', 'uglyDir', 'auraBonus'].filter(function (k) { return p[k]; })
          .map(function (k) { return k + '=' + (p[k] === true ? 'true' : JSON.stringify(p[k])); }).join(' ') || '标记 —'
      ];
      rows.forEach(function (x) { print(x); });
    },

    cards: function () {
      var R = window.ROGUE;
      if (!R) { print('没有加载 rogue.js', 'err'); return; }
      var order = { common: '普通', rare: '稀有', ultra: '超稀有' };
      R.CARDS.forEach(function (c) {
        print('  ' + (c.id + '                  ').slice(0, 18) + '[' + order[c.rarity] + '] ' + c.name + ' —— ' + c.desc);
      });
    },

    turn: function (arg) {
      needLocal();
      var g = game();
      var n = num(arg);
      if (n < 1) throw new Error('回合数至少 1');
      g.turn = Math.round(n);
      refresh();
      print('回合 → ' + g.turn);
    },

    seat: function (arg) {
      needLocal();
      var g = game();
      var n = Math.round(num(arg));
      if (n !== 0 && n !== 1) throw new Error('只能是 0（青方）或 1（赤方）');
      g.active = n;
      refresh();
      print('行动方 → ' + (n === 0 ? '青方' : '赤方'));
    },

    energy: function (arg) {
      needLocal();
      var g = game();
      var s = String(arg || '').trim();
      if (/^[+-]/.test(s)) {
        g.energy = Math.max(0, g.energy + Number(s));
      } else {
        g.energy = Math.max(0, Math.round(num(s)));
      }
      refresh();
      print('费用 → ' + g.energy);
    },

    hp: function (arg) {
      needLocal();
      var parts = String(arg || '').trim().split(/\s+/);
      var p = pieceAt(parts[0]);
      var n = num(parts[1]);
      p.hp = Math.max(1, Math.round(n));
      p.maxHp = Math.max(p.maxHp, p.hp);
      refresh();
      print(p.key + ' 血量 → ' + p.hp + '/' + p.maxHp);
    },

    spawn: function (arg) {
      needLocal();
      var parts = String(arg || '').trim().split(/\s+/);
      if (parts.length < 2) throw new Error('用法：spawn 坦克 0,-3 [0|1]');
      var id = typeName(parts[0]);
      var c = cellOf(parts[1]);
      var owner = parts[2] == null ? game().active : Math.round(num(parts[2]));
      var p = game().spawn(owner, id, c.key);
      if (!p) throw new Error('这个格子放不了（越界或已占用）');
      refresh();
      print('放下 ' + (owner === 0 ? '青方' : '赤方') + ' ' + id + ' @ ' + c.key);
    },

    kill: function (arg) {
      needLocal();
      var p = pieceAt(arg);
      var g = game();
      g.removeById(p.id);
      refresh();
      print('移除了 ' + p.key + ' 上的棋子');
    },

    end: function () {
      needLocal();
      HF = HF || window.HexFront;
      HF.endTurn();
      print('已结束回合');
    },

    resolve: function () {
      needLocal();
      HF = HF || window.HexFront;
      HF.resolve();
      print('已结算');
    },

    offer: function () {
      needLocal();
      var g = game();
      if (!g.rogue) throw new Error('不是肉鸽模式');
      var o = g.active;
      var pk = g.perksOf(o);
      pk.pickedTurn = 0;
      pk.offer = null;
      pk.offerTurn = 0;
      var got = window.ROGUE.ensureOffer(g, o);
      refresh();
      print((o === 0 ? '青方' : '赤方') + ' 手牌 → ' + ((got || []).join(', ') || '（发不出来）'));
    },

    give: function (arg) {
      needLocal();
      var g = game();
      if (!g.rogue) throw new Error('不是肉鸽模式');
      var id = String(arg || '').trim();
      if (!window.ROGUE.card(id)) throw new Error('没有这张卡：' + id + '（用 cards 看列表）');
      var o = g.active;
      var pk = g.perksOf(o);
      pk.pickedTurn = 0;
      pk.offer = [id];
      pk.offerTurn = g.turn;
      var r = window.ROGUE.pick(g, o, id, {});
      refresh();
      if (!r.ok) throw new Error('拿不了：' + r.msg + '（这张卡需要目标，用 promote / 界面点选，或先 spawn 一个目标）');
      print('获得能力「' + r.card.name + '」');
    },

    promote: function (arg) {
      needLocal();
      var parts = String(arg || '').trim().split(/\s+/);
      var p = pieceAt(parts[0]);
      var id = typeName(parts[1]);
      var g = game();
      var pk = g.perksOf(g.active);
      if (!(pk.promoteLeft > 0)) pk.promoteLeft = 1;      // 调试用：没有额度就补一次
      var r = window.ROGUE.promote(g, g.active, p.key, id);
      refresh();
      if (!r.ok) throw new Error('改造失败：' + r.msg);
      print(p.key + ' → ' + id + '（血量 ' + r.piece.hp + '，费用没扣）');
    },

    flag: function (arg) {
      needLocal();
      var g = game();
      if (!g.rogue) throw new Error('不是肉鸽模式');
      var name = String(arg || '').trim();
      if (!name) throw new Error('用法：flag capture');
      var pk = g.perksOf(g.active);
      pk.flags[name] = true;
      refresh();
      print((g.active === 0 ? '青方' : '赤方') + ' 旗标 ' + name + ' 已开');
    },

    clear: function () { out.innerHTML = ''; }
  };

  /* ---------------- 执行 ---------------- */

  function run(line) {
    var text = String(line || '').trim();
    if (!text) return;
    print('> ' + text, 'in');
    var sp = text.indexOf(' ');
    var name = (sp < 0 ? text : text.slice(0, sp)).toLowerCase();
    var arg = sp < 0 ? '' : text.slice(sp + 1).trim();
    var fn = CMDS[name];
    if (!fn) { print('没有这个命令：' + name + '（help 看列表）', 'err'); return; }
    try {
      fn(arg);
    } catch (e) {
      print('出错：' + ((e && e.message) || e), 'err');
    }
  }

  /* ---------------- 开关 ---------------- */

  document.addEventListener('keydown', function (e) {
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    var typing = tag === 'INPUT' || tag === 'TEXTAREA';
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
