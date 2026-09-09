# 离线动画解码实验源码

此目录保存上一轮已经在本机验证的 PAP/SKLB 解码桥接原型，不参与网页构建或启动。证明结果、真实样本校验值与边界见 `../../docs/ANIMATION-DECODE.md`。

源文件职责：

- `inspect_fixtures.py`：读取 `fixtures/` 中的 PAP/SKLB 包装，拆出 Havok payload。
- `hkx_dump.cpp`：通过 hkxparse 读取旧版 binary tagfile 对象图。
- `spline_probe.cpp`：将压缩数据与 binding 交给 HavokLib，导出逐帧 TRS。
- `build_animation_glb.py`：使用本目录的 `skeleton-dump.txt` 与 `joy-tracks.csv` 生成实验动画 GLB。
- `verify_three.mjs`：使用仓库 npm 依赖加载本目录生成的 `cbem_joy.animation.glb`，验证动画轨道及实际姿态变化。

第三方源码依赖保持独立，不提交编译器、SDK、可执行文件或原始客户端样本：

| 依赖 | 固定提交 | 许可证 |
| --- | --- | --- |
| `https://github.com/exyorha/hkxparse` | `7328d2ca732bc418d995528068b937cba065e3af` | MIT |
| `https://github.com/PredatorCZ/HavokLib` | `ef5d5c6f5ab8d7f32cb4e8983300b8db61e4dc6b` | GPL-3.0 |

本机证明使用 Visual Studio C++ 14.29 手工编译上述两个 C++ 工具。这里保存的是实验源码，不提供未经验证的通用跨平台构建命令；依赖和具体解码格式说明记录在证明报告中。应用本身已在 `site/` 中预构建，无需运行此实验。

生产化仍需更多 PAP 编码样本、真实角色蒙皮绑定、叠加动作、根运动、时间线与怪物骨骼验证。
