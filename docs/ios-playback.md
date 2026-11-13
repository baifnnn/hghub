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

# iOS 冷启动底部黑带：WKWebView 拿到了「安全区内尺寸」

> 1.3.3 修错了一层（改了 CSS 视口与底色），1.3.4 才修对：**原生层的 webview frame 本身就不是整屏**。

## 现象

冷启动（从桌面点图标进）后，页面底部空出一条。1.3.3 之前是白的，加了 `backgroundColor: "#000000"` 之后变成黑的 —— 颜色变了但那条带子一直在。切后台再回前台就正常。

## 决定性证据：93 = 59 + 34

拿用户截图量（1179×2556 像素，3x，即 393×852pt）：

| 区间 | 像素 | 换算 |
| --- | --- | --- |
| 页面内容 | 0 – 2054 | 0 – 684.7pt |
| 底部导航 TabBar | 2055 – 2276 | 685 – 758.7pt |
| 黑带 | 2277 – 2555 | **759 – 852pt，93pt** |

`852 − 759 = 93`，而 `93 = 59（顶部状态栏）+ 34（底部 home indicator）`。

这不是巧合。`tao-0.37.2/src/platform_impl/ios/window.rs:761` 的 `safe_area_screen_space()`：

```rust
let bounds: CGRect = msg_send![self.window, bounds];
let safe_area: UIEdgeInsets = msg_send![self.window, safeAreaInsets];
let width = bounds.size.width - safe_area.left - safe_area.right;
let height = bounds.size.height - safe_area.top - safe_area.bottom;   // 852 - 59 - 34 = 759
```

而 `tao` 把**这个**尺寸当作 `inner_size` 报给 Tauri，`wry` 在创建 WKWebView 时又是直接沿用父视图当时的 frame（`wry-0.57.1/src/wkwebview/mod.rs:489` `let frame = ns_view.frame();` → `initWithFrame: frame`）。

于是：**iOS 上 WebView 被塞进「安全区内尺寸」，而页面本身已经用 `viewport-fit=cover` + `--sat`/`--sab` 处理过安全区了 —— 安全区被扣了两遍。**

## 为什么「再进一次就好」

唯一的纠正点是 `tao` 给根视图装的 `layoutSubviews` 钩子（`tao-0.37.2/src/platform_impl/ios/view.rs:132-168`）：

```rust
// If the app is started in landscape, the view frame and window bounds can be mismatched.
let view_frame: CGRect = msg_send![object, frame];
if view_frame != window_bounds { let () = msg_send![object, setFrame: window_bounds]; }
```

它只在 UIKit 主动重排时才跑。冷启动首帧赶不上这次重排，切后台再回来才触发 —— 所以第二次打开是好的。

## 为什么 1.3.3 那套 CSS 兜底没用

`100dvh`、`visualViewport.height`、`innerHeight` 拿到的都是**浏览器视口**的高度，而视口本身就只有 759pt。CSS 再怎么算也补不出被原生砍掉的那 93pt。1.3.3 唯一真正生效的是 `backgroundColor`，它把白边变成了黑边。

## 修法：`src-tauri/src/ios_viewport.rs`

冷启动后的几个时间点（`0 / 60 / 240 / 720 / 1920 / 4420 ms`）里，把 `window.bounds` 当唯一真相：

1. `window.rootViewController.view`（tao 的根视图）`setFrame:` 到 `window.bounds`；
2. WKWebView 自己也 `setFrame:` 到同一尺寸（它的 `autoresizingMask` 是 `FlexibleWidth|FlexibleHeight`，但冷启动时父子可能同步变化，显式再设一次最稳）；
3. 对两者 `setNeedsLayout` + `layoutIfNeeded` 立刻跑完；
4. 把 `webview.scrollView.contentInsetAdjustmentBehavior` 设成 `.never`（枚举值 2），免得 UIKit 之后又把安全区折算成 `adjustedContentInset` 加回来。

实现刻意沿用 `src-tauri/src/api.rs:226-312` 里 `set_orientation` 那套裸 `objc_msgSend` 写法 —— **零新依赖，`Cargo.toml` 不用改**：

```rust
extern "C" {
    fn objc_getClass(name: *const c_char) -> Id;
    fn sel_registerName(name: *const c_char) -> Sel;
    fn objc_msgSend();
}

unsafe fn send_rect(obj: Id, name: &[u8], rect: CGRect) {
    let f: extern "C" fn(Id, Sel, CGRect) = std::mem::transmute(objc_msgSend as *const ());
    f(obj, sel(name), rect);
}
```

接线在 `src-tauri/src/lib.rs` 的 `setup` 里：

```rust
#[cfg(target_os = "ios")]
ios_viewport::install(app);
```

每次校准都往播放诊断日志写一条 `ios.viewport.nudge`，带 `window` / `root_before` / `webview_after` / `inset_before` 四组实测值。**如果还不对，先看这条日志**：`window` 是 393×852 而 `webview_after` 是 393×759，说明 `setFrame:` 没生效（被上层又改回去了）；两个都是 759，说明 `window.bounds` 本身就是 759（那是 tao 的窗口创建路径问题，得换路子）。

## 1.3.3 留下的东西还要不要

要，但性质变了：

| 1.3.3 的改动 | 1.3.4 之后的作用 |
| --- | --- |
| `tauri.conf.json` 的 `backgroundColor: "#000000"` | 保留。冷启动第一帧 DOM 还没画时露的是它 |
| `index.html` 内联首帧底色 | 保留。CSS bundle 解析前的兜底 |
| `src/viewport.ts` 的 `--app-h` / `--inset-*` | 保留。视口变化、横竖屏切换时仍然需要 |
| `MobileShell` 的三者取 max | 保留。`--sab` 兜底导航内边距 |

它们不再是「修复」，而是「兜底」。真正的修复是原生层那一次 `setFrame:`。

## 自查

1. 真机**杀掉进程后冷启动**，底部不应有空带；切后台回来对比，两次完全一致。
2. 设置 → 播放诊断 → 打开日志，`~/Library/Application Support/com.hghub.huangguo/playback.log` 里搜 `ios.viewport.nudge`，应有 6 条，`webview_after` 与 `window` 相等。
3. 进横屏再回竖屏，不应出现新的空带（`resize` 事件会再校准一轮）。