import { useState, type ChangeEvent } from "react";
import {
  clearAiEndpoint,
  isAiEndpointConfigured,
  loadAiEndpoint,
  saveAiEndpoint,
  type AiEndpointSettings,
} from "../../engine/ai-endpoint";
import type { Overlays } from "./useOverlays";

export function Toasts({ overlays }: { readonly overlays: Overlays }) {
  return (
    <div id="toasts">
      {overlays.toasts.map((toast) => (
        <div key={toast.id} className={`toast t-${toast.kind}${toast.leaving ? " out" : ""}`}>
          {toast.message}
        </div>
      ))}
    </div>
  );
}

/* 自带 OpenAI 兼容端点的设置表单：三个字段只写 localStorage（见 engine/ai-endpoint.ts），
   随分析请求逐次发往薄后端，服务端不落日志、不持久化。放在「关于」弹窗内是刻意的：
   工作台常驻界面受 react-parity 像素门禁锁定，弹窗只在用户主动打开时出现，不影响比对。 */
const AI_FIELD_STYLE = {
  width: "100%",
  padding: "6px 9px",
  borderRadius: "var(--r-sm)",
  border: "1px solid var(--stroke-hi)",
  background: "rgba(255, 255, 255, 0.65)",
  color: "var(--ink-0)",
  fontFamily: "var(--f-mono)",
  fontSize: "12px",
} as const;

function AiEndpointSettingsForm() {
  const [settings, setSettings] = useState<AiEndpointSettings>(loadAiEndpoint);
  const [showKey, setShowKey] = useState(false);
  const [notice, setNotice] = useState("");

  const bind = (field: keyof AiEndpointSettings) => ({
    value: settings[field],
    onChange: (event: ChangeEvent<HTMLInputElement>) => setSettings({ ...settings, [field]: event.target.value }),
  });

  const save = () => {
    const trimmed: AiEndpointSettings = {
      baseUrl: settings.baseUrl.trim(),
      apiKey: settings.apiKey.trim(),
      model: settings.model.trim(),
    };
    const anyField = trimmed.baseUrl || trimmed.apiKey || trimmed.model;
    if (anyField && !isAiEndpointConfigured(trimmed)) {
      // 与服务端 parseAiOverride 同一校验口径，避免保存了也被 400 打回
      setNotice("需要同时提供 Base URL 与模型名（API Key 按端点要求可选）");
      return;
    }
    saveAiEndpoint(trimmed);
    setSettings(trimmed);
    setNotice(anyField ? "已保存。仅存于本浏览器，随分析请求逐次发送，服务端不保存。" : "已保存为空配置。");
  };

  const clear = () => {
    clearAiEndpoint();
    setSettings({ baseUrl: "", apiKey: "", model: "" });
    setNotice("已清除，本地不再保留任何端点信息。");
  };

  return (
    <div
      style={{
        border: "1px solid var(--stroke)",
        borderRadius: "var(--r-md)",
        padding: "10px 12px",
        display: "grid",
        gap: "8px",
      }}
    >
      <b>
        AI 设置（自带 OpenAI 兼容端点）
        <span style={{ fontWeight: "normal", color: "var(--ink-1)", marginLeft: "8px", fontSize: "12px" }}>
          {isAiEndpointConfigured(settings) ? "已配置" : "未配置（当前使用规则引擎）"}
        </span>
      </b>
      <label style={{ display: "grid", gap: "3px", fontSize: "12px" }}>
        Base URL（如 https://api.openai.com/v1 或本地 Ollama 地址）
        <input {...bind("baseUrl")} style={AI_FIELD_STYLE} placeholder="https://api.openai.com/v1" spellCheck={false} />
      </label>
      <label style={{ display: "grid", gap: "3px", fontSize: "12px" }}>
        API Key（按端点要求可选；仅存本浏览器）
        <span style={{ display: "flex", gap: "6px" }}>
          <input
            {...bind("apiKey")}
            style={AI_FIELD_STYLE}
            type={showKey ? "text" : "password"}
            placeholder="sk-…"
            spellCheck={false}
            autoComplete="off"
          />
          <button type="button" className="btn btn-ghost" onClick={() => setShowKey(!showKey)}>
            {showKey ? "隐藏" : "显示"}
          </button>
        </span>
      </label>
      <label style={{ display: "grid", gap: "3px", fontSize: "12px" }}>
        模型名（如 gpt-4o-mini / qwen2.5 等端点支持的模型）
        <input {...bind("model")} style={AI_FIELD_STYLE} placeholder="gpt-4o-mini" spellCheck={false} />
      </label>
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <button type="button" className="btn btn-primary" onClick={save}>
          保存
        </button>
        <button type="button" className="btn btn-ghost" onClick={clear}>
          清除
        </button>
        <span role="status" style={{ fontSize: "12px", color: "var(--ink-1)" }}>
          {notice}
        </span>
      </div>
    </div>
  );
}

/* 文案与结构和旧 _confirm / _aboutModal 一致；点遮罩空白处同样视为取消/关闭。 */
export function ModalHost({ overlays }: { readonly overlays: Overlays }) {
  const confirm = overlays.confirm;
  return (
    <div id="modal-root">
      {confirm ? (
        <div
          className="modal-mask"
          onClick={(event) => {
            if (event.target === event.currentTarget) overlays.resolveConfirm(false);
          }}
        >
          <div className="modal">
            <h3>
              <span className="ph-tick" />
              {confirm.title}
            </h3>
            <p>{confirm.text}</p>
            <div className="m-btns">
              <button className="btn btn-ghost" data-a="no" onClick={() => overlays.resolveConfirm(false)}>
                取消
              </button>
              <button className="btn btn-danger-ghost" data-a="ok" onClick={() => overlays.resolveConfirm(true)}>
                确认停止
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {overlays.aboutOpen ? (
        <div
          className="modal-mask"
          onClick={(event) => {
            if (event.target === event.currentTarget) overlays.closeAbout();
          }}
        >
          <div className="modal">
            <h3>
              <span className="ph-tick" />
              FORGE·X 智造洞察
            </h3>
            <p>
              FORGE·X 工业 3D 打印仿真 × 生产数据分析：左手模拟四款可切换机型（CoreXY 封闭式 / i3 龙门 / Delta 并联臂 /
              工业大幅面龙门）的完整打印流程，右手对生产数据做聚合分析。
            </p>
            <p>
              <b>快速上手</b>
              <br />① 顶部「模型」：切换打印机型，选择内置零件或上传图片生成浮雕 / 剪影模型
              <br />② 右上 <b>参数按钮</b>：调整工艺参数，「质量」页实时评估风险
              <br />③ 底部 Dock「开始打印」，观察喷头沿切片路径逐层成形
              <br />④ 右下 <b>波形按钮</b>：温度曲线、耗材、日志与故障演练
              <br />⑤ 顶部「<b>洞察</b>」：对生产数据提问 — 故障归因、材料对比、成本趋势
            </p>
            <p>
              <b>关于分析引擎</b>
              {"\u3000"}默认引擎是<b>规则引擎，不是 AI</b>：关键词意图路由 + 确定性聚合统计，只覆盖 5
              个分析维度，问题超出范围时它会明说没听懂。在下方「AI 设置」填入自己的 OpenAI 兼容端点后可切换到云端 AI
              叙述——数字仍由统计核算出，AI 只负责组织语言。
            </p>
            <AiEndpointSettingsForm />
            <p>
              <b>数据来源</b>
              {"\u3000"}内置示例是<b>合成数据</b>
              （预埋了故事线，仅供演示，不可据此下真实结论，界面上有「合成」标记）；支持上传自己的
              CSV；每次打印完成会自动采集为「仿真采集」数据集——那是真实的物理仿真结果。
            </p>
            <p>
              <b>视口操作</b>
              {"\u3000"}
              <span className="kbd">左键拖拽</span> 旋转 · <span className="kbd">右键拖拽</span> 平移 ·{" "}
              <span className="kbd">滚轮</span> 缩放
            </p>
            <div className="m-btns">
              <button className="btn btn-primary" data-a="ok" onClick={() => overlays.closeAbout()}>
                开始使用
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
