/* =========================================================
 * hex.js —— 六边形网格数学
 *
 * 采用「轴向坐标」(q, r)，地图是平顶（flat-top）小六边形拼成的
 * 尖顶大六边形（上下各一个顶点，双方的基地就在这两个顶点上）。
 *
 *   像素换算：  x = size * 1.5 * q
 *              y = size * sq3 * (r + q / 2)
 *
 * 大六边形区域： |q| <= N-1 且 |r| <= N-1 且 |q+r| <= N-1
 * 障碍物按「中心对称」成对生成： (q,r) 与 (-q,-r)
 *   格子总数： 3N(N-1) + 1
 * ========================================================= */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.Hex = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SQRT3 = Math.sqrt(3);

  // 六个相邻方向
  var DIRS = [
    { q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 },
    { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }
  ];

  function key(q, r) { return q + ',' + r; }

  function parse(k) {
    var i = k.indexOf(',');
    return { q: Number(k.slice(0, i)), r: Number(k.slice(i + 1)) };
  }

  function neighbors(q, r) {
    var out = [];
    for (var i = 0; i < 6; i++) out.push({ q: q + DIRS[i].q, r: r + DIRS[i].r });
    return out;
  }

  // 两格之间的六边形距离（步数）
  function distance(a, b) {
    var dq = a.q - b.q;
    var dr = a.r - b.r;
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
  }

  function toPixel(q, r, size) {
    return { x: size * 1.5 * q, y: size * SQRT3 * (r + q * 0.5) };
  }

  function roundAxial(qf, rf) {
    var xf = qf, zf = rf, yf = -xf - zf;
    var rx = Math.round(xf), ry = Math.round(yf), rz = Math.round(zf);
    var dx = Math.abs(rx - xf), dy = Math.abs(ry - yf), dz = Math.abs(rz - zf);
    if (dx > dy && dx > dz) rx = -ry - rz;
    else if (dy > dz) ry = -rx - rz;
    else rz = -rx - ry;
    return { q: rx, r: rz };
  }

  function fromPixel(x, y, size) {
    var qf = (2 / 3) * x / size;
    var rf = ((SQRT3 / 3) * y - x / 3) / size;
    return roundAxial(qf, rf);
  }

  function cellCount(side) { return 3 * side * (side - 1) + 1; }

  // 中心对称（旋转 180°）：绕棋盘中心点反射
  //   像素坐标下 (x, y) -> (-x, -y)，恰好把上下两个基地互换
  function mirror(q, r) { return { q: -q, r: -r }; }

  // 从某格出发、只走非障碍格，能到达多少格 / 是否到达目标
  function floodFree(cells, startKey) {
    var seen = new Set([startKey]);
    var stack = [startKey];
    var count = 0;
    while (stack.length) {
      var k = stack.pop();
      count++;
      var c = parse(k);
      var ns = neighbors(c.q, c.r);
      for (var i = 0; i < 6; i++) {
        var nk = key(ns[i].q, ns[i].r);
        if (seen.has(nk)) continue;
        var nc = cells.get(nk);
        if (!nc || nc.obstacle) continue;
        seen.add(nk);
        stack.push(nk);
      }
    }
    return { seen: seen, count: count };
  }

  /**
   * 生成地图
   * @param {number} side      边长（3~7）
   * @param {number} density   障碍密度（占格子比例，0 ~ 0.4）
   * @param {function} rng     0~1 随机函数
   */
  function createBoard(side, density, rng) {
    var u = Math.max(1, side - 1);
    var cells = new Map();
    var order = [];

    for (var q = -u; q <= u; q++) {
      var rMin = Math.max(-u, -q - u);
      var rMax = Math.min(u, -q + u);
      for (var r = rMin; r <= rMax; r++) {
        var c = { q: q, r: r, key: key(q, r), obstacle: false };
        cells.set(c.key, c);
        order.push(c);
      }
    }

    // 上下两个顶点 = 双方大本营
    var baseA = { q: 0, r: -u };
    var baseB = { q: 0, r: u };

    // 基地本体 + 周围一圈永远不放障碍，避免开局就被闷死
    var protect = new Set();
    [baseA, baseB].forEach(function (b) {
      protect.add(key(b.q, b.r));
      neighbors(b.q, b.r).forEach(function (n) { protect.add(key(n.q, n.r)); });
    });

    var d = Math.max(0, Math.min(0.4, Number(density) || 0));
    var obstacleCount = 0;

    if (d > 0) {
      var ok = false;
      for (var round = 0; round < 4 && !ok; round++) {
        for (var attempt = 0; attempt < 60 && !ok; attempt++) {
          for (var i = 0; i < order.length; i++) order[i].obstacle = false;

          // 成对放置，保证严格中心对称（(q,r) 与 (-q,-r) 同时出现）
          var handled = new Set();
          for (var j = 0; j < order.length; j++) {
            var cc = order[j];
            if (handled.has(cc.key)) continue;
            var m = mirror(cc.q, cc.r);
            var mk = key(m.q, m.r);
            handled.add(cc.key);
            handled.add(mk);
            if (cc.key === mk) continue;                       // 中轴上的格子跳过
            if (protect.has(cc.key) || protect.has(mk)) continue;
            if (rng() < d) {
              cc.obstacle = true;
              var mc = cells.get(mk);
              if (mc) mc.obstacle = true;
            }
          }

          ok = validate(cells, order, baseA, baseB);
        }
        if (!ok) d *= 0.5;
      }
      for (var k = 0; k < order.length; k++) if (order[k].obstacle) obstacleCount++;
    }

    return {
      side: side,
      cells: cells,
      order: order,
      baseA: baseA,
      baseB: baseB,
      obstacles: obstacleCount,
      count: order.length
    };
  }

  // 校验：两个基地必须连通，且 90% 以上的空地连成一片（不留大片死区）
  function validate(cells, order, baseA, baseB) {
    var free = 0;
    for (var i = 0; i < order.length; i++) if (!order[i].obstacle) free++;
    var res = floodFree(cells, key(baseA.q, baseA.r));
    var reachB = res.seen.has(key(baseB.q, baseB.r));
    return reachB && res.count >= Math.max(1, Math.floor(free * 0.9));
  }

  return {
    SQRT3: SQRT3,
    DIRS: DIRS,
    key: key,
    parse: parse,
    neighbors: neighbors,
    distance: distance,
    toPixel: toPixel,
    fromPixel: fromPixel,
    cellCount: cellCount,
    mirror: mirror,
    createBoard: createBoard
  };
});
