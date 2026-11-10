/* =========================================================
 * server.js —— 昨日圆车 联机服务端
 *
 *   - 静态托管仓库根目录（index.html / css / js），所以整个项目只需要这一个进程
 *   - WebSocket 在 /ws，房间状态放在内存里，服务端说了算（客户端改不了数值）
 *   - 直接复用 js/engine.js，规则只有一份，不会前后端不一致
 *
 *   本地运行： node server/server.js      → http://localhost:3000
 *   Render：  start 命令 = node server/server.js，端口读 process.env.PORT
 * ========================================================= */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const ENGINE = require('../js/engine.js');
const ROGUE = require('../js/rogue.js');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.join(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

/* ---------------- 静态文件 ---------------- */

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    res.writeHead(400);
    return res.end('bad url');
  }

  if (pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('ok');
  }

  // 首页「当前有几个房间」用
  if (pathname === '/stats') {
    let playing = 0;
    let players = 0;
    let waiting = 0;
    rooms.forEach((room) => {
      const online = room.seats.filter((c) => c.online).length;
      if (online === 0) return;
      players += online;
      if (online >= 2) playing += 1;
      else waiting += 1;
    });
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    });
    return res.end(JSON.stringify({ rooms: playing, waiting, players }));
  }
  // ---- 自建兵种 API ----
  if (pathname === '/api/mods' && req.method === 'GET') {
    const list = Array.from(modStore.values())
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .map((m) => {
        const pub = Object.assign({}, m);
        delete pub.secret;          // 只有作者自己知道 secret
        delete pub.owner;           // 不上传者身份
        return pub;
      });
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    });
    return res.end(JSON.stringify({ mods: list }));
  }

  if (pathname === '/api/mods/quota' && req.method === 'GET') {
    const qs = new URL(req.url, 'http://localhost').searchParams;
    const owner = modOwner(req, { client: qs.get('client') || '' });
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    });
    return res.end(JSON.stringify({
      used: modCountBy(owner),
      limit: MOD_FREE_LIMIT
    }));
  }

  if (pathname === '/api/mods' && req.method === 'POST') {
    if (!modRateOk(req)) {
      res.writeHead(429, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '操作太频繁，请过一会儿再试' }));
    }
    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 8192) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) {
        res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: '内容太大' }));
      }
      let data = null;
      try { data = JSON.parse(body || '{}'); } catch (e) { data = null; }
      const clean = data && cleanMod(data.mod || data);
      if (!clean) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: '兵种数据不合法（至少要有名称）' }));
      }
      if (modStore.size >= MOD_MAX) {
        res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: '自建兵种数量已达上限 ' + MOD_MAX }));
      }
      const owner = modOwner(req, data);
      const keyOk = data && String(data.key || '').trim() === MOD_KEY;
      const used = modCountBy(owner);
      if (!keyOk && used >= MOD_FREE_LIMIT) {
        res.writeHead(429, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
          error: '免费额度已用完：不填秘钥最多只能上传 ' + MOD_FREE_LIMIT + ' 个棋子（已上传 ' + used + ' 个）',
          used,
          limit: MOD_FREE_LIMIT
        }));
      }

      const id = 'mod_' + crypto.randomBytes(5).toString('hex');
      const secret = crypto.randomBytes(12).toString('hex');
      const mod = Object.assign({
        id, secret, owner, at: Date.now(),
        author: String(data.author || '').slice(0, 16)
      }, clean);
      modStore.set(id, mod);
      saveMods();
      const pub = Object.assign({}, mod);
      delete pub.secret;
      delete pub.owner;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ mod: pub, secret }));
    });
    return;
  }

  if (pathname.indexOf('/api/mods/') === 0 && req.method === 'DELETE') {
    if (!modRateOk(req)) {
      res.writeHead(429, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '操作太频繁，请过一会儿再试' }));
    }
    const id = pathname.slice('/api/mods/'.length);
    const m = modStore.get(id);
    const secret = String(req.headers['x-mod-secret'] || '');
    if (!m || !secret || secret !== m.secret) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '没有权限删除这个兵种' }));
    }
    modStore.delete(id);
    saveMods();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (pathname === '/') pathname = '/index.html';

  const file = path.normalize(path.join(ROOT, pathname));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    return res.end('forbidden');
  }

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache'
    });
    res.end(buf);
  });
});

/* ---------------- 房间 ---------------- */

const rooms = new Map();          // code -> room
/* ---------------- 自建兵种（mod）存储 ---------------- */

const MOD_FILE = path.join(__dirname, '..', 'data', 'mods.json');
const MOD_MAX = 200;
const MOD_FREE_LIMIT = 4;          // 不填秘钥时每个用户最多上传几个
const MOD_KEY = 'mrfz';            // 填了这个秘钥就不限数量

const modStore = new Map();

function loadMods() {
  try {
    const raw = fs.readFileSync(MOD_FILE, 'utf8');
    const list = JSON.parse(raw);
    if (Array.isArray(list)) {
      list.forEach((m) => { if (m && m.id) modStore.set(m.id, m); });
    }
  } catch (e) { /* 文件不存在就当作空库 */ }
}

let modSaveTimer = null;
function saveMods() {
  if (modSaveTimer) return;
  modSaveTimer = setTimeout(() => {
    modSaveTimer = null;
    try {
      fs.mkdirSync(path.dirname(MOD_FILE), { recursive: true });
      fs.writeFileSync(MOD_FILE, JSON.stringify(Array.from(modStore.values()), null, 2));
    } catch (e) {
      console.error('保存自建兵种失败:', e.message);
    }
  }, 300);
}

// 请求方的身份：优先用客户端自己生成的 id，没有就退化成 IP
function modOwner(req, body) {
  const c = body && typeof body.client === 'string' ? body.client.trim() : '';
  if (c && /^[a-z0-9_-]{6,40}$/i.test(c)) return 'c:' + c;
  const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
  return 'i:' + ip;
}

function modCountBy(owner) {
  let n = 0;
  modStore.forEach((m) => { if (m && m.owner === owner) n += 1; });
  return n;
}

// 简单的按 IP 限流：10 分钟内最多写 20 次（上传 + 删除）
const MOD_RATE = new Map();          // ip -> [timestamp...]
const MOD_RATE_WINDOW = 10 * 60 * 1000;
const MOD_RATE_MAX = 20;

function modRateOk(req) {
  const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
  const now = Date.now();
  const arr = (MOD_RATE.get(ip) || []).filter((t) => now - t < MOD_RATE_WINDOW);
  if (arr.length >= MOD_RATE_MAX) {
    MOD_RATE.set(ip, arr);
    return false;
  }
  arr.push(now);
  MOD_RATE.set(ip, arr);
  if (MOD_RATE.size > 5000) MOD_RATE.clear();   // 防止无限增长
  return true;
}

function modNum(v, min, max, fallback) {
  const n = Number(v);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// 把客户端提交的定义洗成安全数据
function cleanMod(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim().slice(0, 10);
  if (!name) return null;
  const mode = raw.rangeMode === 'line' ? 'line' : (raw.rangeMode === 'none' ? 'none' : 'circle');
  const out = {
    name,
    glyph: String(raw.glyph || name.charAt(0)).slice(0, 2),
    hp: modNum(raw.hp, 1, 30, 3),
    atk: modNum(raw.atk, 0, 20, 1),
    range: modNum(raw.range, 0, 6, 1),
    cost: modNum(raw.cost, 0, 30, 2),
    rangeMode: mode,
    aura: null,
    desc: String(raw.desc || '').slice(0, 120)
  };
  if (raw.aura === true) {
    out.aura = { radius: 1, effect: 'atk', amount: 1 };
  } else if (raw.aura && typeof raw.aura === 'object') {
    const effs = ['atk', 'hp', 'enemyAtk', 'enemyHp'];
    out.aura = {
      radius: modNum(raw.aura.radius, 1, 3, 1),
      effect: effs.indexOf(raw.aura.effect) >= 0 ? raw.aura.effect : 'atk',
      amount: modNum(raw.aura.amount, 1, 5, 1)
    };
  }
  if (out.rangeMode === 'none') out.range = 0;
  if (out.atk <= 0) out.range = 0;
  return out;
}

loadMods();
const ROOM_TTL = 3 * 60 * 60 * 1000;   // 3 小时没动静就清理
const EMPTY_TTL = 10 * 60 * 1000;      // 对局没打完、所有人都离线：保留 10 分钟等重连
const OVER_TTL = 60 * 1000;            // 对局已结束、所有人都离线：1 分钟后删
const SEAT_TIMEOUT = 10 * 60 * 1000;   // 掉线后座位保留 10 分钟

function newCode() {
  for (let i = 0; i < 200; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  return String(Date.now()).slice(-4);
}

function newToken() {
  return crypto.randomBytes(12).toString('hex');
}

function sanitizeSettings(raw) {
  const s = raw || {};
  const rules = {
    baseHp: clamp(s.rules && s.rules.baseHp, 1, 20, 4),
    energyPerTurn: clamp(s.rules && s.rules.energyPerTurn, 1, 9, 3),
    firstPlayer: (s.rules && Number(s.rules.firstPlayer) === 0) ? 0 : 1,
    firstTurnEnergy: [3, 3]
  };
  const bonus = clamp(s.lastBonus, 0, 8, 1);
  rules.firstTurnEnergy = [rules.energyPerTurn, rules.energyPerTurn];
  rules.firstTurnEnergy[1 - rules.firstPlayer] = rules.energyPerTurn + bonus;

  const types = {};
  (ENGINE.ALL_TYPE_LIST || ENGINE.TYPE_LIST).forEach((id) => {
    const t = (s.types && s.types[id]) || {};
    const def = ENGINE.TYPES[id];
    types[id] = {
      hp: clamp(t.hp, 1, 30, def.hp),
      atk: clamp(t.atk, 0, 20, def.atk),
      range: clamp(t.range, 0, 6, def.range),
      cost: clamp(t.cost, 0, 30, def.cost)
    };
  });

  // 自建兵种只认服务器上已发布的 id
  const modIds = [];
  if (Array.isArray(s.modIds)) {
    s.modIds.slice(0, 8).forEach((raw) => {
      const id = String(raw || '');
      if (!/^mod_[a-z0-9]{4,16}$/.test(id)) return;
      if (modIds.indexOf(id) >= 0) return;
      const m = modStore.get(id);
      if (!m) return;
      modIds.push(id);
      types[id] = {
        name: m.name, glyph: m.glyph, hp: m.hp, atk: m.atk,
        range: m.range, cost: m.cost, rangeMode: m.rangeMode,
        aura: m.aura, desc: m.desc
      };
    });
  }

  const seed = Number(s.seed);
  return {
    side: clamp(s.side, 3, 8, 5),
    density: clampFrac(s.density, 0, 0.4, 0.14),
    seed: isFinite(seed) && seed > 0 ? (seed >>> 0) : null,
    rules,
    types,
    modIds,
    rogue: !!s.rogue
  };
}

function clamp(v, min, max, fallback) {
  const n = Number(v);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// 小数用的夹取：density 是 0~0.4 的比例，用 clamp 会被 Math.round 抹成 0（整张图空掉）
function clampFrac(v, min, max, fallback) {
  const n = Number(v);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n * 1000) / 1000));
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  const text = JSON.stringify(msg);
  room.seats.forEach((c) => {
    if (c.ws && c.ws.readyState === 1) c.ws.send(text);
  });
}

function pushState(room, extra) {
  // 肉鸽模式：发状态前先把「这一回合的三选一」发好，双方看到的是同一组牌
  const g = room.game;
  if (g.rogue && !g.over) {
    try { ROGUE.ensureOffer(g, g.active); } catch (e) {}
  }
  const msg = {
    t: 'state',
    state: room.game.toJSON(),
    seats: room.seats.map((c) => !!c.online)
  };
  if (extra) msg.event = extra;
  broadcast(room, msg);
}

// 结算结果要发给前端做飘字/战报，Map 转成普通对象
function damageToObj(map) {
  const out = {};
  if (map) map.forEach((v, k) => { out[k] = v; });
  return out;
}

function roomOf(ws) {
  return ws.meta && ws.meta.code ? rooms.get(ws.meta.code) : null;
}

/* ---------------- WebSocket ---------------- */

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.meta = { code: null, seat: -1 };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }
    try {
      handle(ws, msg);
    } catch (err) {
      send(ws, { t: 'err', msg: String(err && err.message || err) });
    }
  });

  ws.on('close', () => {
    const room = roomOf(ws);
    if (!room) return;
    const seat = room.seats[ws.meta.seat];
    if (seat && seat.ws === ws) {
      seat.ws = null;
      seat.online = false;
      seat.leftAt = Date.now();
      broadcast(room, { t: 'peer', seat: ws.meta.seat, online: false });
    }
  });
});

function handle(ws, msg) {
  switch (msg.t) {
    case 'ping':
      return send(ws, { t: 'pong', now: Date.now() });
    case 'create':
      return doCreate(ws, msg);
    case 'join':
      return doJoin(ws, msg);
    case 'rejoin':
      return doRejoin(ws, msg);
    case 'act':
      return doAct(ws, msg);
    case 'leave':
      return doLeave(ws);
    default:
      return send(ws, { t: 'err', msg: '未知指令' });
  }
}

function doCreate(ws, msg) {
  if (ws.meta.code) doLeave(ws);
  const s = sanitizeSettings(msg.settings);
  const code = newCode();
  const game = new ENGINE.Game({
    side: s.side,
    density: s.density,
    rules: s.rules,
    types: s.types,
    seed: s.seed || Math.floor(Math.random() * 1e9),
    rogue: s.rogue
  });

  const token = newToken();
  const room = {
    code,
    game,
    drawOffer: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    seats: [
      { token, ws, online: true, leftAt: 0 },
      { token: null, ws: null, online: false, leftAt: 0 }
    ]
  };
  rooms.set(code, room);
  ws.meta = { code, seat: 0 };
  send(ws, { t: 'room', code, seat: 0, token });
  pushState(room);
}

function doJoin(ws, msg) {
  const code = String(msg.code || '').trim();
  const room = rooms.get(code);
  if (!room) return send(ws, { t: 'err', msg: '房间不存在或已失效' });
  if (ws.meta.code) doLeave(ws);

  // 找一个空位（掉线超过保留时间的座位可以让出来）
  let seat = -1;
  for (let i = 0; i < 2; i++) {
    const s = room.seats[i];
    const reconnectable = !s.online && s.token && (Date.now() - s.leftAt < SEAT_TIMEOUT);
    if (!s.token || (!reconnectable && !s.online)) { seat = i; break; }
    if (reconnectable) continue;
  }
  if (seat < 0) return send(ws, { t: 'err', msg: '房间已满（两个座位都在线）' });

  const token = newToken();
  room.seats[seat] = { token, ws, online: true, leftAt: 0 };
  room.updatedAt = Date.now();
  ws.meta = { code, seat };

  send(ws, { t: 'room', code, seat, token });
  broadcast(room, { t: 'peer', seat, online: true });
  pushState(room);
}

function doRejoin(ws, msg) {
  const code = String(msg.code || '').trim();
  const token = String(msg.token || '');
  const room = rooms.get(code);
  if (!room) return send(ws, { t: 'err', msg: '房间已失效' });

  for (let i = 0; i < 2; i++) {
    const s = room.seats[i];
    if (s.token === token) {
      if (s.ws && s.ws !== ws && s.ws.readyState === 1) {
        // 旧连接还在，顶掉它
        try { s.ws.close(); } catch (e) {}
      }
      s.ws = ws;
      s.online = true;
      s.leftAt = 0;
      ws.meta = { code, seat: i };
      room.updatedAt = Date.now();
      send(ws, { t: 'room', code, seat: i, token, resumed: true });
      broadcast(room, { t: 'peer', seat: i, online: true });
      pushState(room);
      return;
    }
  }
  send(ws, { t: 'err', msg: '座位已过期，请重新加入' });
}

function doAct(ws, msg) {
  const room = roomOf(ws);
  if (!room) return send(ws, { t: 'err', msg: '不在房间里' });
  const seat = ws.meta.seat;
  const g = room.game;
  const action = msg.action || {};

  if (g.over) return send(ws, { t: 'err', msg: '对局已结束' });

  // 求和应答：任何时候都能答，不受回合限制
  if (action.kind === 'drawAnswer') {
    if (!room.drawOffer) return send(ws, { t: 'err', msg: '没有待处理的求和' });
    if (room.drawOffer.from === seat) return send(ws, { t: 'err', msg: '不能答应自己的求和' });
    const from = room.drawOffer.from;
    if (action.accept) {
      g.over = true;
      g.winner = -1;
    }
    room.drawOffer = null;
    room.updatedAt = Date.now();
    return pushState(room, { kind: 'drawResult', accepted: !!action.accept, from: from });
  }

  if (g.active !== seat) return send(ws, { t: 'err', msg: '还没轮到你' });

  // 发起求和：只能在自己回合发
  if (action.kind === 'draw') {
    if (room.drawOffer) return send(ws, { t: 'err', msg: '已经有一个求和在进行中' });
    room.drawOffer = { from: seat, at: Date.now() };
    room.updatedAt = Date.now();
    return pushState(room, { kind: 'drawOffer', from: seat });
  }

  let event = null;

  if (action.kind === 'place') {
    if (!g.types[action.type]) return send(ws, { t: 'err', msg: '未知兵种' });
    const opts = {};
    if (action.dir != null) opts.dir = Number(action.dir);
    try {
      g.place(g.active, action.type, String(action.cell), opts);
    } catch (e) {
      return send(ws, { t: 'err', msg: e.message || '无法放置' });
    }
    event = {
      kind: 'place', owner: seat, type: action.type,
      cell: String(action.cell), dir: (opts.dir == null ? null : opts.dir)
    };
  } else if (action.kind === 'slave') {
    try {
      g.placeSlave(g.active, String(action.cell));
    } catch (e) {
      return send(ws, { t: 'err', msg: e.message || '无法召唤奴隶' });
    }
    event = { kind: 'slave', owner: seat, cell: String(action.cell) };
  } else if (action.kind === 'resolve') {
    const result = g.resolve();
    event = {
      kind: 'resolve',
      active: seat,
      resolveCount: result ? result.resolveCount : 0,
      removed: (result ? result.removed : []).map((r) => ({
        owner: r.piece.owner,
        kind: r.piece.kind,
        key: r.piece.key,
        hp: r.piece.hp,
        reason: r.reason,
        damage: r.damage
      })),
      damage: damageToObj(result ? result.damage : null),
      over: g.over,
      winner: g.winner
    };
  } else if (action.kind === 'end') {
    g.endTurn();
    event = { kind: 'end', active: seat, next: g.active, turn: g.turn };
  } else if (action.kind === 'resign') {
    g.over = true;
    g.winner = 1 - seat;
    event = { kind: 'resign', active: seat, winner: g.winner };
  } else if (action.kind === 'perk') {
    if (!g.rogue) return send(ws, { t: 'err', msg: '不是肉鸽模式' });
    const res = ROGUE.pick(g, seat, String(action.id || ''), action.args || {});
    if (!res.ok) return send(ws, { t: 'err', msg: res.msg || '这张卡用不了' });
    event = { kind: 'perk', owner: seat, id: res.card.id, name: res.card.name };
  } else if (action.kind === 'perkSkip') {
    if (!g.rogue) return send(ws, { t: 'err', msg: '不是肉鸽模式' });
    ROGUE.skip(g, seat);
    event = { kind: 'perkSkip', owner: seat };
  } else if (action.kind === 'promote') {
    if (!g.rogue) return send(ws, { t: 'err', msg: '不是肉鸽模式' });
    const res = ROGUE.promote(g, seat, String(action.cell || ''), String(action.to || ''));
    if (!res.ok) return send(ws, { t: 'err', msg: res.msg || '无法晋升' });
    event = { kind: 'promote', owner: seat, cell: String(action.cell || ''), to: String(action.to || '') };
  } else {
    return send(ws, { t: 'err', msg: '未知操作' });
  }

  room.updatedAt = Date.now();
  pushState(room, event);
}

function doLeave(ws) {
  const room = roomOf(ws);
  if (!room) return;
  const seat = room.seats[ws.meta.seat];
  if (seat && seat.ws === ws) {
    seat.ws = null;
    seat.online = false;
    seat.leftAt = Date.now();
    broadcast(room, { t: 'peer', seat: ws.meta.seat, online: false });
  }
  ws.meta = { code: null, seat: -1 };

  // 对局已经结束、又没人留在房间里 → 立刻回收房间号
  const anyoneOnline = room.seats.some((s) => s.online);
  if (!anyoneOnline && room.game.over) {
    rooms.delete(room.code);
    return;
  }
  room.updatedAt = Date.now();
}

/* ---------------- 保活 / 清理 ---------------- */

// WebSocket 心跳：防止中间层把长连接掐掉
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 25000);

// 清理空房间：没人了就开始倒计时
const sweeper = setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, code) => {
    if (room.seats.some((s) => s.online)) return;       // 还有人挂着，不动
    const idle = now - room.updatedAt;
    const ttl = room.game.over ? OVER_TTL : EMPTY_TTL;
    if (idle > ttl || idle > ROOM_TTL) rooms.delete(code);
  });
}, 30 * 1000);

function shutdown() {
  clearInterval(heartbeat);
  clearInterval(sweeper);
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => {
  console.log('昨日圆车 服务已启动: http://localhost:' + PORT);
});
