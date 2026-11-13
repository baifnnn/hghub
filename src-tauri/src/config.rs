//! 维护配置 —— 这是本 fork 里**唯一**需要改的「数据源 / 线路 / 更新源」入口。
//!
//! 原作者删库后上游 API 已经下线，所以这里默认不再指向 huangguoai.*，
//! 而是指向「你自己的后端」。改完这里，重新跑一次 GitHub Actions 就能出新 IPA。
//!
//! 三种用法：
//! 1. 你自己搭后端（见仓库根目录 `server/`，node 零依赖，一条命令起）→ 把下面的
//!    `DEFAULT_BASE` 改成你的地址，`FIXED_LINES` 填进去，用户装完就直连。
//! 2. 你想让用户自己填地址 → 保持 `DEFAULT_BASE` 为占位值，用户在「设置 → 线路 →
//!    自定义线路」里手填，地址会落盘到应用数据目录 line.json，重启仍在。
//! 3. 想恢复上游镜像 → 把 `PUBLISH_PAGE` 填成地址发布页，镜像列表会自动拉取。

/// 默认数据源（不带结尾斜杠，必须是纯 origin）。用户首次启动就连这里。
/// 改成你自己的后端，例如 `https://api.your-domain.com`。
pub const DEFAULT_BASE: &str = "https://xjtu.dmsbazvt.cc";

/// 固定线路列表：显示在「设置 → 线路 → 固定线路」。留空则不显示这一块。
/// 例如：`&[("我的服务器", "https://api.your-domain.com")]`
pub const FIXED_LINES: &[(&str, &str)] = &[
    ("线路一（西交）", "https://xjtu.dmsbazvt.cc"),
    ("线路二（中大）", "https://sysu.dmsbazvt.cc"),
    ("线路三（上交）", "https://sjtu.dmsbazvt.cc"),
];

/// 地址发布页（自动发现镜像用）。留空 = 关闭镜像发现，界面只显示自定义线路输入框。
/// 上游原来的发布页是 `https://huangguoai.pages.dev/`，现已失效。
pub const PUBLISH_PAGE: &str = "";

/// 检查更新用的 GitHub 仓库（`owner/repo`）。留空 = 关闭检查更新。
/// 填成你自己的 fork，例如 `"yourname/hghub-ios"`。
pub const UPDATE_REPO: &str = "";

/// 正文里相对路径的补全基址。留空则跟随当前线路（推荐留空）。
pub const SITE: &str = "";

/// 「关于」页展示的项目主页。留空则隐藏该行。
pub const PROJECT_URL: &str = "";

/// 是否为「未配置」状态（首次安装、用户还没填地址时给出明确引导）。
pub fn is_placeholder(base: &str) -> bool {
    base.starts_with("https://hghub.example.com")
}
