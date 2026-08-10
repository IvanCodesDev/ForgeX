import { NavLink, Outlet } from "react-router-dom";
import type { RuntimeMode } from "./runtime/runtime-mode";

interface AppShellProps {
  readonly runtimeMode: RuntimeMode;
}

export function AppShell({ runtimeMode }: AppShellProps) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <header className="topbar">
        <a className="brand" href="#/" aria-label="FORGE X 首页">
          <span className="brand-mark">FX</span>
          <span>
            <strong>FORGE·X</strong>
            <small>INDUSTRIAL WORKBENCH</small>
          </span>
        </a>
        <div className={`runtime-pill runtime-${runtimeMode.kind}`}>
          <span aria-hidden="true" />
          {runtimeMode.kind === "remote" ? "服务接入" : "离线预览"}
        </div>
      </header>
      <aside className="sidebar" aria-label="主导航">
        <p className="nav-label">工作台</p>
        <nav>
          <NavLink to="/" end>
            迁移总览
          </NavLink>
          <NavLink to="/gcode">G-code 切片</NavLink>
          <NavLink to="/architecture">架构边界</NavLink>
        </nav>
        <div className="legacy-note">
          <strong>渐进替换</strong>
          <p>现有 JavaScript 页面继续作为回滚基线；新功能按垂直切片迁入。</p>
        </div>
      </aside>
      <main className="workspace" id="main-content" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
