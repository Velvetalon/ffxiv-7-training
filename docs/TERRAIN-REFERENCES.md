# 地形参考与还原范围

保留 FF14 式第三人称 3D、自由镜头和即时技能战斗。早期日式 RPG 仅作为手绘材质、色彩与造型的美术方向，不改变玩法类型。

## 地图依据

地图原图来自 FFXIV Community Wiki：

- `https://ffxiv.consolegameswiki.com/mediawiki/images/3/33/New_Gridania_Map.jpg`
- `https://ffxiv.consolegameswiki.com/mediawiki/images/5/55/Limsa_Lominsa_Lower_Decks1.jpg`

位置说明：

- `https://ffxiv.consolegameswiki.com/wiki/New_Gridania`
- `https://ffxiv.consolegameswiki.com/wiki/Limsa_Lominsa_Lower_Decks`

视觉参考包括上述 Wiki 的区域截图，以及水车和以太之光截图：

- `https://ff14.tabibun.net/guide/img/spot/020118_l.jpg`
- `https://ff14.tabibun.net/guide/img/spot/020101_l.jpg`

本地原图及标尺裁切保存在 `work/references/`。原图不作为游戏场景贴图使用。

## 数据结构

`src/world/terrain/layouts.js` 先保存 `TRACE_PIXELS` 原图像素坐标，再转换为世界坐标：

```
worldX = (pixelX - anchorX) / scale
worldZ = (pixelY - anchorY) / scale
```

| 场景 | 原图尺寸 | 原图坐标基点 | 比例 |
| --- | --- | --- | --- |
| 格里达尼亚新街 | 1930×1930 | `[960, 1040]` | 3 px / 世界单位 |
| 利姆萨下层甲板 | 1924×1926 | `[800, 960]` | 3 px / 世界单位 |

新街包含西北双蛇党与木工房分支、北/东北旧街出口、东部弓术师行会、南部栖木旅馆与蓝獾门、西部白狼门。海都包含八分仪广场、西向东西商人街、秘术师行会及渡轮、东部大厅与和风门、南侧两条环形连接路线、主桅、捕鱼人行会、阿斯塔利西亚号和双剑师行会。

道路、广场、坡道、码头、水域、地标、出生点与 NPC 独立声明。`Navigation` 和 `buildCity` 使用同一数据，地图界面也使用同一数据源，避免视觉路线与碰撞各写一份。

## 明确的还原边界

这是根据二维地图人工描绘主要可通行轮廓、连接关系和地标位置，并以原创三维建筑重建的地形版本。没有从客户端导出地形网格，也没有测绘每栋建筑内部和精确海拔。平台高差、建筑尺寸和细节是依据截图做的近似。

未接入的其他区域在出口位置标识，不创建不存在的可传送区域。木人和训练 NPC 属于练习器添加内容。

`npm run verify:terrain` 检查所有地标/出口/NPC 的可达性、整体路径连通性、出生点、初始木人距离，以及位移不能越出导航区域。这些检查验证内部一致性，不代表与游戏客户端逐坐标一致。
