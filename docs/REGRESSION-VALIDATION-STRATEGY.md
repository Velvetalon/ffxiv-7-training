# Regression / Validation Strategy

本规范是后续修改的默认验收依据。地图数量可以继续增长，主 Agent 的阅读与分析成本应主要取决于异常数量，而不是地图总数。

禁止每次任务完成后，由主 Agent 逐张加载、逐张观察和分析全部地图。采用自动检测、异常驱动分析：脚本完成正常路径检查，主 Agent 只处理失败、回归和异常值。

## 默认验收范围

| 修改类型 | 自动执行范围 |
|---|---|
| 普通修改 | Impacted Maps ∪ 固定 Smoke Set |
| Asset / Renderer / Shared Runtime 重大修改 | Smoke Set → Automated Full Regression |
| Release / Major Milestone | Automated Full Regression；失败时由 Agent 定位异常 |

Smoke 失败时停止扩大验证范围，先处理异常；全量任务开始后，尽量收集全部失败地图，而不是第一个地图失败后丢失剩余覆盖。浏览器崩溃、资源耗尽等使后续数据无效的情况应中止并标记未测地图。

本项目已有完整目录、资源引用图和自动浏览器验证器。日常任务不需要重新生成或重新加载全部地图，除非变更范围和上述策略要求。

## Impacted Maps

输入包括当前改动、Asset Dependency Graph 和代码依赖：

```text
Changed Files / ResourceIDs / Code Modules
    → reverse dependencies
    → affected resource owners
    → Impacted Maps
```

- 共享纹理、几何、材质等变化影响所有引用者，不只文件所在目录。
- 资源增删、重命名和引用关系变化都参与计算。删除资源的引用可从上一版本的图补充，不能因为当前文件不存在就跳过。
- 地图专属代码按已知绑定选择；Renderer、Scheduler、Cache、Bundle Reader、Decoder 等共享模块应沿代码依赖传播。
- 构建器、清单协议和引用分析器变更可能改变整个发布包，应保守扩大范围。
- 未知路径、失效依赖图或无法确定的影响必须出现在选择报告中。无法证明局部影响时扩大覆盖，不能假定无影响。
- 手工缩小选择范围属于诊断运行，不能代替策略要求的验收，也不能标记为完整发布通过。

选择器输出地图 ID、选择原因、依赖图标识、改动标识及无法解析的影响。正常地图的详细依赖信息不提供给主 Agent。

## Representative Smoke Set

固定集合维护在 `config/map-regression.json`，约 5～10 张。应覆盖：

- 小、中、大资源规模；
- 城市与户外地图；
- 不同材质、透明/多层贴图和环境光；
- 高实例数、高场景复杂度；
- 大碰撞数据、跨区入口、无普通出口地图；
- 曾发生回归的高风险地图。

集合不按每次运行随机抽取。每个条目记录选择原因；替换条目时说明覆盖变化。地图 ID 失效应报错，不能静默缩小 Smoke Set。示例中的地图总数不得作为固定验收目标；实际总数来自本次发布目录，当前世界范围的完整性约束仍需核对。

## 自动记录

每张地图的机器报告至少包含：

| 字段 | 含义 |
|---|---|
| Load Success / Failure | 可见、可交互及要求的完整加载是否完成；失败阶段与原因 |
| First Render Time | 实际导入场景可见；加载遮罩隐藏且不再拦截输入 |
| Time To Interactive | 场景可见，所需导航就绪，真实输入可用 |
| Missing Assets | 资源 ID、缺失引用、请求状态；不记录签名密钥/query |
| Runtime / JS / GPU Errors | 异常、资源解析错误、WebGL 错误等 |
| Memory Peak | 采样得到的内存峰值、采样间隔和计量范围 |
| 关键资源数量 | 预期/实际模型、纹理、碰撞或分块数量 |
| Screenshot / Image Diff | 必要时生成；保存路径、基准和差异指标 |

CPU 资源估算、JS heap 和 GPU 显存不能混称为同一种“内存”。记录未支持或未测量字段，不以 `0` 冒充实测值。峰值必须来自运行中的采样，不能把最终快照称为峰值。

完整贴图恢复和后台内容全部就绪另记为 Fully Loaded。它不等同于 TTI。Renderer 提交了绘制调用，也不等同于用户已看到画面。

## 性能回归与异常值

基准必须有可追溯标识：资源/代码版本、设备、浏览器、缓存状态、视口、网络条件和并发设置。环境不兼容时标记 `not comparable`，不伪报改善或回归。

阈值集中配置，同时考虑相对增幅和最小绝对差值，避免把毫秒级噪声报告成大比例回归。没有基准时，可检查绝对预算并标记缺少历史比较。基准更新需说明原因，不能自动用失败结果覆盖原基准。

功能回归可以有限并行；性能基准应控制并发和网络竞争。并行功能任务耗时不得直接与串行冷加载性能基准比较。

## 输出给主 Agent 的内容

自动任务将详细报告保存在磁盘，只向主 Agent 返回有界汇总：

```text
Total: 126
Pass: 121
Failed: 2
Performance Regression: 3
Not Run / Unmeasured: 0

Map 17: missing texture
Map 42: load failed
Map 81: TTI +74%
Map 96: memory +43%
Map 103: visual diff abnormal
```

以上是格式示例，不代表本项目当前地图总数或实测结果。

汇总还应包含当前任务是否完整、选择范围、基准兼容性、报告路径，以及被截断异常的数量。正常地图不逐条列出。详细日志、逐资源 Trace 和截图不送入主 Agent 上下文。

主 Agent 只进一步读取异常地图需要的片段；图片检查按项目既有规定交给子 Agent。即使任务很长，也不按地图轮询模型。使用原生进程等待退出、文件事件或有界脚本监控，只有失败、阻塞或完成时回传结果。

## 工具入口

- `scripts/assets/select-regression-maps.mjs`：根据改动和依赖图选择范围。
- `config/map-regression.json`：Smoke Set 和回归阈值。
- `scripts/regress-maps.mjs`：按日常、重大 Runtime、发布三种模式调度自动任务。
- `scripts/verify-asset-world.mjs`：自动验证所选地图和必要跨区行为。
- `scripts/assets/summarize-regression.mjs`：生成仅含汇总、回归、异常和失败地图的报告。
- `scripts/benchmark-assets.mjs`：受控环境下的详细性能基准。

具体参数以各工具的 `--help` 为准。发布模式必须验证完整目录和关键跨区行为，不得把部分 Smoke 成功显示为全量通过。恢复执行只复用相同代码/资源指纹的结果。

典型命令：

```sh
npm run regress:select -- --base=HEAD --mode=daily --out=work/regression/selection.json
npm run regress:maps -- --mode=daily --config=config/map-regression.json --base=HEAD --url=http://127.0.0.1:8080/ff14-web/ --out=work/regression/daily.json
npm run regress:maps -- --mode=release --config=config/map-regression.json --url=http://127.0.0.1:8080/ff14-web/ --out=work/regression/release.json
```

`--base=HEAD` 用于尚未提交的改动；已提交任务应使用其真实起始提交作为比较基准。不要用任务完成后的 HEAD 比较自己而遗漏已提交的修改。资源图路径不采用默认位置时显式传 `--graph`。

## 当前发布的处理

正在进行的新版正式发布属于 Major Milestone，继续完成已有自动全量任务，不因本策略新增而重复运行已验证地图。将现有报告转换为汇总，检查失败和异常后再发布。策略、选择器和汇总脚本的文档性改动不触发再次全量加载。
