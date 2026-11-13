# iOS 播放链路：为什么不能用自定义协议喂 `<video>`

> 这份文档解释 1.3.2 修掉的「首页一直转圈、只显示封面图、永远不出画面」。以后再改播放相关代码前先读一遍。

## 现象

1.3.1 装上巨魔后，线路是通的 —— 首页能拉到列表、封面图正常显示、点进详情能看到集数，但播放器一直转圈，画面永远不出来。

## 根因

```
feed / playback  →  streams.main（真实 https 的 .m3u8）
        ↓
src/api.ts  playlist()  →  hg://localhost/hls?u=https%3A%2F%2F...
        ↓
<video src="hg://localhost/hls?u=...">
        ↓
WKVWebView 内部：这个 src 到底交给谁？
   ├─ hls.js 可用（有 MediaSource / ManagedMediaSource）→ hls.js 用 XHR 拉，能通
   └─ hls.js 不可用 → 直接 video.src = 自定义协议 url
                        → AVPlayer 接手
                        → AVPlayer 不经过 WKURLSchemeHandler
                        → 解析不了 hg://  →  永久停在加载态
```

两个关键事实：

1. **`hg://` 只在 WebKit 的 JS 网络栈里有效**。`src-tauri` 用 `register_asynchronous_uri_scheme_protocol("hg", ...)`（`src-tauri/src/lib.rs:80`）注册它，`fetch` / `XHR` 能拿到响应，但 AVPlayer 在另一个进程，看不到这个 handler。
2. **iOS 17.1 以前 WKWebView 没有 `MediaSource`**，也没有 `ManagedMediaSource`。hls.js 的 `isSupported()` 依赖它们（`getMediaSource()` → `self.ManagedMediaSource || self.MediaSource || self.WebKitMediaSource`），返回 false，于是必然走原生分支 —— 也就是必然踩上面那条死路。

TrollStore 只能装在 iOS 14.0b2 ~ 17.0，所以**绝大多数巨魔用户都在 hls.js 不可用的区间**。

## 修法

iOS 单独走「原生播放器 + 真实 https 地址」，其它平台继续用 `hg://` 代理：

`src/api.ts`

```ts
/** 把 hg://localhost/xxx?u=... 还原成上游真实地址 */
export function nativeMedia(url: string): string {
  if (!url) return "";
  if (isLocalMedia(url)) {
    const i = url.indexOf("?u=");
    if (i >= 0) {
      try { return decodeURIComponent(url.slice(i + 3)); } catch { return url; }
    }
  }
  return url;
}
```

`src/components/VideoSurface.tsx`

```tsx
const nativeOnly = platform === "ios";
const playSrc = nativeOnly ? nativeMedia(url) : url;
const useHls = !nativeOnly && !url.includes("/seg?u=");

if (useHls && Hls.isSupported()) {
  // ... hls.js 老路径
} else {
  video.src = playSrc;      // ← iOS 走这里，喂真实 https
  if (autoPlay) activity.play("native_autoplay", true);
}
```

`src/components/Player.tsx` 同样处理（原来是无条件 `playlist(src)`，会把已经是代理的地址再包一层）。

`src-tauri/tauri.conf.json` 的 CSP 必须同时放行 https，否则原生播放器被 CSP 拦：

```jsonc
"media-src 'self' blob: hg: http://hg.localhost https://hg.localhost https:"
```

## 为什么交给原生反而更好

上游 m3u8 里所有分片和 `#EXT-X-KEY` 的 URI **都是绝对 https URL**（实测 38 个分片全绝对），所以：

| | hls.js + `hg://` 代理 | AVPlayer 原生 |
|---|---|---|
| AES-128 解密 | JS 用 WebCrypto 解，iOS 有 `subtle` | AVPlayer 自己解，零开销 |
| 分片传输 | Rust 代理**先下完整个分片再吐给 WebView**（`media.rs` 不实现 Range） | AVPlayer 自己按需分段请求 |
| 首帧时间 | 要等 1.68 MB 分片全部到齐 | 边下边解，几百 ms 出画 |
| WebWorker | iOS 上 `enableWorker: !isIos` 已关，主线程跑 | 无 JS 参与 |

也就是说，原生路径在这套 CDN 上不仅「能播」，而且比 hls.js 快得多。

## 保留代理的意义

`hg://` 代理不是废的，它还在两件事上必需：

1. **封面**：`cover()` 走 `hg://localhost/img?u=...`，Rust 端用 `AES-128-CBC(key=f5d965df75336270, iv=97b60394abc2fbe1)` 解密后返回真实图片。CDN 上的封面是加密字节，直接给 `<img>` 是花屏。
2. **非 iOS 平台**（Windows / macOS / Android）：那里 `<video>` 是 Chromium 内核，`http://hg.localhost` 走的是本地 HTTP 服务，自定义协议没问题。

## 自查清单

改完播放相关代码，按这个顺序验：

1. `node node_modules/typescript/bin/tsc --noEmit` → 0
2. `node node_modules/vite/bin/vite.js build` → 0，`dist/assets/index-*.js` 里能搜到 `native_only`
3. 打出来的 IPA 里，二进制能搜到 `hg://localhost`（代理还在）和三条线路域名
4. 真机打开：首页应直接出画面（默认静音），点开声音按钮有声音
5. 若仍不出画面：设置 → 播放诊断 → 打开日志，看 `application support/com.hghub.huangguo/playback.log`：
   - 有 `source.load` 且 `engine: "native"`、`native_only: true` → 分支进对了
   - 跟着有 `media.error`（1.3.2 新加的）→ 是解码/网络错误，看 `code`
   - 连 `source.load` 都没有 → `playUrl` 没拿到，回去查 `api_play` 是不是报错

---

# iOS 底部白边：冷启动首帧的 viewport / safe-area 竞态

> 这份是 1.3.3 修的「刚打开时底部一条白边，退到桌面再进一次就正常」。

## 现象

冷启动后首页视频正常播，但底部导航「首页 / 搜索 / 分类 / 我的」下面多出一条白带。切到后台再回来（或杀掉重开一次）就没了。

## 根因

Tauri 在 iOS 上把 WKWebView 挂到 tao 的 root view 上。冷启动时 UIKit 的**第一次 layout 早于安全区和最终 frame 落定**，于是首帧同时踩两个坑：

1. `html { height: 100% }` 量到的 initial containing block 比真实屏幕矮 → 底部空出一条，露出来的是 **WKWebView 自己的原生底色**；
2. `env(safe-area-inset-bottom)` 返回 `0` → `TabBar` 的 `paddingBottom: var(--sab)` 失效。

切后台再回来，UIKit 会重新 layout 一次，两处都恢复正常 —— 所以「进第二次就好了」。

两个来自框架源码的直接证据：

`tao-0.37.2/src/platform_impl/ios/view.rs:155`

```rust
// If the app is started in landscape, the view frame and window bounds can be mismatched.
let view_frame: CGRect = msg_send![object, frame];
if view_frame != window_bounds { let () = msg_send![object, setFrame: window_bounds]; }
```

→ view frame 是**事后**被纠正的，首帧必然存在偏差窗口。

`wry-0.57.1/src/wkwebview/mod.rs:489`

```rust
// Without a background color the webview stays opaque and white, flashing before the page paints,
// so fall back to the system background to follow the current appearance.
let color = if let Some((r, g, b, a)) = attributes.background_color { ... } else { UIColor::systemBackgroundColor() };
```

→ **没配 `backgroundColor` 时底色取 `systemBackgroundColor()`，浅色模式下就是白色**。白边的颜色就是从这里来的。

另外 `tao` 的 iOS 后端里 `set_inner_size` 是空实现（只 `warn!`），`set_background_color` 也是空实现 —— 所以**无法从 Rust 侧修窗口尺寸**，只能在配置层和前端层解决。

## 修法（四层一起上，任一层单独都不够）

### 1. 原生底色：`src-tauri/tauri.conf.json`

```jsonc
"app": { "windows": [ { ..., "backgroundColor": "#000000" } ] }
```

这样即使 DOM 一帧都没画，露出来的是黑底而不是白纸。配置链路：`tauri-utils` 的 `WindowConfig.background_color: Option<Color>`（hex 字符串）→ `tauri-runtime-wry` 的 `webview_builder.with_background_color(color.into())` → wry 的 `UIColor::colorWithRed_green_blue_alpha`。

### 2. 首帧 CSS 兜底：`index.html` 内联 `<style>`

CSS bundle 解析前也不能露白，而且 `#root` 自己要有底色（`height` 没撑满时露的是 body，body 又透出 WebView）：

```html
html, body, #root { background: #1a1a1a; height: 100%; }
html.theme-light, html.theme-light body, html.theme-light #root { background: #f3f3f3; }
@supports (height: 100dvh) { html, body, #root { height: 100dvh; } }
```

### 3. 实测视口高度：新增 `src/viewport.ts`

`installViewportSync()` 做三件事：

- 用 `window.visualViewport.height || innerHeight` 实测高度写进 `--app-h`（`index.css` 里 `html, body, #root` 用 `height: var(--app-h, 100%)` 兜底）；
- 造一个 0 尺寸探针 div，`padding-top/bottom: env(safe-area-inset-*)`，`getComputedStyle` 读回 px 写进 `--inset-top` / `--inset-bottom`（这是唯一能**在 JS 里读到安全区**的办法）；
- 在 `0 / 60 / 180 / 480 / 1200 ms` 这几个时间点各对齐一次，并监听 `resize` / `orientationchange` / `visualViewport.resize|scroll` / `visibilitychange`。iOS 上额外轻推两次 reflow，促使 WKWebView 尽快完成 `viewDidLayout`。

`src/main.tsx` 里在 `installPlaybackPageEvents()` 之前调用它。

### 4. 导航内边距取三者最大：`src/App.tsx` 的 `MobileShell`

```tsx
"--sat": "max(env(safe-area-inset-top), var(--inset-top, 0px), 12px)",
"--sab": "max(env(safe-area-inset-bottom), var(--inset-bottom, 0px), 16px)",
```

冷启动时 `env()` 是 0，但 `--inset-*`（实测）和 12/16px 兜底能立刻顶上，导航不会再缺一截内边距。

## 自查

1. `tsc --noEmit` → 0
2. `vite build` → 0，`dist/index.html` 里能看到 `@supports (height: 100dvh)`
3. IPA 的 `Info.plist` 旁边（`tauri.conf.json` 编译产物 `Assets.car` 无关）—— 直接看 `tauri.conf.json` 里 `backgroundColor` 是否在，以及二进制里能搜到 `--app-h`
4. 真机**冷启动**（先杀掉进程）打开，底部不应再露白；再切后台回来对比，两次应完全一致
