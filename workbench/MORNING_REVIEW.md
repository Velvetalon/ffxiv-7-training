# MORNING_REVIEW · FF14 Babylon 开发工作台（S00–S12）

> 生成时间：2026-09-16 · 本轮任务：`D:/OneDrive/codex/task/20260914/v3/ff14_babylon_workbench_infrastructure_plan.md`
> 一句话：13 个阶段全部落地——S00–S10、S12 已验证（VERIFIED），S11 本地演练通过但在线发布按规划阻塞（无凭据）。

## 一、访问地址与运行命令

| 用途 | 命令 |
|---|---|
| 本地开发服务器（推荐，黄金港资源在本地） | `cd E:\Code\ffxiv-7-training` → `set BABYLON_ASSET_DIR=work/babylon-golden-map` → `npm run dev:babylon` → `http://127.0.0.1:5173/ff14-web-babylon-preview/` |
| CDN 模式开发服务器 | `npm run dev:babylon`（5173 被占则自动换端口） |
| 健康体检 | `node scripts/workbench/doctor.mjs --url=http://127.0.0.1:5173/ff14-web-babylon-preview/` |
| 脚本控制示例 | `node scripts/workbench/wb.mjs --command=camera.set --args="{\"position\":[90.5,67,92],\"target\":[164.5,22,0]}" --url=…5173…` |
| A/B 配方 | `node scripts/workbench/recipe.mjs --recipe=workbench/recipes/ab-roughness-exposure.json` |
| 影响计划 | `node scripts/workbench/impact.mjs --change="{\"type\":\"resource\",\"resourceId\":\"glb:sha256:…\"}"` |
| 全套回归（本轮验证过的） | `npm run validate-babylon` / `validate-fast`（既有工具未改动） |

- 页面右下角有 **WORKBENCH 面板**（viewer 模式自动挂载，`?noworkbench` 可关闭）：案例采集/保存/恢复、对象溯源、隔离、参数覆盖+补丁导出、异常读数。
- 自动化必设：`set PLAYWRIGHT_MODULE_PATH=E:/Code/scp/node_modules/playwright`（浏览器复用 `%LOCALAPPDATA%/ms-playwright`）。

## 二、约五分钟人工观察路径

1. 打开 `http://127.0.0.1:5173/ff14-web-babylon-preview/?viewer=1&scene=e3t1`，等待右上 Stage=complete（本地资源模式约 11 秒）。
2. 右下 WORKBENCH 面板 → Cases → **Capture** → **Save**。
3. Object 栏输入 `e3t1:118:0` → **Inspect**（下方出现材质路径/工作流/贴图语义）→ **Isolate**（画面只剩这一个道具，中性光照）。
4. Overrides 栏 roughness 改 0.3 → **Apply**（隔离对象变化，其余不受影响）→ **Undo** → **Exit**（Isolate Release）回到原视角。
5. Anomalies → **Anomalies/Status** 看读数。全程应无红色错误文本。

## 三、两个标准案例（脚本一键重放）

- **案例 A（材质/环境问题）**：`node scripts/workbench/validate-final.mjs`（内含 A/B 两案例）。流程：恢复黄金港基线 → 溯源 → 存现场 → 隔离 → 临时改 roughness 0.3/0.9 对比 → 导出补丁 `workbench/patches/s12-caseA-roughness.json` → 重载后重新导入补丁复现 → 撤销复原。11/11 PASS，视觉复查 PASS（截图 `work/workbench/s12/caseA-*.png`）。
- **案例 B（资源异常）**：同上脚本。页面本地故障注入（`faults.inject`，只拦截本页资源访问，不动 CDN）→ 热更新安全失败 → 异常聚合 → 证据包（`work/workbench/s12/caseB-evidence/`）→ 新页面无故障复现案例 → 移除注入恢复正常。已通过。

## 四、各阶段状态（明细见 workbench/milestones.json）

| 阶段 | 状态 | 证据 |
|---|---|---|
| S00 基线+doctor | VERIFIED | doctor 9/9；基线案例 `workbench/cases/e3t1-baseline.json` |
| S01 程序化控制 | VERIFIED | `work/workbench/s01/`（9/9，含跨导航切换） |
| S02 快照/恢复 | VERIFIED | `work/workbench/s02/`（7/7） |
| S03 对象溯源 | VERIFIED | `work/workbench/s03/`（6/6） |
| S04 覆盖/补丁 | VERIFIED | `work/workbench/s04/`（11/11） |
| S05 热更新/回退 | VERIFIED | `work/workbench/s05/`（8/8） |
| S06 隔离实验室 | VERIFIED | `work/workbench/s06/`（7/7，含流式冻结修复） |
| S07 配方/A-B | VERIFIED | `work/workbench/s07/`（6/6） |
| S08 异常/证据包 | VERIFIED | `work/workbench/s08/`（9/9） |
| S09 影响/定向构建 | VERIFIED | `work/workbench/s09/`（8/8） |
| S10 工作台 UI | VERIFIED | `work/workbench/s10/`（12/12） |
| S11 预览发布/回退 | **BLOCKED（发布）** / 本地演练 PASS | `work/workbench/s11/`（6/6 本地；在线未演练） |
| S12 总闭环+交接 | VERIFIED | `work/workbench/s12/`（11/11 + 视觉复查 PASS） |

当前 Release：`workbench/releases/`（最新一条 = 当前 `site-babylon-preview/` 构建；buildId/sourceSha256 见文件）。

## 五、必须人工观察 / 尚未确认

- 隔离视图中 roughness 0.3→0.9 的**高光差异很微妙**（平面中性光照下肉眼难辨）。要评估质感需切换回原始环境或对比更多贴图槽位——脚本只证明参数生效（Draw 计数变化 + 读回值），不代替视觉结论。
- 隔离时对象为世界空间放置（脱离空间格节点）；阴影/雾/邻接物依赖已按规划标注为"隔离中变化"。

## 六、已知限制与阻塞

1. **S11 在线发布阻塞**：COS/CDN 凭据不在本机（在被 Git 忽略的部署服务器 `work/deployment/`）。凭据到位后：`node scripts/workbench/release.mjs verify --origin=https://yuluo.site` 补在线验证；本地回退演练已通过，线上回退未实演。
2. **CDN 限流**：重复全图流式下载会被限流（ECONNRESET）。工作台默认用本地资源包 `work/babylon-golden-map/`（约 303MB，`scripts/workbench/fetch-golden-pack.mjs` 可重建）。
3. 预览为单页单图：`map.switch` 走页面导航（跨导航 epoch 已验证）；不加载地图直接打开原始资源标记为 UNSUPPORTED（需第二场景）。
4. 既有渲染事实（记录未修改）：albedo 贴图 gammaSpace=linear；水体平面感、个别悬浮踏板——属视觉复刻任务范围。

## 七、下一项最值得推进的工作

1. 凭据到位后补 S11 在线验证（半小时内可完成，工具全部就绪）。
2. 工作台面板接入完整客户端（`__APP__` + DeveloperPanel 同一命令链），打通角色/坐骑隔离观察。
3. S09 资源变化的"定向重打包"接上真实提取管线（当前为 dry-run 计划）。

## 八、本轮环境修复（对后续任务有用）

- dev 服务器 ticket 重写中间件 + `/ff14-assets` 代理指向 img.yuluo.site（CDN 只对生产源发 CORS 头）。
- 无头 Chromium 必须 `--use-gl=angle`（软件渲染 6fps 且材质升级卡死）。
- npm lifecycle 需要 `E:\nodejs` 在 PATH。
