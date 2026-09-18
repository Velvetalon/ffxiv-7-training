# Fast Validation / 快速验收

本文件是后续 Codex 开发任务的**默认验收方式**，取代旧的重型全量回归默认策略。本项目是个人 Demo / 实验项目：快速发现明显问题，开发效率优先，不追求商业级覆盖率。

## 默认流程

```text
Build / Basic Static Check
→ 全地图轻量 Smoke 一次
→ 只查看 FAIL / TIMEOUT
→ 固定 4 张地图抽查
→ 完成
```

只有两层默认验收：

### A. 自动轻量 Smoke

脚本从本次构建的地图目录取全部 ID，不把数量写死。每张地图只检查能发起加载、无直接加载失败或 Fatal/Unhandled Error、必要核心资源可用、进入基本可渲染状态，并记录粗略耗时。

**达到基本可用状态即结束该地图。** 不等待全部远景、完整分辨率贴图或后台流式资源完成，不抓全请求 Trace，不默认截图。由脚本有界并行处理，默认每图超时 60 秒；该值按冷缓存 Babylon 首次加载实测上调，避免把仍在正常加载中的地图误报为超时。

标准输出仅包含压缩 Summary、失败和超时项。单图诊断按需保存，正常地图不输出逐条 PASS 日志。主 Agent 不逐图操作、不读全部日志、不用模型循环监控进度。

### B. 固定样本抽查

`config/fast-validation.json` 固定 4 张：

| 地图 | 覆盖原因 |
|---|---|
| `gridania` | 普通城市，常规移动和相机 |
| `x6f2` | 大型复杂地图、大碰撞数据 |
| `y6f1` | 资源较多的户外场景、材质及环境光 |
| `d2t1` | 历史资源生命周期/跨区问题 |

检查正确显示、正常移动和相机、明显 Texture/Geometry/Material 缺失、本次功能以及明显性能退化。固定样本可以覆盖多个类别，不要求每类新增一张地图。

脚本提供简短运行、移动和相机检查辅助；这些**不能替代真实的视觉和本次功能观察**。Codex 在固定样本上完成必要观察即可；按项目规定由图像子 Agent 执行，主 Agent 接收文字结论。不要随机增加地图，不要求每图截图，更不全地图视觉 Diff。

## 命令

```sh
npm run validate-fast
npm run validate-smoke -- --url=http://127.0.0.1:8080/ff14-web/
npm run validate-map -- gridania --url=http://127.0.0.1:8080/ff14-web/ --headed
```

`validate-fast` 编译当前源码到 `work/fast-validation/site/`，执行现有基础职业和相机检查，启动临时本地服务，运行轻量 Smoke 和固定样本的自动辅助检查，输出汇总后关闭临时服务。**不会部署、修改正式 `site/` 或重新转换/复制整套地图资源。**

优先复用 `--asset-release=<打包成品目录>` 或 `ASSET_PIPELINE_DIR`，当前工作区已有 `work/asset-performance/packed-all-final` 时可直接复用；否则使用 `public/extracted` 的已有资源。没有准备好的资源时报告环境问题，不在验收命令里自动启动漫长的解包/打包任务。

需要 Node.js 22+ 与 Playwright。可以使用项目已有安装，或通过 `PLAYWRIGHT_MODULE_PATH`/`--playwright-module-path` 指定既有 Playwright；浏览器可通过 `--browser-path` 指定。

```sh
npm run validate-fast -- --plan-only
npm run validate-fast -- --asset-release=work/assets-release/release
npm run validate-smoke -- --url=http://127.0.0.1:8080/ff14-web/ --scenes=problem-map
```

`--url` 命令验证的是该 URL 实际运行的版本；不要把正式站检查误当作本地未部署代码的验收。

## 防止重复全量

`validate-fast` 在工作目录记录成功或失败的 Smoke 状态及核心代码/资源目录指纹：

- 首次使用或核心逻辑/Bundle/Manifest 变化：执行一次全地图轻量 Smoke。
- 指纹相同且上次通过：复用已有结果，继续固定抽查。
- 指纹相同但存在失败/超时：只重试失败地图。
- 文档、非核心小修改：不因此重复完整 Smoke。
- `--force-smoke` 是显式覆盖，只用于确实影响全局的修复或新阶段要求，不能习惯性每次添加。

暂不尝试精确推导每种代码变动。核心地图模块的变化保守视为全局；资源成品使用不可变清单标识。修改资源后应更新清单，不要覆盖内容哈希文件。原始散文件模式不能据清单判断文件内容变化时，应使用新的 Smoke 阶段或显式覆盖。

一次通过不等于永远通过，但也不应因为小修补反复验收所有地图。轻量 Smoke 未覆盖的少见边界，不构成阻塞理由。

## 输出与边界

汇总记录地图总数、PASS/FAIL/TIMEOUT、总耗时、平均每图耗时和 Agent 需要分析的异常数量。重复使用结果明确显示 `reused`，不声称本轮重新跑过。固定样本的自动检查和待观察清单分开记录。

允许小概率边缘 Bug、非关键视觉问题、未覆盖输入和非关键资源延迟。不能接受 Crash、大面积无法加载、缺失核心资源、本次功能明显失效或严重变慢。

下列内容**不再默认执行**：全场景加载完成检查、多轮全量回归、全部地图截图分析、视觉 Diff、压力测试、完整性能 Benchmark、多浏览器矩阵、大量理论边界测试。

旧命令 `regress:*`、`benchmark:assets`、`verify-asset-world` 保留为按需工具，只有任务明确需要深度回归或诊断时调用。若快速验收本身拖慢开发，优先缩短检查与日志，而不是继续扩大验证。
