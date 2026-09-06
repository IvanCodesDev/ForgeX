using System.Net;
using System.Text.Json;
using ForgeX.Api;
using ForgeX.Application;
using ForgeX.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;

namespace ForgeX.ResourceGate;

/// <summary>The file leg of IShareRepository driven through the production ShareEndpoints handlers.</summary>
internal static class SharesSection
{
    private const string Report = "{\"title\":\"门禁报告\",\"verdict\":\"结论 <b>\",\"rowCount\":3,\"sections\":[{\"h\":\"小节\",\"lines\":[\"第一行\"]}]}";

    public static async Task RunAsync(Gate gate)
    {
        gate.Section("shares-file: IShareRepository file leg via ShareEndpoints");
        var ct = CancellationToken.None;
        var tenantA = Gate.Tenant('a');
        var ownerA = Gate.Owner('a');
        var ownerB = Gate.Owner('b');
        var directory = gate.TempDir("shares");

        var app = await StartAsync(gate, directory, TimeSpan.FromSeconds(30), maxPerOwner: 2000);
        var origin = Gate.Origin(app);
        var repository = app.Services.GetRequiredService<IShareRepository>();

        // Create → 201 with Node-shaped payload.
        var (created, createdBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/shares",
            $"{{\"report\":{Report},\"question\":\"为什么失败\",\"engine\":\"local\"}}", Gate.Trusted(tenantA, ownerA));
        gate.Check("shares-file-create-201", created.StatusCode == HttpStatusCode.Created, createdBody);
        var createdJson = Gate.Parse(createdBody);
        var token = createdJson.GetProperty("token").GetString()!;
        var revokeKey = createdJson.GetProperty("revokeKey").GetString()!;
        gate.Check("shares-file-create-shape",
            token.Length == 18 && revokeKey.Length == 18 &&
            createdJson.GetProperty("publicUrl").GetString() == "/share/" + token &&
            createdJson.GetProperty("expiresAt").ValueKind == JsonValueKind.Number &&
            createdJson.TryGetProperty("note", out _),
            createdBody);
        gate.Check("shares-file-record-on-disk", File.Exists(Path.Combine(directory, token + ".json")));

        // Public render → HTML, escaped, access counted.
        var (page, html) = await gate.SendAsync(origin, HttpMethod.Get, "/share/" + token);
        gate.Check("shares-file-render-200", page.StatusCode == HttpStatusCode.OK && page.Content.Headers.ContentType?.MediaType == "text/html", page.StatusCode);
        // HtmlEncoder.Default entity-encodes non-ASCII text, so compare on the decoded document and
        // separately assert that the raw markup never carries the unescaped user-supplied tag.
        var decoded = WebUtility.HtmlDecode(html);
        gate.Check("shares-file-render-content",
            decoded.Contains("门禁报告", StringComparison.Ordinal) &&
            decoded.Contains("结论 <b>", StringComparison.Ordinal) &&
            !html.Contains("<b>", StringComparison.Ordinal) &&
            decoded.Contains("样本 3 行", StringComparison.Ordinal) &&
            decoded.Contains("第一行", StringComparison.Ordinal),
            html.Length);
        await gate.SendAsync(origin, HttpMethod.Get, "/share/" + token);
        var record = await repository.GetPublicAsync(token, ct);
        gate.Check("shares-file-access-count", record is { AccessCount: 3, LastAccessedAt: not null }, record?.AccessCount);

        // Revoke: wrong key → 403; other owner → 404; correct key → ok; page gone afterwards.
        var (badKey, badKeyBody) = await gate.SendAsync(origin, HttpMethod.Post, $"/api/v1/shares/{token}/revoke",
            "{\"revokeKey\":\"nope\"}", Gate.Trusted(tenantA, ownerA));
        gate.Check("shares-file-revoke-bad-key-403", badKey.StatusCode == HttpStatusCode.Forbidden && badKeyBody.Contains("bad_revoke_key", StringComparison.Ordinal), badKeyBody);
        var (foreign, foreignBody) = await gate.SendAsync(origin, HttpMethod.Post, $"/api/v1/shares/{token}/revoke",
            $"{{\"revokeKey\":\"{revokeKey}\"}}", Gate.Trusted(tenantA, ownerB));
        gate.Check("shares-file-revoke-other-owner-404", foreign.StatusCode == HttpStatusCode.NotFound && foreignBody.Contains("share_not_found", StringComparison.Ordinal), foreignBody);
        var (revoked, revokedBody) = await gate.SendAsync(origin, HttpMethod.Post, $"/api/v1/shares/{token}/revoke",
            $"{{\"revokeKey\":\"{revokeKey}\"}}", Gate.Trusted(tenantA, ownerA));
        gate.Check("shares-file-revoke-200", revoked.StatusCode == HttpStatusCode.OK && Gate.Parse(revokedBody).GetProperty("revoked").GetBoolean(), revokedBody);
        var (gone, goneBody) = await gate.SendAsync(origin, HttpMethod.Get, "/share/" + token);
        gate.Check("shares-file-render-after-revoke-404", gone.StatusCode == HttpStatusCode.NotFound && goneBody.Contains("share_not_found", StringComparison.Ordinal), goneBody);
        gate.Check("shares-file-revoke-missing-404", (await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/shares/unknown/revoke", "{}", Gate.Trusted(tenantA, ownerA))).Response.StatusCode == HttpStatusCode.NotFound);

        // Validation parity with the PG leg / Node route.
        var (badJson, badJsonBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/shares", "{not json", Gate.Trusted(tenantA, ownerA));
        gate.Check("shares-file-invalid-json-400", badJson.StatusCode == HttpStatusCode.BadRequest && badJsonBody.Contains("invalid_json", StringComparison.Ordinal), badJsonBody);
        var (badReport, badReportBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/shares", "{\"report\":[1]}", Gate.Trusted(tenantA, ownerA));
        gate.Check("shares-file-invalid-report-400", badReport.StatusCode == HttpStatusCode.BadRequest && badReportBody.Contains("invalid_report", StringComparison.Ordinal), badReportBody);
        var huge = "{\"report\":{\"pad\":\"" + new string('x', 5 * 1024 * 1024 + 1024) + "\"}}";
        var (tooLarge, tooLargeBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/shares", huge, Gate.Trusted(tenantA, ownerA));
        gate.Check("shares-file-payload-too-large-413", tooLarge.StatusCode == HttpStatusCode.RequestEntityTooLarge && tooLargeBody.Contains("payload_too_large", StringComparison.Ordinal), tooLargeBody);

        // TTL: requested ttl is capped by the configured ttl; a tiny ttl expires and is deleted on read.
        var (capped, cappedBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/shares",
            $"{{\"report\":{Report},\"ttlMs\":{7L * 24 * 3600 * 1000}}}", Gate.Trusted(tenantA, ownerA));
        var cappedExpires = Gate.Parse(cappedBody).GetProperty("expiresAt").GetInt64();
        gate.Check("shares-file-ttl-capped", capped.StatusCode == HttpStatusCode.Created && cappedExpires - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() <= 30_000, cappedExpires);
        var (shortLived, shortBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/shares",
            $"{{\"report\":{Report},\"ttlMs\":20}}", Gate.Trusted(tenantA, ownerA));
        var shortToken = Gate.Parse(shortBody).GetProperty("token").GetString()!;
        gate.Check("shares-file-short-ttl-created", shortLived.StatusCode == HttpStatusCode.Created, shortBody);
        await Task.Delay(80, ct);
        var (expired, _) = await gate.SendAsync(origin, HttpMethod.Get, "/share/" + shortToken);
        gate.Check("shares-file-expired-404-and-deleted", expired.StatusCode == HttpStatusCode.NotFound && !File.Exists(Path.Combine(directory, shortToken + ".json")), expired.StatusCode);

        // Count / Sweep: sweep removes expired records only.
        var (sweepTarget, sweepBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/shares",
            $"{{\"report\":{Report},\"ttlMs\":20}}", Gate.Trusted(tenantA, ownerA));
        var sweepToken = Gate.Parse(sweepBody).GetProperty("token").GetString()!;
        gate.Check("shares-file-sweep-target-created", sweepTarget.StatusCode == HttpStatusCode.Created, sweepBody);
        await Task.Delay(80, ct);
        var liveBefore = await repository.CountAsync(ct);
        var swept = await repository.SweepAsync(DateTimeOffset.UtcNow, ct);
        gate.Check("shares-file-sweep", swept == 1 && !File.Exists(Path.Combine(directory, sweepToken + ".json")) && await repository.CountAsync(ct) == liveBefore, $"{swept}/{liveBefore}");

        // Restart: a fresh repository over the same directory still serves the record.
        var reopened = new FileShareRepository(directory, TimeSpan.FromSeconds(30));
        var cappedToken = Gate.Parse(cappedBody).GetProperty("token").GetString()!;
        gate.Check("shares-file-survives-restart", (await reopened.GetPublicAsync(cappedToken, ct)) is { Question: "" }, cappedToken);
        gate.Check("shares-file-probe", await Task.Run(async () => { await reopened.ProbeAsync(ct); return true; }, ct));

        // Eviction (A5): with max 2 per owner the OLDEST share disappears, the newest two remain.
        var evictionApp = await StartAsync(gate, gate.TempDir("shares-evict"), TimeSpan.FromSeconds(30), maxPerOwner: 2);
        var evictionOrigin = Gate.Origin(evictionApp);
        var tokens = new List<string>();
        for (var i = 0; i < 3; i++)
        {
            var (_, body) = await gate.SendAsync(evictionOrigin, HttpMethod.Post, "/api/v1/shares", $"{{\"report\":{Report}}}", Gate.Trusted(tenantA, ownerA));
            tokens.Add(Gate.Parse(body).GetProperty("token").GetString()!);
            await Task.Delay(5, ct);
        }
        var (_, otherOwnerBody) = await gate.SendAsync(evictionOrigin, HttpMethod.Post, "/api/v1/shares", $"{{\"report\":{Report}}}", Gate.Trusted(tenantA, ownerB));
        var otherOwnerToken = Gate.Parse(otherOwnerBody).GetProperty("token").GetString()!;
        var statuses = new List<HttpStatusCode>();
        foreach (var candidate in tokens)
        {
            statuses.Add((await gate.SendAsync(evictionOrigin, HttpMethod.Get, "/share/" + candidate)).Response.StatusCode);
        }
        gate.Check("shares-file-evict-oldest-first",
            statuses[0] == HttpStatusCode.NotFound && statuses[1] == HttpStatusCode.OK && statuses[2] == HttpStatusCode.OK,
            string.Join(",", statuses));
        gate.Check("shares-file-evict-other-owner-untouched", (await gate.SendAsync(evictionOrigin, HttpMethod.Get, "/share/" + otherOwnerToken)).Response.StatusCode == HttpStatusCode.OK);
    }

    private static Task<WebApplication> StartAsync(Gate gate, string directory, TimeSpan ttl, int maxPerOwner) =>
        gate.StartApiAsync(
            new Dictionary<string, string?>(),
            builder =>
            {
                builder.Services.AddSingleton(new SharePublicBase(string.Empty));
                builder.Services.AddSingleton<IShareRepository>(_ => new FileShareRepository(directory, ttl, maxPerOwner));
            },
            ShareEndpoints.Map);
}
