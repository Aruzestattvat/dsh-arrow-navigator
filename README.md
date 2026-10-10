# dsh-arrow-navigator

DSH Web 客户端的方向键导航插件：**← / → 快速切换对话**，**↑ / ↓ 在当前会话的上下"对话段"之间跳转**。

> **English** — Arrow-key navigation for the DSH Web client: `←`/`→` switch conversations in the order the sidebar
> actually shows them, `↑`/`↓` jump between turns of the current conversation. A fixed-key plugin built on the
> official `shortcuts` registry, with no build step (the browser bundle ships prebuilt as `lib/client.js`).
>
> ```bash
> dsh plugin --profile <your-profile> add github:Aruzestattvat/dsh-arrow-navigator
> # or, from the DSH UI: Plugins → install → github:Aruzestattvat/dsh-arrow-navigator
> ```
>
> Refresh the page after installing. Full notes are in Chinese below.

```
项目 A
  会话 1                       ← 按一次 ← 上一个对话
  会话 2                       → 按一次 → 下一个对话
项目 B
  会话 3
  会话 4
  ...
```

（示例是虚构的：插件只关心顺序，不关心名字。）

| 按键 | 行为 |
|---|---|
| `←` | 切到**上一个对话**（顺序 = 左侧栏里看得见的行顺序；跨越被折叠/隐藏的会话时**自动展开**，走过去之后再**自动折叠**回去） |
| `→` | 切到**下一个对话**（同上） |
| `↑` | 跳到当前会话内的**上一段对话**（上一个 turn：一条用户提问 + 对应回复视为一段） |
| `↓` | 跳到**下一段对话**；已经在最后一段时滚到会话底部 |
| **按住** `←`/`→` | **长按快速切换**：一路连续切过去（按下 0.22 秒后开始，每 0.09 秒切一个；到列表尽头自动停） |
| 按住 `↑`/`↓` | **不接管**：仍是浏览器原生滚动画面。想让长按连续跳段落，把 `holdTurns` 设成 `true` |

每次跳转顶部会浮出一行小提示（`6/28 · 对话标题` 或 `第 3 段`），约 1.4 秒后自动消失；
`←`/`→` 还会把目标行滚进侧边栏可视区。

> 长按的节奏由插件自己的定时器控制（不依赖系统键盘重复速度），松手、窗口失焦、到列表尽头都会立刻收尾。
> **被插件接管的重复事件会同时阻止默认行为**——否则浏览器会一边自己滚画面、一边被插件跳段落，两个动画抢同一帧
> （这就是"长按上下又滚又跳"的原因）。「按住只在侧边栏移动高亮、松手才切换」的预览式手感用 `holdPreview: true`。
>
> **长按是一个手势，只在按下那一刻判定一次。** 后续步进不再重跑焦点守卫：切会话本身会把焦点交给 composer 编辑器，
> 若把这种"由自己造成的焦点变化"再判成"会话区之外"，长按会在第一步就被自己掐死（实测表现为按住 `→` 能走、按住 `←` 走不动）。
> 同理，"属于会话区"的判定不只看 transcript 子树，而是**任何含有 transcript 的容器**（composer 与同列的其他部件都在其中）。

## 安装

### 从 GitHub 安装（其他用户）

```bash
# profile 名按你的安装而定：桌面版通常是 desktop，纯 Web 版是 web
dsh plugin --profile desktop add github:Aruzestattvat/dsh-arrow-navigator
```

也可以在 DSH 里用插件管理器安装同一个规格：

```
action: install_bundle
target: github:Aruzestattvat/dsh-arrow-navigator
```

安装器支持 `github:用户/仓库`、完整 git URL，以及本地绝对路径 / `link:` / tarball。
安装后 **刷新页面** 即可生效（已打开的页面也会通过 HMR 收到新插件）。
`设置 → 快捷键` 里能看到新增的两行只读按键：

- 「上一个对话 / 下一个对话」——本插件的 fixed 只读行（`←` / `→`）
- 「移动菜单选择 ↑ ↓」——DSH 自带的只读行，插件复用了同一组按键

### 从本地源码安装（开发时）

```powershell
dsh plugin --profile desktop add link:C:\path\to\dsh-arrow-navigator
```

`link:` 会把包软链进 profile 的 `node_modules`，并把它追加到 profile `package.json` 的 `dsh.profile.bundles`；
包内的 `cordis.patch.yml` 随即把插件条目插入配置树。改完 `lib/client.js` 刷新页面即可。

## 实现要点

这是标准的 DSH 双面插件：

| 文件 | 作用 |
|---|---|
| `lib/index.js` | Node 侧空实现（只为 Loader 有一行宿主条目） |
| `lib/client.js` | 浏览器侧 bundle（DSH 的 `window.__ModuleLoader__.load({ id, factory })` 预构建格式） |
| `cordis.patch.yml` | bundle patch：把插件插入 profile 配置树 |

浏览器侧做的事：

1. **对话顺序 = 你在侧边栏看到的顺序**：直接按渲染出来的会话行（`[data-row-key="session:*"]`）顺序走，
   所以分组顺序、置顶前置、搜索结果的顺序都被如实遵循；
   **"当前对话"同样取自屏幕上真正渲染的那个会话**（主会话区的 `[data-conversation-session]`），
   服务端保留状态（`retainedBy.mainView`）只在其后兜底——两者不一致时，保留状态会让我算出同一个"下一跳"、
   反复打开一个视图上已经显示的会话，于是按键看起来毫无反应。侧边栏收成图标栏或未渲染时，回退到服务投影
   （`ctx.workspaces.list` 的 `items[].sessionIds` + `ctx.sessions.list`，与侧边栏同一套可见性规则：
   跳过归档、子 Agent、非当前空白会话）。切对话调用官方 `ctx.uiWorkspace.openSession(sessionId)`。
   **每次打开都当场核验**（同步查 `ctx.sessions.retainInfo(id).retainedBy.mainView`，落后时最多再等 350ms）：
   没生效就记下来、跳过它继续走，并在同一次按键内完成——不会出现"提示说切了、画面却没动"。
2. **跨越隐藏区域：先展开、走过去、再折叠**。侧边栏有两级"藏起来"，都用它自己的控件驱动（模拟点击，不碰组件内部状态）：
   - `overflow:<分组 key>` —— 「展开其余 N 个会话」按钮（每按一次 +5 行，最后一批直接全展开；全部展开后同一个按钮变成「收起」）；
   - `workspace:<分组 key>` 且 `aria-expanded="false"` —— 折叠的分组头，点它展开这个分组。
   判定一步怎么走的关键是**看清"下一跳"是谁**：朝行进方向逐个 entry 看，先遇到的是会话行就跳过去；先遇到的是展开控件，
   说明中间还藏着会话，就先展开它再重算。**这条规则同时解决了两个问题**：既能一直走到「展开其余 N 个会话」里面的会话，
   又不会把同组里隐藏的会话跳过去（旧做法只看"可见行"，从组内最后一行按 `→` 会直接窜到下一个分组）。
   展开会被记下来（按分组记账），**默认不自动折叠**（`autoCollapse: false`，展开后保持展开，与最初版本一致）；
   设成 `true` 则在你走到别的分组时自动折叠回去。一次按键最多 8 轮展开，目标行会
   `scrollIntoView({ block: "nearest" })`。
   **渲染层说不清的时候以服务投影为准**：如果当前会话本身没被渲染出来（列表刚折叠、正在动画），或者渲染出来的行
   到头了而投影里还有下一个会话，插件不会报"已经是最后一个对话"，而是按投影取邻居；必要时先把挡住目标的分组展开。
   所以"屏幕上看不到"永远不会让方向键停住。
3. **对话段跳转**：优先按**DSH 自己的对话段导航条**（transcript 右侧那排小横条）来跳——找到 `aria-current` 的当前段标记，
   点它的相邻标记，跳转就完全走 Chat 自己的逻辑（含未加载段的翻页、暂停"跟随尾部"、落点记忆），因此不会和会话区的
   滚动策略互相拉扯。导航条不可用（例如只渲染出一个标记）时，才回退到几何实现：
   - 一个 turn 可能占多行，跳转一律对齐该段的**第一行**（从段落开头读起，而不是段尾）；
   - 跳转后记住"落点"（哪个段 + 落点滚动位置），位置没变时以它为准——只靠几何判断时，对齐后的段常常比
     "阅读线"矮，会被读成下一段，于是下一次 `↑` 又瞄准刚离开的行；
   - 滚动用 `scrollTo({ behavior: "instant" })` 瞬时落位，并派发一次 `scrollend`，让会话区立刻采样、停止跟随；
   - 折叠的进程组、空的流节点（高度为 0）不参与读取和跳转；
   - 到顶时若还有更早历史，会先点「加载更早」翻页、等新内容到位后落到更早的段；正在加载时提示"正在加载更早的对话…"。
4. **按键接入**：裸方向键是 DSH 快捷键表里的**保留键**（Web 端不允许绑定成可编辑命令），
   因此走官方只读通道 `ctx.shortcuts.registerFixed()` + `ctx.shortcuts.observeFixedInput()`。
   这同时带来两件事：快捷键面板里可见、别人无法把它绑到别的命令上。

## 不会被打扰的场景（保护逻辑）

插件只在真正完成一次跳转时才 `consume()`（阻止默认行为），其余情况一律放行：

- 带修饰键（Ctrl/Alt/Shift/Cmd）、长按重复、输入法组合中、事件已被别人 `preventDefault`；
- 有模态框/菜单打开（方向键先归它，此时会提示"方向键先归打开的菜单/弹窗"）、焦点在终端（`.xterm`）里；
- 浮层只在**真正持有交互**时才让路：`role="listbox"`/`role="menu"` 里要么焦点在你身上，要么它带着
  `aria-activedescendant`（`/` 命令、`@` 提及）。仅仅"屏幕上有个浮层"不会关掉导航——否则鼠标停在侧边栏某一行、
  预览层一出现，方向键就会莫名其妙地失灵（也就是"点一下空白才恢复"的那种卡住）；
- 焦点在**别的**输入框里（搜索框、设置项等）——方向键仍然是光标/原生行为；
- 焦点在**输入框（composer）里但已经打了字**——此时 ←/→ 依然是移光标；
  只有焦点在空 composer 里（或焦点在页面/侧边栏/会话区）时，方向键才触发导航。
  注意 composer **不属于** transcript 子树（它是同一列的兄弟节点），所以它被单独计入会话作用域：
  切完会话后 Chat 会把焦点交给编辑器，如果把它判成"会话区之外"，方向键就会在那之后一律失灵。

被上面任何一条拒绝时都会**记账**：写进诊断日志；同一条原因连续拒绝 3 次时，
如果打开了 `diagnostics` 还会自动把面板弹出来——所以"按了没反应"永远不是一个没有解释的状态。
被弹窗/菜单挡住方向键时，提示条也会直接说明（`方向键先归打开的菜单/弹窗`）。

## 排查问题：内置诊断面板

这是给排查用的**支持工具，默认完全不会出现**。

- 需要时按 `Shift + ↑`：显示最近 12 次按键决策，**常驻**到你再按一次 `Shift + ↑`；
- 想让它在出问题时自己说话：把 `diagnostics` 设成 `true`（默认 `false`）。此时出现
  "跳过打不开的会话""方向键被拒绝""已经是第一个/最后一个对话"会**自动显示 6 秒**然后消失，
  任何一次成功跳转也会立刻收掉它。

```
dsh-arrow-nav v1.6.0 · 6 秒后自动消失，Shift+↑ 可常驻
[→] vis=7 at=3 cur=ff36e234 hop=row
[→] open dab040a4 failed: session retain refused: ...
[→] vis=7 at=3 cur=ff36e234 skip=1 hop=row open=49ba2194(6/27)
[↑] rail 3→2
[ArrowDown] refused: editor holds keys: <textarea> (x3)
```

读法：`vis` = 我扫到的侧边栏会话行数，`at` = 当前会话在其中的位置（`-1` = 没渲染出来），
`cur` = 当前会话 id 前缀，`skip` = 已拉黑的打不开的会话数，`hop`/`rail`/`open` = 这一步走了哪个分支；
`refused:` 则是**被保护逻辑挡下**的方向键及其原因（弹窗、编辑器、焦点位置…）。
"卡住"时提示条也会带上构建号（如 `已经是最后一个对话 · 1.7.2`），一眼能看出页面跑的是哪一版。

**打不开的会话不会再挡住去路**：`openSession` 底层是同步的 `sessions.retain(...)`，打不开会抛异常；
插件会记住这个会话并**跳过它继续走**（日志里是 `open <id> failed`）。**打开没生效也会被当场发现**
（同步查 `retainInfo`，落后时最多再等 350ms；日志里是 `open <id> failed: open did not take effect`），
同样跳过并在这次按键内继续。跳过记录在页面刷新后清空。

> 另外：宿主会轮询插件的 `lib/client.js`，文件一变就热重载，所以改完通常**不需要手动刷新**。
> 插件还往 `shell.overlay` 注册了一个不渲染任何内容的探针（`id: arrow-nav-probe`），
> 可以在 Slots 检查器里确认当前页面是否真的加载了这一版。

## 运行参数（可选）

在浏览器控制台写入 `localStorage["dsh.arrow-nav.v1"]` 后刷新即可，例如：

```js
localStorage.setItem('dsh.arrow-nav.v1', JSON.stringify({
  hint: true,              // 是否显示浮层提示
  wrap: false,             // 到第一个/最后一个对话时是否循环
  loadEarlier: true,       // ↑ 到顶时是否自动翻页加载更早历史
  allowEmptyComposer: true,// 空 composer 是否让出方向键
  autoExpand: true,        // ←/→ 是否自动展开挡路的折叠分组/「展开其余 N 个会话」
  autoCollapse: false,     // 走出被自动展开的分组后，是否自动折叠回去（默认关：展开保持，和最初版本一致）
  diagnostics: false,      // 是否让诊断面板在出问题时自动出现（默认关；Shift+↑ 随时可手动打开）
  autoHideMs: 6000,        // 自动出现的诊断面板停留多久（毫秒）
  holdRepeat: true,        // 长按方向键是否连续切换（←/→）
  holdPreview: false,      // false = 按住即连续真切（默认）；true = 只在侧边栏移动高亮、松手才切换
  holdTurns: false         // 长按 ↑/↓ 是否连续跳段落（默认 false：保留浏览器原生滚动）
}))
```

> 默认**不会**有任何诊断面板出现：只有按 `Shift + ↑` 才看得到它。
> 想让它在出问题时主动解释（拒绝、跳过、到边界时自动显示，6 秒后自动消失），把 `diagnostics` 设成 `true`。

## 自测

零依赖的 Node 测试台（含 DOM 替身），覆盖顺序投影、DOM 行序、自动展开/自动折叠、服务投影兜底、导航条跳转、跳转几何、落点记忆、滚动信号、翻页、诊断浮层与全部保护逻辑：

```powershell
cd dsh-arrow-navigator
node test/run.mjs      # 182 checks（npm test 等价；若 PowerShell 禁用了 npm.ps1 就用这行）
```

推送到 GitHub 后，`.github/workflows/test.yml` 会在 Node 20/22 上自动跑同一套测试。

## 开发与发版

仓库根目录**就是插件包**（`package.json` 在根），这样才能用 `github:用户/仓库` 直接安装。

```powershell
# 1) 本地提交
git add -A
git commit -m "feat: ..."
git tag v1.0.0                     # 可选：发布一个版本点
git push origin main --tags

# 2) 更新已安装的插件（git 安装按 commit 解析，重装即取最新）
dsh plugin --profile desktop add github:Aruzestattvat/dsh-arrow-navigator
```

- **没有构建步骤**：DSH 直接读取仓库里的 `lib/client.js`（预构建 bundle）。
  改完源码后 `npm test` 通过即可提交，不要引入打包产物目录。
- 发新版时改 `package.json` 的 `version` 并打 tag；`dsh.profile.bundles` 里记的是包名，版本由安装器解析。
- 想让别人更容易发现：仓库 Topics 填 `dsh-plugin`、`deepseek-harness`，README 顶部放一张界面截图或 GIF。
- **隐私规则（本仓库是公开的）**：README、截图、测试固件、提交信息里**一律使用虚构名称**
  （如 `项目 A` / `会话 1`）。真实侧边栏内容会暴露工作目录名与会话标题，
  既不要粘进代码，也不要放进截图；`node test/run.mjs` 里带 `[1d]` 的那组用例会先在本地拦住结构类错误。

## 已知边界

- `←`/`→` 的主体顺序是**侧边栏当前渲染出来的行**；中间被折叠/隐藏的会话会被自动展开走过去。
  展开/折叠都**写进侧边栏自己的状态**（和手动点一样）。**默认不自动折叠**（`autoCollapse: false`），
  展开后保持展开，和最初版本的行为一致；想要"走出分组就收回去"把它设成 `true`。
- 自动折叠按 DSH 的「收起」语义还原：分组回到默认的一批（5 行），不是回到"你手动展开到一半"的那一档——这与直接点「收起」的结果一致。
- 侧边栏整体收起（图标栏）时没有可点的展开控件，此时直接用完整服务顺序（`workspaces.list` + `sessions.list`），不会自动展开/折叠。
- 一次按键最多 8 轮展开；极端大的分组（几十个隐藏会话）可能需要再按一次。
- 会话区若被别的脚本/插件强行拉回尾部，插件的落位可能被覆盖——正常使用（含回答流式中）不会。
- `↑`/`↓` 复用 DSH 自带的「移动菜单选择」按键；在菜单/浮层里方向键仍归菜单所有（见上面的保护逻辑）。
- 会话很大时，更早的 turn 需要点一次「加载更早」翻页才能落到 DOM 里，插件会自动翻一次；若历史加载很慢，
  提示会先显示"正在加载更早的对话…"。
- 只读（fixed）按键不能像可编辑命令那样在设置里改键；想换键需要改 `lib/client.js` 里的 `bindings`。
- 插件以源码形式交付；`link:` 安装时改完 `lib/client.js` 刷新页面即可生效（HMR 可用时无需刷新），
  `github:` 安装时则要先提交推送（git 安装解析的是某个 commit）。

## 许可

MIT。
