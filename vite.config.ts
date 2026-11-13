import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";

const host = process.env.TAURI_DEV_HOST;
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

/**
 * 从 Rust 侧的 src-tauri/src/config.rs 里读常量，前端不要在别处再写一遍域名。
 * 读不到就给空串，让界面退回「未配置」状态，而不是继续指向已经删库的上游。
 */
function rustConst(name: string): string {
  try {
    const src = readFileSync(new URL("./src-tauri/src/config.rs", import.meta.url), "utf8");
    const m = new RegExp(`pub\\s+const\\s+${name}\\s*:\\s*&str\\s*=\\s*"([^"]*)"`).exec(src);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  // 版本号只维护 package.json（CI 会按 tag 改写它），界面里的版本由这里注入，避免写死后漂移
  define: {
    __APP_VERSION__: JSON.stringify(version),
    // 站点根地址 / 项目地址同样只在 config.rs 里维护
    __SITE__: JSON.stringify(rustConst("SITE")),
    __PROJECT_URL__: JSON.stringify(rustConst("PROJECT_URL")),
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
  },
});
