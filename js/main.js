/* FORGE·X — 启动引导 */
(function () {
  "use strict";

  function showFallback(msg, err) {
    console.error("[FORGE·X] 初始化失败：", err || msg);
    const reason = document.getElementById("fb-reason");
    if (reason && msg) reason.textContent = msg;
    document.getElementById("webgl-fallback").hidden = false;
  }

  function boot() {
    if (window.FX_COMPAT && !window.FX_COMPAT.ok) return;  // 守卫已提示，避免覆盖文案
    const canvas = document.getElementById("gl");
    let fx;
    try {
      if (typeof THREE === "undefined") throw new Error("THREE 未加载");
      fx = new FXScene(canvas);
    } catch (e) {
      const s = String((e && e.message) || e);
      showFallback(
        s.indexOf("THREE") >= 0
          ? "核心组件加载失败，请检查文件是否完整。"
          : "当前浏览器或显卡驱动不支持 WebGL（或已被禁用）。",
        e
      );
      return;
    }

    const bus = new FXU.EventBus();
    const sim = new FXSim(fx, bus);
    fx.onTick = (dt, t) => sim.tick(dt, t);

    const ui = new FXUI(sim, fx, bus);
    const insight = new FXInsight(sim, fx, bus, ui);
    window.FX = { fx, sim, ui, insight, bus };   // 便于控制台调试

    // 默认载入行星齿轮并切片
    sim.setModel(ui._builtins()[0], true);
    ui.renderCtx("import");

    bus.emit("state", "idle");
    sim.log("ok", "FORGE·X 仿真系统初始化完成 · FX-256 已联机（模拟）");
    sim.log("info", "运动系统自检通过 · XY 皮带张力正常 · 三丝杆同步就绪");
    sim.log("info", "载入默认模型「行星齿轮」，切片完成，等待任务指令");
    sim.log("info", "智造洞察已就绪 · 内置示例生产数据 · 顶部「洞察」可开始数据分析");

    // 启动动画结束后移除 boot 类，避免动画重放
    setTimeout(() => document.body.classList.remove("boot"), 1600);

    // #insight 锚点直达洞察面板；?q=问题 直达分析结果（可分享的演示链接）
    const qMatch = /[?&]q=([^&]+)/.exec(location.search);
    if (location.hash === "#insight" || qMatch) {
      setTimeout(() => {
        bus.emit("insight-toggle", document.getElementById("pill-insight"));
        if (qMatch) {
          try { insight.ask(decodeURIComponent(qMatch[1])); } catch (e) { /* 非法编码忽略 */ }
        }
      }, 700);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
