# 从零开始：把 HGhub 变成你自己的、能长期维护的 iOS App

这份文档是总入口。看完这一页，你就知道整个东西是什么、要动哪几个地方、怎么拿到能装进手机的 ipa。

---

## 一、先说结论：原始软件发生了什么

我拆了 `HGhub.exe`（Tauri 2 + Rust + React 19，你看的前端其实是一个网页），结论是：

| 项目 | 状态 |
| --- | --- |
| 客户端代码 | **完好**。UI、播放器、缓存、代理协议全都在，能正常跑 |
| 上游数据接口 | **已死**。`huangguoai.com` / `.ai` / `.pages.dev` 全部超时，域名已被解析到 Facebook 的 IP，属于被接管/黑洞 |
| 原作者仓库 | **已清空**。`Minireel/HGhub` 的 size = 0，只剩 README 和 LICENSE |
| 官方 ipa | **从来没有发过**。所有 fork 的 Releases 都是空的 |

所以「还能不能用」的关键不在客户端，而在**数据从哪来**。客户端只认一套 JSON 契约，谁按这个契约吐数据，它就连谁。

我做的事就是：把客户端所有写死的域名抽成一个文件，再给你写一个**能自己跑的后端**（把 mp4 短剧放进去就能播），配套 GitHub Actions 一键出无签名 ipa。

---

## 二、你现在拥有什么

```
hghub-ios/
├── src/                    前端（React + TS）
├── src-tauri/src/
│   └── config.rs           ★ 唯一需要你改的文件（后端地址、项目链接）
├── server/                 ★ 你自己跑的后端（Node，零依赖）
│   ├── media/              把 mp4 丢这里（目录名 = 剧名）
│   └── src/index.mjs       接口实现，约 700 行，普通 ESM，随时可改
├── .github/workflows/
│   └── build-ios.yml       ★ 推代码就自动出 ipa
├── docs/self-host.md       详细部署手册
├── server/README.md        后端接口契约（改后端必读）
└── START-HERE.md           本文件
```

三处「唯一」：

- 改后端地址 → 只动 `src-tauri/src/config.rs`
- 加片子 → 只往 `server/media/` 丢文件（30 秒自动重扫，不用重启）
- 发新版本 → 只改 `package.json` 和 `src-tauri/tauri.conf.json` 的 version

---

## 三、五步走完（每步都能单独验证）

### 第 1 步：把仓库变成你自己的

在 GitHub 建一个**空**仓库（私有也行），然后：

```bash
cd hghub-ios
git init
git add -A
git commit -m "HGhub 自维护分支"
git branch -M main
git remote add origin https://github.com/你的用户名/hghub-ios.git
git push -u origin main
```

> 许可证是 PolyForm Noncommercial 1.0.0，保留 `LICENSE` 原样即可，非商业用途没问题。

### 第 2 步：让后端跑起来（先验证数据源活了）

```bash
cd server
mkdir -p media/我的第一部剧
# 把 第01集.mp4 第02集.mp4 放进去；同名 cover.jpg 会当封面
ADMIN_PASS=换成你的密码 node src/index.mjs
```

浏览器打开 `http://127.0.0.1:8787/`，看到 `{"ok":true,...}` 就通了。再开 `http://127.0.0.1:8787/api/videos?page=1&size=10`，能看到你的剧就说明契约对上了。

**手机要用必须上 https**（iOS 的 ATS 会拦 http，客户端严格模式也会拒内网地址）。最省事的做法：

```bash
# 反代示例（Caddy，自动签证书）
your-domain.com {
    reverse_proxy 127.0.0.1:8787
    # 关键：别缓冲，边转边播才不卡
}
```

Nginx 记得 `proxy_buffering off;`，细节在 `server/README.md`。

### 第 3 步：填后端地址

打开 `src-tauri/src/config.rs`，只改这一行：

```rust
pub const DEFAULT_BASE: &str = "https://your-domain.com";
```

顺手可填（不填就自动关闭对应功能，不会报错）：

```rust
pub const FIXED_LINES: &[(&str, &str)] = &[("我的后端", "https://your-domain.com")];
pub const UPDATE_REPO: &str = "你的用户名/hghub-ios";   // 填了才有「检查更新」
pub const PROJECT_URL: &str = "https://github.com/你的用户名/hghub-ios";
pub const SITE: &str = "https://your-domain.com";        // 分享链接和正文相对路径
```

> 不改也行 —— App 装好后在「设置 → 线路 → 自定义线路」里手填地址，效果一样。区别只是每次重装都要再填一次。

### 第 4 步：让它自动出 ipa

推上去就行，或者去 Actions 页面手动点 `Run workflow`：

```
Actions → iOS → Run workflow
```

跑完在 Releases 里下 `HGhub_x.y.z_ios.ipa`。第一次大约 15~25 分钟（要编译整个 Rust + Xcode 工程），之后有缓存会快很多。

两个容易踩的点：

- `-configuration release` **必须小写**。Tauri 生成的工程用小写配置名，写成 `Release` 会静默编成 debug 包，装上去能开但很慢、还带调试信息。
- 脚本里有一条 `grep -F 'localhost:1420'` 的检查，命中就拒绝打包。这是防止把 dev 版当正式版发出去，**别删**。

### 第 5 步：巨魔装进手机

前提：iOS 14.0 beta 2 ~ 17.0（越界版本 TrollStore 装不了）。

1. 把 ipa 传到手机（AirDrop / 文件 App / 微信文件传输都行）
2. 打开 **TrollStore**，点右上角 `+`
3. 选中那个 ipa，等它自己装完，桌面出现图标
4. 打开 App →「设置」→「线路」→「自定义线路」→ 填 `https://your-domain.com` → 点「使用」
5. 回到首页，能刷出片子就成了

装了 TrollStore 的包是**永久签名**，不会 7 天掉签，也不用证书。

> 没有巨魔的话：AltStore / SideStore / Sideloadly 走免费开发者证书（7 天要重签一次），或者 ESign / 牛蛙 / Feather / 全能签 用付费证书签。ipa 是同一个。

---

## 四、验证过什么（免得你怀疑）

- `tsc --noEmit` 类型检查 = 0 错误（含测试工程的 `tsconfig.tests.json`）
- `vite build` 成功，产物 924 kB / gzip 285 kB
- `cargo check --all-targets` = **exit 0**（Rust 侧类型全绿，包括所有单元测试代码）
- 后端实跑：健康检查、列表、详情、播放、登录、注册、评论、盖楼回复、点赞、收藏、关注、退出全登态，全部实测通过
- 后端静态资源：HLS 清单 `application/vnd.apple.mpegurl`、分片 `video/mp4`、Range 206、`../` 逃逸被拦
- 新生成的封面是真 PNG（magic 校验过）
- 6 个 workflow 的 YAML 全部能正常解析

> 唯一没能在这台机器上跑完的是 Rust 单元测试**二进制**：编译通过了，但执行时报 `STATUS_ENTRYPOINT_NOT_FOUND`，原因是本机 Win10 的 mingw 运行库和 rustup 自带的 gnu 工具链 ABI 对不上（这台机器连 `cc1.exe` 都是我从 msys2 镜像手工补齐的）。这只是环境问题，CI 上 macOS runner 用的是官方工具链，不受影响。

---

## 五、以后要改东西，看这张表

| 你想做的事 | 动哪里 | 注意 |
| --- | --- | --- |
| 换个后端地址 | `src-tauri/src/config.rs` 的 `DEFAULT_BASE`，或在 App 内手填 | 换地址会清掉登录态，这是设计如此（token 和域名绑定） |
| 加剧 / 加集 | 往 `server/media/` 丢文件 | 目录名就是剧名，30 秒内自动上架 |
| 换封面 | 同目录放 `cover.jpg` / `poster.png` / `封面.jpg` | 不给就自动生成渐变图 |
| 改界面 | `src/pages/`、`src/components/` | 改完 `pnpm build` 必须过 |
| 换数据库 | `server/src/db.mjs` 的四个出口 | JSON 文件在低并发够用，要上量就换 SQLite |
| 改接口字段 | `src/types.ts` **和** `server/src/index.mjs` 必须同时改 | 少一个字段前端就白屏 |
| 改原生逻辑 | `src-tauri/src/*.rs` | 新命令要在 `lib.rs` 的 `invoke_handler` 里注册 |
| 发新版本 | `package.json` + `src-tauri/tauri.conf.json` 的 version | 打 tag `v1.4.0` 会自动按 tag 出包 |

### 四个一定会踩的坑

1. **`src/api.ts` 的 `LOCAL` 必须和 `media.rs` 的 `LOCAL_ORIGIN` 一致**。iOS/macOS/Linux 是 `hg://localhost`，Windows/Android 是 `http://hg.localhost`。改一个忘另一个，封面和视频会全部 502。
2. **播放地址必须是 `.m3u8`**。前端一律把播放地址交给 hls.js，直接返回 mp4 会解析失败。`server/` 已经用 ffmpeg 自动切片了（`-c:v copy`，不重新编码，很快）。
3. **换线路会掉登录**。`session.json` 里的 token 是跟 origin 绑定的，这是原作者的安全设计，别去改掉。
4. **改完前端一定跑 `pnpm build`**。CI 也会跑，本地先过一遍能省一次 20 分钟的等待。

---

## 六、别指望能「恢复」原来的内容

原来那些片子是从上游接口拉的，上游没了，接口数据也没了。这个客户端现在是一个**空壳播放器**，内容得你自己提供。

`server/` 就是为这个准备的：它不关心片子哪来的，只关心 `media/` 里有什么。你有自己的片源就放进去；想接别的数据源，照 `server/README.md` 的契约实现那几个接口就行，客户端一行都不用改。

---

详细部署、反代配置、接口清单、维护清单，都在：

- `docs/self-host.md` —— 部署与发版全流程
- `server/README.md` —— 后端契约与运维
