import { lazy, Suspense, useMemo, type ReactNode } from "react";
import { HashRouter, Route, Routes } from "react-router-dom";
import { createApiAdapter } from "./api/api-adapter";
import { AppShell } from "./AppShell";
import { detectRuntimeMode } from "./runtime/runtime-mode";
import { readFeatureFlags } from "./runtime/feature-flags";
import { GcodePlaceholderPage } from "../features/gcode/GcodePlaceholderPage";
import { OverviewPage } from "../features/overview/OverviewPage";

const ArchitecturePage = lazy(() =>
  import("../features/architecture/ArchitecturePage").then((module) => ({ default: module.ArchitecturePage }))
);
const GcodePage = lazy(() => import("../features/gcode/GcodePage").then((module) => ({ default: module.GcodePage })));

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

export function App() {
  const runtimeMode = useMemo(() => detectRuntimeMode(window.location, import.meta.env), []);
  const adapter = useMemo(() => createApiAdapter(runtimeMode), [runtimeMode]);
  const featureFlags = useMemo(() => readFeatureFlags(import.meta.env), []);

  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell runtimeMode={runtimeMode} />}>
          <Route
            index
            element={<OverviewPage adapter={adapter} runtimeMode={runtimeMode} featureFlags={featureFlags} />}
          />
          <Route path="gcode" element={featureFlags.gcodeReact ? deferred(<GcodePage />) : <GcodePlaceholderPage />} />
          <Route path="architecture" element={deferred(<ArchitecturePage />)} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
