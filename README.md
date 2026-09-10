# 以太演武场 · Aetheryte

基于 Three.js 的《最终幻想 XIV》7.0 / 100 级单机职业循环练习器。职业为白魔法师、绘灵法师、钐镰客；大世界范围覆盖 47 个户外区域与 18 个城市、公共据点。

保留第三人称 3D、自由镜头、即时技能战斗与 FF14 式操作。世界清单覆盖 65 个区域，沿用客户端原始模型、摆放、贴图和碰撞，通过 145 条源数据指定的区域连接衔接；远方区域也可使用传送菜单进入。资源均使用相对路径，支持部署在 `/ff14-web/` 等子目录。角色和木人仍为练习器模型，技能图标来源见 [ICON-SOURCES.md](docs/ICON-SOURCES.md)。

当前提供本地单人练习模式，未实现多人联网服务。真实地图的版本、导入结果与材质边界见 [CLIENT-MAPS.md](docs/CLIENT-MAPS.md)；手工回退版本见 [TERRAIN-REFERENCES.md](docs/TERRAIN-REFERENCES.md)。威力统计不是装备面板下的实际 DPS，规则边界见 [RULES.md](docs/RULES.md)。

## 启动

服务器或只想直接体验时，安装 Node.js 22 后在仓库根目录运行：

```sh
npm start
```

打开 `http://localhost:8080`。此入口直接提供已提交的 `site/`，无需 `npm install`、游戏客户端、Python、.NET 或本机绝对路径。也可直接运行 `node scripts/serve.mjs`。部署到子目录：

```sh
node scripts/serve.mjs --port 8080 --base /ff14-web
```

也可以将 `site/` 的内容交给 Nginx 等静态服务器。`/ff14-web` 应重定向至 `/ff14-web/`，具体说明见 [DEPLOYMENT.md](docs/DEPLOYMENT.md)。

修改源码、进行开发时：

双击 `Start.cmd`，或右键 `Start.ps1` 选择“使用 PowerShell 运行”。启动成功后自动打开浏览器，服务在后台运行。也可在项目根目录运行：

```powershell
.\Start.ps1
```

默认地址：`http://127.0.0.1:5173`。重复启动会复用已运行的演武场；端口被其他程序占用时自动选择后续端口。脚本会优先使用本机 Codex 附带的现代 Node.js，避免系统 Node.js 16 不兼容 Vite 的问题。也可在 Node.js 18+ 环境下使用标准命令：

```sh
npm install
npm run dev
```

建议使用 Node.js 22 和支持 WebGL 2 的现代浏览器。依赖安装后，运行不需要外部图片、字体、账号或在线游戏服务。可用 `.\Start.ps1 -Port 5174` 更换端口。

启动日志保存在 `work/server-端口.stdout.log` 和 `work/server-端口.stderr.log`；失败信息另写入 `work/startup-error.log`，错误窗口会等待按键后关闭。`Start.ps1` 使用带 BOM 的 UTF-8 编码以兼容 Windows PowerShell 5.1，编辑时请保留此编码。自动化调用可加 `-NoBrowser -NoPause`。

```sh
npm run build
npm run preview
npm run verify
npm run verify:camera
npm run verify:terrain
npm run verify:extracted
npm run verify:world
```

`build` 输出到 `dist/`；发布前运行 `npm run release` 更新随仓库提交的 `site/`。构建复制当前激活清单中的全部地图，不复制旧的重建版本。通过 HTTP 访问，不能直接双击 `index.html` 使用 ES 模块。可使用 `?scene=f1f1` 等参数直接进入已开放地区。

## 操作

| 操作 | 输入 |
| --- | --- |
| 移动 | WASD / 方向键 |
| 跑动 | Shift + 移动 |
| 跳跃 | Space |
| 传统操作：转镜头并同步角色朝向 | 按住右键 + 移动鼠标 |
| 独立观察镜头 | 左键拖动 |
| 横移 | A/D 或 Q/E |
| 缩放镜头 | 滚轮 |
| 选中木人 | 点击木人 / Tab |
| 第一行技能 | 1–0、`-`、`=` |
| 第二行技能 | Shift + 对应按键 |
| 其他技能 | 技能栏右侧上下箭头翻页 |
| 传送 / 地图 / 技能一览 | T / M / P |
| 从区域出口进入相邻地图 | 靠近蓝色出口标记后按 F，或点击提示 |
| 操作指南 | H / 顶栏问号 |
| 关闭窗口 / 中断传送 / 取消目标 | Esc |

手机视口提供方向按钮和点击技能。悬停技能查看提示，或在“技能一览”中选择技能查看说明。技能栏显示公共复唱、独立复唱、充能、触发状态；职业量谱位于技能栏上方。

默认使用传统操作模式，游戏区域屏蔽右键菜单。按住右键时隐藏并捕获鼠标来连续转动视角，松开、打开菜单或切换窗口时释放。设置中可切回独立的自由观察模式。若内嵌浏览器不允许鼠标锁定，自动使用按住右键拖动视角。

近战需要走到木人身边。左侧准星按钮可返回木人附近；重置会清空本轮技能状态与记录。使用技能会开始练习计时，统计累计威力、威力/秒和技能次数。下载按钮导出本轮 JSON 记录。

设置中可开启治疗压力练习：交战后每 8 秒承受最多 2,500 HP 的非致命伤害，也可手动承受一次伤害，用来练习恢复、护盾和减伤。默认关闭。

## 练习方式

- **白魔法师**：维持天辉，以闪耀填充；穿插法令，神速咏唱期间消耗闪耀神圣。战斗中百合随时间生成，百合治疗积累血百合后释放苦难之心。治疗、回蓝、即刻咏唱与防护技能可在其他技能栏中使用。
- **绘灵法师**：脱战准备画布，正向调色三连积累量谱和颜料，减色混合进入减色三连。利用生物、武器和风景意象安排爆发，处理肖像、锤击、星极及彩虹触发。稳定技能槽会随资源和阶段变成对应动作。
- **钐镰客**：维持死亡之影，基础三连与灵魂切割积累灵魂。通过暴食/化身技能消耗灵魂并积累魂衣，交替处理身位与强化技。神秘环、大丰收、魂衣连段、团契及完美收割组成爆发；地狱入境/出境支持返回地狱门。

这些是资源与循环入口，不是固定装备速度下的最优开场脚本。练习器保留手动输入，便于练习时机、穿插、身位和资源规划。

## 场景与扩展

传送窗口展示**当前激活清单中的全部目的地**，支持按地区筛选与搜索。传送咏唱 5 秒；移动会打断，交战中需要先重置。相邻区域可从地图窗口找到出口，靠近后按 F 切换；出生位置来自对应入口并经过碰撞地面验证。没有直接出口记录的区域仍可从传送菜单抵达。

区域清单、实际连接的来源、完整重建命令和验证边界见 [OVERWORLD.md](docs/OVERWORLD.md)。各区域保留自己的源坐标，通过区域切换连接；并未把不同区域的局部原点强行叠放为一张无缝地图。

设计按职责划分：

| 模块 | 职责 |
| --- | --- |
| `src/combat/` | 不依赖 DOM/Three.js 的战斗状态机和职业插件 |
| `src/world/scenes/` | 场景构建器注册 |
| `src/world/terrain/` | 原图坐标、道路/广场/高差、导航和三维地形构建 |
| `src/world/art/` | 手绘材质、建筑与植被造型 |
| `src/world/imported/` | 客户端真实地图加载、实例、原始碰撞导航 |
| `src/world/entities.js` | NPC、木人、怪物的实体注册 |
| `src/world/actors.js` | 角色、武器和训练目标外观 |
| `src/world/input.js` | 三维移动与镜头输入 |
| `src/world/effects.js` | 技能事件对应的视觉表现 |
| `src/world/renderer.js` | 渲染器、光照和质量选项 |
| `src/core/` | 设置、传送生命周期和可选治疗压力练习 |
| `src/ui/` | HUD、技能栏、地图、窗口与界面组件 |
| `src/audio/` | 程序合成技能音效 |
| `src/main.js` | 装配模块、路由用户动作、驱动帧循环 |

新增职业、场景、NPC、怪物的开发说明见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)。模块之间的接口见 [CONTRACT.md](docs/CONTRACT.md)。

完整世界的部署快照保存在 `public/extracted/world/`，由 `active.json` 指定当前版本；`bundled/` 保留此前城市快照。发布包使用逐像素验证的无损贴图编码与逐字节验证的碰撞压缩。原始客户端、解包中间文件、历史暂存版本和服务器凭据不在 Git 中。可选离线重建工具源码在 `tools/map-tools/`，不影响服务器直接启动。

## 统一资源加载与打包

地图资源现在可通过统一 AssetRuntime 从 COS/CDN 的内容哈希资源包加载，支持引用去重、优先级调度、取消与重试、浏览器缓存、近区先加载及后台完整贴图恢复。构建期工具输出引用图、空间资源包和版本清单；后续角色、动画、音频、坐骑与 VFX 可复用相同协议。

使用步骤见 [ASSET-PIPELINE-QUICKSTART.md](docs/ASSET-PIPELINE-QUICKSTART.md)，模块设计见 [ASSET-PIPELINE.md](docs/ASSET-PIPELINE.md)，实测口径及结果见 [ASSET-PERFORMANCE.md](docs/ASSET-PERFORMANCE.md)。

CDN 模式的 `site/` 是不含大型地图资源的小型站点，需要可用的 `/ff14-assets/ticket` 签名接口和网络。需要独立本地运行时，按 Quickstart 构建包含资源包的成品；原始解包资源模式仍可通过清除相关构建环境变量恢复。
