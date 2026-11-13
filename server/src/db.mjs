/**
 * 极轻量的持久化：一个 JSON 文件装全站可变数据。
 *
 * 为什么要这样写：
 *   - 这是给自己/小圈子用的后端，不需要数据库运维；
 *   - 客户端只读「列表 + 详情 + 播放地址」，写入只有账号、点赞、收藏、评论；
 *   - 单进程 + 全量内存 + 原子落盘，比引 SQLite 更快上手。
 * 数据量真的大了，把 load/save 换成 SQLite 即可，接口层不用动。
 */
import fs from "node:fs";
import path from "node:path";

let file = "";
let db = {
  users: [],       // { id, username, password_hash, salt, nickname, avatar_color, sign, created_at }
  tokens: {},      // token -> userId
  likes: [],       // { user_id, video_id, ep, created_at }
  collects: [],    // { user_id, video_id, created_at }
  follows: [],     // { user_id, target_id, created_at }
  comments: [],    // { id, video_id, ep, user_id, text, reply_id, created_at, like_count }
  comment_likes: [],
  post_likes: [],
  post_collects: [],
  meta: { next_user_id: 1, next_comment_id: 1 },
};

let saveTimer = null;

export function init(dir) {
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, "db.json");
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      db = { ...db, ...raw, meta: { ...db.meta, ...(raw.meta || {}) } };
    } catch (e) {
      console.error("[db] 读取 db.json 失败，使用空库：", e.message);
    }
  }
  return db;
}

/** 合并多次写盘请求，避免每个请求都打一次磁盘 */
export function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, file);
  }, 120);
}

/** 进程退出前强制落盘 */
export function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!file) return;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, file);
}

export const data = () => db;
