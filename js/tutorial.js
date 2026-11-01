/* =========================================================
 * tutorial.js —— 新手教学关卡
 *
 *   每个关卡都是一个人为摆好的小局面，只教一个知识点：
 *     1. 放置棋子      2. 费用
 *     3. 坦克（血量）   4. 结算与伤害
 *     5. 炮兵射程      6. 断联移除
 *     7. 打大本营
 *
 *   关卡数据是纯逻辑（可在 Node 里跑测试），DOM 交互在 main.js。
 * ========================================================= */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.TUTORIAL = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 棋子数量（不含大本营）
  function units(g, owner) {
    var n = 0;
    g.pieces.forEach(function (p) {
      if (p.owner === owner && p.kind !== 'base') n++;
    });
    return n;
  }

  function opponentUnits(g, me) { return units(g, 1 - me); }

  function findPiece(g, owner, kind) {
    var found = null;
    g.pieces.forEach(function (p) {
      if (p.owner === owner && p.kind === kind) found = p;
    });
    return found;
  }

  // 我方坦克当前会挨多少点攻击（放对了位置才是 3 点）
  function tankTookDamage(g) {
    var tank = findPiece(g, 1, 'tank');
    if (!tank) return 0;
    var dm = g.damageMap();
    return dm.get(tank.id) || 0;
  }

  function hasResolved(g) {
    return g.history.some(function (h) { return h.type === 'resolve'; });
  }

  var LEVELS = [
    {
      key: 'place',
      title: '放置棋子',
      side: 3,
      energy: 3,
      types: ['infantry'],
      spawn: [],
      steps: [
        { text: '先点底部的「步兵」卡片，把它选中（边框会变亮）。', done: function (g, app) { return app.selected === 'infantry'; } },
        { text: '再看棋盘：基地旁边有 3 个闪光的格子。随便点一个，步兵就放下了。', done: function (g) { return units(g, 1) >= 1; } }
      ]
    },

    {
      key: 'cost',
      title: '费用不够就不能放',
      side: 3,
      energy: 3,
      types: ['infantry'],
      spawn: [],
      steps: [
        { text: '3 点费用只够放 3 个步兵。选中步兵，把 3 个都放上。', done: function (g) { return units(g, 1) >= 3; } },
        { text: '费用花光了：卡片变红、棋盘不再闪光，这就是「费用不足」。点「结束回合」领下一回合的 3 点。', done: function (g) { return g.turn > 1; } }
      ]
    },

    {
      key: 'tank',
      title: '坦克：多花 1 费，换 1 点血',
      side: 3,
      energy: 2,
      types: ['infantry', 'tank'],
      spawn: [
        { owner: 0, type: 'infantry', cell: '0,-1' },
        { owner: 0, type: 'infantry', cell: '-1,0' },
        { owner: 0, type: 'infantry', cell: '1,-1' },
        { owner: 1, type: 'infantry', cell: '0,1' }
      ],
      steps: [
        {
          text: '棋盘中间那个空位会同时挨 3 个敌人的攻击，合计 3 点。注意：伤害不累积 —— 挨不到血量就完全没事。步兵只有 3 血，3 点正好打死它；坦克有 4 血（贵 1 费），同样挨 3 点却毫发无伤。选中「坦克」，放到三个敌人正下方那一格，再点「结算」。',
          done: function (g) { return tankTookDamage(g) >= 3; }
        }
      ],
      retry: function (g) {
        return hasResolved(g) && tankTookDamage(g) < 3;
      },
      retryMsg: '结算后没看到坦克硬扛 3 点的效果。重来一次：把坦克放到三个敌人正下方那一格。'
    },

    {
      key: 'resolve',
      title: '结算：攻击之和 ≥ 血量就死',
      side: 3,
      energy: 0,
      types: [],
      spawn: [
        { owner: 0, type: 'infantry', cell: '0,0' },
        { owner: 1, type: 'infantry', cell: '0,1' },
        { owner: 1, type: 'infantry', cell: '-1,1' },
        { owner: 1, type: 'infantry', cell: '-1,0' }
      ],
      steps: [
        {
          text: '中间那个青色步兵被你的 3 个步兵围着：每个打它 1 点，合计 3 点 —— 正好等于它的血量。点右下角的「结算」按钮试试。',
          done: function (g) { return opponentUnits(g, 1) === 0; }
        }
      ]
    },

    {
      key: 'range',
      title: '炮兵：射程 2',
      side: 3,
      energy: 0,
      types: [],
      spawn: [
        { owner: 0, type: 'infantry', cell: '0,-1', hp: 1 },
        { owner: 1, type: 'artillery', cell: '0,1' },
        { owner: 1, type: 'infantry', cell: '1,0' }
      ],
      steps: [
        {
          text: '敌人离你这两个棋子都是 2 格。步兵射程只有 1，够不到；炮兵的射程是 2，正好打得到。点「结算」—— 只有炮兵会开火。',
          done: function (g) { return opponentUnits(g, 1) === 0; }
        }
      ]
    },

    {
      key: 'cut',
      title: '切断补给：断联的棋子会消失',
      side: 3,
      energy: 0,
      types: [],
      spawn: [
        { owner: 0, type: 'infantry', cell: '0,-1' },
        { owner: 0, type: 'infantry', cell: '0,0' },
        { owner: 0, type: 'infantry', cell: '1,0' },
        { owner: 1, type: 'infantry', cell: '0,1' },
        { owner: 1, type: 'infantry', cell: '-1,1' },
        { owner: 1, type: 'infantry', cell: '-1,0' }
      ],
      steps: [
        {
          text: '敌人排成一条线，只有最上面那个贴着它们的大本营。点「结算」——中间那个被打死后，最后面那个就断了补给，会跟着一起消失。',
          done: function (g) { return units(g, 0) <= 1; }
        }
      ]
    },

    {
      key: 'base',
      title: '拆掉大本营',
      side: 3,
      energy: 2,
      types: ['artillery'],
      spawn: [
        { owner: 1, type: 'infantry', cell: '0,1' },
        { owner: 1, type: 'infantry', cell: '0,0' },
        { owner: 1, type: 'infantry', cell: '0,-1' },
        { owner: 1, type: 'infantry', cell: '1,-1' },
        { owner: 1, type: 'infantry', cell: '1,-2' },
        { owner: 1, type: 'infantry', cell: '-1,-1' }
      ],
      steps: [
        {
          text: '大本营有 4 点血，可能贴上去打的格子只有 3 个 —— 光靠步兵最多打 3 点。选中「炮兵」，放在离敌营 2 格以内的闪光格里，补上第 4 点。',
          done: function (g) { return units(g, 1) >= 7; }
        },
        {
          text: '点「结算」拆掉它。如果只打掉 3 点，就「结束回合」再补一门炮。',
          done: function (g) { return g.over && g.winner === 1; }
        }
      ]
    }
  ];

  // 生成关卡局面
  function buildLevel(ENGINE, index) {
    var level = LEVELS[index];
    var rules = {
      firstPlayer: 1,
      energyPerTurn: level.energy,
      firstTurnEnergy: [level.energy, level.energy],
      baseHp: 4
    };
    var g = new ENGINE.Game({
      side: level.side, density: 0, seed: 1000 + index, rules: rules
    });
    g.active = 1;
    g.turn = 1;
    g.energy = level.energy;

    (level.spawn || []).forEach(function (s) {
      g.spawn(s.owner, s.type, s.cell, s.hp);
    });
    return g;
  }

  return {
    LEVELS: LEVELS,
    buildLevel: buildLevel,
    units: units,
    findPiece: findPiece
  };
});
