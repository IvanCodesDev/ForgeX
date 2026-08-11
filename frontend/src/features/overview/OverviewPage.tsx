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
  "React 身份、即时仿真、Profile、G-code、真机日志、数据分析与校准治理竖切片",
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
        <p className="eyebrow">REACT + TYPESCRIPT MIGRATION / STAGE 2</p>
        <h1>主用户流程按可回滚竖切片迁入 React。</h1>
        <p className="hero-copy">
          Header 身份、Profile
          参数、浏览器即时仿真、G-code/真机日志强摘要对账、本地可审计分析与服务端校准治理已接入；旧实现仍作为发布回滚基线。
        </p>
        <div className="hero-meta">
          <span>Runtime：{runtimeMode.kind}</span>
          <span>API：{runtimeMode.apiBase === "" ? "same-origin" : (runtimeMode.apiBase ?? "disabled")}</span>
          <span>Feature：gcode-react {featureFlags.gcodeReact ? "on" : "off"}</span>
          <span>Simulator：{featureFlags.simulatorReact ? "on" : "off"}</span>
          <span>Profile：{featureFlags.profileSelectorReact ? "on" : "off"}</span>
          <span>Machine log：{featureFlags.machineLogReact ? "on" : "off"}</span>
          <span>Analytics：{featureFlags.analyticsReact ? "on" : "off"}</span>
          <span>Governance：{featureFlags.governanceReact ? "on" : "off"}</span>
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
