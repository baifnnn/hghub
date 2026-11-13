/**
 * 账号与令牌。
 *
 * 只做「自己用」的量级：scrypt 哈希 + 随机 token 放内存/落盘。
 * 没有邮箱验证、没有找回密码 —— 忘了直接删 db.json 里的 users 重来。
 */
import crypto from "node:crypto";
import { data, save } from "./db.mjs";

const KEYLEN = 32;

export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, KEYLEN).toString("hex");
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  const got = crypto.scryptSync(password, salt, KEYLEN);
  const want = Buffer.from(hash, "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const COLORS = ["#7c5cff", "#22c55e", "#f97316", "#06b6d4", "#ec4899", "#eab308", "#ef4444"];

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    nickname: u.nickname,
    avatar: "",
    avatar_color: u.avatar_color,
    sign: u.sign || "",
    desc: u.sign || "",
    user_type: u.id === 1 ? 1 : 0,
    counts: {
      like: data().likes.filter((x) => x.user_id === u.id).length,
      collect: data().collects.filter((x) => x.user_id === u.id).length,
      follow: data().follows.filter((x) => x.user_id === u.id).length,
      fans: data().follows.filter((x) => x.target_id === u.id).length,
    },
    interactions: {
      like_video_ids: data().likes.filter((x) => x.user_id === u.id).map((x) => x.video_id),
      favorite_video_ids: data().collects.filter((x) => x.user_id === u.id).map((x) => x.video_id),
      follow_user_ids: data().follows.filter((x) => x.user_id === u.id).map((x) => x.target_id),
      like_video_episodes: data()
        .likes.filter((x) => x.user_id === u.id)
        .map((x) => ({ video_id: x.video_id, ep: x.ep })),
    },
  };
}

export function createUser(username, password) {
  const db = data();
  const exists = db.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (exists) throw new Error("该用户名已被占用");
  const { salt, hash } = hashPassword(password);
  const user = {
    id: db.meta.next_user_id++,
    username,
    password_hash: hash,
    salt,
    nickname: username,
    avatar_color: COLORS[db.users.length % COLORS.length],
    sign: "",
    created_at: new Date().toISOString(),
  };
  db.users.push(user);
  save();
  return user;
}

export function findUser(username) {
  const db = data();
  return db.users.find((u) => u.username.toLowerCase() === String(username).toLowerCase()) || null;
}

export function tokenFor(user) {
  const db = data();
  const token = crypto.randomBytes(24).toString("hex");
  db.tokens[token] = user.id;
  save();
  return token;
}

export function dropToken(token) {
  const db = data();
  if (token && db.tokens[token]) {
    delete db.tokens[token];
    save();
  }
}

/** 从 Authorization: Bearer xxx 取当前用户 */
export function userFromRequest(req) {
  const raw = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  if (!m) return null;
  const uid = data().tokens[m[1]];
  if (!uid) return null;
  return data().users.find((u) => u.id === uid) || null;
}
