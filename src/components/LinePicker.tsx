import { useEffect, useState } from "react";
import {
  api, hostOf, isMobile, normalizeLineInput,
  type LineItem, type LineProbe, type LineState,
} from "../api";
import { useStore } from "../store";
import { Modal, Sheet } from "./ui";
import { ICheck, IClose, IRefresh, ISettings } from "../icons";

type ProbeMap = Record<string, LineProbe>;

/* 单条线路：左侧点一下即切换，右侧单独检测 */
function Row({ item, current, probe, busy, disabled, onPick, onProbe }: {
  item: LineItem; current: boolean; probe?: LineProbe; busy: boolean; disabled: boolean;
  onPick: (item: LineItem) => void; onProbe: (url: string) => void;
}) {
  return (
    <div className={`flex items-center gap-2 px-3.5 py-2.5 ${current ? "bg-s3/70" : ""}`}>
      <button onClick={() => onPick(item)} disabled={disabled} className="flex-1 min-w-0 text-left pressable disabled:opacity-60">
        <div className="flex items-center gap-1.5 text-[12.5px] text-on">
          <span className="truncate">{item.name || item.host || hostOf(item.url)}</span>
          {current && <ICheck size={13} className="text-mint shrink-0" />}
        </div>
        <div className="text-[10.5px] text-mut truncate mt-0.5">{item.url}</div>
      </button>
      <span
        title={probe ? (probe.error || (probe.status ? `HTTP ${probe.status}` : "")) : ""}
        className={`text-[10.5px] tabular-nums shrink-0 ${probe ? (probe.ok ? "text-mint" : "text-danger") : "text-dim"}`}>
        {busy ? "…" : probe ? (probe.ok ? `${probe.ms}ms` : probe.status ? `HTTP ${probe.status}` : "失败") : "—"}
      </span>
      <button onClick={() => onProbe(item.url)} disabled={busy || disabled}
        className="shrink-0 h-7 px-2.5 rounded-(--r-sm) bg-s4 text-[11px] text-on/80 pressable disabled:opacity-50">检测</button>
    </div>
  );
}

/* 线路选择：桌面居中弹窗，移动端底部抽屉 */
export default function LinePicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast, setUser } = useStore();
  const [state, setState] = useState<LineState | null>(null);
  const [mirrors, setMirrors] = useState<LineItem[] | null>(null);
  const [mirrorErr, setMirrorErr] = useState("");
  const [loadingMirrors, setLoadingMirrors] = useState(false);
  const [probes, setProbes] = useState<ProbeMap>({});
  const [probing, setProbing] = useState("");
  const [switching, setSwitching] = useState("");
  /* 自定义线路输入（原作者删库后，这是唯一能救活客户端的入口） */
  const [custom, setCustom] = useState("");
  const [customErr, setCustomErr] = useState("");

  const readState = () => {
    api.lineState().then(setState).catch((e) => toast((e as Error).message || "读取线路失败", "info"));
  };

  const readMirrors = async () => {
    setLoadingMirrors(true);
    setMirrorErr("");
    try {
      const res = await api.lineMirrors();
      setMirrors(res?.items || []);
    } catch (e) {
      setMirrors([]);
      setMirrorErr((e as Error).message || "镜像线路获取失败");
    } finally {
      setLoadingMirrors(false);
    }
  };

  /* 镜像线路只在用户点开「线路」后才去拉，拉过一次就留在内存里，可手动刷新 */
  useEffect(() => {
    if (!open) return;
    readState();
    if (mirrors === null && state?.has_publish_page !== false) void readMirrors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const probe = async (list: LineItem[], key: string) => {
    if (!list.length) return;
    setProbing(key);
    try {
      const res = await api.lineProbe(list.map((x) => x.url));
      setProbes((p) => {
        const next = { ...p };
        for (const r of res) next[r.url] = r;
        return next;
      });
    } catch (e) {
      toast((e as Error).message || "检测失败", "info");
    } finally {
      setProbing("");
    }
  };

  /* guest=true 的地址来自自动发现的镜像，只给游客浏览；手填和固定线路可以登录 */
  const pick = async (url: string, guest: boolean) => {
    if (switching || state?.base === url) return;
    setSwitching(url);
    try {
      const next = await api.lineSet(url, guest);
      if (next !== state?.base) setUser(null);
      setState((s) => (s ? { ...s, base: next, trusted: !guest, placeholder: false } : s));
      toast(
        guest
          ? `线路已切换到 ${hostOf(next)}（仅游客浏览）`
          : `线路已切换到 ${hostOf(next)}，可以正常登录`,
        "ok",
      );
    } catch (e) {
      toast((e as Error).message || "切换失败", "info");
    } finally {
      setSwitching("");
    }
  };

  const applyCustom = async () => {
    const { url, error } = normalizeLineInput(custom);
    if (!url) {
      setCustomErr(error || "地址无效");
      return;
    }
    setCustomErr("");
    await pick(url, false);
  };

  const fixed = state?.fixed || [];
  const busyAll = !!probing || !!switching;
  const showMirrors = state?.has_publish_page !== false;

  const body = (
    <div className="flex flex-col min-h-0" style={{ maxHeight: isMobile ? "74vh" : "min(72vh, 620px)" }}>
      <div className="shrink-0 flex items-center gap-2 px-4 pt-3 pb-2">
        <span className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary"><ISettings size={16} /></span>
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-bold text-on leading-tight">线路</div>
          <div className="text-[10.5px] text-mut mt-0.5 truncate">
            当前：{state ? (state.placeholder ? "未配置" : hostOf(state.base)) : "读取中…"}
          </div>
        </div>
        <button onClick={onClose} aria-label="关闭" className="w-8 h-8 rounded-full bg-s3/80 flex items-center justify-center text-mut pressable"><IClose size={16} /></button>
      </div>

      <div className="flex-1 scroll-y px-3 pb-4">
        {/* 自定义线路：自建后端 / 自己找的可用地址都填这里 */}
        <div className="flex items-center gap-2 px-1 mt-1 mb-1.5">
          <span className="text-[10.5px] font-semibold text-dim tracking-wide">自定义线路</span>
          <span className="text-[10px] text-dim">填你自己的后端地址</span>
        </div>
        <div className="rounded-(--r-md) bg-s2 p-3">
          <div className="flex items-center gap-2">
            <input
              value={custom}
              onChange={(e) => { setCustom(e.target.value); setCustomErr(""); }}
              onKeyDown={(e) => { if (e.key === "Enter") void applyCustom(); }}
              placeholder="https://api.your-domain.com"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="flex-1 min-w-0 h-9 px-3 rounded-(--r-sm) bg-s4 text-[12px] text-on placeholder:text-dim outline-none"
            />
            <button onClick={() => void applyCustom()} disabled={busyAll || !custom.trim()}
              className="shrink-0 h-9 px-3.5 rounded-(--r-sm) bg-primary text-[12px] text-white pressable disabled:opacity-50">
              {switching && !fixed.some((f) => f.url === switching) ? "连接中…" : "使用"}
            </button>
          </div>
          {customErr && <div className="text-[10.5px] text-danger mt-1.5">{customErr}</div>}
          {!customErr && state?.placeholder && (
            <div className="text-[10.5px] text-dim mt-1.5 leading-relaxed">
              客户端还没连上任何数据源。填一个你自己部署的地址（仓库里的 server/ 可以直接跑），填完立刻生效。
            </div>
          )}
        </div>

        {!!fixed.length && (
          <>
            <div className="flex items-center gap-2 px-1 mt-4 mb-1.5">
              <span className="text-[10.5px] font-semibold text-dim tracking-wide">固定线路</span>
              <span className="text-[10px] text-dim">构建时写入</span>
              <button onClick={() => probe(fixed, "fixed")} disabled={busyAll}
                className="ml-auto text-[10.5px] text-primary pressable disabled:opacity-50">
                {probing === "fixed" ? "检测中…" : "全部检测"}
              </button>
            </div>
            <div className="rounded-(--r-md) bg-s2 divide-y divide-s3 overflow-hidden">
              {fixed.map((it) => (
                <Row key={it.url} item={it} current={state?.base === it.url} probe={probes[it.url]}
                  busy={probing === it.url} disabled={busyAll}
                  onPick={(x) => void pick(x.url, false)} onProbe={(u) => probe([{ url: u }], u)} />
              ))}
            </div>
          </>
        )}

        {showMirrors && (
          <>
            <div className="flex items-center gap-2 px-1 mt-4 mb-1.5">
              <span className="text-[10.5px] font-semibold text-dim tracking-wide">镜像线路</span>
              <span className="text-[10px] text-dim">一般可直连 · 仅游客浏览</span>
              <button onClick={() => { void readMirrors(); }} disabled={loadingMirrors}
                className="ml-auto inline-flex items-center gap-1 text-[10.5px] text-primary pressable disabled:opacity-50">
                <IRefresh size={12} />{loadingMirrors ? "获取中…" : "刷新"}
              </button>
            </div>
            <div className="rounded-(--r-md) bg-s2 divide-y divide-s3 overflow-hidden">
              {loadingMirrors && <div className="flex justify-center py-6"><div className="w-6 h-6 spinner" /></div>}
              {!loadingMirrors && mirrorErr && (
                <div className="px-3.5 py-3">
                  <div className="text-[11.5px] text-danger">镜像线路获取失败</div>
                  <div className="text-[10.5px] text-mut mt-1 break-all">{mirrorErr}</div>
                </div>
              )}
              {!loadingMirrors && !mirrorErr && mirrors?.length === 0 && (
                <div className="px-3.5 py-3 text-[11px] text-mut">地址发布页里没有可用的镜像地址</div>
              )}
              {!loadingMirrors && (mirrors || []).map((it) => (
                <Row key={it.url} item={it} current={state?.base === it.url} probe={probes[it.url]}
                  busy={probing === it.url} disabled={busyAll}
                  onPick={(x) => void pick(x.url, true)} onProbe={(u) => probe([{ url: u }], u)} />
              ))}
            </div>
            {!loadingMirrors && !!mirrors?.length && (
              <div className="flex justify-end px-1 mt-2">
                <button onClick={() => probe(mirrors, "mirrors")} disabled={busyAll}
                  className="text-[10.5px] text-primary pressable disabled:opacity-50">
                  {probing === "mirrors" ? "检测中…" : `全部检测（${mirrors.length}）`}
                </button>
              </div>
            )}
          </>
        )}

        <div className="text-[10px] text-dim leading-relaxed px-1 mt-4">
          切换后立即生效，请求链路与数据模型不变。固定的自定义线路与固定线路可以登录；自动发现的镜像线路只给游客浏览。
          不做自动检测 / 自动切换，只有点「检测」时才探测一次。
        </div>
      </div>
    </div>
  );

  return isMobile
    ? <Sheet open={open} onClose={onClose}>{body}</Sheet>
    : <Modal open={open} onClose={onClose} width={460}>{body}</Modal>;
}
