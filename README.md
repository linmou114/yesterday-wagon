# 昨日圆车 · Hex Wagon

六边形双人回合战棋。三种玩法：**本地双人**（同一台设备）、**单人**（内置 AI）、**联机**（建房实时对下）。
纯前端 + 一个可选的 Node 服务端；规则只写一份（`js/engine.js`），浏览器和服务器共用。

---

## 1. 马上开始玩

### 玩法 A / B：本地双人、单人打 AI（不需要服务器）

**最简单**：双击 `index.html`，打开开始菜单选模式即可。

**更稳妥**（手机也能测）：在项目目录起一个静态服务器

```bash
python -m http.server 8000
# 或 npx serve .
```

然后浏览器打开 <http://localhost:8000>。

### 玩法 C：联机（需要服务端）

```bash
npm install          # 装唯一的依赖 ws
npm start            # = node server/server.js，默认 http://localhost:3000
```

同一局域网里，两台设备打开 `http://你的电脑IP:3000`，一个人「创建房间」拿到 4 位房号，
另一个人「加入」输入房号，两人都在线就自动开局。

> 想先在自己电脑上试：开两个浏览器窗口（一个普通、一个隐身），各开一次页面，一个建房一个加入。

---

## 2. 目录结构

```
昨日圆车/
├─ index.html          开始菜单页（模式选择 / 设置 / 规则）
├─ game.html           对局页（棋盘 + 双方面板 + 操作区）
├─ css/style.css       全部样式（深色主题 + 响应式）
├─ js/hex.js           六边形网格数学（浏览器/Node 双用）
├─ js/engine.js        规则引擎（浏览器/Node 双用，唯一真相来源）
├─ js/ai.js            内置 AI（评估函数 + 一步前瞻）
├─ js/tutorial.js      新手教学关卡（7 关，纯数据+判定，可在 Node 测）
├─ js/net.js           联机客户端（WebSocket、自动重连、心跳保活）
├─ js/settings.js      设置数据模型（两个页面共用）
├─ js/rules.js         规则文案（两个页面共用）
├─ js/menu.js          菜单页交互（设置表单、地图预览、跳转）
├─ js/renderer.js      Canvas 绘制层
├─ js/main.js          对局页交互（四种模式的调度都在这里）
├─ server/server.js    联机服务端（静态托管 + WebSocket 房间）
├─ package.json        依赖与 start 脚本
├─ render.yaml         Render 一键部署配置
├─ tools/              自检与截图脚本（不参与线上运行）
└─ README.md
```

**分层的好处**：规则全在 `engine.js`，服务器 `require` 同一份文件，所以前后端不可能出现"客户端能下、服务端不认"的分歧。

---

## 2.5 两个页面

拆成两个独立页面，各有独立 URL，可以直接分享/收藏：

| 页面 | 地址 | 内容 |
| --- | --- | --- |
| 开始菜单 | `/`（`index.html`） | 四种模式入口、快速加入房号、设置、规则、服务器状态与房间数 |
| 对局 | `/game.html` | 棋盘、双方状态面板、战报、兵种商店、操作按钮 |

对局页靠 URL 参数启动：`game.html?mode=local|ai|online|tutorial`，联机还能带 `&code=1234` 直接进房。
从对局页点「主菜单」会**把当前棋局存进 sessionStorage**，回到菜单后按钮变成「继续当前对局」。

两个页面共用的部分单独抽了出来：`js/settings.js`（设置数据）和 `js/rules.js`（规则文案），
避免同一份内容两边各写一遍。

---
## 3. 四种模式

| 模式 | 谁在跑规则 | 说明 |
| --- | --- | --- |
| 本地双人 | 浏览器 | 两人轮流用同一台设备，青方/赤方面板并排显示 |
| 单人 · 对战 AI | 浏览器 | 你执先手，AI 执后手；AI 每步约 0.3 秒，会算"这刀砍下去我亏不亏" |
| 新手教学 | 浏览器 | 7 个预设小关卡，每关只教一件事：放置 → 费用 → 坦克 → 结算 → 射程 → 断联 → 拆基地 |
| 联机 | **服务端** | 客户端只发动作，服务端裁定后广播状态；改数值、改胜负都做不到 |

### 联机协议（想改服务端时看这里）

客户端 → 服务端：`create` / `join` / `rejoin` / `act` / `ping` / `leave`
服务端 → 客户端：`room` / `state` / `peer` / `err` / `pong`

- `state` 里带整局的紧凑快照（地图只传障碍坐标，客户端按 seed 重建），外加一次性 `event`（place / resolve / end / resign）
- 掉线保留座位 10 分钟，客户端用 token 自动 `rejoin` 回到原位置
- 客户端每 45 秒发一次 `ping`：既保活连接，也防止 Render 免费实例 15 分钟休眠

---

## 4. 规则实现对照

| 规则 | 实现方式 |
| --- | --- |
| 回合与费用 | **赤方先手**（默认）；每回合 3 点费用、不累积；后手青方首回合 4 点 |
| 步兵 / 坦克 / 炮兵 | 1 费 3 血 1 攻 1 射程 / 2 费 4 血 1 攻 1 射程 / 2 费 3 血 1 攻 2 射程 |
| 只能在连通块边缘放置 | 从大本营出发做 BFS，只有紧邻该连通块的空格可放 |
| 结算：血量 ≤ 敌方攻击之和 → 死亡 | **小于等于**：3 血吃 3 点就死，吃 2 点没事 |
| 同时结算 | 先按结算前的局面算完全部伤害，再统一移除 |
| 移除断联棋子 | 死亡处理完后，双方各自移除与大本营失去连接的棋子 |
| 大本营 4 血 | 吃满 4 点攻击被摧毁，游戏结束 |
| 障碍随机且对称 | **中心对称**（旋转 180°）成对生成；大本营及其邻格永不生成障碍；生成后校验双方基地连通 |
| 结算次数 | 回合结束前**随时可点、不限次数**；局面没变时重复结算不会产生新结果 |

> 「伤害是一次性判定」：不累积掉血，吃 2 点完全没事，下一回合重新算。

---

## 5. 所有数值都在「设置」里改

开始菜单 → **设置**（改完立刻生效，会记住）：

| 设置项 | 范围 | 默认 |
| --- | --- | --- |
| 地图来源 | 随机地图 / 默认地图（8 张固定图） | 随机地图 |
| 地图边长（仅随机地图） | 3 ~ 8（19 ~ 169 格） | 5（61 格） |
| 障碍密度 | 无 / 低 / 中 / 高 | 中 |
| 每回合费用 | 1 ~ 9 | 3 |
| 先手方 | 青方 / 赤方 | 赤方 |
| **后手补偿** | 0 ~ 8 点 | 1（青方首回合 4 点） |
| 大本营血量 | 1 ~ 20 | 4 |
| 步兵 / 坦克 / 炮兵 · 血量/攻击/射程/费用 | 1~30 / 0~20 / 0~6 / 1~30 | 见上表 |

- 存在浏览器 `localStorage`（键名 `yesterday-bus.settings.v1`），下次打开自动恢复，「恢复默认」一键还原
- 联机时以**建房者**的设置开局，服务端会再校验一遍范围（防止手改请求）
- 代码里的默认值：`js/engine.js` 顶部 `DEFAULT_RULES` 与 `TYPES`

---

## 6. 部署到自己的服务器（阿里云 / 任意 Linux）

> 自己的服务器**不会休眠**、国内访问快，代价是每月花钱、绑域名要备案。
> 只用 **IP + 端口** 访问**不需要备案**。

### 一次性准备

1. 买一台轻量应用服务器（2 核 2G 起），镜像选 **Ubuntu 22.04 / 24.04**
2. 控制台「防火墙」放行 **TCP 3000**
3. 把 `yesterday-wagon-server.zip` 传到 `/root/`
4. 解压并部署：

```bash
cd /root
python3 -m zipfile -e yesterday-wagon-server.zip .
cd yesterday-wagon
bash deploy-server.sh
```

脚本自动完成：装 Node（npmmirror 国内源）→ 装依赖（淘宝源）→ 注册 systemd 服务（开机自启 + 崩溃重启）→ 放行防火墙 → 本地自检。

### 之后更新代码

```bash
# 上传新包覆盖 /root/yesterday-wagon-server.zip 后
cd /root/yesterday-wagon
bash update-server.sh
```

> ⚠️ **别用 `rm -rf` 删项目目录再解压**：压缩包里不含 `node_modules`，删掉后服务会起不来
> （`Cannot find module 'ws'`）。`update-server.sh` 就是为此写的——只覆盖代码，保留依赖。

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `systemctl status yesterday-wagon` | 看服务状态 |
| `journalctl -u yesterday-wagon -f` | 实时日志 |
| `systemctl restart yesterday-wagon` | 重启 |
| `curl -sS http://127.0.0.1:3000/health` | 本地健康检查 |
| `curl -sS http://127.0.0.1:3000/stats` | 当前房间数 |

### 换端口

```bash
PORT=8080 bash deploy-server.sh
```

（记得同步在控制台放行新端口）

---
## 7. 部署到 Render（免费托管）

> Render 是「把 Git 仓库变成一台常驻服务器」的托管平台：推代码 → 自动 `npm install && npm start` → 给你 `https://xxx.onrender.com`。

### 一键脚本（推荐）

项目根目录自带 `deploy.cmd`，双击即可。它会自动：

1. 检查 git，没装就用 winget 帮你装
2. 检查 GitHub CLI 登录状态（没登录就打开浏览器登录）
3. `git init` → 提交所有改动 → 在 GitHub 建仓库 → 推送
4. 最后把 Render 上要点的步骤打印出来

```bat
deploy.cmd                    :: 交互式一键部署
deploy.cmd -DryRun            :: 只体检 + 打印计划，不改任何东西（建议先跑这个）
deploy.cmd -RepoName myGame   :: 指定 GitHub 仓库名
deploy.cmd -Message "改了什么"  :: 自定义这次提交说明
deploy.cmd -SkipGitHub        :: 只本地提交，不推送
```

> 为什么用 `.cmd` 包装：有些电脑默认禁止运行 `.ps1`（执行策略），脚本用
> `-ExecutionPolicy Bypass` 绕过，双击就能跑。之后每次改完代码再双击一次，
> 它会自动提交并推送，Render 收到 push 就重新部署。

### 手动步骤（不想用脚本的话）

1. 把整个项目推到 GitHub（新建一个 Public 仓库）
2. 打开 <https://dashboard.render.com/register> 注册（用 GitHub 账号直接登录）
3. 控制台 **New → Blueprint** → 选中这个仓库（有 `render.yaml` 会自动配好）
   - 没有 Blueprint 入口就 **New → Web Service**，手填：
     - Runtime: **Node**
     - Build Command: `npm install`
     - Start Command: `node server/server.js`
     - Instance Type: **Free**
4. 等 3~5 分钟，拿到 `https://yesterday-wagon-xxxx.onrender.com`
5. 把这个网址发给朋友，两人打开 → 建房 / 加入房号

### 免费档的坑（官方文档口径）

| 项 | 情况 |
| --- | --- |
| 配置 | 0.1 CPU / 512 MB（够用，一个房间才几十 KB） |
| 休眠 | **15 分钟没有任何入站流量就休眠**，下次访问约 1 分钟冷启动 |
| 磁盘 | 临时文件系统，重启即清空（房间本来就放内存里，不需要磁盘） |
| 额度 | 每工作区每月 750 实例小时 ≈ 24.7 小时/天 |

对策：

- **心跳保活**：客户端每 45 秒发一次 ping，只要有人开着页面就不会休眠（代码已内置）
- **演示前热身**：演示前 2 分钟先自己打开一次页面，把实例叫醒
- **想完全不睡**：升级付费实例（约 $7/月起），或挂一个免费 uptime 监控定时访问 `/health`
- 免费实例约 24 小时/天就跑满 750 小时额度，所以**一个服务正好，别开第二个免费实例**

### 也可以只部署静态版

不用联机的话，`index.html + css + js` 直接丢给 Netlify Drop / GitHub Pages / Vercel 就行（见第 8 节）。
用本地文件（`file://`）打开时联机会提示「本地文件打开时不能联机」，本地双人和 AI 模式照常玩。

---

## 8. 只发布静态版（不用联机）

1. **Netlify Drop**：把文件夹拖到 <https://app.netlify.com/drop>，立刻得到网址
2. **GitHub Pages**：仓库 → Settings → Pages → Source: Deploy from a branch → `main` / `(root)`
3. **Vercel / Cloudflare Pages**：导入仓库，构建命令留空，输出目录填 `/`

上线前自查：

- [ ] 路径都是相对的（本项目已是：`css/style.css`、`js/hex.js`）
- [ ] 文件名大小写一致（Linux 服务器区分大小写）
- [ ] 入口是 `index.html`
- [ ] 手机打开一次，确认布局和点击正常

---

## 9. 自检与调试

```bash
node tools/selftest.js        # 规则自检（525 项）：对称性、伤害判定、断联、结算次数、自定义数值、胜负
node tools/aitest.js          # AI 自检（84 项）：落子合法、AI vs 随机胜率、速度
node tools/nettest.js         # 联机自检（30 项）：真起服务器，两客户端建房/落子/断线重连/整局同步
node tools/balance.js 4 5 6   # 平衡性模拟（贪心 AI 互打）
npm test                      # 上面三个测试一起跑
```

浏览器控制台调试入口：

```js
HexFront.app.game          // 当前对局（联机模式就是服务端最新快照）
HexFront.app.mode          // 'local' | 'ai' | 'online'
HexFront.app.mySeat        // 联机时自己的座位
HexFront.resolve()         // 触发一次结算（仅本地/AI 模式）
```

---

## 10. 关于平衡性（实测数据，仅供参考）

`node tools/balance.js 3 4 5 6`（贪心 AI 互打，每档 40 局）：

| 边长 | 分出胜负 | 平均回合 |
| --- | --- | --- |
| 3（19 格） | 39 / 40 | 约 9 回合 |
| 4（37 格） | 21 / 40 | 约 102 回合 |
| 5（61 格） | 15 / 40 | 约 130 回合 |
| 6（91 格） | 0 / 40 | 200 回合仍僵持 |

内置 AI 之间的对局（来自 `tools/aitest.js` 的统计）：边长 3 约 12 回合、边长 4 约 17 回合就能分胜负，
边长 5 会拖到 100 回合以上 —— **单人模式建议选边长 4**。

**这些数字只能当「能不能打完」的参考，不能当平衡依据**：换个边长胜负方向就会反转，说明贪心 AI 的波动远大于真人。

---

## 11. 版权

全部画面由 Canvas 代码绘制，没有使用任何外部图片、字体、音频资源，可直接用于课程展示。
