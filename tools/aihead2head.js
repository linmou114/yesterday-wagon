// tools/aihead2head.js —— 新旧 AI 对抗（报告 3.3 节数据的来源）
// 用法：node tools/aihead2head.js [局数]
const path = require('path');
const { execFileSync } = require('child_process');
const fs = require('fs');

const root = path.join(__dirname, '..');
const N = Number(process.argv[2] || 10);
// 对照版本：默认取「加入吃子估值之前」的那一版（可用第二个参数覆盖）
const REV = process.argv[3] || 'a1684d6';

let oldSrc = '';
try {
  oldSrc = execFileSync('C:\\Program Files\\Git\\cmd\\git.exe', ['show', REV + ':js/ai.js'], { cwd: root, encoding: 'utf8' });
} catch (e) {
  console.log('无法从 git 取到 ' + REV + ' 的 ai.js，跳过对照');
  process.exit(0);
}
const tmp = path.join(root, 'js', '_ai_prev.js');
fs.writeFileSync(tmp, oldSrc, 'utf8');

const E = require(path.join(root, 'js', 'engine.js'));
const NEW = require(path.join(root, 'js', 'ai.js'));
const OLD = require(tmp);

function play(seed, first, second) {
  const g = new E.Game({
    side: 5, density: 0.14, seed,
    rules: { baseHp: 4, energyPerTurn: 3, firstPlayer: 1, firstTurnEnergy: [3, 4], lastBonus: 1 }
  });
  for (let t = 0; t < 90 && !g.over; t++) {
    (g.active === 0 ? first : second).playTurn(g);
    if (!g.over) g.endTurn();
  }
  return g.over ? g.winner : -2;
}

let nw = 0, ow = 0, dr = 0, nn = 0;
for (let s = 0; s < N; s++) {
  const a = play(900 + s, NEW, OLD);
  const b = play(900 + s, OLD, NEW);
  if (a === -2) nn++; else if (a === -1) dr++; else if (a === 0) nw++; else ow++;
  if (b === -2) nn++; else if (b === -1) dr++; else if (b === 0) ow++; else nw++;
}
console.log(`新版 AI ${nw} 胜 / 旧版 ${ow} 胜 / 平 ${dr} / 未分 ${nn}（共 ${N * 2} 局，双方交换先手）`);
fs.unlinkSync(tmp);
