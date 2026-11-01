/* =========================================================
 * maps.js —— 8 张固定的默认地图
 *
 *   每张地图只记录「密度 + 种子」，地图本身由 Hex.createBoard 按同一套规则
 *   确定性生成（中心对称 + 基地保护 + 连通性校验），所以：
 *     · 同一张地图每次打开完全一样
 *     · 文件很小，改一张图只要改一行
 *
 *   边长固定 5（61 格）；密度递增，难度由开阔到拥挤。
 * ========================================================= */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.MAPS = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SIDE = 5;

  var DEFAULT_MAPS = [
    { name: '开阔平原', desc: '没有任何障碍，纯拼运营和正面推进', density: 0, seed: 1 },
    { name: '碎石散落', desc: '零星几块石头，几乎不影响走位', density: 0.10, seed: 1 },
    { name: '环形遗迹', desc: '障碍围出一圈空地，适合绕后', density: 0.10, seed: 3 },
    { name: '孤峰对峙', desc: '障碍很少且分散，中路开阔', density: 0.14, seed: 4 },
    { name: '中枢通路', desc: '中心附近留出通道，两翼有掩体', density: 0.14, seed: 1 },
    { name: '两侧峡谷', desc: '中路被卡住，主要从两侧发展', density: 0.14, seed: 2 },
    { name: '密林迷宫', desc: '障碍较多，绕路和断联更常见', density: 0.18, seed: 1 },
    { name: '乱石荒原', desc: '最拥挤的一张，正面很难铺开', density: 0.22, seed: 3 }
  ];

  return {
    SIDE: SIDE,
    DEFAULT_MAPS: DEFAULT_MAPS
  };
});
