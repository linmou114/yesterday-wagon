/* =========================================================
 * net.js —— 联机客户端（WebSocket）
 *
 *   服务端是权威：客户端只发动作、收状态，本地不推进局面。
 *   断线会自动用 token 回到原座位；连不上（比如纯静态部署）会优雅报错。
 * ========================================================= */
(function (root) {
  'use strict';

  var ws = null;
  var handlers = {};
  var info = { code: null, seat: -1, token: null, connected: false };
  var heartbeat = null;
  var retryTimer = null;
  var retry = 0;
  var manualClose = false;
  var pending = [];          // 连接还没建立好时先把请求排队

  function url() {
    var proto = (typeof location !== 'undefined' && location.protocol === 'https:') ? 'wss:' : 'ws:';
    var host = (typeof location !== 'undefined' && location.host) ? location.host : 'localhost:3000';
    return proto + '//' + host + '/ws';
  }

  function emit(name, arg) {
    if (handlers[name]) {
      try { handlers[name](arg); } catch (e) { console.error(e); }
    }
  }

  function sendRaw(obj) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  // 没连上就排队，连上后自动补发
  function sendOrQueue(obj) {
    if (ws && ws.readyState === 1) return sendRaw(obj);
    pending.push(obj);
    if (!ws || ws.readyState === 3) connect();
    return true;
  }

  function startHeartbeat() {
    stopHeartbeat();
    // 45 秒一次：既保活 WebSocket，也让 Render 免费实例不会因为 15 分钟没流量而休眠
    heartbeat = setInterval(function () { sendRaw({ t: 'ping' }); }, 45000);
  }
  function stopHeartbeat() {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  }

  function connect() {
    if (typeof WebSocket === 'undefined') {
      emit('status', { text: '这个浏览器不支持联机', ok: false });
      return false;
    }
    if (typeof location !== 'undefined' && location.protocol === 'file:') {
      emit('status', { text: '本地文件打开时不能联机：请先运行 node server/server.js', ok: false });
      return false;
    }
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return true;

    manualClose = false;
    emit('status', { text: '正在连接服务器…', ok: null });

    try {
      ws = new WebSocket(url());
    } catch (e) {
      emit('status', { text: '无法连接服务器', ok: false });
      return false;
    }

    ws.onopen = function () {
      info.connected = true;
      retry = 0;
      emit('open', info);
      emit('status', { text: '已连接', ok: true });
      startHeartbeat();
      while (pending.length) sendRaw(pending.shift());
      if (info.code && info.token) {
        sendRaw({ t: 'rejoin', code: info.code, token: info.token });
      }
    };

    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      switch (msg.t) {
        case 'room':
          info.code = msg.code;
          info.seat = msg.seat;
          info.token = msg.token;
          emit('room', msg);
          break;
        case 'state':
          emit('state', msg);
          break;
        case 'peer':
          emit('peer', msg);
          break;
        case 'err':
          emit('error', msg.msg || '服务端错误');
          break;
        case 'pong':
          break;
        default:
          break;
      }
    };

    ws.onclose = function () {
      info.connected = false;
      stopHeartbeat();
      ws = null;
      if (manualClose) return;
      emit('status', { text: '连接已断开，正在重连…', ok: false });
      scheduleRetry();
    };

    ws.onerror = function () {
      emit('status', { text: '连接服务器失败', ok: false });
    };

    return true;
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retry += 1;
    if (retry > 6) {
      emit('status', { text: '重连失败，请刷新页面', ok: false });
      return;
    }
    var wait = Math.min(1000 * Math.pow(1.6, retry), 8000);
    retryTimer = setTimeout(function () {
      retryTimer = null;
      if (!info.code) { emit('status', { text: '未连接', ok: false }); return; }
      connect();
    }, wait);
  }

  var Net = {
    start: function (h) {
      handlers = h || {};
      return connect();
    },
    create: function (settings) {
      return sendOrQueue({ t: 'create', settings: settings });
    },
    join: function (code) {
      var c = String(code || '').trim();
      if (!/^\d{4}$/.test(c)) {
        emit('error', '房号是 4 位数字');
        return false;
      }
      return sendOrQueue({ t: 'join', code: c });
    },
    act: function (action) {
      return sendRaw({ t: 'act', action: action });
    },
    leave: function () {
      if (info.connected) sendRaw({ t: 'leave' });
      manualClose = true;
      stopHeartbeat();
      if (ws) { try { ws.close(); } catch (e) {} }
      ws = null;
      info = { code: null, seat: -1, token: null, connected: false };
    },
    info: function () { return info; },
    isConnected: function () { return !!info.connected; }
  };

  root.Net = Net;
})(typeof globalThis !== 'undefined' ? globalThis : this);
