/**
 * HGhub 自建后端 —— HTTP 路由层。
 *
 * 目标：客户端（Tauri/iOS）把 base 指到这里，首页、分类、搜索、详情、播放、
 * 评论、点赞、收藏、关注、登录全部能跑通，不依赖任何第三方服务。
 *
 * 两种访问形态都支持：
 *   1. POST /api/edge/request  —— 客户端默认的「边缘信封」，请求体
 *      { method, path, body(base64), content_type }，返回 { status:1, data }
 *   2. 同名 REST 直连（GET /api/videos 等）—— 客户端在不支持信封时会自动降级到这里
 *
 * 媒体链路：/api/videos/:id/episodes/:ep/playback 返回一个 .m3u8
 * 客户端把它交给 hls.js，分片由本服务从 cache/ 里静态吐出去。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";
import { init as initDb, data, save, flush } from "./db.mjs";
import { scan } from "./scan.mjs";
import { ensureHls, isHlsSource, hlsReady } from "./hls.mjs";
import { coverPng } from "./cover.mjs";
import {
  createUser, findUser, verifyPassword, publicUser, tokenFor, dropToken, userFromRequest,
} from "./auth.mjs";

/* ──────────────────────────── 运行时状态 ──────────────────────────── */

const state = {
  videos: [],            // 扫描出的剧集（Detail 精简版）
  byId: new Map(),       // id -> video
  files: new Map(),      // "id:ep" -> 源文件绝对路径
  covers: new Map(),     // id -> 真实封面文件路径（有就用它，没有就生成 PNG）
  rawHls: new Map(),     // "id:ep" -> { dir, name }  源本身就是 m3u8 的情况
  scannedAt: 0,
};

function rescan() {
  const out = scan(config.mediaDir);
  state.videos = out.videos;
  state.byId = new Map(out.videos.map((v) => [v.id, v]));
  state.files = out.files;
  state.covers = new Map();
  state.rawHls = new Map();
  for (const v of out.videos) {
    if (v.cover) state.covers.set(v.id, v.cover);
    v.cover = ""; // 后面按请求域名动态拼 URL
  }
  state.scannedAt = Date.now();
  console.log(`[scan] ${state.videos.length} 部 / ${state.files.size} 个文件 ← ${config.mediaDir}`);
}

/* ──────────────────────────── 小工具 ──────────────────────────── */

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

function originOf(req) {
  if (config.publicBase) return config.publicBase;
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || `127.0.0.1:${config.port}`).split(",")[0].trim();
  return `${proto}://${host}`;
}

function paged(items, page, size) {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(1, page), pages);
  return {
    items: items.slice((p - 1) * size, p * size),
    pagination: { page: p, pages, size, total },
  };
}

const iso = (t) => new Date(t).toISOString();

function author() {
  return { id: 0, name: "本地媒体库", avatar: "", followers: 0 };
}

/** 列表卡片：把 Detail 精简成 VideoCard 需要的形状 */
function card(v, base) {
  return {
    id: v.id,
    title: v.title,
    cover: coverUrl(v, base),
    description: v.description || "",
    tags: v.tags || [],
    score: v.score || 0,
    episode_count: v.episode_count,
    total_episodes: v.total_episodes,
    duration: v.duration || 0,
    hot: v.hot || 0,
    like_count: likeCount(v.id),
    collect_count: collectCount(v.id),
    comment_count: commentCount(v.id),
    is_finished: v.is_finished,
    is_original: v.is_original,
    created_at: v.created_at,
    last_ep_at: v.created_at,
    new_at: v.created_at,
    author: author(),
  };
}

function coverUrl(v, base) {
  return `${base}/cover/${v.id}.png`;
}

const likeCount = (vid) => data().likes.filter((x) => Number(x.video_id) === Number(vid)).length;
const collectCount = (vid) => data().collects.filter((x) => Number(x.video_id) === Number(vid)).length;
const commentCount = (vid) => data().comments.filter((x) => Number(x.video_id) === Number(vid)).length;

function detail(v, base, user) {
  const uid = user?.id || 0;
  const likedEps = data().likes.filter((x) => x.user_id === uid && Number(x.video_id) === Number(v.id)).map((x) => x.ep);
  return {
    id: v.id,
    title: v.title,
    description: v.description || "",
    cover: coverUrl(v, base),
    tags: v.tags || [],
    tag_links: [],
    score: v.score || 0,
    episode_count: v.episode_count,
    total_episodes: v.total_episodes,
    episodes: v.episodes,
    counts: {
      collect: collectCount(v.id),
      comment: commentCount(v.id),
      hot: v.hot || 0,
      like: likeCount(v.id),
    },
    author: { ...author(), is_following: false, following: false, like_count: 0 },
    interaction: {
      collected: uid ? data().collects.some((x) => x.user_id === uid && Number(x.video_id) === Number(v.id)) : false,
      liked: likedEps.length > 0,
      liked_ep: likedEps[0] || 0,
    },
    video_url: "",
    video_url_hevc: "",
    is_finished: v.is_finished,
    is_original: v.is_original,
    video_type: "hls",
    duration: v.duration || 0,
    created_at: v.created_at,
  };
}

function needLogin(user) {
  if (!user) throw new HttpError(401, "请先登录");
  return user;
}

function needVideo(id) {
  const v = state.byId.get(Number(id));
  if (!v) throw new HttpError(404, "视频不存在");
  return v;
}

/* ──────────────────────────── 业务处理 ──────────────────────────── */

async function playInfo(v, ep, base) {
  const file = state.files.get(`${v.id}:${ep}`) || state.files.get(`${v.id}:${v.episodes[0]?.ep_num}`);
  if (!file) throw new HttpError(404, "这一集还没有片源");
  if (isHlsSource(file)) {
    const dir = path.dirname(file);
    state.rawHls.set(`${v.id}:${ep}`, { dir, name: path.basename(file) });
    return {
      id: v.id,
      ep_num: ep,
      duration: 0,
      title: v.episodes.find((e) => e.ep_num === ep)?.title || v.title,
      video_url: `${base}/rawhls/${v.id}/${ep}/index.m3u8`,
      video_url_hevc: "",
      streams: { main: `${base}/rawhls/${v.id}/${ep}/index.m3u8` },
    };
  }
  const hls = ensureHls(file);
  if (!hls) throw new HttpError(500, "无法读取片源文件");
  return {
    id: v.id,
    ep_num: ep,
    duration: 0,
    title: v.episodes.find((e) => e.ep_num === ep)?.title || v.title,
    video_url: `${base}/hls/${hls.key}/index.m3u8`,
    video_url_hevc: "",
    streams: {
      main: `${base}/hls/${hls.key}/index.m3u8`,
      ready: hlsReady(file),
    },
  };
}

function rank(kind) {
  const scored = state.videos.map((v) => {
    const metrics = {
      collect: collectCount(v.id),
      comment: commentCount(v.id),
      like: likeCount(v.id),
      play: v.hot || 0,
    };
    const metric = kind === "potential" ? metrics.collect + metrics.comment * 2
      : kind === "recommend" ? metrics.like * 3 + metrics.play
        : metrics.play + metrics.like;
    return { v, metrics, metric };
  }).sort((a, b) => b.metric - a.metric).slice(0, 30);

  return {
    items: scored.map((s, i) => ({
      rank: i + 1,
      video_id: s.v.id,
      title: s.v.title,
      cover: "",
      tags: s.v.tags || [],
      score: s.v.score || 0,
      cate_name: "全部",
      episode_count: s.v.episode_count,
      is_finished: s.v.is_finished,
      metric_label: kind === "potential" ? "潜力值" : kind === "recommend" ? "推荐值" : "热度",
      metric_value: s.metric,
      metrics: s.metrics,
    })),
  };
}

/** 帖子：把剧集当「爆料帖」展示，保证客户端底部那个 Tab 不是空的 */
function postFromVideo(v, base) {
  return {
    id: v.id,
    title: v.title,
    desc: v.description || `${v.episode_count} 集`,
    content: `<p>${v.title}</p><p>共 ${v.episode_count} 集，点击下方播放。</p>`,
    cover: coverUrl(v, base),
    tags: v.tags || [],
    hot: v.hot || 0,
    video_url: "",
    video_id: v.id,
    author: author(),
    counts: { like: likeCount(v.id), comment: commentCount(v.id), collect: collectCount(v.id) },
    created_at: v.created_at,
    publish_time: v.created_at,
  };
}

function commentsOf(vid, ep, user, page, size) {
  const uid = user?.id || 0;
  const all = data().comments
    .filter((c) => Number(c.video_id) === Number(vid) && (!ep || Number(c.ep) === Number(ep) || !c.ep))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const out = paged(all, page, size);
  out.ep = ep;
  out.items = out.items.map((c) => ({
    id: c.id,
    user_id: c.user_id,
    nickname: c.nickname,
    avatar: "",
    avatar_color: c.avatar_color || "#7c5cff",
    text: c.text,
    time: relative(c.created_at),
    created_at: c.created_at,
    like_count: c.like_count || 0,
    liked: data().comment_likes.some((x) => x.comment_id === c.id && x.user_id === uid),
    reply_count: data().comments.filter((r) => r.reply_id === c.id).length,
    reply_id: c.reply_id || 0,
    reply_list: [],
    ip_region: "",
  }));
  return out;
}

function relative(t) {
  const diff = (Date.now() - new Date(t).getTime()) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(t).toISOString().slice(0, 10);
}

/* ──────────────────────────── 路由 ──────────────────────────── */

/**
 * @returns {Promise<any>} 直接返回 data 部分；抛 HttpError 表示失败
 */
async function route(method, pathname, query, body, user, base, bearer = "") {
  const q = (k, d) => query.get(k) ?? d;
  const page = num(q("page"), 1);
  const size = Math.min(100, num(q("size"), 20));
  let m;

  /* —— 账号 —— */
  if (pathname === "/api/account/loginByPassword" && method === "POST") {
    const u = findUser(body?.username || "");
    if (!u || !verifyPassword(String(body?.password || ""), u.salt, u.password_hash)) {
      throw new HttpError(400, "用户名或密码不正确");
    }
    return { token: tokenFor(u), user: publicUser(u) };
  }
  if (pathname === "/api/account/registerByPassword" && method === "POST") {
    const username = String(body?.username || "").trim();
    const password = String(body?.password || "");
    if (username.length < 2) throw new HttpError(400, "用户名至少 2 个字符");
    if (password.length < 6) throw new HttpError(400, "密码至少 6 位");
    if (body?.confirm_password && body.confirm_password !== password) throw new HttpError(400, "两次密码不一致");
    const u = createUser(username, password);
    return { token: tokenFor(u), user: publicUser(u) };
  }
  if (pathname === "/api/account/logout" && method === "POST") {
    // 客户端把 token 放在 Authorization 头里，body 里一般没有 —— 两种都认
    const fromBody = String(body?.token || "").trim();
    const fromHeader = /^Bearer\s+(.+)$/i.exec(String(bearer || "").trim())?.[1] || "";
    if (fromHeader) dropToken(fromHeader);
    if (fromBody) dropToken(fromBody);
    return { ok: true };
  }
  if (pathname === "/api/account/me" && method === "GET") {
    needLogin(user);
    return publicUser(user);
  }

  /* —— 列表 —— */
  if (pathname === "/api/videos" && method === "GET") {
    const out = paged(state.videos, page, size);
    out.items = out.items.map((v) => card(v, base));
    return out;
  }
  if ((m = /^\/api\/videos\/category\/([^/]+)$/.exec(pathname)) && method === "GET") {
    const cate = decodeURIComponent(m[1]);
    const inCate = state.videos.filter((v) => (v.tags || []).includes(cate));
    const out = paged(inCate, page, size);
    out.items = out.items.map((v) => card(v, base));
    return out;
  }
  if ((m = /^\/api\/ranks\/([^/]+)$/.exec(pathname)) && method === "GET") {
    return rank(m[1]);
  }
  if (pathname === "/api/search" && method === "GET") {
    const kw = String(q("q", "")).trim().toLowerCase();
    const hit = kw
      ? state.videos.filter((v) => v.title.toLowerCase().includes(kw) || (v.tags || []).some((t) => String(t).toLowerCase().includes(kw)))
      : state.videos;
    const out = paged(hit, page, size);
    out.items = out.items.map((v) => card(v, base));
    return out;
  }

  /* —— 详情 —— */
  if ((m = /^\/api\/videos\/(\d+)$/.exec(pathname)) && method === "GET") {
    return detail(needVideo(m[1]), base, user);
  }

  /* —— 播放 —— */
  if ((m = /^\/api\/videos\/(\d+)\/episodes\/(\d+)\/playback$/.exec(pathname)) && method === "POST") {
    const v = needVideo(m[1]);
    return playInfo(v, Number(m[2]), base);
  }
  if ((m = /^\/api\/videos\/(\d+)\/play$/.exec(pathname)) && method === "GET") {
    const v = needVideo(m[1]);
    const ep = num(q("ep"), v.episodes[0]?.ep_num || 1);
    return playInfo(v, ep, base);
  }

  /* —— 互动 —— */
  if ((m = /^\/api\/videos\/(\d+)\/like$/.exec(pathname))) {
    const v = needVideo(m[1]);
    const u = needLogin(user);
    const ep = num(q("ep"), 1);
    const db = data();
    const on = method === "POST";
    const i = db.likes.findIndex((x) => x.user_id === u.id && Number(x.video_id) === Number(v.id) && x.ep === ep);
    if (on && i < 0) db.likes.push({ user_id: u.id, video_id: v.id, ep, created_at: iso(Date.now()) });
    if (!on && i >= 0) db.likes.splice(i, 1);
    save();
    return { liked: on, like_count: likeCount(v.id) };
  }
  if ((m = /^\/api\/videos\/(\d+)\/collect$/.exec(pathname))) {
    const v = needVideo(m[1]);
    const u = needLogin(user);
    const db = data();
    const i = db.collects.findIndex((x) => x.user_id === u.id && Number(x.video_id) === Number(v.id));
    const on = i < 0;
    if (on) db.collects.push({ user_id: u.id, video_id: v.id, created_at: iso(Date.now()) });
    else db.collects.splice(i, 1);
    save();
    return { collected: on, collect_count: collectCount(v.id) };
  }
  if ((m = /^\/api\/videos\/(\d+)\/comments$/.exec(pathname))) {
    const v = needVideo(m[1]);
    if (method === "GET") {
      return commentsOf(v.id, num(q("ep"), 0), user, page, size);
    }
    const u = needLogin(user);
    const text = String(body?.text || body?.content || "").trim();
    if (!text) throw new HttpError(400, "评论内容不能为空");
    const db = data();
    const c = {
      id: db.meta.next_comment_id++,
      video_id: v.id,
      // 客户端把集号放在 query 上（?ep=1），回复时改放 body，两边都认
      ep: num(body?.ep, num(q("ep"), 0)),
      user_id: u.id,
      nickname: u.nickname,
      avatar_color: u.avatar_color,
      text: text.slice(0, 500),
      reply_id: num(body?.reply_id, 0),
      created_at: iso(Date.now()),
      like_count: 0,
    };
    db.comments.push(c);
    save();
    return { id: c.id, ok: true };
  }
  if ((m = /^\/api\/users\/(\d+)\/follow$/.exec(pathname))) {
    const target = Number(m[1]);
    const u = needLogin(user);
    const db = data();
    const i = db.follows.findIndex((x) => x.user_id === u.id && x.target_id === target);
    // POST 关注 / DELETE 取关，客户端就是这么调的，不需要额外参数
    const on = method !== "DELETE";
    if (on && i < 0) db.follows.push({ user_id: u.id, target_id: target, created_at: iso(Date.now()) });
    if (!on && i >= 0) db.follows.splice(i, 1);
    save();
    return { following: on };
  }

  /* —— 帖子（用剧集映射，保证 Tab 有内容）—— */
  if (pathname === "/api/posts" && method === "GET") {
    const out = paged(state.videos, page, size);
    out.items = out.items.map((v) => postFromVideo(v, base));
    return out;
  }
  if ((m = /^\/api\/posts\/(\d+)$/.exec(pathname)) && method === "GET") {
    return postFromVideo(needVideo(m[1]), base);
  }
  if ((m = /^\/api\/posts\/(\d+)\/comments$/.exec(pathname)) && method === "GET") {
    return commentsOf(Number(m[1]), 0, user, page, size);
  }
  if ((m = /^\/api\/posts\/(\d+)\/like$/.exec(pathname))) {
    const v = needVideo(m[1]);
    const u = needLogin(user);
    const db = data();
    const i = db.post_likes.findIndex((x) => x.user_id === u.id && x.post_id === v.id);
    const on = method !== "DELETE";
    if (on && i < 0) db.post_likes.push({ user_id: u.id, post_id: v.id });
    if (!on && i >= 0) db.post_likes.splice(i, 1);
    save();
    return { liked: on, like_count: db.post_likes.filter((x) => x.post_id === v.id).length };
  }
  if ((m = /^\/api\/posts\/(\d+)\/collect$/.exec(pathname))) {
    const v = needVideo(m[1]);
    const u = needLogin(user);
    const db = data();
    const i = db.post_collects.findIndex((x) => x.user_id === u.id && x.post_id === v.id);
    const on = i < 0;
    if (on) db.post_collects.push({ user_id: u.id, post_id: v.id });
    else db.post_collects.splice(i, 1);
    save();
    return { collected: on };
  }

  throw new HttpError(404, `没有这个接口：${method} ${pathname}`);
}

/* ──────────────────────────── 静态资源 ──────────────────────────── */

const MIME = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".m4s": "video/mp4",
  ".mp4": "video/mp4",
  ".ts": "video/mp2t",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

function sendFile(req, res, file, cacheControl = "public, max-age=3600") {
  let st;
  try { st = fs.statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  const head = {
    "Content-Type": type,
    "Cache-Control": cacheControl,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": "*",
  };
  const range = req.headers.range;
  if (range) {
    const mm = /^bytes=(\d*)-(\d*)$/.exec(String(range));
    if (mm) {
      const start = mm[1] ? Number(mm[1]) : 0;
      const end = mm[2] ? Math.min(Number(mm[2]), st.size - 1) : st.size - 1;
      if (start > end) { res.writeHead(416, { "Content-Range": `bytes */${st.size}` }); res.end(); return true; }
      res.writeHead(206, { ...head, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
      return true;
    }
  }
  res.writeHead(200, { ...head, "Content-Length": st.size });
  fs.createReadStream(file).pipe(res);
  return true;
}

/** 防止 ../ 逃逸 */
function inside(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

function serveStatic(req, res, pathname, base) {
  let m;

  if ((m = /^\/cover\/(\d+)\.png$/.exec(pathname))) {
    const id = Number(m[1]);
    const real = state.covers.get(id);
    if (real && fs.existsSync(real)) return sendFile(req, res, real, "public, max-age=86400");
    const v = state.byId.get(id);
    const buf = coverPng(v ? v.title : String(id));
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": buf.length,
      "Cache-Control": "public, max-age=86400",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(buf);
    return true;
  }

  if ((m = /^\/hls\/([0-9a-f]{8,40})\/([\w.-]+)$/.exec(pathname))) {
    const key = m[1];
    const name = m[2];
    const file = path.join(config.cacheDir, key, name);
    if (!inside(path.join(config.cacheDir, key), file)) return false;
    return sendFile(req, res, file, name.endsWith(".m3u8") ? "no-store" : "public, max-age=86400");
  }

  if ((m = /^\/rawhls\/(\d+)\/(\d+)\/([\w.-]+)$/.exec(pathname))) {
    const entry = state.rawHls.get(`${m[1]}:${m[2]}`) || (() => {
      // 未走 playback 直接访问时，用源文件所在目录补齐
      const src = state.files.get(`${m[1]}:${m[2]}`);
      return src ? { dir: path.dirname(src), name: path.basename(src) } : null;
    })();
    if (!entry) return false;
    let name = m[3];
    if (name === "index.m3u8") name = entry.name;
    const file = path.join(entry.dir, path.basename(name));
    if (!inside(entry.dir, file)) return false;
    return sendFile(req, res, file, "no-store");
  }

  return false;
}

/* ──────────────────────────── HTTP 入口 ──────────────────────────── */

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { req.destroy(); resolve(""); return; }
      raw += c.toString("utf8");
    });
    req.on("end", () => resolve(raw));
    req.on("error", () => resolve(""));
  });
}

function parseJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

const ok = (res, data, status = 200) => {
  const buf = Buffer.from(JSON.stringify({ status: 1, data }), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": buf.length,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Cache-Control": "no-store",
  });
  res.end(buf);
};

const fail = (res, status, msg) => {
  const buf = Buffer.from(JSON.stringify({ status: 0, msg }), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": buf.length,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(buf);
};

async function handleApi(req, res, url, pathname, body, user, base, bearer = "") {
  // 边缘信封：拆出来当普通请求再走一遍同一个路由
  if (pathname === "/api/edge/request" && req.method === "POST") {
    const inner = body || {};
    const innerPath = String(inner.path || "");
    const innerMethod = String(inner.method || "GET").toUpperCase();
    if (!innerPath.startsWith("/api/")) return fail(res, 400, "信封里的 path 不合法");
    let innerBody = null;
    if (inner.body) {
      try { innerBody = JSON.parse(Buffer.from(String(inner.body), "base64").toString("utf8")); } catch { innerBody = null; }
    }
    const qi = innerPath.indexOf("?");
    const p = qi < 0 ? innerPath : innerPath.slice(0, qi);
    const q = new URLSearchParams(qi < 0 ? "" : innerPath.slice(qi + 1));
    try {
      return ok(res, await route(innerMethod, p, q, innerBody, user, base, bearer));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      return fail(res, status === 401 ? 401 : status, e.message || "服务端错误");
    }
  }

  try {
    return ok(res, await route(req.method, pathname, url.searchParams, body, user, base, bearer));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error("[api]", e);
    return fail(res, status, e.message || "服务端错误");
  }
}

const server = http.createServer(async (req, res) => {
  const base = originOf(req);
  const url = new URL(req.url || "/", base);
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    });
    return res.end();
  }

  if (pathname === "/" || pathname === "/health") {
    const body = Buffer.from(JSON.stringify({
      ok: true,
      name: "hghub-server",
      videos: state.videos.length,
      files: state.files.size,
      media: config.mediaDir,
      scanned_at: state.scannedAt,
      hint: "把客户端「自定义线路」填成这个地址即可",
    }, null, 2), "utf8");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
    return res.end(body);
  }

  if (serveStatic(req, res, pathname, base)) return;

  if (pathname.startsWith("/api/")) {
    const raw = await readBody(req);
    const user = userFromRequest(req);
    return handleApi(req, res, url, url.pathname, parseJson(raw), user, base, String(req.headers.authorization || ""));
  }

  return fail(res, 404, "没有这个路径");
});

/* ──────────────────────────── 启动 ──────────────────────────── */

function bootstrapAdmin() {
  if (data().users.length) return;
  const pass = config.adminPass || Math.random().toString(36).slice(2, 10);
  const u = createUser(config.adminUser, pass);
  console.log("─".repeat(52));
  console.log(`已创建管理员账号：${config.adminUser} / ${pass}`);
  console.log("（密码只打印这一次，登录后可以改 db.json 或再加账号）");
  console.log("─".repeat(52));
  return u;
}

initDb(config.dataDir);
rescan();
bootstrapAdmin();

// 每 30 秒看一次媒体库有没有增删（不监听 inotify，够用且不占资源）
setInterval(() => {
  try {
    const out = scan(config.mediaDir);
    if (out.videos.length !== state.videos.length || out.files.size !== state.files.size) rescan();
  } catch (e) {
    console.error("[scan] 定时扫描失败：", e.message);
  }
}, 30_000).unref?.();

server.listen(config.port, () => {
  console.log(`HGhub 后端已启动：http://127.0.0.1:${config.port}`);
  console.log(`媒体目录：${config.mediaDir}`);
  console.log(`缓存目录：${config.cacheDir}`);
  console.log(`对外地址：${config.publicBase || "（按请求头推断，建议设 PUBLIC_BASE）"}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log("\n正在落盘并退出…");
    try { flush(); } catch { /* ignore */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
