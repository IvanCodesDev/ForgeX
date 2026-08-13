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
              个分析维度，问题超出范围时它会明说没听懂。配置 InfiniSynapse 密钥后可切换到云端 AI。
            </p>
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
