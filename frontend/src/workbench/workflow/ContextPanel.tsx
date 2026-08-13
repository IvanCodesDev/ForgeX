import type { ReactNode } from "react";
import type { WorkbenchHandles } from "../useLegacyWorkbench";
import { NAV_ITEMS, navIndex, type WorkflowNavId } from "./nav-items";
import { CalibPage } from "./pages/CalibPage";
import { ImportPage } from "./pages/ImportPage";
import { QualityPage } from "./pages/QualityPage";
import { SlicePage } from "./pages/SlicePage";
import type { ImportAssets } from "./useImportAssets";
import type { WorkflowNav } from "./useWorkflowNav";

/** 四个流程页全部由 React 渲染；renderCtx 只负责 currentNav 同步与刷新事件。 */
function renderReactPage(id: WorkflowNavId, handles: WorkbenchHandles, assets: ImportAssets): ReactNode | null {
  if (id === "import") return <ImportPage sim={handles.sim} ui={handles.ui} bus={handles.bus} assets={assets} />;
  if (id === "slice") return <SlicePage sim={handles.sim} bus={handles.bus} />;
  if (id === "calib") return <CalibPage sim={handles.sim} bus={handles.bus} />;
  if (id === "quality") return <QualityPage sim={handles.sim} bus={handles.bus} />;
  return null;
}

interface ContextPanelProps {
  readonly nav: WorkflowNav;
  readonly handles: WorkbenchHandles | null;
  readonly assets: ImportAssets;
}

/* 面板壳、头部与内容体全部由 React 驱动（引擎启动完成前内容体为空）。 */
export function ContextPanel({ nav, handles, assets }: ContextPanelProps) {
  const index = navIndex(nav.lastNav);
  const item = NAV_ITEMS[index];
  const reactPage = handles ? renderReactPage(nav.lastNav, handles, assets) : null;

  return (
    <section
      id="ctx-panel"
      className={nav.entering ? "float-card boot-item entering" : "float-card boot-item"}
      hidden={!nav.open}
    >
      <header className="panel-head">
        <h2 id="ctx-title">{item?.title ?? ""}</h2>
        <span className="ph-tag mono" id="ctx-step">
          {`0${index + 1}`}
        </span>
        <button className="close-btn" id="ctx-close" title="收起面板" onClick={() => nav.close()} />
      </header>
      <div id="ctx-body" className="panel-body">
        {nav.open ? reactPage : null}
      </div>
    </section>
  );
}
