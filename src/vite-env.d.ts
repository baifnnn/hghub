/// <reference types="vite/client" />

/** 由 vite.config.ts 的 define 注入，来源是 package.json 的 version */
declare const __APP_VERSION__: string;

/** 由 vite.config.ts 的 define 注入，来源是 src-tauri/src/config.rs 的 SITE（未配置为空串） */
declare const __SITE__: string;

/** 由 vite.config.ts 的 define 注入，来源是 src-tauri/src/config.rs 的 PROJECT_URL（未配置为空串） */
declare const __PROJECT_URL__: string;
