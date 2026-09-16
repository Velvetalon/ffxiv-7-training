# 本地工具链部署记录（2026-09-16）

本机的 FF14 解包/检查工具链已部署并通过自检。机器本地组件（`Meddle/`、`dotnet/`、`bin/`、`nuget/`、`.dotnet-home/`、`work/`）均为 Git 忽略的本地生成目录；本文档记录已部署内容与验证方式。

## 已部署组件

| 组件 | 位置 | 版本/来源 |
|---|---|---|
| .NET SDK（便携） | `tools/map-tools/dotnet/dotnet.exe` | 10.0.401（dotnet-install 脚本安装，toolchain.ps1 首选此路径） |
| Meddle 源码 | `tools/map-tools/Meddle/` | 固定提交 `7ef61f44f82c6363465d46b46e963a054d431c16`（v0.1.56.0） |
| MapExtract 构建 | `tools/map-tools/bin/MapExtract.exe` | Release 构建，`selftest` 通过（输出合法 glTF） |
| Python（官方） | `C:\Users\LXN\AppData\Local\Programs\Python\Python310\` | 3.10.11，winget 安装，已注册 PEP 514 |
| py 启动器 | `C:\Users\LXN\AppData\Local\Programs\Python\Launcher\`（已加入用户 PATH） | `py -3` 可用 |
| Pillow | site-packages（py -3） | 12.0.0（requirements.txt 指定版本） |

保留的既有 Python：`E:\Python3.10`（3.10.10，便携，未注册 PEP 514——注册表项已写入但新启动器未采用；不影响本工具链）。

## 验证结果

```text
MapExtract --help          # 命令入口正常（targets/probe/extract-map/collision-map/raw/model/selftest）
MapExtract selftest        # 通过：work/selftest/synthetic-quad.glb（合法 glTF，无游戏数据）
parse_envb.py --help       # 正常（纯标准库实现，无第三方依赖）
py -3 -c "import PIL"      # Pillow 12.0.0
```

## 使用前提与示例

所有提取命令都需要已安装的 FF14 客户端（只读访问），通过环境变量或参数提供：

```powershell
$env:FFXIV_CLIENT = '<客户端目录，含 ffxivgame.ver>'
```

```powershell
# 探测客户端与目录结构
.\MapExtract.cmd probe $env:FFXIV_CLIENT

# 提取单张地图（几何/材质/碰撞）
.\MapExtract.cmd extract-map $env:FFXIV_CLIENT e3t1 .\exports\e3t1

# 提取原始文件（例如 level/bg.lgb 灯光层、.envb 环境文件）
.\MapExtract.cmd raw $env:FFXIV_CLIENT "bg/ex2/02_est_e3/twn/e3t1/level/bg.lgb" .\outside\e3t1-bg.lgb

# ENVB 解码（纯标准库，无客户端依赖，输入为已提取的 .envb）
py -3 tools\map-tools\environment\parse_envb.py .\outside\<name>.envb --output .\outside\<name>.json

# 完整重建管线（提取+转换+发布校验）
.\rebuild-client-maps.ps1
```

## 网络/代理注意

- Meddle 克隆、NuGet 还原、dotnet/Python 下载在本机均需代理 `http://127.0.0.1:7890`
  （git 用 `-c http.proxy=…`；NuGet/dotnet 用 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量；pip 用 `--proxy`）。
- 工具只写输出目录，从不修改或附加游戏进程（MapExtract 声明保持只读）。

## 与光照任务的关系

v4 光照专项中被阻塞的「LGB 灯光实例 / 天空盒资产 / 天气语义」提取，在提供客户端后可立即用
`MapExtract.cmd raw` + `environment/parse_envb.py`（及 `probe_environment.py` 的候选扫描）续作，
无需重复本次工具链部署。
