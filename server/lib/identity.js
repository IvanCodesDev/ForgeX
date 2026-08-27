/* 统一请求身份与资源级授权。

   认证优先级：有效 API Key > 本地匿名 IP（REQUIRE_AUTH=1 时匿名直接 401）。
   tenantId 当前与 caller 一致，后续迁移到 C# 时可替换为独立租户声明。 */
"use strict";

const crypto = require("crypto");
const { HttpError } = require("./http");

function storageId(value, prefix) {
  const raw = String(value || "legacy:unowned");
  if (raw === `${prefix}local`) return raw;
  if (raw.startsWith(prefix) && /^[a-f0-9]{32}$/.test(raw.slice(prefix.length))) return raw;
  return prefix + crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

async function resolveIdentity(req, rc, ctx) {
  const apiIdentity = ctx.auth.identify(req, rc.ip);
  if (apiIdentity.authenticated) {
    return Object.assign({}, apiIdentity, {
      tenantId: apiIdentity.caller,
      source: "api-key",
    });
  }

  const denied = ctx.auth.guard(apiIdentity);
  if (denied) throw new HttpError(denied.status, denied.message);
  return Object.assign({}, apiIdentity, {
    tenantId: apiIdentity.caller,
    source: "anonymous-ip",
  });
}

function requireOwner(resource, identity, ctx, resourceType, resourceId) {
  const ownerMatches = resource && (
    resource.owner === identity.tenantId ||
    resource.ownerId === storageId(identity.tenantId, "ow_")
  );
  if (ownerMatches) return resource;
  ctx.log.warn("resource access denied", {
    audit: true,
    action: "read",
    resourceType,
    resourceId: String(resourceId || ""),
    caller: identity.caller,
    tenantId: identity.tenantId,
    owner: resource && resource.owner ? resource.owner : "unowned",
  });
  throw new HttpError(403, "无权访问该资源");
}

module.exports = { resolveIdentity, requireOwner, storageId };
