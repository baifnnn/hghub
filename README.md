# HGhub（自维护版）

**Tauri 2 + Rust + React 的短剧客户端，数据源完全可配置。**

这个仓库是从原项目 fork 出来的**自维护分支**。原作者的 GitHub 仓库已经清空、
上游 `huangguoai.*` 接口全部下线，正版客户端打开就是一片空白。
本分支做了三件事：

1. **拔掉所有写死的域名** —— 数据源收敛到 [`src-tauri/src/config.rs`](src-tauri/src/config.rs) 一个文件
2. **自带一个后端** —— [`server/`](server/) 把本地视频目录直接变成客户端能读的 API（零第三方依赖）
3. **构建流程去个人化** —— GitHub Actions 免费出无签名 IPA，直接扔进 TrollStore（巨魔）

**从零到装上手机，一步不跳的走法：看 [`START-HERE.md`](START-HERE.md)。**
只想看部署与发版的细节：看 [`docs/self-host.md`](docs/self-host.md)。

---

## 架构

```text
┌─────────────────────────┐
│  iOS / 桌面客户端        │
│  React 19 + hls.js      │  ← 界面、播放、交互
│        ↕ invoke         │
│  Rust (Tauri 2)         │  ← 网络、缓存、HLS 代理、账号态
│        ↕ HTTPS          │
└─────────────────────────┘
             │
             ▼  可换成任何人部署的实例
┌─────────────────────────┐
│  server/ (Node, 无依赖)  │
│  扫描媒体库 → API → HLS  │
└─────────────────────────┘
```

客户端不关心后端是谁，只认一套 HTTP 契约（见 [`server/README.md`](server/README.md)）。
只要满足契约，后端用 Go、Python、Java 重写都行。

---

## 特点

- **播放链路**：`hg://localhost/hls` 本地协议代理 m3u8 与分片，AES Key 与分片内存缓存，
  拖进度条自愈重连，片尾自动连播
- **原生能力**：iOS 横竖屏调用系统屏幕方向 API，物理横置自动全屏
- **触控**：双指缩放平移（1x–4x）、单击清屏、双击暂停、长按 2x 倍速、横滑预览定位
- **网络策略**：严格模式防内网探测与 DNS 回退投毒，可选关闭
- **线路管理**：固定线路 + 手动自定义 + 可选镜像自动发现，切换即时生效

## 目录

```text
src/                界面、交互、状态管理
src-tauri/          原生能力与 Rust 实现
  src/config.rs     ★ 唯一需要改的配置文件
  src/net.rs        网络与「边缘信封」请求
  src/media.rs      hg:// 协议：HLS 改写、封面解密、缓存
  src/lines.rs      线路发现与探测
server/             自建后端（Node 原生 ESM，零依赖）
scripts/            构建与验证脚本
docs/               维护说明
tests/              回归用例
.github/workflows/  构建流水线（含 iOS 无签名 IPA）
```

## 本地开发

需要 Node 22+、pnpm 10+、Rust 1.90+，以及目标平台的 Tauri 环境。

```bash
pnpm install --frozen-lockfile
pnpm dev             # 只起前端（浏览器里调 UI）
pnpm app:dev         # 桌面端完整应用
pnpm build           # 类型检查 + 前端构建
```

后端单独跑：

```bash
cd server && ADMIN_PASS=你的密码 node src/index.mjs
```

- exFAT 等不支持符号链接的文件系统需保留 `.npmrc` 里的 `node-linker=hoisted`
- 网络安全边界与回归说明见 [docs/security.md](docs/security.md)
- 改成自己的仓库、自己的后端、自己出包，见 [docs/self-host.md](docs/self-host.md)

## 许可证

沿用上游的 [PolyForm Noncommercial License 1.0.0](LICENSE)：**非商业使用**。
上游 v1.0.1 及更早版本曾以 MIT 发布，那部分授权不因换证而撤回。

本项目只包含客户端与一个通用媒体库服务端，不托管、不分发任何音视频内容；
内容来源与授权由部署者自行负责。
