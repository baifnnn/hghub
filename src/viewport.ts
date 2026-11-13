import { platform } from "./api";

/**
 * iOS WKWebView 的视口/安全区同步。
 *
 * 背景：Tauri 在 iOS 上把 WKWebView 挂到 tao 的 root view 上。冷启动时
 * UIKit 的第一次 layout 往往早于安全区（safe area）与最终 frame 落定，
 * 于是首帧会出现两种偏差：
 *   1. `html { height: 100% }` 量到的 initial containing block 比真实屏幕矮，
 *      底部于是空出一条（露出来的是 WKWebView / window 的原生底色）；
 *   2. `env(safe-area-inset-bottom)` 返回 0，底部导航的 paddingBottom 失效。
 * 把 App 切到后台再回来，UIKit 会重新 layout 一次，两处都恢复正常 —— 这正好
 * 对上「打开时底部有白边，返回桌面再进一次就正常」的现象。
 *
 * 这里做两件事，都不依赖原生改动：
 *   - 用 visualViewport / innerHeight 实测高度，写进 `--app-h`，CSS 用它兜底；
 *   - 用一个 0 尺寸探针元素实测 env(safe-area-inset-*)，写进
 *     `--inset-top` / `--inset-bottom`，让底部导航立刻拿到正确内边距。
 * 另外在挂载后的几个时间点主动触发一次 reflow，促使 WKWebView 尽快完成首帧布局。
 */

type Insets = { top: number; bottom: number };

function measureInsets(): Insets {
  if (typeof document === "undefined") return { top: 0, bottom: 0 };
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = [
    "position:fixed",
    "left:0",
    "top:0",
    "width:0",
    "height:0",
    "pointer-events:none",
    "visibility:hidden",
    "padding-top:env(safe-area-inset-top)",
    "padding-bottom:env(safe-area-inset-bottom)",
  ].join(";");
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const top = parseFloat(style.paddingTop) || 0;
  const bottom = parseFloat(style.paddingBottom) || 0;
  probe.remove();
  return { top: Math.round(top), bottom: Math.round(bottom) };
}

export function installViewportSync() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const root = document.documentElement;
  let raf = 0;

  const apply = () => {
    raf = 0;

    const vv = window.visualViewport;
    const height = Math.round(vv?.height || window.innerHeight || root.clientHeight || 0);
    const width = Math.round(vv?.width || window.innerWidth || root.clientWidth || 0);
    if (height > 0) root.style.setProperty("--app-h", `${height}px`);
    if (width > 0) root.style.setProperty("--app-w", `${width}px`);

    const insets = measureInsets();
    root.style.setProperty("--inset-top", `${insets.top}px`);
    root.style.setProperty("--inset-bottom", `${insets.bottom}px`);
  };

  const schedule = () => {
    if (raf) return;
    raf = window.requestAnimationFrame(apply);
  };

  apply();
  window.addEventListener("resize", schedule, { passive: true });
  window.addEventListener("orientationchange", schedule, { passive: true });
  window.visualViewport?.addEventListener("resize", schedule, { passive: true });
  window.visualViewport?.addEventListener("scroll", schedule, { passive: true });

  /* 切回前台时 UIKit 会重新 layout，这时再同步一次，顺手把迟到的安全区补上 */
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) schedule();
  });

  /* 首帧之后可能还有一到两次迟到的布局回调，集中在这几个时间点对齐 */
  for (const delay of [0, 60, 180, 480, 1200]) {
    window.setTimeout(schedule, delay);
  }

  if (platform === "ios") {
    /* 轻推一次 reflow：WKWebView 在内容尺寸变化时更容易触发一次 viewDidLayout */
    for (const delay of [120, 480]) {
      window.setTimeout(() => {
        const previous = root.style.height;
        root.style.height = "calc(var(--app-h, 100dvh) + 1px)";
        window.requestAnimationFrame(() => {
          root.style.height = previous;
          schedule();
        });
      }, delay);
    }
  }
}
