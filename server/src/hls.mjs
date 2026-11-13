/**
 * 播放：把媒体库里的视频变成客户端能吃的 HLS。
 *
 * 客户端只有一条路 —— 拿到 `.m3u8` 就交给 hls.js / 原生播放器。
 * 所以这里统一做「按需转码 + 缓存」：
 *   1. 首次请求某集 → 起一个 ffmpeg 把整段切成 fMP4 分片写进 cache/
 *   2. 同时把已生成的 m3u8 立刻返回，让播放先跑起来（边转边看）
 *   3. 转完打一个 .done 标记，下次直接读缓存
 *
 * 如果源文件本身已经是 .m3u8，就直接代理它的清单。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { config } from "./config.mjs";

const jobs = new Map(); // key -> Promise
const HLS_TIME = Number.isFinite(config.hlsTime) && config.hlsTime > 0 ? config.hlsTime : 6;

function cacheKey(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const h = crypto.createHash("sha1");
  h.update(file);
  h.update(String(stat.size));
  h.update(String(Math.floor(stat.mtimeMs)));
  return h.digest("hex").slice(0, 24);
}

export function isHlsSource(file) {
  return /\.(m3u8)$/i.test(file);
}

/**
 * 确保 HLS 目录存在，返回 { dir, playlist } 或 null（源文件不存在）
 */
export function ensureHls(file) {
  const key = cacheKey(file);
  if (!key) return null;
  const dir = path.join(config.cacheDir, key);
  fs.mkdirSync(dir, { recursive: true });
  const playlist = path.join(dir, "index.m3u8");
  const done = path.join(dir, ".done");

  if (!fs.existsSync(done) && !jobs.has(key)) {
    jobs.set(key, runFfmpeg(file, dir).finally(() => jobs.delete(key)));
  }
  return { dir, playlist, done, key };
}

function runFfmpeg(file, dir) {
  return new Promise((resolve) => {
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-i", file,
      // 码率不重编到离谱：只统一封装，能 copy 就 copy
      "-c:v", "copy", "-c:a", "aac", "-ac", "2",
      "-f", "hls",
      "-hls_time", String(HLS_TIME),
      "-hls_playlist_type", "event",
      "-hls_segment_type", "fmp4",
      "-hls_fmp4_init_filename", "init.mp4",
      "-hls_segment_filename", path.join(dir, "seg%05d.m4s"),
      path.join(dir, "index.m3u8"),
    ];
    const child = spawn(config.ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (b) => { err += b.toString(); if (err.length > 4000) err = err.slice(-4000); });
    child.on("error", (e) => {
      console.error(`[hls] 启动 ffmpeg 失败（${config.ffmpeg}）：${e.message}`);
      resolve(false);
    });
    child.on("close", (code) => {
      if (code === 0) {
        // 转完把 event 改成 VOD，播放器才知道总时长
        try {
          const p = path.join(dir, "index.m3u8");
          const text = fs.readFileSync(p, "utf8")
            .replace("#EXT-X-PLAYLIST-TYPE:EVENT", "#EXT-X-PLAYLIST-TYPE:VOD")
            .replace("#EXT-X-ENDLIST", "");
          fs.writeFileSync(p, `${text.trimEnd()}\n#EXT-X-ENDLIST\n`);
          fs.writeFileSync(path.join(dir, ".done"), "1");
        } catch (e) {
          console.error("[hls] 收尾失败：", e.message);
        }
      } else {
        console.error(`[hls] ffmpeg 退出码 ${code}：${err.slice(-600)}`);
      }
      resolve(code === 0);
    });
  });
}

/** 转码是否完成（前端可用它判断要不要显示「处理中」） */
export function hlsReady(file) {
  const key = cacheKey(file);
  if (!key) return false;
  return fs.existsSync(path.join(config.cacheDir, key, ".done"));
}
