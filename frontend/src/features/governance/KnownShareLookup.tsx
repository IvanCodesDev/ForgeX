import { useState } from "react";
import type { GovernanceClient } from "./governance-client";

export interface KnownShareLookupProps {
  readonly client: GovernanceClient;
}

export function KnownShareLookup({ client }: KnownShareLookupProps) {
  const [token, setToken] = useState("");
  const href = client.shareHref(token);
  const touched = token.trim().length > 0;
  const inputId = "governance-share-token";
  const errorId = `${inputId}-error`;

  return (
    <section className="panel governance-share" aria-labelledby="governance-share-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">SHARE / KNOWN TOKEN ONLY</p>
          <h2 id="governance-share-heading">打开已有分享快照</h2>
        </div>
      </div>
      <p className="muted">
        创建分享必须引用已完成任务并通过任务归属校验；创建响应中的撤销密钥只返回一次。本页不虚构任务，也不代存撤销密钥。
      </p>
      <div className="governance-share-form">
        <label htmlFor={inputId}>
          18 位分享 token
          <input
            id={inputId}
            value={token}
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            disabled={client.mode === "offline"}
            aria-invalid={touched && !href}
            aria-describedby={touched && !href ? errorId : undefined}
            onChange={(event) => setToken(event.currentTarget.value)}
          />
        </label>
        {href ? (
          <a className="button-link" href={href} target="_blank" rel="noreferrer">
            打开服务端分享页
          </a>
        ) : (
          <button type="button" disabled>
            打开服务端分享页
          </button>
        )}
      </div>
      {client.mode === "offline" ? (
        <p className="muted" role="status">
          离线模式没有可验证的服务端分享地址。
        </p>
      ) : touched && !href ? (
        <p id={errorId} className="error-copy" role="alert">
          token 必须是服务端创建时返回的 18 位十六进制值。
        </p>
      ) : (
        <p className="muted">打开后由服务端验证分享是否存在、过期或已撤销。</p>
      )}
    </section>
  );
}
