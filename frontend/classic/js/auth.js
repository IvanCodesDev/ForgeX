/* InfiniSynapse Partner SSO 前端状态层。密钥与 code 兑换全部在服务端完成。 */
(function (root) {
  "use strict";

  function $(id) {
    return document.getElementById(id);
  }

  function messageFromQuery() {
    const q = new window.URLSearchParams(location.search);
    if (q.get("login") === "cancelled") return "登录已取消，你可以随时重新发起。";
    if (q.get("login") === "success") return "授权成功，正在进入工作台…";
    return "";
  }

  function showGate(message) {
    const gate = $("auth-gate");
    if (!gate) return;
    gate.hidden = false;
    document.body.classList.add("auth-required");
    $("auth-login").href = FXApiClient.url("/api/auth/infini/login");
    $("auth-message").textContent = message || messageFromQuery();
  }

  function showAccount(user) {
    const pill = $("account-pill");
    if (!pill) return;
    $("account-name").textContent = user.nickname || user.email || "InfiniSynapse 用户";
    const avatar = $("account-avatar");
    if (user.avatar && /^https:\/\//i.test(user.avatar)) {
      avatar.src = user.avatar;
      avatar.hidden = false;
    }
    pill.hidden = false;
  }

  function boot() {
    if (typeof FXApiClient === "undefined") return;
    // 离线直开没有同源 API；先确定运行模式，避免向 file:///api/auth 发出无效请求。
    if (location.protocol === "file:" && !FXApiClient.base) {
      root.FXAuth = {
        enabled: false,
        authenticated: false,
        user: null,
        canUseAi: false,
        integration: "offline",
      };
      return;
    }
    FXApiClient.authMe()
      .then(function (state) {
        root.FXAuth = state;
        if (!state.enabled) return;
        if (!state.authenticated) return showGate();
        if (!state.canUseAi)
          return showGate("账号已授权，但未能签发 Partner API Key，请清理账号中的旧 Key 后重新登录。");
        $("auth-gate").hidden = true;
        document.body.classList.remove("auth-required");
        showAccount(state.user || {});
      })
      .catch(function () {
        // 服务不可用时不伪装成登录成功；保留工作台原有离线降级能力。
      });

    const logout = $("account-logout");
    if (logout)
      logout.addEventListener("click", function () {
        logout.disabled = true;
        FXApiClient.logout()
          .then(function () {
            location.reload();
          })
          .catch(function () {
            logout.disabled = false;
          });
      });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(typeof window !== "undefined" ? window : globalThis);
