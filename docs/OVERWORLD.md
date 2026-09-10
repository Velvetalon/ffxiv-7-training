# 大世界转换与区域连接

本次扩展以随仓库保存的 7.0 `TerritoryType`、`Map` 和 `PlaceName` 数据表确定范围。客户端资产仍取自实际安装版本，不能据此宣称是历史 7.0 画面快照。

## 范围及可复现清单

`tools/map-tools/world-catalog.json` 包含 65 个区域：47 个常规户外区域与 18 个城市或公共据点。其中包括原有的新街与海都下层甲板。筛选依据是公共城市/户外用途、版本不晚于 7.0，并排除住宅、PvP 和其他实例用途；未纳入的有资源区域逐条记录排除理由。

```powershell
python tools/map-tools/build_world_catalog.py
```

生成器只读取 `tools/map-tools/data/` 的已保存数据，清单记录各表 SHA-256、TerritoryType 行号、Map 行号、客户端资源根路径和地图纹理路径。名称翻译独立于区域选择规则。

`MapExtract probe-catalog <client-root>` 检查每个清单区域的背景布局、地形和碰撞索引是否存在。它只验证资源入口；完整转换还必须验证模型、材质、碰撞和安全落地点。

2026-09-09 的实际客户端探测已确认 65 个区域的上述入口全部存在。布局解析读取全部 65 份 `planmap.lgb`，得到 145 条清单内连接：134 条严格互逆匹配，11 条具有源记录指定的目标入口、但没有严格互逆的出口 ID。另有 38 条通往清单外区域，以及 2 条目标实例 ID 为零，均单独记录。

## 区域衔接方式

各区域保留客户端原始坐标，按区域边界进行加载切换。不能把不同地区的局部原点直接叠放为同一个场景，也不能为了填补未知连接关系随意创造出口。

场景清单中的连接点使用以下数据：

```json
{
  "id": "source-endpoint-id",
  "targetScene": "destination-scene-id",
  "targetConnection": "destination-endpoint-id",
  "position": [0, 0, 0],
  "spawn": [0, 0, 4],
  "radius": 3,
  "name": "区域出口",
  "source": { "description": "必须由转换器填写的原始记录证据" }
}
```

这是字段示例，不是实际连接坐标。`position` 是当前区域可交互位置；`spawn` 是通过另一侧连接进入当前区域时的本地落地点。`targetConnection` 指向目标区域的对应端点。确需使用显式目标坐标时，出发端的 `arrival` 表示目标区域坐标，与本地 `spawn` 区分。

玩家靠近后按 `F` 或点击提示进入；`Q/E` 仍用于横移。地图窗口列出出口，点击地标可在脱战练习时前往附近。进入目标图之前会检查真实碰撞地面；加载失败保留原区域。

## 验证命令

```sh
npm run verify
npm run verify:camera
npm run verify:extracted
npm run verify:world
```

`verify:extracted` 按激活清单检查全部区域，验证模型与材质引用、实例矩阵、碰撞和可行走练习点。`verify:world` 检查发布目标、端点对应、原始来源记录、入口距离、跨楼层误触发和目标落地。尚未完成的转换或连接不得仅凭资源入口探测或这份文档认定完成。

独立源审计逐字节比对原始导出与组装后的 GLB，并重新组合布局变换。少量客户端模型的源 UV 中含 `NaN`：审计保留并统计这些源异常；运行时仅将非有限 UV 分量置零、非有限颜色分量置一，记录在几何体的 `sourceInvalidRenderComponents`。磁盘 GLB 不被悄悄改写，正常 UV 和颜色保持原值。

发布包装可以使用无损 WebP 与 gzip 碰撞数据。WebP 必须逐文件解码后 RGBA 字节完全一致，仅在体积更小时使用；碰撞数据解压后校验原始字节数与 SHA-256。缓存和中间数据不进入运行资源目录。

## 完整重建入口

准备工具依赖后：

```powershell
.\scripts\rebuild-world.ps1 -Client "<客户端安装目录>"
```

入口按完整清单转换到独立目录，然后读取原始连接布局，将入口投影到实际可行走碰撞面，运行全图和全连接校验。全部通过才原子替换当前索引；`-NoPublish` 可以只验证而不发布。

转换失败后先修复报告中的具体问题，再用同一个 run ID 续跑：

```powershell
.\scripts\rebuild-world.ps1 -Client "<客户端安装目录>" -ResumeRun "<原 run ID>"
```

已完整转换的区域可复用。不能因为观察工具超时而启动第二个并行重建；先核对原进程是否仍然存在和报告是否真的终止。
