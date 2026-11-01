# =========================================================
# 昨日圆车 —— 一键部署脚本（Windows / PowerShell）
#
#   默认流程：检查环境 → 装 git（缺了就用 winget 装）→ 建立仓库
#            → 提交 → 在 GitHub 建仓库并推送 → 打印 Render 部署步骤
#
#   用法（推荐直接双击 deploy.cmd）：
#     .\deploy.cmd                 交互式一键部署
#     .\deploy.cmd -DryRun         只检查环境和打印计划，不改任何东西
#     .\deploy.cmd -RepoName myGame  指定 GitHub 仓库名
#     .\deploy.cmd -Message "改了AI"  自定义这次提交说明
#     .\deploy.cmd -SkipGitHub     只本地提交，不推送（离线用）
# =========================================================

param(
    [string]$RepoName = 'yesterday-wagon',
    [string]$Message = '',
    [switch]$DryRun,
    [switch]$SkipGitHub,
    [switch]$Yes
)

$ErrorActionPreference = 'Continue'
$script:Git = $null
$script:Gh = $null
$script:Failed = $false

function Write-Head($text) {
    Write-Host ''
    Write-Host ('=' * 62) -ForegroundColor DarkCyan
    Write-Host "  $text" -ForegroundColor Cyan
    Write-Host ('=' * 62) -ForegroundColor DarkCyan
}
function Write-Step($text) { Write-Host "`n[$text]" -ForegroundColor Yellow }
function Write-Ok($text)   { Write-Host "  OK  $text" -ForegroundColor Green }
function Write-Warn2($text){ Write-Host "  注意  $text" -ForegroundColor Yellow }
function Write-Err2($text) { Write-Host "  失败  $text" -ForegroundColor Red }
function Write-Info($text) { Write-Host "  $text" -ForegroundColor Gray }

function Ask-Yes($question) {
    if ($Yes) { return $true }
    $ans = Read-Host "$question [Y/n]"
    if ([string]::IsNullOrWhiteSpace($ans)) { return $true }
    return ($ans.Trim().ToLower().StartsWith('y'))
}

function Invoke-Cmd($exe, [string[]]$arguments, [switch]$AllowFail) {
    if ($DryRun) {
        Write-Info ("[模拟] " + (Split-Path $exe -Leaf) + " " + ($arguments -join ' '))
        return @{ Code = 0; Output = '' }
    }
    $output = & $exe @arguments 2>&1
    $code = $LASTEXITCODE
    if ($code -ne 0 -and -not $AllowFail) {
        Write-Err2 ((Split-Path $exe -Leaf) + " " + ($arguments -join ' ') + " -> 退出码 $code")
        if ($output) { $output | ForEach-Object { Write-Info ("    " + $_) } }
        $script:Failed = $true
    }
    return @{ Code = $code; Output = ($output -join "`n") }
}

# ---------------- 环境检查 ----------------

function Find-Git {
    $cmd = Get-Command git -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $paths = @(
        'C:\Program Files\Git\cmd\git.exe',
        'C:\Program Files (x86)\Git\cmd\git.exe',
        "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe",
        'C:\Program Files\Git\bin\git.exe'
    )
    foreach ($p in $paths) { if (Test-Path $p) { return $p } }
    return $null
}

function Ensure-Git {
    Write-Step '检查 git'
    $git = Find-Git
    if ($git) {
        Write-Ok "已安装：$git"
        $script:Git = $git
        return $true
    }
    Write-Warn2 '没找到 git，部署必须用它'
    if ($DryRun) {
        Write-Info '可以用 winget 自动安装：winget install --id Git.Git -e --source winget'
        Write-Info '[模拟] 会安装 git 并继续往下走'
        $script:Git = 'git'
        return $true
    }
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Info '可以用 winget 自动安装：winget install --id Git.Git -e --source winget'
        if (Ask-Yes '现在自动安装 git 吗？') {
            Invoke-Cmd $winget.Source @('install', '--id', 'Git.Git', '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements') | Out-Null
            $git = Find-Git
            if ($git) {
                Write-Ok "安装完成：$git"
                $script:Git = $git
                return $true
            }
            Write-Err2 '装完还是找不到 git，可能需要重新打开命令行窗口再跑一次'
            return $false
        }
    } else {
        Write-Info '请先安装 git：https://git-scm.com/download/win'
    }
    Write-Err2 '没有 git，无法继续'
    return $false
}

function Find-Gh {
    $cmd = Get-Command gh -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    if (Test-Path 'C:\Program Files\GitHub CLI\gh.exe') { return 'C:\Program Files\GitHub CLI\gh.exe' }
    return $null
}

function Ensure-GhLogin {
    Write-Step '检查 GitHub CLI'
    $gh = Find-Gh
    if (-not $gh) {
        Write-Warn2 '没装 GitHub CLI（gh），将改为手动建仓库'
        return $false
    }
    $script:Gh = $gh
    $status = & $gh auth status 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Ok '已登录 GitHub'
        return $true
    }
    Write-Warn2 'gh 还没登录'
    if ($DryRun) {
        Write-Info '[模拟] 跳过 gh auth login'
        return $false
    }
    if (Ask-Yes '现在登录 GitHub 吗？（会打开浏览器）') {
        & $gh auth login --web --git-protocol https
        if ($LASTEXITCODE -eq 0) {
            Write-Ok '登录成功'
            return $true
        }
        Write-Warn2 '登录没完成，将改为手动建仓库'
        return $false
    }
    return $false
}

function Ensure-Identity {
    Write-Step '检查提交身份（user.name / user.email）'
    $name = $null
    $mail = $null
    if (-not $DryRun) {
        $name = (& $script:Git config --global user.name 2>$null | Out-String).Trim()
        $mail = (& $script:Git config --global user.email 2>$null | Out-String).Trim()
    }
    if ($name -and $mail) {
        Write-Ok "$name <$mail>"
        return
    }
    # 试着用 gh 账号信息补上
    if ($script:Gh -and -not $DryRun) {
        $login = (& $script:Gh api user --jq '.login' 2>$null)
        if ($login) {
            $noreply = "$login@users.noreply.github.com"
            Invoke-Cmd $script:Git @('config', '--global', 'user.name', $login) | Out-Null
            Invoke-Cmd $script:Git @('config', '--global', 'user.email', $noreply) | Out-Null
            Write-Ok "已用 GitHub 账号补上：$login <$noreply>"
            return
        }
    }
    if ($DryRun) { Write-Info '[模拟] 会要求你填写名字和邮箱'; return }
    Write-Info 'git 需要知道你是谁，请填一次（只对本机生效）'
    $inputName = Read-Host '  你的名字 / 昵称'
    $inputMail = Read-Host '  你的邮箱（可随便填一个）'
    if ($inputName) { Invoke-Cmd $script:Git @('config', '--global', 'user.name', $inputName) | Out-Null }
    if ($inputMail) { Invoke-Cmd $script:Git @('config', '--global', 'user.email', $inputMail) | Out-Null }
}

# ---------------- 仓库与提交 ----------------

function Ensure-Repo {
    Write-Step '准备本地 git 仓库'
    if (Test-Path '.git') {
        Write-Ok '已经有 .git'
    } else {
        Invoke-Cmd $script:Git @('init') | Out-Null
        Invoke-Cmd $script:Git @('symbolic-ref', 'HEAD', 'refs/heads/main') | Out-Null
        Write-Ok '已初始化，分支 main'
    }
    # 确保分支叫 main
    $branch = $null
    if (-not $DryRun) { $branch = (& $script:Git branch --show-current 2>$null | Out-String).Trim() }
    if ($branch -and $branch -ne 'main') {
        Invoke-Cmd $script:Git @('branch', '-M', 'main') | Out-Null
        Write-Ok "分支已改名为 main（原来是 $branch）"
    }
    # 兜底：忽略 node_modules
    if (-not (Test-Path '.gitignore')) {
        Write-Warn2 '.gitignore 不存在，建议加一条 node_modules/'
    }
}

function Commit-All {
    Write-Step '提交改动'
    Invoke-Cmd $script:Git @('add', '-A') | Out-Null
    $status = ''
    if (-not $DryRun) { $status = (& $script:Git status --porcelain 2>$null | Out-String).Trim() }
    if (-not $status) {
        Write-Ok '没有新改动，跳过提交'
        return
    }
    $count = ($status -split "`n" | Where-Object { $_ }).Count
    if ([string]::IsNullOrWhiteSpace($Message)) {
        $Message = '更新：' + (Get-Date -Format 'yyyy-MM-dd HH:mm')
    }
    Write-Info "共 $count 个文件有改动"
    if ($DryRun) { Write-Info ("[模拟] git commit -m `"" + $Message + "`""); return }
    $r = Invoke-Cmd $script:Git @('commit', '-m', $Message) -AllowFail
    if ($r.Code -eq 0) { Write-Ok "已提交：$Message" }
    else {
        Write-Warn2 '提交失败，常见原因：没配 user.name / user.email，或没有可提交的改动'
        $script:Failed = $true
    }
}

function Ensure-Remote {
    Write-Step '推送到 GitHub'
    $remote = $null
    if (-not $DryRun) { $remote = (& $script:Git remote 2>$null | Out-String).Trim() }
    if ($remote -and ($remote -split "`n") -contains 'origin') {
        $url = ''
        if (-not $DryRun) { $url = (& $script:Git remote get-url origin 2>$null | Out-String).Trim() }
        Write-Info "已有远端 origin：$url"
        $r = Invoke-Cmd $script:Git @('push', '-u', 'origin', 'main') -AllowFail
        if ($r.Code -eq 0) { Write-Ok '已推送' }
        else { Write-Warn2 '推送失败：检查网络 / 是否登录 GitHub（gh auth login）'; $script:Failed = $true }
        return
    }

    if ($SkipGitHub) {
        Write-Warn2 '按参数要求跳过 GitHub 推送'
        return
    }

    if ($script:Gh) {
        Write-Info "用 gh 创建仓库 $RepoName 并推送"
        $r = Invoke-Cmd $script:Gh @('repo', 'create', $RepoName, '--public', '--source=.', '--remote=origin', '--push') -AllowFail
        if ($r.Code -eq 0) {
            Write-Ok "仓库地址：https://github.com/<你的账号>/$RepoName"
            return
        }
        Write-Warn2 'gh 建仓库失败（可能重名或网络问题），改为手动方式'
    }

    Write-Info '请在浏览器打开 https://github.com/new 新建一个 Public 仓库'
    Write-Info "仓库名建议：$RepoName （不要勾选 README / .gitignore）"
    if ($DryRun) {
        Write-Info '[模拟] 会要求粘贴仓库地址'
        return
    }
    $url = Read-Host '  建好后，把仓库地址粘贴到这里（形如 https://github.com/你的名字/yesterday-wagon）'
    if ([string]::IsNullOrWhiteSpace($url)) {
        Write-Warn2 '没填地址，先不推送。之后可以手动：git remote add origin <地址>; git push -u origin main'
        return
    }
    # 可能已经有 origin（比如 gh 建仓库到一半失败），有就改地址，没有才新增
    $existing = ''
    if (-not $DryRun) { $existing = (& $script:Git remote 2>$null | Out-String).Trim() }
    if ($existing -match 'origin') {
        Invoke-Cmd $script:Git @('remote', 'set-url', 'origin', $url.Trim()) | Out-Null
    } else {
        Invoke-Cmd $script:Git @('remote', 'add', 'origin', $url.Trim()) | Out-Null
    }
    $r = Invoke-Cmd $script:Git @('push', '-u', 'origin', 'main') -AllowFail
    if ($r.Code -eq 0) { Write-Ok '已推送' }
    else { Write-Warn2 '推送失败：检查仓库地址、网络，或登录状态'; $script:Failed = $true }
}

# ---------------- 收尾指引 ----------------

function Show-RenderGuide {
    Write-Head 'GitHub 好了，接下来在 Render 点几下（只有第一次要做）'
    Write-Host @'
  1) 打开 https://dashboard.render.com/register 用 GitHub 账号注册/登录
  2) 点右上 New  ->  Blueprint
  3) 选择刚才推上去的仓库（本项目自带 render.yaml，会自动配好）
        - 如果只让你选 Web Service，就手填：
            Runtime         : Node
            Build Command   : npm install
            Start Command   : node server/server.js
            Instance Type   : Free
  4) 点 Deploy，等 3~5 分钟
  5) 拿到形如 https://yesterday-wagon-xxxx.onrender.com 的网址，
     发给朋友，两人打开 -> 联机对战 -> 一个建房、一个输房号

  免费实例的两个提醒：
   - 15 分钟没人访问会休眠，下次打开要等约 1 分钟（演示前先自己开一次热身）
   - 客户端每 45 秒会自动 ping 一次，所以只要有人开着页面就不会睡
'@ | Write-Host

    Write-Host ''
    Write-Host '  本地先自测联机（可选）：' -ForegroundColor Yellow
    Write-Host '     npm install' -ForegroundColor Gray
    Write-Host '     npm start        # 打开 http://localhost:3000' -ForegroundColor Gray
    Write-Host '     # 再开一个隐身窗口，一个建房一个加入' -ForegroundColor Gray

    Write-Host ''
    Write-Host '  只想要静态版（不联机）：把文件夹拖到 https://app.netlify.com/drop 就行' -ForegroundColor Gray
}

# ---------------- 主流程 ----------------

Write-Head '昨日圆车 —— 一键部署到 Render'
Write-Info ("项目目录：" + (Get-Location).Path)
if ($DryRun) { Write-Warn2 '当前是【模拟模式】，不会真的改文件或推送' }

if (-not (Ensure-Git)) { Write-Head '中止'; exit 1 }
if (-not $SkipGitHub) {
    Ensure-GhLogin | Out-Null
}
Ensure-Identity
Ensure-Repo
Commit-All
Ensure-Remote

if ($script:Failed) {
    Write-Head '有步骤失败了，请往上翻红字'
    exit 1
}

Show-RenderGuide
Write-Head '完成'
Write-Host '  之后每次改完代码，再跑一次 deploy.cmd 就会自动提交并推送，Render 会重新部署。' -ForegroundColor Green
