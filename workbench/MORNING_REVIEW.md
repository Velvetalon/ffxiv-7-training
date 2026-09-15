# MORNING_REVIEW · 今晚光照还原专项（v4）

> 2026-09-16 交付 · 任务：`task/20260914/v4/ff14_babylon_tonight_lighting_goal.md`
> 分支 `v4-lighting-sprint` 已合并 master 并推送。修复前基线：`work/lighting/s0/`，修复后：`work/lighting/after/`。

## 三个打开入口（黄金港 e3t1）

```sh
cd E:\Code\ffxiv-7-training
# 本地资源模式（推荐）：
set BABYLON_ASSET_DIR=work/babylon-golden-map && npm run dev:babylon
# 打开 http://127.0.0.1:5173/ff14-web-babylon-preview/?viewer=1&scene=e3t1
```

- **K-DAY**：页面 Day 按钮（12 时）——受光面/背光面/屋檐投影，天空渐变。
- **K-DUSK**：Dusk（17.5 时）——暖色低角度光、地平线辉光、纵深雾。
- **K-NIGHT**：Night（22 时）——月亮光+暗天空，灯笼/窗光自发光点。
- 保护地图：`?scene=gridania`、`?scene=limsa`（需 CDN 模式服务器，见下）。

## 修了什么根因（每项可回答：哪层修复/如何证明/画面关系）

1. **奶白雾感（白天）**：环境半球光恒定 0.64 压过太阳直接光（S0 消融证据：关掉太阳画面几乎不变、关掉环境光变化巨大）。修复：环境填充让位于太阳（AMBIENT_DAY_YIELD），白天 0.64→0.29、夜间保持 0.62。证据：消融前后截图 + 运行时读回。
2. **高光硬截断**：输出链完全没有色调映射（exposure 1、toneMappingEnabled=false）。修复：启用 S2 实验（9 张对照）选出的 TONEMAPPING_STANDARD @ exposure 1.0——白天无截断、暗部零代价。近似项：FF14 的 ToneMapping 曲线语义未知。
3. **阴影发灰无结构**：darkness 0.35→0.18、frustum 512→384、normalBias 0.02→0.012。证据：白天台阶/屋檐投影边界变实。
4. **背景死板**：纯雾色清屏 → 同源数据驱动的渐变天穹（地平线=雾色+太阳辉光，天顶=雾色加深；黄昏暖辉光、夜间近黑）。颜色全部来自 ENVB 解码值，垂直映射为推断。
5. **夜晚黑死**：环境填充夜间保持 + 近黑天空 + 灯笼/窗光自发光点（源材质 emissive，未改动）。读数：夜间环境光 0.615，画面可读。

## 数据依据与诚实边界

- 已接入（SOURCE_DERIVED）：65 图逐时 ENVB 关键帧（太阳/月亮颜色强度、雾色/距离、ambientScale 等）——S1 数值追踪验证白天 1.4/dusk 1.246(插值)/夜晚 0.4 精确到达灯光装备。
- 推断（INFERRED/APPROXIMATE）：太阳方向圆弧、天空渐变垂直映射、色调映射曲线选择、环境填充比例。
- **BLOCKED**：夜景真实灯实例（LGB）、天空盒资产、天气语义——本机无游戏客户端无法提取（解析先例在 tools/map-tools/environment/，凭据客户端到位即可续作）。未添加任何无源数据的假灯。

## 回归与性能

- 保护地图 G-1 gridania PASS（森林城日光合理）；G-2 limsa 街景 PASS（高空远景受源雾数值+树叶卡牌遮挡限制，属既有内容/流式表现，见 `work/lighting/s7/`）。
- 项目自带 `validate-babylon` 回归：errors=[]（修复了验证器缺 `--use-gl=angle` 导致的超时误报）；engine/manifest 检查全过；mapPosition 需原始客户端导出（预存在限制）。
- 性能（1440×900 全量加载后，kugane-castle 机位）：阴影开启中位 39.8fps；阴影图禁用 44.3（+4.5）；天穹隐藏 44.6（+0.3）。即阴影装备约 4.5fps、天穹 0.3fps——为影子结构付出的合理代价。
- 跨午夜 23.5→0.5→白天：插值正常，返回白天状态逐值一致（无累积漂移）。

## 部署状态

- `site-babylon-preview/`（8.7MB）已按本轮代码构建，`verify-babylon-deployment` 对本地 stand-in origin **PASS（0 失败）**。
- **线上未部署**：COS/CDN 凭据不在本机。部署步骤：凭据到位 → 按现有发布器增量上传本目录 → 线上核对 Release → 恢复 K-DAY/K-NIGHT 案例。上一可用版本回退：git checkout v3 提交 + 重建。
