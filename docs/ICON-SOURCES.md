# 技能图标来源

检索日期：2026-09-09。

已整理 116 个技能图标，覆盖当前三个职业的基础动作和变换动作。通过 7.0 历史 `Action.csv` 的技能英文名、Action ID 和 Icon ID 进行对应，而不是根据颜色或外观猜测。

- 文件信息来自 FF14 灰机 Wiki 的公开 MediaWiki `imageinfo` API。职业页面的 HTML 查询也通过公开 `parse` API取得。
- 灰机普通页面返回 HTTP 403，图片 CDN 返回 HTTP 567；没有绕过访问限制。
- 实际图片下载自公开 XIVAPI 图标资源，使用与灰机文件及历史 7.0 数据相同的 Icon ID。
- 每个文件的灰机 URL、实际下载 URL、SHA-256 和动作映射写入 `public/icons/manifest.json`。
- 图标保留原游戏美术；著作权属于 SQUARE ENIX。原创三维场景素材与这些游戏图标分别管理。

## 数据入口

- `src/ui/action-icons.json`：英文动作名 → 本地图片路径。
- `src/ui/SkillIcon.js`：技能栏/技能书统一图标组件；未匹配动作使用通用后备图标。
- `scripts/fetch-skill-icons.py`：重建数据对应和下载图片。
- `scripts/preview-skill-icons.py`：生成三职业图标对照图。

历史规则数据提交：`xivapi/ffxiv-datamining@1b6d74360fcb3665dd5ab2f62129144112caf0f8`（7.0）。此次只替换界面图片，不采用当前 Wiki 的后续版本技能数值。
