import { useMemo } from "react";
import type { IdentityState } from "./identity-client";
import { useIdentity } from "./IdentityProvider";

interface IdentityNotification {
  readonly id: string;
  readonly tone: "info" | "success" | "warning" | "error";
  readonly title: string;
  readonly detail: string;
}

function loginResultNotification(search: string): IdentityNotification | null {
  const result = new URLSearchParams(search).get("login");
  if (result === "success") {
    return { id: "login-success", tone: "success", title: "登录完成", detail: "授权回调已完成，身份已刷新。" };
  }
  if (result === "cancelled") {
    return { id: "login-cancelled", tone: "warning", title: "登录已取消", detail: "可随时重新发起 SSO 登录。" };
  }
  return null;
}

export function buildIdentityNotifications(state: IdentityState, search = ""): readonly IdentityNotification[] {
  const notifications: IdentityNotification[] = [];
  const loginResult = loginResultNotification(search);
  if (loginResult) notifications.push(loginResult);

  if (state.phase === "loading") {
    notifications.push({ id: "loading", tone: "info", title: "正在连接", detail: state.message });
  } else if (state.phase === "error") {
    notifications.push({ id: "error", tone: "error", title: "身份服务异常", detail: state.message });
  } else if (state.mode === "offline") {
    notifications.push({ id: "offline", tone: "info", title: "离线预览", detail: state.message });
  } else if (state.mode === "sso") {
    notifications.push({
      id: "sso",
      tone: state.canUseAi ? "success" : "warning",
      title: "SSO 会话有效",
      detail: state.canUseAi ? "当前用户可使用 AI 分析能力。" : "当前用户没有独立 AI 能力，将使用可用的基础功能。",
    });
  } else if (state.mode === "api") {
    notifications.push({
      id: "api",
      tone: "success",
      title: "API 能力已接入",
      detail: state.canUseAi ? "请求凭据已配置，服务报告 AI 能力可用。" : "请求凭据已配置，当前使用规则能力。",
    });
  } else {
    notifications.push({
      id: "anonymous",
      tone: state.authRequired ? "warning" : "info",
      title: state.authRequired ? "需要身份认证" : "匿名体验",
      detail: state.ssoEnabled ? "可通过 SSO 登录以获得用户级能力。" : "当前服务允许匿名使用基础功能。",
    });
  }
  return notifications;
}

function initials(state: IdentityState): string {
  const source = state.user?.displayName.trim() || (state.mode === "api" ? "API" : "访客");
  return Array.from(source).slice(0, 2).join("").toUpperCase();
}

function IdentityControl() {
  const { state, loginHref, logoutPending, refresh, logout } = useIdentity();
  if (state.phase === "loading") {
    return (
      <div className="identity-pill identity-loading" role="status" aria-busy="true">
        <span className="identity-avatar" aria-hidden="true">
          ···
        </span>
        <span className="identity-copy">
          <strong>身份核验中</strong>
          <small>正在连接服务</small>
        </span>
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div className="identity-pill identity-error" role="status">
        <span className="identity-avatar" aria-hidden="true">
          !
        </span>
        <span className="identity-copy">
          <strong>连接异常</strong>
          <small>{state.message}</small>
        </span>
        <button type="button" onClick={refresh}>
          重试
        </button>
      </div>
    );
  }

  const label =
    state.mode === "offline"
      ? "离线访客"
      : state.mode === "sso"
        ? state.user?.displayName || "SSO 用户"
        : state.mode === "api"
          ? "API 客户端"
          : "匿名访客";
  const detail =
    state.mode === "offline"
      ? "仅浏览器能力"
      : state.mode === "sso"
        ? state.canUseAi
          ? "SSO · AI 可用"
          : "SSO · 基础能力"
        : state.mode === "api"
          ? state.canUseAi
            ? "API · AI 可用"
            : "API · 规则能力"
          : state.authRequired
            ? "服务要求认证"
            : "免登录体验";

  return (
    <div className={`identity-pill identity-${state.mode}`}>
      <span className="identity-avatar" aria-hidden="true">
        {initials(state)}
      </span>
      <span className="identity-copy">
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
      {state.mode === "sso" ? (
        <button type="button" disabled={logoutPending} onClick={() => void logout()}>
          {logoutPending ? "退出中" : "退出"}
        </button>
      ) : state.mode === "anonymous" && state.ssoEnabled && loginHref ? (
        <a href={loginHref}>登录</a>
      ) : null}
    </div>
  );
}

function NotificationCenter({ notifications }: { readonly notifications: readonly IdentityNotification[] }) {
  return (
    <details className="notification-center">
      <summary aria-label={`通知，${notifications.length} 条`}>
        <span className="notification-label">通知</span>
        <span className="notification-count">{notifications.length}</span>
      </summary>
      <div className="notification-popover">
        <div className="notification-heading">
          <strong>运行通知</strong>
          <small>{notifications.length} 条</small>
        </div>
        <ul>
          {notifications.map((notification) => (
            <li key={notification.id} className={`notification-${notification.tone}`}>
              <strong>{notification.title}</strong>
              <p>{notification.detail}</p>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

export function IdentityHeader() {
  const { state } = useIdentity();
  const search = typeof window === "undefined" ? "" : window.location.search;
  const notifications = useMemo(() => buildIdentityNotifications(state, search), [search, state]);
  return (
    <>
      <span className="sr-only" aria-live="polite">
        {state.message}
      </span>
      <NotificationCenter notifications={notifications} />
      <IdentityControl />
    </>
  );
}
