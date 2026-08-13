/* InfiniSynapse Partner SSO 状态层（React 版，自 js/auth.js 收编）。
   密钥与 code 兑换全部在服务端完成；这里只读取登录态并驱动 gate / account pill。 */
import { useEffect, useState } from "react";
import { authMe, logout as apiLogout, url as apiUrl, clientState } from "../engine/api-client";

export interface AuthView {
  /** 登录门显示与文案；null = 不显示。 */
  gate: { message: string } | null;
  /** 账号胶囊；null = 不显示。 */
  account: { name: string; avatar: string | null } | null;
  loginUrl: string;
  loggingOut: boolean;
  logout: () => void;
}

function messageFromQuery(): string {
  const q = new URLSearchParams(location.search);
  if (q.get("login") === "cancelled") return "登录已取消，你可以随时重新发起。";
  if (q.get("login") === "success") return "授权成功，正在进入工作台…";
  return "";
}

export function useAuth(): AuthView {
  const [gate, setGate] = useState<{ message: string } | null>(null);
  const [account, setAccount] = useState<{ name: string; avatar: string | null } | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    // 离线直开没有同源 API；先确定运行模式，避免向 file:///api/auth 发出无效请求。
    if (location.protocol === "file:" && !clientState.base) return;
    let cancelled = false;
    authMe()
      .then((state) => {
        if (cancelled || !state.enabled) return;
        if (!state.authenticated) return setGate({ message: messageFromQuery() });
        if (!state.canUseAi)
          return setGate({ message: "账号已授权，但未能签发 Partner API Key，请清理账号中的旧 Key 后重新登录。" });
        const user = state.user || {};
        setGate(null);
        setAccount({
          name: user.nickname || user.email || "InfiniSynapse 用户",
          avatar: user.avatar && /^https:\/\//i.test(user.avatar) ? user.avatar : null,
        });
      })
      .catch(() => {
        // 服务不可用时不伪装成登录成功；保留工作台原有离线降级能力。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.body.classList.toggle("auth-required", gate != null);
    return () => document.body.classList.remove("auth-required");
  }, [gate]);

  return {
    gate,
    account,
    loginUrl: apiUrl("/api/auth/infini/login"),
    loggingOut,
    logout: () => {
      setLoggingOut(true);
      apiLogout()
        .then(() => location.reload())
        .catch(() => setLoggingOut(false));
    },
  };
}
