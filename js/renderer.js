/* =========================================================
 * renderer.js —— Canvas 绘制层（只画，不改规则状态）
 * ========================================================= */
window.Renderer = (function () {
  'use strict';

  var FONT = '"Noto Sans SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif';
  var EMPTY = new Set();

  function rgba(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function Renderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.game = null;
    this.provider = null;
    this.hexSize = 24;
    this.cx = 0;
    this.cy = 0;
    this.w = 0;
    this.h = 0;
    this.ui = {};
    this._raf = null;

    var self = this;
    this._onResize = function () { self.resize(); };
    if (window.ResizeObserver) {
      this.ro = new ResizeObserver(this._onResize);
      this.ro.observe(canvas.parentElement);
    } else {
      window.addEventListener('resize', this._onResize);
    }
    this.resize();
  }

  Renderer.prototype.setGame = function (g) {
    this.game = g;
    this.resize();
  };

  Renderer.prototype.resize = function () {
    var host = this.canvas.parentElement;
    if (!host) return;

    // 先把画布清零：否则画布的固有尺寸会把容器撑大，测出来的尺寸永远偏大（死循环）
    this.canvas.style.width = '0px';
    this.canvas.style.height = '0px';

    var rect = host.getBoundingClientRect();
    var w = Math.max(220, Math.floor(rect.width));
    var h = Math.max(220, Math.floor(rect.height));
    var dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.w = w;
    this.h = h;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.cx = w / 2;
    this.cy = h / 2;

    var side = this.game ? this.game.side : 5;
    var pad = 12;
    var sW = (w - pad * 2) / (3 * side - 1);
    var sH = (h - pad * 2) / (Math.sqrt(3) * (2 * side - 1));
    this.hexSize = Math.max(7, Math.min(sW, sH));
  };

  Renderer.prototype.start = function (provider) {
    this.provider = provider || function () { return {}; };
    var self = this;
    if (this._raf) return;
    (function frame() {
      self._raf = requestAnimationFrame(frame);
      self.draw();
    })();
  };

  Renderer.prototype.cellCenter = function (q, r) {
    var p = Hex.toPixel(q, r, this.hexSize);
    return { x: this.cx + p.x, y: this.cy + p.y };
  };

  Renderer.prototype.pickCell = function (clientX, clientY) {
    if (!this.game) return null;
    var rect = this.canvas.getBoundingClientRect();
    var hx = Hex.fromPixel(clientX - rect.left - this.cx, clientY - rect.top - this.cy, this.hexSize);
    var key = Hex.key(hx.q, hx.r);
    if (!this.game.board.cells.has(key)) return null;
    return { q: hx.q, r: hx.r, key: key };
  };

  Renderer.prototype.hexPath = function (x, y, rad) {
    var ctx = this.ctx;
    ctx.beginPath();
    for (var i = 0; i < 6; i++) {
      var a = Math.PI / 3 * i;
      var px = x + rad * Math.cos(a);
      var py = y + rad * Math.sin(a);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  };

  /* ---------------- 主绘制 ---------------- */

  Renderer.prototype.draw = function () {
    var ctx = this.ctx;
    var g = this.game;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!g) return;

    var ui = this.provider ? (this.provider() || {}) : {};
    this.ui = ui;

    var self = this;
    var s = this.hexSize;
    var activeColor = g.players[g.active].color;
    var legal = ui.legal || EMPTY;
    var hover = ui.hover || null;
    var inspect = ui.inspect || null;
    var selected = ui.selected || null;
    var pulse = 0.55 + 0.45 * Math.sin(performance.now() / 420);

    // 1. 地块
    g.board.order.forEach(function (c) {
      var p = self.cellCenter(c.q, c.r);
      self.hexPath(p.x, p.y, s * 0.965);
      ctx.fillStyle = c.obstacle ? '#10151d' : 'rgba(27,39,60,0.92)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = c.obstacle ? 'rgba(120,145,180,0.10)' : 'rgba(120,160,210,0.15)';
      ctx.stroke();

      if (c.obstacle) {
        // 碎石堆，让「不可通行」一眼可辨
        var rocks = [
          [-0.19, 0.17, 0.23], [0.17, 0.03, 0.17], [-0.02, -0.21, 0.135]
        ];
        for (var ri = 0; ri < rocks.length; ri++) {
          var rx = p.x + rocks[ri][0] * s;
          var ry = p.y + rocks[ri][1] * s;
          var rr = rocks[ri][2] * s;
          ctx.beginPath();
          ctx.arc(rx, ry, rr, 0, Math.PI * 2);
          ctx.fillStyle = ri === 0 ? 'rgba(104,126,158,0.62)' : 'rgba(78,99,128,0.55)';
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(14,20,30,0.85)';
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(rx - rr * 0.25, ry - rr * 0.3, rr * 0.42, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(170,192,220,0.22)';
          ctx.fill();
        }
      }
    });

    // 2. 合法落点（买不起时标红，而不是干脆不显示）
    if (selected && !g.over) {
      var canPay = !!ui.canAfford;
      var markColor = canPay ? activeColor : '#f87171';
      legal.forEach(function (k) {
        var c = Hex.parse(k);
        var p = self.cellCenter(c.q, c.r);
        self.hexPath(p.x, p.y, s * 0.88);
        ctx.fillStyle = rgba(markColor, canPay ? (0.07 + 0.07 * pulse) : 0.10);
        ctx.fill();
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = rgba(markColor, canPay ? (0.45 + 0.35 * pulse) : 0.55);
        ctx.stroke();
        ctx.restore();
      });
    }

    // 3. 射程提示（悬浮 / 选中某个棋子时）
    var focusPiece = null;
    if (hover) focusPiece = g.pieceAt(hover.key);
    else if (inspect) focusPiece = g.pieceAt(inspect.key);
    if (focusPiece && focusPiece.atk > 0) this.drawRange(focusPiece);

    // 2.5 落点预览：这个兵种放这里能打到哪
    var preview = ui.previewCells;
    if (preview && preview.size) {
      preview.forEach(function (k) {
        var c = Hex.parse(k);
        var p = self.cellCenter(c.q, c.r);
        self.hexPath(p.x, p.y, s * 0.74);
        ctx.fillStyle = 'rgba(251,191,36,0.14)';
        ctx.fill();
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(251,191,36,0.85)';
        ctx.stroke();
        ctx.restore();
        // 中心小圆点，强调「这个格子会被打到」
        ctx.beginPath();
        ctx.arc(p.x, p.y, s * 0.10, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(251,191,36,0.55)';
        ctx.fill();
        // 范围内有敌方棋子 → 画个红圈提示「能打到它」
        var occ = g.occupant.get(k);
        if (occ != null) {
          var target = g.pieces.get(occ);
          if (target && g.active != null && target.owner !== g.active) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, s * 0.30, 0, Math.PI * 2);
            ctx.lineWidth = 2;
            ctx.strokeStyle = 'rgba(248,113,113,0.85)';
            ctx.stroke();
          }
        }
      });
    }

    // 3.5 场上狙击兵的射线 + 指挥所光环
    g.pieces.forEach(function (p) {
      if (p.kind === 'sniper') self.drawSniperLine(p, 0.30);
      if (p.kind === 'command') self.drawAura(p);
    });

    // 4. 棋子
    g.pieces.forEach(function (p) { self.drawPiece(p, 1); });

    // 4.1 已选中待替换的棋子：外圈高亮
    if (ui.pendingReplace) {
      var pc = Hex.parse(ui.pendingReplace);
      var pp = this.cellCenter(pc.q, pc.r);
      this.hexPath(pp.x, pp.y, s * 0.95);
      ctx.save();
      ctx.setLineDash([7, 4]);
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = 'rgba(251,191,36,0.95)';
      ctx.stroke();
      ctx.restore();
    }

    // 4.5 狙击兵待定方向：画 6 个方向箭头 + 当前方向的射线
    if (ui.pending) this.drawPendingDirection(ui.pending);

    // 5. 放置预览
    if (hover && selected && ui.canAfford && legal.has(hover.key) && !g.over) {
      var hc = Hex.parse(hover.key);
      var hp = this.cellCenter(hc.q, hc.r);
      this.hexPath(hp.x, hp.y, s * 0.86);
      ctx.fillStyle = rgba(activeColor, 0.22);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = rgba(activeColor, 0.7);
      ctx.stroke();
      var fake = { owner: g.active, kind: selected, hp: ENGINE.TYPES[selected].hp, key: hover.key };
      this.drawGlyph(hp.x, hp.y, fake, 0.72);
    }

    // 6. 飘字
    var now = performance.now();
    if (ui.effects && ui.effects.length) {
      for (var i = ui.effects.length - 1; i >= 0; i--) {
        var e = ui.effects[i];
        var t = (now - e.born) / e.life;
        if (t >= 1) { ui.effects.splice(i, 1); continue; }
        var ep = this.cellCenter(e.q, e.r);
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - t * t);
        ctx.fillStyle = e.color || '#fff';
        ctx.font = '800 ' + (s * 0.58).toFixed(1) + 'px ' + FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.85)';
        ctx.shadowBlur = 6;
        ctx.fillText(e.text, ep.x, ep.y - s * (0.35 + (e.lift || 0)) - t * s * 1.1);
        ctx.restore();
      }
    }
  };

  // 狙击兵的直线射线
  Renderer.prototype.drawSniperLine = function (p, alpha) {
    var ctx = this.ctx;
    var s = this.hexSize;
    var col = this.game.players[p.owner].color;
    var cells = this.game.attackCells(p);
    if (!cells.size) return;
    var from = Hex.parse(p.key);
    var start = this.cellCenter(from.q, from.r);
    ctx.save();
    ctx.globalAlpha = alpha == null ? 0.35 : alpha;
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = rgba(col, 0.9);
    var self = this;
    cells.forEach(function (k) {
      var c = Hex.parse(k);
      var pos = self.cellCenter(c.q, c.r);
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
      self.hexPath(pos.x, pos.y, s * 0.55);
      ctx.fillStyle = rgba(col, 0.10);
      ctx.fill();
    });
    ctx.restore();
  };

  // 指挥所：给相邻己方棋子加一圈金边
  Renderer.prototype.drawAura = function (p) {
    var ctx = this.ctx;
    var s = this.hexSize;
    var c = Hex.parse(p.key);
    var pos = this.cellCenter(c.q, c.r);
    ctx.save();
    this.hexPath(pos.x, pos.y, s * 1.28);
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = 'rgba(251,191,36,0.55)';
    ctx.stroke();
    ctx.restore();
  };

  // 待选方向：把 6 个方向各画一个箭头，当前方向高亮并画出射线
  Renderer.prototype.drawPendingDirection = function (pending) {
    var ctx = this.ctx;
    var s = this.hexSize;
    var g = this.game;
    var from = Hex.parse(pending.cell);
    var pos = this.cellCenter(from.q, from.r);
    var col = g.players[pending.owner == null ? g.active : pending.owner].color;
    var self = this;

    for (var d = 0; d < 6; d++) {
      var dir = Hex.DIRS[d];
      var ax = pos.x + dir.q * s * 0.62 + dir.r * 0;
      var ay = pos.y + Math.sqrt(3) * s * 0.62 * (dir.r + dir.q / 2);
      var active = (pending.dir === d);

      // 射线预览
      if (active) {
        var len = pending.len || 3;
        for (var step = 1; step <= len; step++) {
          var k = Hex.key(from.q + dir.q * step, from.r + dir.r * step);
          if (!g.board.cells.has(k)) break;
          var c2 = Hex.parse(k);
          var p2 = self.cellCenter(c2.q, c2.r);
          self.hexPath(p2.x, p2.y, s * 0.8);
          ctx.fillStyle = rgba(col, 0.16);
          ctx.fill();
          ctx.save();
          ctx.setLineDash([4, 3]);
          ctx.lineWidth = 1.6;
          ctx.strokeStyle = rgba(col, 0.8);
          ctx.stroke();
          ctx.restore();
        }
      }

      // 方向箭头
      ctx.save();
      ctx.globalAlpha = active ? 1 : 0.62;
      ctx.translate(ax, ay);
      var ang = Math.atan2(ay - pos.y, ax - pos.x);
      ctx.rotate(ang);
      // 箭头底座，提升可读性
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.20, 0, Math.PI * 2);
      ctx.fillStyle = active ? 'rgba(8,14,24,0.72)' : 'rgba(8,14,24,0.45)';
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(s * 0.24, 0);
      ctx.lineTo(-s * 0.10, -s * 0.17);
      ctx.lineTo(-s * 0.10, s * 0.17);
      ctx.closePath();
      ctx.fillStyle = active ? col : 'rgba(205,220,240,0.9)';
      ctx.fill();
      if (active) {
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = 'rgba(255,255,255,0.75)';
        ctx.stroke();
      }
      ctx.restore();
    }

    // 落点上的半透明棋子预览
    if (pending.type) {
      var ghost = { owner: pending.owner == null ? g.active : pending.owner, kind: pending.type };
      this.drawGlyph(pos.x, pos.y, ghost, 0.5);
    }
  };

  Renderer.prototype.drawRange = function (p) {
    var ctx = this.ctx;
    var s = this.hexSize;
    var col = this.game.players[p.owner].color;
    var self = this;
    var cells = this.game.attackCells(p);
    cells.forEach(function (k) {
      var c = Hex.parse(k);
      var pos = self.cellCenter(c.q, c.r);
      self.hexPath(pos.x, pos.y, s * 0.9);
      ctx.fillStyle = rgba(col, 0.05);
      ctx.fill();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = rgba(col, 0.36);
      ctx.stroke();
    });
  };

  Renderer.prototype.drawGlyph = function (x, y, p, alpha) {
    var ctx = this.ctx;
    var s = this.hexSize;
    var col = this.game.players[p.owner].color;
    var t = (this.game.types && this.game.types[p.kind]) || ENGINE.TYPES[p.kind];
    if (!t) return;
    ctx.save();
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.font = '800 ' + (s * 0.66).toFixed(1) + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = col;
    ctx.fillText(t.glyph, x, y - s * 0.06);
    ctx.restore();
  };

  Renderer.prototype.drawPiece = function (p, alpha) {
    var ctx = this.ctx;
    var s = this.hexSize;
    var c = Hex.parse(p.key);
    var pos = this.cellCenter(c.q, c.r);
    var col = this.game.players[p.owner].color;
    var isBase = p.kind === 'base';

    ctx.save();
    ctx.globalAlpha = alpha == null ? 1 : alpha;

    if (isBase) {
      var grad = ctx.createRadialGradient(pos.x, pos.y, s * 0.08, pos.x, pos.y, s * 1.05);
      grad.addColorStop(0, rgba(col, 0.62));
      grad.addColorStop(1, rgba(col, 0.06));
      this.hexPath(pos.x, pos.y, s * 0.93);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = rgba(col, 0.95);
      ctx.stroke();
      this.hexPath(pos.x, pos.y, s * 0.70);
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(col, 0.38);
      ctx.stroke();
    } else {
      this.hexPath(pos.x, pos.y, s * 0.86);
      ctx.fillStyle = rgba(col, 0.20);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = rgba(col, 0.95);
      ctx.stroke();
    }

    this.drawGlyph(pos.x, pos.y, p, 1);

    // 血量角标
    var bx = pos.x;
    var by = pos.y + s * (isBase ? 0.42 : 0.47);
    var br = s * (isBase ? 0.30 : 0.26);
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(9,14,24,0.92)';
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = rgba(col, 0.85);
    ctx.stroke();
    ctx.fillStyle = '#f2f8ff';
    ctx.font = '700 ' + (s * 0.30).toFixed(1) + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(p.hp), bx, by + s * 0.012);

    ctx.restore();
  };

  return Renderer;
})();
