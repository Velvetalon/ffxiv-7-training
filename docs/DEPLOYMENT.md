# 部署与拉取后直接运行

统一资源体系及 COS/CDN 发布方式见 [ASSET-PIPELINE.md](ASSET-PIPELINE.md)。资源包通过 CDN 直接送达浏览器；业务服务器仅提供页面、版本目录及受限的签名凭证。以下本地静态运行方式仍保留，用于离线运行、验证与回退。

仓库同时保存源码、完整世界资源快照和预构建的 `site/`。运行成品不需要安装 FF14、解包资源或安装 npm 依赖。当前世界范围为 65 个区域，资源较大，首次拉取和首次载入需要一定时间。

预构建成品采用 CDN 模式时，`npm start` 只提供网页；地图下载还需要同源签名接口。完全独立的本地运行应先生成 Quickstart 中包含资源包的成品。源码和既有原始资源快照继续保留，不要求重新安装游戏。

## 直接启动

安装 Node.js 22 后：

```sh
git clone https://github.com/Velvetalon/ffxiv-7-training.git
cd ffxiv-7-training
npm start
```

默认监听 `0.0.0.0:8080`。可以通过 `PORT`、`HOST`、`BASE_PATH` 环境变量，或 `--port`、`--host`、`--base` 参数配置。服务器只提供仓库内的 `site/`，不会暴露源码、Git 文件或工作目录。

子路径示例：

```sh
node scripts/serve.mjs --port 8080 --base /ff14-web
```

入口是 `/ff14-web/`。不带尾斜杠的 `/ff14-web` 自动重定向，保证相对脚本、图标、模型和贴图路径正确。

## 静态服务器

将 `site/` 内容复制到独立静态目录，给该目录配置 `/ff14-web/` URL 前缀。入口 `/ff14-web` 必须重定向到 `/ff14-web/`。不要将不存在的 `.json`、`.glb`、`.png` 请求重写成 HTML。

可选 Nginx 配置示例；`/srv/ff14-web/current/` 是服务器选定的发布目录，不是项目依赖：

```nginx
location = /ff14-web {
    return 308 /ff14-web/;
}
location ^~ /ff14-web/ {
    alias /srv/ff14-web/current/;
    index index.html;
}
```

服务域名和路径为 `https://yuluo.site/ff14-web/`。本机发现的实际服务器配置、连接验证和发布记录保存在被 Git 忽略的 `work/deployment/`；凭据不提交。

## Docker

```sh
docker build -t ff14-web .
docker run --rm -p 8080:8080 -e BASE_PATH=/ff14-web ff14-web
```

镜像只复制现成的 `site/` 和零依赖静态服务器，不在构建过程中提取地图或安装 npm 依赖。

## 从源码更新成品

```sh
npm ci
npm run verify
npm run verify:camera
npm run verify:extracted
npm run verify:world
npm run release
```

构建只复制 `public/extracted/active.json` 指向的全部地图，并把输出清单中的资源目录改成包含发布版本号的相对路径。旧重建版本不进入成品，跨版本资源不会混用浏览器缓存。

提交源码和更新后的 `site/` 后，服务器拉取新版本即可继续使用 `npm start`。生产环境采用独立发布目录并保留上一版本，校验通过后再切换；回滚时切回旧目录。

## 内容边界

职业规则以 7.0 为目标；地图快照来自清单记录的 `2026.09.01.0000.0000` 客户端版本。材质多层混合、环境光、水面等仍有近似。角色、NPC 和木人尚未替换为完整原版骨骼角色。Havok 动画的离线解码验证见 `ANIMATION-DECODE.md`，它是独立的可行性证明。
