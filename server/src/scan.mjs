/**
 * 扫描媒体库，生成「剧集 → 分集 → 视频文件」的目录结构。
 *
 * 支持的目录约定（最简单的一种，够用就行）：
 *
 *   media/
 *     某部剧名/
 *       第01集.mp4
 *       第02集.mp4
 *     另一部剧.mp4          ← 单文件也当成 1 集的短剧
 *
 * 文件名里的集数按「第12集 / EP12 / E12 / 12」依次尝试解析。
 * 重新扫描会增量合并：手动改过的标题/封面（存在 db.json 的 overrides 里）不会被覆盖。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const VIDEO_EXT = new Set([".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".flv", ".ts", ".m3u8"]);
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);

/** 从文件名里抠出集号；抠不到就按给定顺序号补 */
function episodeNumber(name, fallback) {
  const base = name.replace(/\.[^.]+$/, "");
  const patterns = [
    /第\s*(\d{1,4})\s*[集话話期]/,
    /\bEP?\s*(\d{1,4})\b/i,
    /\bS\d{1,2}E(\d{1,4})\b/i,
    /(?:^|[\s._-])(\d{1,4})(?:[\s._-]|$)/,
  ];
  for (const re of patterns) {
    const m = re.exec(base);
    if (m) {
      const n = Number(m[1]);
      if (n > 0) return n;
    }
  }
  return fallback;
}

/** 由相对路径生成稳定 ID：同一文件每次扫描得到同一个数 */
function stableId(key) {
  const h = crypto.createHash("sha1").update(key).digest();
  return h.readUInt32BE(0) % 900000 + 100000;
}

function titleOf(name) {
  return name
    .replace(/\.[^.]+$/, "")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * @returns {{ videos: Array, files: Map<number, string> }}
 *   videos 是客户端要的 Detail 精简版；files 记录 video_id/ep → 磁盘绝对路径
 */
export function scan(mediaDir) {
  const videos = [];
  const files = new Map();

  const addSeries = (title, entries, cover, dirName) => {
    const eps = entries
      .map((e, i) => ({
        ep_num: episodeNumber(e.name, i + 1),
        title: titleOf(e.name),
        path: e.full,
        size: e.size,
      }))
      .sort((a, b) => a.ep_num - b.ep_num);

    // 集号去重：同号保留先出现的
    const seen = new Set();
    const unique = eps.filter((e) => (seen.has(e.ep_num) ? false : (seen.add(e.ep_num), true)));

    const id = stableId(dirName || title);
    unique.forEach((e) => files.set(`${id}:${e.ep_num}`, e.path));

    videos.push({
      id,
      title,
      key: dirName || title,
      cover: cover || "",
      description: "",
      tags: [],
      score: 0,
      episode_count: unique.length,
      total_episodes: unique.length,
      duration: 0,
      hot: 0,
      like_count: 0,
      collect_count: 0,
      comment_count: 0,
      is_finished: true,
      is_original: false,
      created_at: new Date().toISOString(),
      episodes: unique.map((e) => ({
        ep_num: e.ep_num,
        title: e.title,
        duration: 0,
        status: 1,
      })),
    });
  };

  for (const entry of listDir(mediaDir)) {
    const full = path.join(mediaDir, entry.name);
    if (entry.isDirectory()) {
      const children = listDir(full);
      const vids = children
        .filter((c) => c.isFile() && VIDEO_EXT.has(path.extname(c.name).toLowerCase()))
        .map((c) => {
          const p = path.join(full, c.name);
          let size = 0;
          try { size = fs.statSync(p).size; } catch { /* ignore */ }
          return { name: c.name, full: p, size };
        });
      const img = children.find(
        (c) => c.isFile() && IMAGE_EXT.has(path.extname(c.name).toLowerCase()) &&
          /^(cover|poster|folder|封面)/i.test(c.name),
      );
      if (vids.length) addSeries(titleOf(entry.name), vids, img ? path.join(full, img.name) : "", entry.name);
    } else if (entry.isFile() && VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) {
      let size = 0;
      try { size = fs.statSync(full).size; } catch { /* ignore */ }
      addSeries(titleOf(entry.name), [{ name: entry.name, full, size }], "", entry.name);
    }
  }

  videos.sort((a, b) => a.title.localeCompare(b.title, "zh-Hans-CN"));
  return { videos, files };
}
