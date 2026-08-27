import { useRef, type ChangeEvent } from "react";
import { Dock } from "./cockpit/Dock";
import { Hud } from "./cockpit/Hud";
import { MonitorPanel } from "./cockpit/MonitorPanel";
import { FullscreenButton, SpeedControl, StatusPill } from "./cockpit/TopControls";
import { useSimState } from "./cockpit/useSimState";
import { useTelemetry } from "./cockpit/telemetry";
import { InsightPanel } from "./insight/InsightPanel";
import { useInsight } from "./insight/useInsight";
import { ModalHost, Toasts } from "./overlays/Overlays";
import { useOverlays } from "./overlays/useOverlays";
import { ParamPanel } from "./params/ParamPanel";
import { ContextPanel } from "./workflow/ContextPanel";
import { FlowPills } from "./workflow/FlowPills";
import { useImportAssets } from "./workflow/useImportAssets";
import { useWorkflowNav } from "./workflow/useWorkflowNav";
import { useLegacyWorkbench } from "./useLegacyWorkbench";

/* 工作台外壳：结构与 index.html 逐节点对应，样式复用 css/style.css。
   全部区域均由 React 渲染；引擎只写 #gl 画布（WebGL），不再有命令式 DOM 填充。 */
export function Workbench() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { handles, fallback } = useLegacyWorkbench(canvasRef);
  const state = useSimState(handles?.sim ?? null, handles?.bus ?? null);
  const telemetry = useTelemetry(handles?.sim ?? null);
  const nav = useWorkflowNav(handles);
  const assets = useImportAssets(handles);
  const overlays = useOverlays(handles);
  const insight = useInsight(handles, nav.close);

  const pickFile = (handler: (file: File) => void) => (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) handler(file);
    event.target.value = "";
  };

  return (
    <>
      <div id="bg-space" aria-hidden="true" />

      <canvas id="gl" ref={canvasRef} />

      <div id="webgl-fallback" hidden={!fallback}>
        <div className="fb-card">
          <h2>无法初始化 3D 视口</h2>
          <p id="fb-reason">{fallback ?? "当前浏览器或显卡驱动不支持 WebGL。"}</p>
          <p>
            建议：① 更换 Chrome / Edge / Firefox / 360 极速模式等现代浏览器；② 在浏览器设置中开启「硬件加速」；③
            更新显卡驱动后重试。
          </p>
        </div>
      </div>

      <header id="topbar">
        <div className="top-left">
          <div className="brand pill-card boot-item">
            {/* SVG 与旧 ui.js _brand 注入的标记一致 */}
            <div className="brand-mark" id="brand-mark">
              <svg viewBox="0 0 32 32">
                <circle cx="16" cy="16" r="14" fill="#2c323e" />
                <path d="M11 12h10l-3.4 6h-3.2z" fill="#eef1f6" />
                <rect x="14.6" y="19.5" width="2.8" height="4.5" fill="#ff6a2b" />
              </svg>
            </div>
            <div className="brand-text">
              <div className="brand-name">FORGE·X</div>
              <div className="brand-strip" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
              </div>
            </div>
          </div>
        </div>

        <FlowPills nav={nav} insightOpen={insight.open} />

        <div className="top-right boot-item">
          <StatusPill state={state} />
          <SpeedControl sim={handles?.sim ?? null} ui={handles?.ui ?? null} />
          <button
            className={overlays.param.open ? "icon-btn pill-card on" : "icon-btn pill-card"}
            id="btn-params"
            title="工艺参数"
            onClick={() => overlays.toggleParam()}
          />
          <button
            className="icon-btn pill-card"
            id="btn-about"
            title="关于与操作说明"
            onClick={() => overlays.openAbout()}
          />
          <FullscreenButton ui={handles?.ui ?? null} />
        </div>
      </header>

      <ContextPanel nav={nav} handles={handles} assets={assets} />

      <aside
        id="param-panel"
        className={overlays.param.entering ? "float-card entering" : "float-card"}
        hidden={!overlays.param.open}
      >
        <header className="panel-head">
          <h2>工艺参数</h2>
          <span
            className="ph-tag mono warn-tag"
            id="param-lock-tag"
            hidden={!(state !== "idle" && state !== "done") && !handles?.sim.importedToolpath}
          >
            {state !== "idle" && state !== "done" ? "打印中锁定" : "G-code 几何已固化"}
          </span>
          <button className="close-btn" id="param-close" title="收起面板" onClick={() => overlays.toggleParam()} />
        </header>
        <div className="panel-body" id="param-body">
          {handles ? <ParamPanel sim={handles.sim} ui={handles.ui} bus={handles.bus} assets={assets} /> : null}
        </div>
      </aside>

      <InsightPanel insight={insight} ui={handles?.ui ?? null} />

      <Hud fx={handles?.fx ?? null} telemetry={telemetry} fleetOn={insight.fleetOn} onExitFleet={insight.exitFleet} />

      <Dock
        sim={handles?.sim ?? null}
        ui={handles?.ui ?? null}
        state={state}
        telemetry={telemetry}
        monitorOpen={overlays.monitor.open}
        onToggleMonitor={overlays.toggleMonitor}
      />

      <MonitorPanel telemetry={telemetry} handles={handles} overlays={overlays} />

      <Toasts overlays={overlays} />
      <ModalHost overlays={overlays} />
      {/* 六个隐藏文件输入框全部由宿主绑定（uploads 区 + 洞察 CSV） */}
      <input
        type="file"
        id="file-input"
        accept="image/png,image/jpeg,image/webp,image/bmp"
        hidden
        onChange={pickFile(assets.handleImageFile)}
      />
      <input type="file" id="csv-input" accept=".csv,text/csv" hidden onChange={pickFile(insight.handleCsvFile)} />
      <input
        type="file"
        id="gcode-input"
        accept=".gcode,.gco,.gc,text/x-gcode,text/plain"
        hidden
        onChange={pickFile(assets.handleGcodeFile)}
      />
      <input
        type="file"
        id="machine-log-input"
        accept=".json,.csv,application/json,text/csv"
        hidden
        onChange={pickFile(assets.handleMachineLogFile)}
      />
      <input
        type="file"
        id="profile-input"
        accept=".json,application/json"
        hidden
        onChange={pickFile(assets.handleProfileFile)}
      />
      <input
        type="file"
        id="calibration-input"
        accept=".json,application/json"
        hidden
        onChange={pickFile(assets.handleCalibrationFile)}
      />
    </>
  );
}
