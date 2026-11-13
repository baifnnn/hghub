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
