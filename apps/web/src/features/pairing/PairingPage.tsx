import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { claimPairing, requestPairing } from "../../lib/api/client";

export function PairingPage() {
  const navigate = useNavigate();
  const [code, setCode] = useState(readCodeFromHash);
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [permission, setPermission] = useState<"read-only" | "reply" | "full-control">("reply");
  const [status, setStatus] = useState<"idle" | "requesting" | "pending">("idle");
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    return () => abortRef.current?.abort();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setStatus("requesting");
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const pairing = await requestPairing({ code, deviceName, permission });
      setStatus("pending");
      while (!controller.signal.aborted) {
        await delay(1_500, controller.signal);
        const claim = await claimPairing(pairing.requestId, pairing.exchangeToken, controller.signal);
        if (claim.status === "pending") continue;
        if (claim.status === "rejected") {
          setStatus("idle");
          setError("Mac 已拒绝这次配对。请确认设备后重新生成配对码。");
          return;
        }
        navigate("/attention", { replace: true });
        return;
      }
    } catch (caught) {
      if (controller.signal.aborted) return;
      setStatus("idle");
      setError(caught instanceof Error ? caught.message : "配对失败，请重试。");
    }
  };

  return (
    <main className="centered-page">
      <section className="surface pairing-card">
        <span className="eyebrow">Corptie Web</span>
        <h1>连接这台 Mac</h1>
        <p>输入 Mac 上显示的一次性配对码。提交后还需要在 Mac 上确认这台设备。</p>
        <form className="pairing-form" onSubmit={(event) => void submit(event)}>
          <label>
            <span>六位配对码</span>
            <input
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              required
            />
          </label>
          <label>
            <span>设备名称</span>
            <input
              autoComplete="off"
              maxLength={80}
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
              required
            />
          </label>
          <label>
            <span>访问权限</span>
            <select value={permission} onChange={(event) => setPermission(event.target.value as typeof permission)}>
              <option value="read-only">只读</option>
              <option value="reply">查看并回复（推荐）</option>
              <option value="full-control">完整控制</option>
            </select>
          </label>
          <button type="submit" disabled={status !== "idle" || code.length !== 6 || !deviceName.trim()}>
            {status === "requesting" ? "正在提交…" : status === "pending" ? "等待 Mac 确认…" : "请求配对"}
          </button>
        </form>
        {status === "pending" ? (
          <div className="pairing-status" role="status">
            请求已发送。请回到 Mac 核对设备名称和权限，然后批准或拒绝。
          </div>
        ) : null}
        {error ? <div className="form-error" role="alert">{error}</div> : null}
      </section>
    </main>
  );
}

function readCodeFromHash() {
  return new URLSearchParams(window.location.hash.replace(/^#/, "")).get("code")?.replace(/\D/g, "").slice(0, 6) ?? "";
}

function defaultDeviceName() {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
    || navigator.platform;
  return platform ? `${platform} Web` : "Mobile Web";
}

function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}
