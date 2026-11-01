/* 生成「截图验收用」页面（tools/ 下，不参与发布）
 *   node tools/mkpreview.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'game.html'), 'utf8');

function build(name, driver) {
  const page = html
    .replace(/href="css\//g, 'href="../css/')
    .replace(/src="js\//g, 'src="../js/')
    .replace('</body>', '<script>\n' + driver + '\n</script>\n</body>');
  fs.writeFileSync(path.join(__dirname, name), page, 'utf8');
  console.log('written tools/' + name);
}

// 公共工具：放子、把指针移到某个格子上
const helpers = `
  function put(g, owner, type, n) {
    for (var i = 0; i < n; i++) {
      var legal = Array.from(g.legalCells(owner));
      if (!legal.length) return;
      try { g.place(owner, type, legal[Math.floor(legal.length / 2)]); } catch (e) { return; }
    }
  }
  function pointAt(cell) {
    var r = window.HexFront.app.renderer;
    var c = r.cellCenter(cell.q, cell.r);
    var box = document.getElementById('board').getBoundingClientRect();
    return { x: box.left + c.x, y: box.top + c.y };
  }
  function hover(cell) {
    var p = pointAt(cell);
    document.getElementById('board').dispatchEvent(
      new PointerEvent('pointermove', { clientX: p.x, clientY: p.y, bubbles: true })
    );
  }
  function clickCell(cell) {
    var p = pointAt(cell);
    document.getElementById('board').dispatchEvent(
      new PointerEvent('pointerdown', { clientX: p.x, clientY: p.y, bubbles: true })
    );
  }
`;

build('preview-board.html', `
window.addEventListener('load', function () {
  window.HexFront.start('local');
  console.log('board preview ready, cells=' + window.HexFront.app.game.board.count);
});
`);

// 中局：双方各铺开几轮，轮到青方且有费用 -> 显示落点高亮 + 放置预览
build('preview-mid.html', `
window.addEventListener('load', function () {
  var HF = window.HexFront;
  var Hex = window.Hex;
  window.HexFront.start('local');
  var g = HF.app.game;
  ${helpers}
  // 用真实指针事件点一个落点（验证坐标拾取 + 点击放置）
  var first = Array.from(g.legalCells(g.active))[0];
  clickCell(Hex.parse(first));
  HF.refresh(); HF.endTurn();

  put(g, g.active, 'tank', 1); put(g, g.active, 'infantry', 1); HF.refresh(); HF.endTurn();
  put(g, g.active, 'infantry', 1); HF.refresh(); HF.endTurn();
  put(g, g.active, 'infantry', 2); HF.refresh(); HF.endTurn();

  // 留 1 点费用：显示落点高亮 + 半透明放置预览
  HF.select('infantry');
  put(g, g.active, 'artillery', 1);
  HF.refresh();
  var rest = Array.from(g.legalCells(g.active));
  hover(Hex.parse(rest[Math.floor(rest.length / 2)]));
  console.log('mid ready units=' + g.pieces.size + ' energy=' + g.energy);
});
`);

// 悬浮单位：显示信息卡与射程范围
build('preview-unit.html', `
window.addEventListener('load', function () {
  var HF = window.HexFront;
  var Hex = window.Hex;
  window.HexFront.start('local');
  var g = HF.app.game;
  ${helpers}
  put(g, g.active, 'infantry', 2); HF.refresh(); HF.endTurn();
  put(g, g.active, 'artillery', 1); put(g, g.active, 'infantry', 1); HF.refresh(); HF.endTurn();
  put(g, g.active, 'infantry', 2); HF.refresh(); HF.endTurn();
  put(g, g.active, 'infantry', 2); HF.refresh();
  var target = null;
  g.pieces.forEach(function (p) { if (p.owner === 0 && p.kind === 'artillery') target = p; });
  if (target) hover(Hex.parse(target.key));
  console.log('unit ready, hover=' + (target ? target.key : 'none'));
});
`);

// 胜负：赤方一路打到青方基地并拆掉它
build('preview-over.html', `
window.addEventListener('load', function () {
  var HF = window.HexFront;
  var Hex = window.Hex;
  window.HexFront.start('local');
  var g = HF.app.game;
  ${helpers}

  g.active = 1;
  g.energy = 40;
  var startKey = g.baseOf(1).key;
  var targets = Hex.neighbors(g.board.baseA.q, g.board.baseA.r)
    .map(function (n) { return Hex.key(n.q, n.r); })
    .filter(function (k) { var c = g.board.cells.get(k); return c && !c.obstacle; });

  // BFS 找一条从赤方基地通向青方基地邻格的空地路径
  var prev = new Map();
  var seen = new Set([startKey]);
  var queue = [startKey];
  var goal = null;
  while (queue.length && !goal) {
    var k = queue.shift();
    if (targets.indexOf(k) >= 0 && k !== startKey) { goal = k; break; }
    var ns = Hex.neighbors(Hex.parse(k).q, Hex.parse(k).r);
    for (var i = 0; i < ns.length; i++) {
      var nk = Hex.key(ns[i].q, ns[i].r);
      if (seen.has(nk)) continue;
      var c = g.board.cells.get(nk);
      if (!c || c.obstacle) continue;
      seen.add(nk);
      prev.set(nk, k);
      queue.push(nk);
    }
  }
  var pathKeys = [];
  var cur = goal;
  while (cur && cur !== startKey) { pathKeys.push(cur); cur = prev.get(cur); }
  pathKeys.reverse();
  pathKeys.forEach(function (k) { try { g.place(1, 'infantry', k); } catch (e) {} });

  // 基地三个邻格补满 + 两门炮兵（射程 2），凑够 5 点
  targets.forEach(function (k) { try { g.place(1, 'infantry', k); } catch (e) {} });
  var ring2 = [];
  g.board.order.forEach(function (c) {
    if (Hex.distance({ q: c.q, r: c.r }, g.board.baseA) === 2) ring2.push(c.key);
  });
  var guns = 0;
  ring2.forEach(function (k) {
    if (guns >= 2) return;
    try { g.place(1, 'artillery', k); guns++; } catch (e) {}
  });

  HF.refresh();
  HF.resolve();
  console.log('over ready, over=' + g.over + ' winner=' + g.winner + ' guns=' + guns);
});
`);

// 战斗结算：造一个「4 点攻击打死 3 血步兵」的场面，验证飘字 / 战报 / 提示
build('preview-fight.html', `
window.addEventListener('load', function () {
  var HF = window.HexFront;
  var Hex = window.Hex;
  window.HexFront.start('local');
  var g = HF.app.game;
  function force(owner, kind, q, r) {
    var t = ENGINE.TYPES[kind];
    var p = { id: g.nextId++, owner: owner, kind: kind, key: Hex.key(q, r), hp: t.hp, maxHp: t.hp, atk: t.atk, range: t.range };
    g.pieces.set(p.id, p);
    g.occupant.set(p.key, p.id);
    return p;
  }
  // 青方 4 个步兵围着 (0,-2)，彼此与基地连通
  force(0, 'infantry', 0, -3);
  force(0, 'infantry', 1, -3);
  force(0, 'infantry', -1, -2);
  force(0, 'infantry', 1, -2);
  // 赤方一个步兵当靶子（吃到 4 点 -> 阵亡）
  var target = force(1, 'infantry', 0, -2);
  // 再加一个赤方步兵，只打到青方 (1,-2) 一点 -> 展示「受击但存活」的 1/4
  force(1, 'infantry', 1, -1);
  HF.refresh();
  setTimeout(function () {
    HF.resolve();
    console.log('fight resolved, target dead=' + !g.pieces.has(target.id));
  }, 800);
});
`);

// 规则弹窗
build('preview-rules.html', `
window.addEventListener('load', function () {
  window.HexFront.start('local');
  document.getElementById('btnRules').click();
  console.log('rules open');
});
`);
// 自动跑完整局，把结果和报错写进 title，便于 --dump-dom 检查
build('preview-auto.html', `
window.addEventListener('load', function () {
  var errors = [];
  window.onerror = function (m, s, l, c, err) { errors.push(String(m) + ' @' + l + ':' + c); };
  var HF = window.HexFront;
  window.HexFront.start('local');
  var g = HF.app.game;
  var actions = 0, turnGuard = 0;
  while (!g.over && turnGuard < 400) {
    turnGuard++;
    var steps = 0;
    while (steps < 8) {
      var legal = Array.from(g.legalCells(g.active));
      if (!legal.length) break;
      var types = ['artillery', 'tank', 'infantry'].filter(function (t) {
        return ENGINE.TYPES[t].cost <= g.energy;
      });
      if (!types.length) break;
      try {
        g.place(g.active, types[0], legal[Math.floor(Math.random() * legal.length)]);
        actions++;
      } catch (e) { errors.push('place: ' + e.message); break; }
      steps++;
    }
    HF.refresh();
    if (!g.resolveCount) { HF.resolve(); actions++; }
    if (g.over) break;
    HF.endTurn(); actions++;
  }
  setTimeout(function () {
    document.title = 'RESULT ' + JSON.stringify({
      over: g.over, winner: g.winner, turns: g.turn, actions: actions,
      pieces: g.pieces.size, log: document.getElementById('log').children.length,
      overShown: !document.getElementById('ovOver').classList.contains('hidden'),
      errors: errors
    });
  }, 900);
});
`);
// 设置面板
{
  const menuHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    .replace(/href="css\//g, 'href="../css/')
    .replace(/src="js\//g, 'src="../js/');
  const driver = `
window.addEventListener('load', function () {
  document.getElementById('btnOpenSettings').click();
  console.log('settings open');
});
`;
  fs.writeFileSync(path.join(__dirname, 'preview-settings.html'),
    menuHtml.replace('</body>', '<script>\n' + driver + '\n</script>\n</body>'), 'utf8');
  console.log('written tools/preview-settings.html (from index.html)');
}