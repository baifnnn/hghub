/**
 * 服务端配置：全部通过环境变量覆盖，源码里不写死任何个人域名。
 *
 *   PORT          监听端口，默认 8787
 *   PUBLIC_BASE   对外可访问的根地址，例如 https://api.your-domain.com
 *                 生成封面/播放地址时用它拼绝对 URL；不填则按请求头推断
 *   DATA_DIR      用户/评论/收藏等可变数据的目录，默认 ./data
 *   MEDIA_DIR     媒体库目录，默认 ./media
 *   CACHE_DIR     HLS 转码缓存目录，默认 ./cache
 *   ADMIN_USER    首次启动时创建的管理员账号，默认 admin
 *   ADMIN_PASS    首次启动时的管理员密码，默认随机生成并打印到控制台
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

export const config = {
  port: Number(process.env.PORT || 8787),
  publicBase: (process.env.PUBLIC_BASE || "").replace(/\/+$/, ""),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(root, "data")),
  mediaDir: path.resolve(process.env.MEDIA_DIR || path.join(root, "media")),
  cacheDir: path.resolve(process.env.CACHE_DIR || path.join(root, "cache")),
  adminUser: process.env.ADMIN_USER || "admin",
  adminPass: process.env.ADMIN_PASS || "",
  /** HLS 分片时长（秒）：越大分片越少、起播越慢 */
  hlsTime: Number(process.env.HLS_TIME || 6),
  ffmpeg: process.env.FFMPEG || "ffmpeg",
};
