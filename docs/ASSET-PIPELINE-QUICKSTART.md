# 资源加载框架：构建、运行与继续优化

框架源码、打包工具和部署能力已落地，支持完整 65 地图目录和 COS/CDN 资源分发。构建、上传和版本切换分开执行；构建工具不会自动上传或切换线上版本。具体已部署版本由发布记录确认。

## 一次构建

需要 Node.js 22+；生成贴图预览层时还需要 Python 3.10+ 和 Pillow。构建输入是 `public/extracted/active.json` 指定的已转换资源，不会启动游戏客户端解包。

先查看实际执行计划：

```sh
node scripts/assets/build-pipeline.mjs --out work/assets-demo --scenes gridania,limsa --plan-only
```

执行两图构建：

```sh
node scripts/assets/build-pipeline.mjs --out work/assets-demo --scenes gridania,limsa
```

不传 `--scenes` 则分析当前目录中的全部区域。完整世界的分析与资源包较大；工具将分析结果分片，避免把整个世界 JSON 转成一个超大字符串。

复用明确指定的分析结果，并启用可选碰撞分块：

```sh
node scripts/assets/build-pipeline.mjs --out work/assets-release --analysis work/assets-demo/analysis/shards/index.json --collision-chunks
```

`--analysis` 是显式复用：输入地图发生变化时重新分析。`--python` 可以指定装有 Pillow 的解释器。预览图按源文件哈希缓存；资源包按内容哈希命名，相同资源可复用。

最后的 `pipeline-result.json` 给出成品目录。成品中的 `publish-manifest.json` 是发布入口，包含全部允许发布的相对路径、长度、哈希、类型及可选 Content-Encoding。不要上传整个临时工作目录。

## 本地运行成品

在 PowerShell 中：

```powershell
$env:ASSET_PIPELINE_DIR = 'G:\path\to\pipeline-result中的release目录'
$env:ASSET_PIPELINE_LINKS = '1'
npm run release
node scripts/serve.mjs --base /ff14-web --port 8080
```

`ASSET_PIPELINE_LINKS=1` 对不可变资源尝试使用硬链接，减少大型构建占用的磁盘空间。默认使用复制。运行生成的 `site/` 不需要 Pillow、游戏客户端或构建依赖。修改框架源码后需要重新构建。

## 发布到 COS/CDN

先执行本地验证与 dry-run：

```sh
python scripts/assets/publish-cos.py --dir <成品目录> --prefix ff14-assets/v1
```

发布器从进程环境读取 `TENCENTCLOUD_SECRET_ID`、`TENCENTCLOUD_SECRET_KEY`、`COS_REGION`、`COS_BUCKET`。不要把密钥写进前端、清单或仓库。

- `--apply`：HEAD 校验后增量上传缺失对象。
- `--activate`：全部资源通过验证后才更新版本指针。
- 相同对象只有长度、哈希元数据和 Content-Encoding 都匹配才跳过。

浏览器资源入口是 CDN；业务服务仅提供页面和小型签名凭证。签名侧车见 `scripts/asset-ticket-server.mjs`，配置及回滚细节见 `ASSET-PIPELINE.md` 和本机忽略目录中的部署记录。

构建服务器上的小型网页成品时，同时设置 `ASSET_PIPELINE_DIR` 和 `ASSET_CDN_TICKET=/ff14-assets/ticket`。此模式在 `site/` 中保留完整地图目录，但不复制大型 pack；浏览器向签名接口申请后直接从 CDN 下载。不要给 CDN 模式成品额外拷贝完整资源包。

## 如何接入新资源类型

地图的 GLB、贴图、材质、导航碰撞已实际接入。角色、动画、坐骑、音频、VFX 的后续转换器需要产出相同 Registry/Manifest 协议，并注册对应 decoder；目前没有虚构这些资源已经完成导入。

```js
runtime.decoder('animation', decodeAnimation, disposeAnimation);
const resource = await runtime.load(resourceId, { priority: 0, signal });
runtime.release(resourceId);
```

业务模块不应自行拼接 COS 路径或持有签名密钥。ResourceID 表示资源内容；地图中的摆放与材质装配关系另外记录，避免同一几何复用时关联错误的材质。

## 验证与性能测量

```sh
node scripts/assets/verify-runtime.mjs
node scripts/assets/verify-delivery.mjs
node scripts/verify-asset-world.mjs --url=http://127.0.0.1:8080/ff14-web/ --out=work/world-verification.json
npm run verify
npm run verify:camera
node scripts/benchmark-assets.mjs --url=https://站点/ff14-web-preview/ --out=work/benchmark.json --scenes=gridania,limsa
```

Benchmark 需要 Playwright，可安装在项目或通过 `PLAYWRIGHT_MODULE_PATH` 指定既有安装；浏览器路径通过 `--browser-path` 指定。原始 URL 的签名 query 不会写入报告。

指标分别判断：首次可见画面 <10 秒、首次可交互 <30 秒、缓存回访 <5 秒。不能把加载遮罩后面的渲染帧当作用户看到的首帧，也不能把 TTI 与完整贴图、远景全部加载完成混为一谈。

## 当前边界与后续方向

- Pack 使用独立资源片段和 offset/length 索引；支持整包与 Range。Range 阈值应通过实际网络 Benchmark 决定，默认不凭经验强开。
- 贴图预览层暂时降低初始纹理分辨率，后台恢复原始贴图；Fully Loaded 包含恢复完成。
- 当前内存预算优先保留被引用资源。若单张地图的活跃资源本身超过预算，不能通过强行释放仍在使用的贴图来保证硬上限。
- 自动分组使用可解释的引用集合、启动集合、空间和类型规则。真实 Trace 已预留，可继续用于打包调整；没有实现复杂的自动优化模型。
- 碰撞分块是可选功能；近区分块支持提前进入，后台提升为完整碰撞 BVH。无损数据与查询一致性检查不能代替完整世界浏览器验收。
