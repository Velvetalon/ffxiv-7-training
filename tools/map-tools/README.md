# FF14 本地地图工具

状态日期：2026-09-09。两张真实地图已用客户端版本 `2026.09.01.0000.0000` 完整重建并验证；这不是对严格 7.0 历史资源的声明。

## 在训练器仓库中使用

此目录应位于 `tools/map-tools`。所有运行时默认路径都由此目录推导：项目根为 `tools/map-tools/../../`，导出目录为 `tools/map-tools/exports`。没有写死的盘符或客户端路径。

首次只需准备源码依赖和 .NET 10 SDK：

```powershell
cd tools/map-tools
.\bootstrap-map-tools.ps1
```

bootstrap 会拉取并校验固定 Meddle 提交到本目录的 `Meddle/`、用 `dotnet/dotnet.exe`（若存在）或 PATH 上的 .NET 10 SDK 构建工具。它不会下载、修改或启动游戏。`Meddle/`、`dotnet/`、`bin/`、`nuget/` 和导出资源均为本地生成/获取目录，不应纳入源码包。

Python 入口固定使用 Windows Python launcher：需要可用的 `py -3`（验证环境为 Python 3.10.5）以及 Pillow。首次执行：

```powershell
py -3 -m pip install -r .\requirements.txt
```

客户端路径必须显式传递，或通过环境变量提供：

```powershell
$env:FFXIV_CLIENT = 'D:\Games\FFXIV'
.\rebuild-client-maps.ps1
# 外部目录运行时，显式指定训练器根：
.\rebuild-client-maps.ps1 -Project 'D:\work\ffxiv-7-training' -Client 'D:\Games\FFXIV'
```

批处理会构建工具、读取客户端、提取碰撞和小地图、转换模型、组装材质与实例，并调用训练器的 `scripts/verify-extracted.mjs`。`-SkipExtract` 复用当前 `exports`；`-NoPublish` 仅验证独立 stage，不修改 `active.json`；`-Node` 可传入 Node 可执行文件。未提供 `-Node` 时优先使用 Codex runtime 的 Node，其次使用 PATH 上的 Node 20+。

命令行入口在完成 `.\build.ps1` 后可直接使用：

```powershell
.\MapExtract.cmd probe $env:FFXIV_CLIENT
.\MapExtract.cmd extract-map $env:FFXIV_CLIENT gridania .\exports\gridania
```

`assemble_scene.py` 和 `collision_mesh.py` 单独执行时的输出默认在本目录的 `assembled/`；批处理会显式传入不可见的 release stage。客户端目录始终只读。

路径可以指向安装根目录，也可以直接指向其 `game` 目录。其中必须实际存在 `game/sqpack`。

工具输出：

- 原始 LVB/LGB、地形分块 TERA、MDL、碰撞及依赖资源。
- 独立模型的几何 GLB。
- 场景摆放的位移、旋转、缩放，以及地形分块位置。
- 清单记录实际客户端版本、缺失文件与解析错误。

`model-folder` 为 GLB 增加法线、UV 和材质路径；`assemble_scene.py` 展开 LGB/SGB 场景、过滤节日层、解码 TEX 贴图并生成实例清单；`collision-map` 提取原始地形 PCB，`collision_mesh.py` 合并原始地形和实例碰撞。MTRL 采样器 CRC 会分别绑定颜色、法线和高光贴图，并应用 UV 缩放。

真实结果：新街 699 个模型、2,452 个实例、98,518 个碰撞三角形；海都 771 个模型、7,024 个实例、227,082 个碰撞三角形。导出、贴图解码、实例组装与碰撞转换均无错误。MTRL 采样器 CRC 已绑定颜色/法线/高光贴图并应用 UV 缩放；完整游戏 shader、环境光和动态动画仍为近似，不宣称原引擎逐像素一致。

目标来自 7.0 历史 TerritoryType/Map 数据：

| 地图 | Territory ID | 名称 | 资源根 |
| --- | --- | --- | --- |
| 格里达尼亚新街 | 132 | f1t1 | `bg/ffxiv/fst_f1/twn/f1t1` |
| 利姆萨下层甲板 | 129 | s1t2 | `bg/ffxiv/sea_s1/twn/s1t2` |

根路径之后的入口由 `MapExtract.cmd targets` 列出；本机 `probe` 已确认两张地图各 6 个入口全部存在。

## 已执行验证

- Release 构建成功，0 错误；上游代码有 2 个非阻塞编译警告。
- CLI 帮助和目标表运行成功。
- `selftest/synthetic-quad.glb` 为显式合成的四边形测试资源，已通过项目 Three.js `GLTFLoader` 读取：1 网格、4 顶点、6 索引。
- 已在真实客户端解析两张地图，并在 Three.js 中加载基础纹理、原始碰撞与场景摆放；角色落地、行走、木人施法和第三人称镜头已验证。

## 来源

- 国服官网：`https://ff.web.sdo.com/web8/index.html#/download`
- 官方客户端下载配置：`https://ff.web.sdo.com/web8/ffconfig.js`
- Meddle：`https://github.com/PassiveModding/Meddle`
- SDK 清单：`https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json`
- 7.0 数据：`xivapi/ffxiv-datamining@1b6d74360fcb3665dd5ab2f62129144112caf0f8`

历史验证在本机的独立工作目录完成，客户端曾位于 `G:\WeGameApps\rail_apps\ffxiv(2000340)`；这仅是审计证据，不是运行时默认值。训练器资源位置、是否提交私有仓库及其发布策略由训练器仓库决定。
