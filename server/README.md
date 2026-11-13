# HGhub 自建后端（server/）

一个**零第三方依赖**的 Node 服务，把本地媒体库变成客户端能吃的 HGhub 后端。
客户端只要在「设置 → 线路 → 自定义线路」里填上这个服务的地址就能用。

## 为什么需要它

原作者的 `huangguoai.*` 系列域名已经全部下线（DNS 被接管 / 连接超时），
客户端本身是完好的 Tauri + React 外壳，缺的只是**数据源**。
这个 server 就是那个数据源：你自己放片源，它负责扫描、出列表、出详情、把视频转成 HLS。

## 三分钟跑起来

```bash
cd server
mkdir -p media/我的剧/          # 目录名 = 剧名
# 把视频丢进去，命名成 第01集.mp4 / 第02集.mp4 …
ADMIN_PASS=你的密码 node src/index.mjs
```

启动后终端会打印管理员账号（默认 `admin`）。手机和电脑在同一网段时，
客户端「自定义线路」填 `http://192.168.x.x:8787` —— **但注意两点**：

1. iOS 上 `http` 会被系统拦住，非 https 的地址客户端本身也不接受；
2. 客户端的「严格安全模式」默认开启，会拒绝内网/回环地址（防 DNS 投毒）。

所以局域网直连只适合**临时调试**：要么在设置里关掉严格安全模式，
要么（推荐）按下面「反向代理」那节套一层 TLS，用域名访问。

## 目录约定

```
server/
  media/
    某部剧名/                ← 目录名就是剧名
      cover.jpg              ← 可选，认 cover/poster/folder/封面 开头的图片
      第01集.mp4
      第02集.mp4
    单文件短剧.mp4           ← 单文件也当成 1 集
  data/db.json               ← 账号、点赞、收藏、评论（自动生成）
  cache/<hash>/              ← HLS 转码产物（自动生成）
```

集号解析顺序：`第12集` → `EP12` → `E12` → 文件名里的裸数字。
排序按解析出的集号，跟文件名分开写也没关系。

支持的源格式：`.mp4 .m4v .mov .mkv .webm .avi .flv .ts`，以及已经是 `.m3u8` 的（直接代理）。

## 视频怎么变成能播的

客户端只有一条播放路径：拿到 `.m3u8` 交给 hls.js / 原生 HLS。

所以 `GET /api/videos/:id/play?ep=1` 返回的不是原始 mp4，而是一个 HLS 播放列表地址：

1. 首次请求 → 后台起 `ffmpeg` 把整段切成 fMP4 分片写进 `cache/`
2. 同一时刻就把 m3u8 返回给客户端，**边转边看**
3. 转完把 `EVENT` 改成 `VOD` 并补 `#EXT-X-ENDLIST`，写 `.done`
4. 之后同一集直接读缓存，不再转码

> 需要本机有 `ffmpeg`（`PATH` 里能找到，或用 `FFMPEG=/path/to/ffmpeg` 指定）。
> 没装的话列表和详情照常能看，只有播放会 500。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `PUBLIC_BASE` | 空 | 对外地址，如 `https://api.your-domain.com`。**生产环境必须设**，否则按请求头推断，反代后面容易拼错 |
| `MEDIA_DIR` | `server/media` | 媒体库根目录 |
| `DATA_DIR` | `server/data` | `db.json` 所在目录 |
| `CACHE_DIR` | `server/cache` | HLS 缓存目录 |
| `ADMIN_USER` | `admin` | 首次启动创建的管理员用户名 |
| `ADMIN_PASS` | 随机 | 首次启动创建的管理员密码（只打印一次） |
| `HLS_TIME` | `6` | 分片时长（秒）。越大分片越少、起播越慢 |
| `FFMPEG` | `ffmpeg` | ffmpeg 可执行文件路径 |

## 接口

客户端有两套走法，本服务**都支持**：

- `POST /api/edge/request` —— 客户端默认的「边缘信封」
  请求体 `{"method","path","body"(base64),"content_type"}`，响应 `{"status":1,"data":…}`
- 同名 REST 直连（`GET /api/videos` 等）—— 客户端在信封返回 404/405/501 时会自动降级到这里

已实现：

```
POST /api/account/loginByPassword      { username, password } → { token, user }
POST /api/account/registerByPassword   { username, password, confirm_password }
POST /api/account/logout
GET  /api/account/me

GET  /api/videos?page=&size=
GET  /api/videos/category/:cate?page=&size=
GET  /api/ranks/:kind                  推荐 recommend / 潜力 potential / 其他当热门
GET  /api/search?q=&page=&size=
GET  /api/videos/:id
GET  /api/videos/:id/play?ep=
POST /api/videos/:id/episodes/:ep/playback      （客户端优先走这个）

GET  /api/videos/:id/comments?ep=&page=&size=
POST /api/videos/:id/comments           { ep, text, reply_id? }
POST /api/videos/:id/like?ep=   /  DELETE
POST /api/videos/:id/collect    /  DELETE

GET  /api/posts?page=&size=
GET  /api/posts/:id
GET  /api/posts/:id/comments
POST /api/posts/:id/collect

POST /api/users/:uid/follow     /  DELETE
```

静态资源：`/cover/:id.png`、`/hls/:key/*`、`/rawhls/:id/:ep/*`，支持 `Range` 请求。

## 数据形状的硬要求

客户端 `src/types.ts` 里的字段是**写死的**，服务端必须按它产出，少字段会白屏。关键几条：

- 列表项要有 `id/title/cover/episode_count/total_episodes/is_finished/is_original`，
  计数用 `like_count/collect_count/comment_count`
- 详情要有 `episodes[]`（每项 `ep_num/title/duration/status`）、`counts{collect,comment,hot,like}`、
  `interaction{collected,liked,liked_ep}`
- 播放信息要有 `video_url`（**必须是 .m3u8**）或 `streams.main`
- 分页统一 `{ items, pagination{page,pages,size,total} }`

## 反向代理（建议）

iOS 客户端只接受 **https** 的后端地址，所以生产上必须套一层 TLS。
Caddy 最省事（自动签证书）：

```
api.your-domain.com {
    reverse_proxy 127.0.0.1:8787
}
```

然后服务端加 `PUBLIC_BASE=https://api.your-domain.com` 再启动 —— 拼封面和播放地址时会用它。

Nginx 的话注意两件事：`proxy_buffering off;`（否则 HLS 分片会卡），
以及 `client_max_body_size` 给够（评论接口）。

## 加片源之后

服务每 30 秒自动比对一次媒体库，有增删就重扫，不用重启。
想立刻生效就重启进程，或者等半分钟。

## 想换成数据库？

`src/db.mjs` 就只有 `init / save / flush / data` 四个出口，
把里面换成 SQLite 或 Postgres 即可，`index.mjs` 一行都不用改。
数据量真的到几万条再说，这个规模用 JSON 反而更省事。
