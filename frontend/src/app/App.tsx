import { lazy, Suspense, useMemo, type ReactNode } from "react";
import { HashRouter, Route, Routes } from "react-router-dom";
import { createApiAdapter } from "./api/api-adapter";
import { AppShell } from "./AppShell";
import { detectRuntimeMode } from "./runtime/runtime-mode";
import { readFeatureFlags } from "./runtime/feature-flags";
import { GcodePlaceholderPage } from "../features/gcode/GcodePlaceholderPage";
import { OverviewPage } from "../features/overview/OverviewPage";
import { IdentityProvider } from "../features/identity/IdentityProvider";

const ArchitecturePage = lazy(() =>
  import("../features/architecture/ArchitecturePage").then((module) => ({ default: module.ArchitecturePage }))
);
const SimulatorPage = lazy(() =>
  import("../features/simulator/SimulatorPage").then((module) => ({ default: module.SimulatorPage }))
);
const GcodePage = lazy(() => import("../features/gcode/GcodePage").then((module) => ({ default: module.GcodePage })));
const AnalyticsPage = lazy(() =>
  import("../features/analytics/AnalyticsPage").then((module) => ({ default: module.AnalyticsPage }))
);
const CalibrationGovernancePage = lazy(() =>
  import("../features/governance/CalibrationGovernancePage").then((module) => ({
    default: module.CalibrationGovernancePage,
  }))
);

function deferred(page: ReactNode): ReactNode {
  return (
    <Suspense
      fallback={
        <p className="route-loading" role="status">
          正在加载工作区…
        </p>
      }
    >
      {page}
    </Suspense>
  );
}

function NotFoundPage() {
  return (
    <section className="panel placeholder-page">
      <p className="eyebrow">ROUTE / 404</p>
      <h1>工作区不存在</h1>
      <p>该 React 路由尚未迁入。请从左侧导航返回已启用的垂直切片。</p>
      <a href="#/">返回迁移总览</a>
    </section>
  );
}

function DisabledFeaturePage({ title }: { readonly title: string }) {
  return (
    <section className="panel placeholder-page">
      <p className="eyebrow">FEATURE ROLLBACK</p>
      <h1>{title}已由独立开关回退</h1>
      <p>其他 React 垂直切片继续运行；如需完整旧流程，可返回原 JavaScript 入口。</p>
      <a href="../">打开旧入口</a>
    </section>
  );
}

export function App() {
  const runtimeMode = useMemo(() => detectRuntimeMode(window.location, import.meta.env), []);
  const adapter = useMemo(() => createApiAdapter(runtimeMode), [runtimeMode]);
  const featureFlags = useMemo(() => readFeatureFlags(import.meta.env), []);

  return (
    <HashRouter>
      <IdentityProvider runtimeMode={runtimeMode}>
        <Routes>
          <Route element={<AppShell runtimeMode={runtimeMode} />}>
            <Route
              index
              element={<OverviewPage adapter={adapter} runtimeMode={runtimeMode} featureFlags={featureFlags} />}
            />
            <Route
              path="simulator"
              element={
                featureFlags.simulatorReact ? deferred(<SimulatorPage />) : <DisabledFeaturePage title="设备过程仿真" />
              }
            />
            <Route
              path="gcode"
              element={
                featureFlags.gcodeReact ? deferred(<GcodePage featureFlags={featureFlags} />) : <GcodePlaceholderPage />
              }
            />
            <Route
              path="analytics"
              element={
                featureFlags.analyticsReact ? deferred(<AnalyticsPage />) : <DisabledFeaturePage title="数据分析" />
              }
            />
            <Route
              path="governance"
              element={
                featureFlags.governanceReact ? (
                  deferred(<CalibrationGovernancePage runtimeMode={runtimeMode} />)
                ) : (
                  <DisabledFeaturePage title="校准治理" />
                )
              }
            />
            <Route path="architecture" element={deferred(<ArchitecturePage />)} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </IdentityProvider>
    </HashRouter>
  );
}
