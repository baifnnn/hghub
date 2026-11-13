# 自己维护 HGhub（iOS / TrollStore）

这份文档写给「原作者删库之后，自己想继续用、也想自己改」的情况。
按顺序走完，你手上会有一个**完全属于你自己**的构建：代码在你仓库里，
数据源在你自己的服务器上，IPA 由 GitHub 的 macOS 机器免费编出来。

---

## 0. 现状判断（先看清楚发生了什么）

| 东西 | 状态 |
| --- | --- |
| 客户端程序 | **完好**。Tauri 2 + Rust 外壳 + React 前端，逻辑一点没坏 |
| 上游接口 `huangguoai.com` / `.ai` | **已死**。域名被接管 / 连接超时，DNS 都不对了 |
| 镜像发布页 `huangguoai.pages.dev` | **已死** |
| 原 GitHub 仓库 | 源码被清空（`size=0`），fork 里还有代码 |
| 官方 IPA | 从未发布过（所有 fork 的 Releases 都是空的） |

结论：**坏的不是软件，是数据源**。所以要做的事只有三件 ——
拿到源码、把数据源换成自己的、把它编成能装进手机的包。

---

## 1. 把源码变成你自己的仓库

1. 在 GitHub 新建一个**空仓库**（私有就行），比如 `yourname/hghub-ios`。
2. 把本项目目录推上去（本目录已经清掉了所有硬编码域名、Team ID、代理规则表）：

```bash
cd hghub-ios
git init
git add .
git commit -m "fork: 可自维护版本，数据源可配置"
git branch -M main
git remote add origin https://github.com/yourname/hghub-ios.git
git push -u origin main
```

3. 之后所有改动都在这个仓库里，原项目再也影响不到你。

> 许可证是 PolyForm Noncommercial 1.0.0（自用、非商业），
> 保留 `LICENSE` 原文即可，别删。

---

## 2. 唯一需要改的文件：`src-tauri/src/config.rs`

原作者把数据源写死在十几个地方。现在全部收敛到一个文件：

```rust
pub const DEFAULT_BASE: &str = "https://hghub.example.com";  // 首选后端地址
pub const FIXED_LINES: &[(&str, &str)] = &[];                // 设置页里的固定线路
pub const PUBLISH_PAGE: &str = "";                            // 镜像发布页，留空=关闭自动发现
pub const UPDATE_REPO: &str = "";                             // "yourname/hghub-ios"，留空=关闭检查更新
pub const SITE: &str = "";                                    // 分享链接/正文相对路径的基址
pub const PROJECT_URL: &str = "";                             // 关于页显示的项目地址
```

怎么填：

- **自己部署了后端** → `DEFAULT_BASE = "https://api.你的域名.com"`，客户端装上就能直接用
- **还没部署** → 全部留空。装好后打开「设置 → 线路 → 自定义线路」，手填地址，立刻生效
- `UPDATE_REPO` 填了之后，「检查更新」会去你的 Releases 找新版本
- `SITE` / `PROJECT_URL` 是可选装饰，不填不影响使用

改完这个文件，`vite.config.ts` 会自动把它读进前端（`__SITE__` / `__PROJECT_URL__`），
不需要再改别的地方。

---

## 3. 准备一个自己的后端

仓库里的 `server/` 就是现成的，零依赖、单进程：

```bash
cd server
mkdir -p media/某部剧
# 把 第01集.mp4、第02集.mp4 丢进去
ADMIN_PASS=你的密码 PUBLIC_BASE=https://api.你的域名.com node src/index.mjs
```

详见 [`server/README.md`](../server/README.md)。要点：

- 目录名 = 剧名，`cover.jpg` 认作封面，没有封面会自动生成一张渐变图
- 播放走 ffmpeg 边转边看，缓存到 `server/cache/`
- **iOS 只接受 https**，所以生产上必须套 Caddy/Nginx 反代

---

## 4. 编出 IPA（不需要 Mac，也不需要开发者账号）

仓库里已经配好 `.github/workflows/build-ios.yml`：

1. 推到 `main`，或手动 Actions → `Build iOS IPA` → Run workflow
2. macOS 机器会：装依赖 → `tauri ios init` → 改 Info.plist（横竖屏 + ATS）
   → `scripts/build-ios-unsigned.sh` 用 `CODE_SIGNING_ALLOWED=NO` 编
   → 打成 `HGhub_<版本>_ios.ipa`
3. 产物在 **Actions 的 Artifacts** 里，同时会建一个 `v<版本>-ios` 的 Release

几个细节，改之前先看一眼：

| 位置 | 作用 |
| --- | --- |
| `APPLE_DEVELOPMENT_TEAM` 环境变量 | 只是 Tauri 生成 Xcode 工程时需要一个 10 位占位值，无签名构建用不到真 Team。想用自己的就在仓库 Secrets 里加同名变量 |
| `scripts/build-ios-unsigned.sh` 里 `-configuration release` | **必须小写**。Tauri 生成的工程是小写配置名，写 `Release` 会静默选到 debug |
| 脚本里的 `localhost:1420` 检查 | 防止把开发版当正式版发出去，别删 |
| 打包名 `HGhub_${VERSION}_ios.ipa` | 想改名就改这一行 |

版本号只改两处：`package.json` 和 `src-tauri/tauri.conf.json`（workflow 会自动对齐）。

---

## 5. 装到 iPhone（TrollStore / 巨魔）

无签名 IPA 走巨魔是因为它用系统漏洞做**永久签名**，不会 7 天掉签。

### 前提

- 系统版本在 TrollStore 支持范围内（大致 iOS 14.0 beta 2 ~ 17.0，具体看巨魔官方支持表）
- 已经装好 TrollStore 本身（没装的话先去装，这一步跟本项目无关）

### 安装

1. 把 `HGhub_1.3.3_ios.ipa` 传到手机（AirDrop / 文件 App / 局域网）
2. 打开 **TrollStore** → 右上角 `+` → 选那个 ipa
3. 等它自己装完，桌面出现 HGhub 图标
4. 首次打开如果提示「未受信任的开发者」，说明走的不是巨魔安装 —— 回上一步

### 第一次打开要做的

1. 进「设置 → 线路」
2. 在**自定义线路**里填 `https://api.你的域名.com`（或你 `DEFAULT_BASE` 里填的地址）
3. 点「使用」→ 回首页，应该能看到片子了
4. 顺手把「严格安全模式」保持**开启**（它挡的是上游投毒和内网探测，自建后端不受影响）

### 其它装法（都不如巨魔省心）

- **AltStore / SideStore / Sideloadly**：个人 Apple ID 自签，7 天要重签一次
- **ESign / 牛蛙 / Feather / 全能签**：拿证书签名，证书掉了就废

---

## 6. 日常维护清单

| 想做什么 | 改哪里 |
| --- | --- |
| 换后端地址 | `config.rs` 的 `DEFAULT_BASE`，或客户端里手填 |
| 加/删片子 | 直接动 `server/media/`，30 秒内自动重扫 |
| 改界面 | `src/pages/`、`src/components/`（React + Tailwind） |
| 改接口字段 | `src/types.ts`（前端）与 `server/src/index.mjs`（后端）必须同步 |
| 改原生能力 | `src-tauri/src/*.rs`，命令在 `lib.rs` 的 `invoke_handler` 里注册 |
| 发新版本 | 改两处 version → 打 tag `v1.4.0` → push，自动出包 |
| 完全换数据源实现 | 只要守住 `server/README.md` 里那份接口契约，随便用什么语言写 |

### 别踩的坑

- **`src/api.ts` 里的 `LOCAL` 必须和 `media.rs` 的 `LOCAL_ORIGIN` 一致**
  （iOS/macOS 是 `hg://localhost`，Windows/Android 是 `http://hg.localhost`），
  改一个不改另一个，封面和视频全部 502。
- **播放地址必须是 `.m3u8`**。前端拿到非 m3u8 的直链会直接丢给 hls.js 然后失败。
- **换 base 会清登录态**（token 与 origin 强绑定），这是设计如此，不是 bug。
- 每次改完前端跑一次 `pnpm build`（会顺带跑 `tsc --noEmit`），类型错了当场能看见。

---

## 7. 如果你只想「能用」，不想碰代码

最短路径：

1. 找台常年开的机器（NAS、VPS、旧笔记本）跑 `server/`
2. Fork 本项目 → 只改 `config.rs` 里的 `DEFAULT_BASE` → 推上去等 Actions 出包
3. 巨魔装包，打开就能看

之后再也不用管它。上游是死是活跟你没关系了。
