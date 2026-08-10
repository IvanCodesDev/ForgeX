"use strict";

const assert = require("assert");
const { PartnerSSO, publicPath } = require("../server/services/partner-sso");
const { InfiniClient } = require("../server/services/infini");

function response() {
  return {
    status: 0,
    headers: {},
    body: "",
    setHeader(k, v) {
      this.headers[k] = v;
    },
    writeHead(status, headers) {
      this.status = status;
      Object.assign(this.headers, headers || {});
    },
    end(body) {
      this.body = body || "";
    },
  };
}

const calls = [];
const fakeFetch = async (url, options) => {
  calls.push({ url, options });
  const isSession = /\/sessions$/.test(url);
  return {
    ok: true,
    status: 200,
    async json() {
      return isSession
        ? { code: 200, data: { entryUrl: "https://app.infinisynapse.cn/auth/entry?session=ps_test" } }
        : {
            code: 200,
            data: {
              user: { id: "u_1", nickname: "测试用户", email: "u@example.com", avatar: "https://example.com/a.png" },
              apiKey: "sk-user-test",
            },
          };
    },
  };
};

const cfg = {
  infiniPartnerApi: "https://api.infinisynapse.cn/api",
  infiniPartnerClientId: "partner_test",
  infiniPartnerClientSecret: "psk_test",
  publicBase: "https://example.com/projects/forgex",
  loginSessionTtlMs: 3600000,
};
const log = { info() {}, warn() {} };

(async () => {
  const sso = new PartnerSSO(cfg, log, fakeFetch);
  assert.strictEqual(sso.enabled, true);
  assert.strictEqual(publicPath(cfg.publicBase), "/projects/forgex/");
  const userClient = new InfiniClient(
    { infiniKey: "sk-global", mode: "infinisynapse", modeReason: "global" },
    log
  ).withKey("sk-user-test");
  assert.strictEqual(userClient.cfg.infiniKey, "sk-user-test");
  assert.strictEqual(userClient.cfg.mode, "infinisynapse");

  const loginRes = response();
  await sso.begin({ headers: {} }, loginRes);
  assert.strictEqual(loginRes.status, 302);
  assert(/^https:\/\/app\.infinisynapse\.cn\//.test(loginRes.headers.Location));
  assert(/HttpOnly/.test(loginRes.headers["Set-Cookie"]));
  assert(/Secure/.test(loginRes.headers["Set-Cookie"]));
  const oauthCookie = loginRes.headers["Set-Cookie"].split(";")[0];
  const created = JSON.parse(calls[0].options.body);
  assert.strictEqual(created.returnUrl, "https://example.com/projects/forgex/api/auth/infini/callback");
  assert(created.state.length >= 32);

  const callbackRes = response();
  await sso.callback(
    { url: "/api/auth/infini/callback?code=ac_test&state=" + created.state, headers: { cookie: oauthCookie } },
    callbackRes
  );
  assert.strictEqual(callbackRes.status, 302);
  assert.strictEqual(callbackRes.headers.Location, "https://example.com/projects/forgex/?login=success");
  const tokenBody = JSON.parse(calls[1].options.body);
  assert.strictEqual(tokenBody.withApiKey, true);
  assert.strictEqual(tokenBody.grant_type, "authorization_code");

  const sessionCookie = callbackRes.headers["Set-Cookie"][0].split(";")[0];
  const meRes = response();
  sso.me({ headers: { cookie: sessionCookie } }, meRes);
  const me = JSON.parse(meRes.body);
  assert.strictEqual(me.authenticated, true);
  assert.strictEqual(me.canUseAi, true);
  assert.strictEqual(me.user.id, "u_1");
  assert.strictEqual("apiKey" in me, false);

  const identity = sso.identity({ headers: { cookie: sessionCookie } });
  assert.strictEqual(identity.apiKey, "sk-user-test");

  const logoutRes = response();
  sso.logout({ headers: { cookie: sessionCookie } }, logoutRes);
  assert.strictEqual(JSON.parse(logoutRes.body).ok, true);
  assert.strictEqual(sso.identity({ headers: { cookie: sessionCookie } }), null);

  await assert.rejects(
    () => sso.callback({ url: "/api/auth/infini/callback?code=bad&state=bad", headers: {} }, response()),
    (err) => err.status === 400
  );

  console.log("Partner SSO OK: state 校验、code 兑换、HttpOnly 会话、用户 Key 隔离、退出登录");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
