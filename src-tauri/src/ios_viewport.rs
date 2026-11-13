//! iOS 冷启动：把 WKWebView 从「安全区内尺寸」纠正回整屏。
//!
//! ## 现象
//! App 从桌面冷启动时，页面底部空出一条（实测 279px / 3x = 93pt），
//! 切后台再回前台就正常。
//!
//! ## 实测数据
//! 截图量出来：屏幕 852pt，页面内容到 759pt 结束，下面 93pt 全黑。
//! 而 93 = 59（顶部状态栏）+ 34（底部 home indicator）。
//! 这正好等于 `tao` 在 iOS 上算窗口尺寸的公式
//! （`tao-0.37.2/src/platform_impl/ios/window.rs:761` `safe_area_screen_space()`）：
//! `height = window.bounds.height - safeAreaInsets.top - safeAreaInsets.bottom`
//! = 852 - 59 - 34 = 759。
//!
//! 也就是说 WebView 拿到的是「安全区内尺寸」，而页面本身已经用
//! `viewport-fit=cover` + `--sat`/`--sab` 处理过安全区了 —— 安全区被扣了两遍。
//!
//! ## 为什么「再进一次就好」
//! 唯一的纠正点是 `tao` 给根视图装的 `layoutSubviews` 钩子
//! （`tao-0.37.2/src/platform_impl/ios/view.rs:132-168`）：它发现
//! `view.frame != window.bounds` 才 `setFrame: window_bounds`。
//! 这个钩子只在 UIKit 主动重排时跑 —— 冷启动首帧往往赶不上，
//! 切后台再回前台才会触发。
//!
//! ## 修复
//! 不去猜任何一层的时序，冷启动后的几个时间点直接把 `window.bounds`
//! 当成唯一真相：根视图对齐到 window，webview 再撑满根视图；
//! 同时把内层 `scrollView.contentInsetAdjustmentBehavior` 设成 `.never`，
//! 免得 UIKit 之后又把安全区折算成 `adjustedContentInset` 加回来。
//!
//! 实现沿用 `api.rs` 里 `set_orientation` 那套裸 `objc_msgSend` 写法，
//! 不引入 objc2 依赖，`Cargo.toml` 无需改动。
//! 整个模块由 `lib.rs` 中的 `#[cfg(target_os = "ios")] mod ios_viewport;` 收口。

use std::ffi::c_void;
use std::os::raw::c_char;
use std::time::Duration;

use tauri::Manager;

use crate::playback_log;

type Id = *mut c_void;
type Sel = *mut c_void;

extern "C" {
    fn objc_getClass(name: *const c_char) -> Id;
    fn sel_registerName(name: *const c_char) -> Sel;
    fn objc_msgSend();
}

/// 冷启动后的校准时间点（毫秒，从 setup 算起）。
/// 首帧到稳定之间 UIKit 会重排几次，单点命中率不够，用递增的几个点覆盖。
const NUDGE_AT_MS: [u64; 6] = [0, 60, 240, 720, 1920, 4420];

fn sel(name: &[u8]) -> Sel {
    debug_assert!(name.ends_with(b"\0"));
    unsafe { sel_registerName(name.as_ptr() as *const c_char) }
}

// ---------------------------------------------------------------------------
// CoreGraphics / UIKit 里按值传递的 C 结构体。
// 都是纯 double，arm64 上走浮点寄存器，与 extern "C" 的 ABI 一致。
// 只用到其中一部分字段，所以整体放开 dead_code。
// ---------------------------------------------------------------------------

#[allow(dead_code)]
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[allow(dead_code)]
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CGSize {
    width: f64,
    height: f64,
}

#[allow(dead_code)]
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

#[allow(dead_code)]
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct UIEdgeInsets {
    top: f64,
    left: f64,
    bottom: f64,
    right: f64,
}

// ---------------------------------------------------------------------------
// objc_msgSend 的各种签名。Rust 侧按目标方法自己挑一个，签名对不上就是 UB，
// 所以每个调用点都写死它用的那一个。
// ---------------------------------------------------------------------------

/// `- (id)foo` / `- (void *)foo` 这类无参、返回指针的消息。
unsafe fn send_obj(obj: Id, name: &[u8]) -> Id {
    if obj.is_null() {
        return std::ptr::null_mut();
    }
    let f: extern "C" fn(Id, Sel) -> Id = std::mem::transmute(objc_msgSend as *const ());
    f(obj, sel(name))
}

/// `- (void)foo` 这类无参、无返回的消息。
unsafe fn send_void(obj: Id, name: &[u8]) {
    if obj.is_null() {
        return;
    }
    let f: extern "C" fn(Id, Sel) = std::mem::transmute(objc_msgSend as *const ());
    f(obj, sel(name));
}

/// `- (void)setXxx:(NSInteger)`，用来传 `NS_ENUM` 的原始值。
unsafe fn send_isize(obj: Id, name: &[u8], arg: isize) {
    if obj.is_null() {
        return;
    }
    let f: extern "C" fn(Id, Sel, isize) = std::mem::transmute(objc_msgSend as *const ());
    f(obj, sel(name), arg);
}

unsafe fn send_rect(obj: Id, name: &[u8], rect: CGRect) {
    if obj.is_null() {
        return;
    }
    let f: extern "C" fn(Id, Sel, CGRect) = std::mem::transmute(objc_msgSend as *const ());
    f(obj, sel(name), rect);
}

unsafe fn send_rect_ret(obj: Id, name: &[u8]) -> CGRect {
    if obj.is_null() {
        return CGRect::default();
    }
    let f: extern "C" fn(Id, Sel) -> CGRect = std::mem::transmute(objc_msgSend as *const ());
    f(obj, sel(name))
}

unsafe fn send_insets_ret(obj: Id, name: &[u8]) -> UIEdgeInsets {
    if obj.is_null() {
        return UIEdgeInsets::default();
    }
    let f: extern "C" fn(Id, Sel) -> UIEdgeInsets = std::mem::transmute(objc_msgSend as *const ());
    f(obj, sel(name))
}

unsafe fn send_insets(obj: Id, name: &[u8], insets: UIEdgeInsets) {
    if obj.is_null() {
        return;
    }
    let f: extern "C" fn(Id, Sel, UIEdgeInsets) = std::mem::transmute(objc_msgSend as *const ());
    f(obj, sel(name), insets);
}

// ---------------------------------------------------------------------------
// 具体动作
// ---------------------------------------------------------------------------

/// 对一个 view 推一次布局：先置脏，再同步跑完 `layoutSubviews`。
unsafe fn relayout(view: Id) {
    if view.is_null() {
        return;
    }
    send_void(view, b"setNeedsLayout\0");
    send_void(view, b"layoutIfNeeded\0");
}

/// `window.rootViewController.view` —— 也就是 `tao` 挂 `layoutSubviews` 钩子的根视图。
unsafe fn root_view(window: Id) -> Option<Id> {
    if window.is_null() {
        return None;
    }
    let vc = send_obj(window, b"rootViewController\0");
    if vc.is_null() {
        return None;
    }
    let view = send_obj(vc, b"view\0");
    if view.is_null() {
        None
    } else {
        Some(view)
    }
}

/// 关掉 WKWebView 内层 scrollView 的「自动安全区内边距」。
///
/// `UIScrollViewContentInsetAdjustmentBehavior` 枚举：
/// `.automatic = 0`、`.scrollableAxes = 1`、`.never = 2`、`.always = 3`。
/// 默认是 `.automatic`，系统会把 `safeAreaInsets` 折算成 `adjustedContentInset`。
/// 页面已经自己处理安全区了，这里固定 `.never`，并把设置前的值带出去写日志。
unsafe fn disable_inset_adjustment(webview: Id) -> UIEdgeInsets {
    let scroll = send_obj(webview, b"scrollView\0");
    if scroll.is_null() {
        return UIEdgeInsets::default();
    }
    let before = send_insets_ret(scroll, b"adjustedContentInset\0");
    send_isize(scroll, b"setContentInsetAdjustmentBehavior:\0", 2);
    before
}

/// 校准一次，返回实测尺寸供日志核对：
/// `(window, 根视图调整前, webview 调整后, 调整前的内边距)`
unsafe fn nudge(webview: Id) -> (CGSize, CGSize, CGSize, UIEdgeInsets) {
    let inset = disable_inset_adjustment(webview);

    let window = send_obj(webview, b"window\0");
    let target = send_rect_ret(window, b"bounds\0").size;

    let root = root_view(window).unwrap_or_else(|| send_obj(webview, b"superview\0"));
    let root_before = send_rect_ret(root, b"bounds\0").size;

    if target.width > 0.0 && target.height > 0.0 {
        let full = CGRect {
            origin: CGPoint { x: 0.0, y: 0.0 },
            size: target,
        };
        if root_before.width != target.width || root_before.height != target.height {
            send_rect(root, b"setFrame:\0", full);
        }
        // webview 的 autoresizingMask 是 FlexibleWidth|FlexibleHeight，
        // 理论上父视图变宽高就会跟随；但冷启动时两者可能同步发生，
        // 显式再设一次最稳，代价只是一条 msgSend。
        send_rect(webview, b"setFrame:\0", full);
    }

    relayout(root);
    relayout(webview);

    let after = send_rect_ret(webview, b"bounds\0").size;
    (target, root_before, after, inset)
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/// 在 `setup` 里调用。窗口可能还没建好，所以每个时间点重新取一次，取不到就跳过。
pub fn install(app: &tauri::App) {
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        let start = std::time::Instant::now();
        for at in NUDGE_AT_MS {
            let elapsed = start.elapsed().as_millis() as u64;
            if at > elapsed {
                std::thread::sleep(Duration::from_millis(at - elapsed));
            }
            let at = start.elapsed().as_millis() as u64;
            let Some(window) = handle.get_webview_window("main") else {
                continue;
            };
            let _ = window.with_webview(|webview| {
                let raw = webview.inner() as Id;
                if raw.is_null() {
                    return;
                }
                let (target, root_before, after, inset) = unsafe { nudge(raw) };
                playback_log::record(
                    "ios.viewport.nudge",
                    serde_json::json!({
                        "at_ms": at,
                        "window": [target.width, target.height],
                        "root_before": [root_before.width, root_before.height],
                        "webview_after": [after.width, after.height],
                        "inset_before": [inset.top, inset.left, inset.bottom, inset.right],
                    }),
                );
            });
        }
    });
}
