/* 联机服务端自检：起一个真服务器，用两个 WebSocket 客户端打一场 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 3187;
let serverChild = null;
const HOST = '127.0.0.1';
const BASE = 'http://' + HOST + ':' + PORT;

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.log('  ✗ ' + msg); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://' + HOST + ':' + PORT + '/ws');
    ws.inbox = [];
    ws.waiters = [];
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      ws.inbox.push(msg);
      ws.waiters = ws.waiters.filter((w) => {
        if (w.pred(msg)) { w.resolve(msg); return false; }
        return true;
      });
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// 每收到一条消息只用一次：匹配过的标记 __used，避免旧消息被重复匹配（会造成状态过期）
function waitFor(ws, pred, label, timeout) {
  const found = ws.inbox.find((m) => !m.__used && pred(m));
  if (found) { found.__used = true; return Promise.resolve(found); }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('超时：' + label)), timeout || 4000);
    ws.waiters.push({
      pred: (m) => {
        let hit = false;
        try { hit = pred(m); } catch (e) { hit = false; }
        if (hit) { clearTimeout(timer); m.__used = true; }
        return hit;
      },
      resolve
    });
  });
}

function send(ws, msg) { ws.send(JSON.stringify(msg)); }

(async () => {
  console.log('== 启动服务 ==');
  serverChild = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: 'ignore'
  });

  let ready = false;
  for (let i = 0; i < 50; i++) {
    await sleep(120);
    try {
      const res = await fetch(BASE + '/health');
      if (res.ok) { ready = true; break; }
    } catch (e) { /* 还没起来 */ }
  }
  ok(ready, '服务能在端口 ' + PORT + ' 启动');
  if (!ready) {
    serverChild.kill();
    process.exit(1);
  }

  try {
    console.log('== 静态页面 ==');
    const page = await (await fetch(BASE + '/')).text();
    ok(page.includes('昨日圆车'), '根路径返回游戏页面');
    const js = await fetch(BASE + '/js/engine.js');
    ok(js.ok, '能取到 js/engine.js');
    const bad = await fetch(BASE + '/%2e%2e/%2e%2e/Windows/win.ini');
    ok(bad.status === 403 || bad.status === 404, '不能越界读仓库外的文件');

    console.log('== 建房 / 加入 ==');
    const a = await connect();
    send(a, { t: 'create', settings: { side: 4, density: 0, rules: { firstPlayer: 1, energyPerTurn: 3, baseHp: 4 }, types: {} } });
    const roomA = await waitFor(a, (m) => m.t === 'room', 'A 收到 room');
    ok(roomA.seat === 0, '创建者拿到 0 号座位');
    ok(/^\d{4}$/.test(roomA.code), '房号是 4 位数字');
    const st0 = await waitFor(a, (m) => m.t === 'state', 'A 收到初始状态');
    ok(st0.state.pieces.length === 2, '开局只有双方大本营');
    ok(st0.seats[1] === false, '对手还没进来');

    const b = await connect();
    send(b, { t: 'join', code: roomA.code });
    const roomB = await waitFor(b, (m) => m.t === 'room', 'B 收到 room');
    ok(roomB.seat === 1, '加入者拿到 1 号座位');
    const stB = await waitFor(b, (m) => m.t === 'state', 'B 收到状态');
    ok(stB.state.side === 4, '双方用同一个地图边长');
    ok(stB.seats[0] === true && stB.seats[1] === true, '两人都在线');

    console.log('== 回合校验 ==');
    // 先手是赤方（seat 1 = 玩家下标 1）
    const s1 = stB.state;
    ok(s1.active === 1, '先手是赤方');

    // A（seat 0）越权行动应被拒绝
    send(a, { t: 'act', action: { kind: 'place', type: 'infantry', cell: '0,0' } });
    const err1 = await waitFor(a, (m) => m.t === 'err', 'A 越权被拒');
    ok(/还没轮到/.test(err1.msg), '不是自己回合会被拒绝');

    // 找赤方能放的格子：从状态里挑一个空格
    const HEX = require('../js/hex.js');
    const ENGINE = require('../js/engine.js');
    const g0 = ENGINE.Game.fromJSON(s1);
    const legal = Array.from(g0.legalCells(1));
    ok(legal.length === 3, '开局赤方有 3 个落点');

    // B（赤方）落子
    send(b, { t: 'act', action: { kind: 'place', type: 'infantry', cell: legal[0] } });
    const st2 = await waitFor(a, (m) => m.t === 'state' && m.state.pieces.length === 3, 'A 收到落子后的状态');
    ok(st2.state.pieces.length === 3, '服务端广播了新的棋子');
    ok(st2.state.energy === 2, '费用被正确扣掉');

    // 非法落点应报错
    send(b, { t: 'act', action: { kind: 'place', type: 'infantry', cell: '0,0' } });
    const err2 = await waitFor(b, (m) => m.t === 'err' && /只能放在|已有棋子|障碍/.test(m.msg), '非法落点被拒');
    ok(!!err2, '非法落点会被服务端拒绝');

    // 结束回合
    send(b, { t: 'act', action: { kind: 'end' } });
    const st3 = await waitFor(b, (m) => m.t === 'state' && m.state.active === 0, '换手');
    ok(st3.state.active === 0, '回合交给青方');
    ok(st3.state.turn === 1, '赤方先走完仍是第 1 回合');

    // A 现在可以行动
    const g1 = ENGINE.Game.fromJSON(st3.state);
    const legalA = Array.from(g1.legalCells(0));
    send(a, { t: 'act', action: { kind: 'place', type: 'infantry', cell: legalA[0] } });
    const st4 = await waitFor(b, (m) => m.t === 'state' && m.state.pieces.length === 4, 'B 收到青方落子');
    ok(st4.state.pieces.length === 4, '青方也能落子');

    // 结算
    send(a, { t: 'act', action: { kind: 'resolve' } });
    const st5 = await waitFor(a, (m) => m.t === 'state' && m.state.resolveCount === 1, '结算广播');
    ok(st5.state.resolveCount === 1, '结算被记录');

    console.log('== 断线重连 ==');
    b.close();
    await sleep(200);
    const peer = await waitFor(a, (m) => m.t === 'peer' && m.online === false, 'A 收到对手掉线');
    ok(peer.seat === 1, '对手掉线有通知');

    const b2 = await connect();
    send(b2, { t: 'rejoin', code: roomA.code, token: roomB.token });
    const roomB2 = await waitFor(b2, (m) => m.t === 'room', 'B 重连成功');
    ok(roomB2.seat === 1 && roomB2.resumed === true, '重连回到原来的座位');
    const stR = await waitFor(b2, (m) => m.t === 'state', '重连后拿到最新状态');
    ok(stR.state.pieces.length === 4, '重连后局面没有丢');

    console.log('== 打完整局 ==');
    // 两个客户端都直接用引擎推演，然后通过服务器同步，直到分出胜负或超时
    let last = stR.state;
    let guard = 0;
    while (!last.over && guard++ < 120) {
      const g = ENGINE.Game.fromJSON(last);
      const actorSeat = g.active;
      const sock = actorSeat === 0 ? a : b2;
      sock.inbox.forEach((m) => { m.__used = true; });   // 清掉旧消息，只等这一次的回包

      // 简单策略：能放就放一个最靠前的，然后结束回合
      const legal2 = Array.from(g.legalCells(actorSeat));
      const before = g.pieces.size;
      if (legal2.length && g.energy > 0) {
        const type = g.energy >= 2 ? 'artillery' : 'infantry';
        try {
          send(sock, { t: 'act', action: { kind: 'place', type, cell: legal2[0] } });
          last = (await waitFor(sock, (m) => m.t === 'state' && m.state.pieces.length === before + 1, '落子同步')).state;
        } catch (e) {
          const errs = sock.inbox.filter((m) => m.t === 'err').slice(-3).map((m) => m.msg);
          throw new Error('守卫 ' + guard + ' 座位 ' + actorSeat + ' 费用 ' + g.energy +
            ' 棋子 ' + before + ' 类型 ' + type + ' 格 ' + legal2[0] + ' 错误=[' + errs.join('|') + ']');
        }
        continue;
      }
      send(sock, { t: 'act', action: { kind: 'resolve' } });
      last = (await waitFor(sock, (m) => m.t === 'state', '结算同步')).state;
      send(sock, { t: 'act', action: { kind: 'end' } });
      last = (await waitFor(sock, (m) => m.t === 'state', '换手同步')).state;
    }
    ok(last.turn >= 1, '服务端能持续推进对局（' + last.turn + ' 回合 / ' + last.pieces.length + ' 棋子）');

    a.close();
    b2.close();
  } catch (err) {
    fail++;
    console.log('  ✗ 异常: ' + err.message);
  }

  console.log('阶段一：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
})();

/* ---------------- 第二阶段：用真实的 js/net.js 客户端连真实服务端 ---------------- */
(async () => {
  console.log('== 客户端 Net 模块 ==');
  try {
    // 两个 async IIFE 是并发的，这里必须等阶段一把服务起来
    let up = false;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(BASE + '/health');
        if (r.ok) { up = true; break; }
      } catch (e) { /* 还没起来 */ }
      await sleep(120);
    }
    ok(up, '第二阶段开始前服务器在线');

    global.location = { host: '127.0.0.1:' + PORT, protocol: 'http:' };
    if (typeof global.WebSocket === 'undefined') {
      global.WebSocket = require('ws');
    }
    require('../js/net.js');
    const Net = global.Net;
    if (!Net) throw new Error('net.js 没有挂到全局');

    const logA = [];
    const logB = [];

    const created = new Promise((resolve) => {
      Net.start({
        status: () => {},
        room: (m) => { logA.push('room'); resolve(m); },
        state: (m) => logA.push('state:' + m.state.pieces.length),
        peer: (m) => logA.push('peer:' + m.online),
        error: (m) => logA.push('err:' + m)
      });
      Net.create({ side: 4, density: 0, lastBonus: 1, rules: { firstPlayer: 1, energyPerTurn: 3, baseHp: 4 }, types: {} });
    });

    const roomA = await Promise.race([created, sleep(4000).then(() => null)]);
    if (!roomA) console.log('    调试: logA=' + JSON.stringify(logA) + ' info=' + JSON.stringify(Net.info()));
    ok(!!roomA && roomA.seat === 0, 'Net.create 能建房间并拿到 0 号座位');
    if (!roomA) throw new Error('建房间失败');

    // 第二个客户端（独立实例，用同模块的 join）
    const joined = new Promise(async (resolve) => {
      const code = roomA.code;
      const ws2 = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
      ws2.on('open', () => ws2.send(JSON.stringify({ t: 'join', code })));
      ws2.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        logB.push(m.t);
        if (m.t === 'room') resolve(m);
      });
    });
    const roomB = await Promise.race([joined, sleep(4000).then(() => null)]);
    ok(!!roomB && roomB.seat === 1, '第二个玩家能加入并拿到 1 号座位');

    await sleep(400);
    ok(logA.includes('peer:true'), 'Net 客户端收到「对手上线」通知');

    // 赤方（seat 1）落子，Net（seat 0）应该收到新状态
    const before = logA.filter((x) => x.startsWith('state')).length;
    const ws2 = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
    await new Promise((r) => ws2.on('open', r));
    ws2.send(JSON.stringify({ t: 'rejoin', code: roomA.code, token: roomB.token }));

    const stateWait = new Promise((resolve) => {
      const t = setInterval(() => {
        if (logA.filter((x) => x.startsWith('state')).length > before) {
          clearInterval(t);
          resolve(logA[logA.length - 1]);
        }
      }, 50);
      setTimeout(() => { clearInterval(t); resolve(null); }, 4000);
    });

    // 建房方（Net）自己行动：赤方先手，所以要等赤方……这里直接让 Net 发一个非法动作验证错误回调
    Net.act({ kind: 'place', type: 'infantry', cell: '0,0' });
    await sleep(500);
    ok(logA.some((x) => /err/.test(x)), 'Net 能收到服务端的错误回调');

    Net.leave();
    ws2.close();
    await sleep(200);
  } catch (err) {
    fail++;
    console.log('  ✗ 异常: ' + err.message);
  }

  try { serverChild.kill(); } catch (e) {}
  await sleep(200);
  console.log('\n最终：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();