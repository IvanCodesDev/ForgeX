import { useEffect, useState } from "react";
import type { ApiAdapter, Capabilities } from "../../app/api/api-adapter";
import type { RuntimeMode } from "../../app/runtime/runtime-mode";
import type { FeatureFlags } from "../../app/runtime/feature-flags";

interface OverviewPageProps {
  readonly adapter: ApiAdapter;
  readonly runtimeMode: RuntimeMode;
  readonly featureFlags: FeatureFlags;
}

const completed = [
  "统一 SSO / API Key 身份优先级",
  "任务、SSE、结果、知识、数据源与分享 owner 隔离",
  "G-code SHA-256 运行时绑定",
  "Delta 中心原点与 file:// 启动修复",
  "24 组版本化黄金样例",
];

export function OverviewPage({ adapter, runtimeMode, featureFlags }: OverviewPageProps) {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    adapter
      .capabilities(controller.signal)
      .then(setCapabilities)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "服务能力探测失败");
      });
    return () => controller.abort();
  }, [adapter]);

  return (
    <div className="page-stack">
      <section className="hero-panel">
        <p className="eyebrow">REACT + TYPESCRIPT MIGRATION / STAGE 1</p>
        <h1>权威计算留在服务端，交互体验迁入现代前端。</h1>
        <p className="hero-copy">
          当前骨架以严格类型、运行模式检测和可替换 API Adapter 为边界；旧实现仍可运行，首个业务切片将从 G-code
          导入与摘要开始。
        </p>
        <div className="hero-meta">
          <span>Runtime：{runtimeMode.kind}</span>
          <span>API：{runtimeMode.apiBase === "" ? "same-origin" : (runtimeMode.apiBase ?? "disabled")}</span>
          <span>Feature：gcode-react {featureFlags.gcodeReact ? "on" : "off"}</span>
        </div>
      </section>

      <section className="grid-two">
        <article className="panel status-panel">
          <div className="panel-heading">
            <p className="eyebrow">CAPABILITY PROBE</p>
            <h2>当前计算能力</h2>
          </div>
          <div role="status" aria-live="polite">
            {capabilities ? (
              <dl className="capability-list">
                <div>
                  <dt>引擎</dt>
                  <dd>{capabilities.engine}</dd>
                </div>
                <div>
                  <dt>连接</dt>
                  <dd>{capabilities.available ? "ready" : "unavailable"}</dd>
                </div>
                <div>
                  <dt>AI</dt>
                  <dd>{capabilities.ai ? "available" : "rules / preview"}</dd>
                </div>
                <div>
                  <dt>作用域</dt>
                  <dd>{capabilities.scope}</dd>
                </div>
              </dl>
            ) : (
              <p className={error ? "error-copy" : "muted"}>{error || "正在探测…"}</p>
            )}
            {capabilities ? <p className="muted">{capabilities.detail}</p> : null}
          </div>
        </article>

        <article className="panel">
          <div className="panel-heading">
            <p className="eyebrow">STAGE 0 / VERIFIED</p>
            <h2>迁移前置条件</h2>
          </div>
          <ul className="check-list">
            {completed.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>
      </section>
    </div>
  );
}
