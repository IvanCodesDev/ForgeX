using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using ForgeX.Api;
using ForgeX.Application;
using ForgeX.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;

namespace ForgeX.ResourceGate;

/// <summary>
/// Calibration governance: direct-mode identity tri-state, the Node file-version state machine,
/// trusted-channel actor headers and Node calibrations.json compatibility (decision A1).
/// </summary>
internal static class CalibrationSection
{
    private const string AlphaKey = "alpha-key";
    private const string BetaKey = "beta-key";
    private const string ReviewKey = "review-key";
    private const string Reason = "Holdout metrics and anonymization evidence reviewed.";

    private static readonly Dictionary<string, string?> DirectSettings = new()
    {
        ["DirectAuth:ApiKeys"] = AlphaKey + "," + BetaKey,
        ["DirectAuth:CalibrationReviewKeys"] = ReviewKey + "," + BetaKey,
    };

    public static async Task RunAsync(Gate gate)
    {
        await RunLegAsync(gate, "file", (max, name) => new FileCalibrationGovernanceStore(Path.Combine(gate.TempDir("calibrations-" + name), "calibrations.json"), max));
        await RunNodeFixtureCompatibilityAsync(gate);
        await RunTrustedChannelAsync(gate);
        if (gate.HasPostgres)
        {
            await RunLegAsync(gate, "postgres", (max, _) => new PostgresCalibrationGovernanceStore(gate.PostgresUrl, RandomTenant(), null, max));
        }
    }

    private static async Task RunLegAsync(Gate gate, string leg, Func<int, string, ICalibrationGovernanceStore> storeFactory)
    {
        gate.Section($"calibrations-{leg}: CalibrationGovernanceEndpoints (direct mode)");
        var ct = CancellationToken.None;
        var alpha = Sha8(AlphaKey);
        var beta = Sha8(BetaKey);
        var reviewer = Sha8(ReviewKey);

        // Tri-state without any configured key: both roles answer 503 (Node submitter()/reviewer()).
        var disabledApp = await gate.StartApiAsync(new Dictionary<string, string?>(), builder => builder.Services.AddSingleton(storeFactory(200, "disabled")), CalibrationGovernanceEndpoints.Map, secret: "");
        var (noKeysSubmit, noKeysSubmitBody) = await gate.SendAsync(Gate.Origin(disabledApp), HttpMethod.Post, "/api/v1/calibrations/submissions", "{}");
        gate.Check($"calibrations-{leg}-submit-503-no-api-keys", noKeysSubmit.StatusCode == HttpStatusCode.ServiceUnavailable && noKeysSubmitBody.Contains("校准候选提交接口未启用：请先配置 API_KEYS", StringComparison.Ordinal), noKeysSubmitBody);
        var (noKeysList, noKeysListBody) = await gate.SendAsync(Gate.Origin(disabledApp), HttpMethod.Get, "/api/v1/calibrations/submissions");
        gate.Check($"calibrations-{leg}-review-503-no-review-keys", noKeysList.StatusCode == HttpStatusCode.ServiceUnavailable && noKeysListBody.Contains("校准审核接口未启用：请先配置 CALIBRATION_REVIEW_KEYS", StringComparison.Ordinal), noKeysListBody);

        var store = storeFactory(200, "main");
        var app = await gate.StartApiAsync(DirectSettings, builder => builder.Services.AddSingleton(store), CalibrationGovernanceEndpoints.Map, secret: "");
        var origin = Gate.Origin(app);

        // Public catalog / stats need no identity.
        var (catalog, catalogBody) = await gate.SendAsync(origin, HttpMethod.Get, "/api/v1/calibrations");
        var catalogJson = Gate.Parse(catalogBody);
        gate.Check($"calibrations-{leg}-catalog-empty",
            catalog.StatusCode == HttpStatusCode.OK &&
            catalogJson.GetProperty("format").GetString() == "forgex-calibration-catalog" &&
            catalogJson.GetProperty("version").GetInt32() == 1 &&
            catalogJson.GetProperty("items").GetArrayLength() == 0,
            catalogBody);
        var (stats, statsBody) = await gate.SendAsync(origin, HttpMethod.Get, "/api/v1/calibrations/stats");
        gate.Check($"calibrations-{leg}-stats-empty", stats.StatusCode == HttpStatusCode.OK && statsBody.Contains("\"approved\":0", StringComparison.Ordinal) && statsBody.Contains("\"pending\":0", StringComparison.Ordinal), statsBody);

        // Identity tri-state (direct mode).
        var (anonSubmit, anonSubmitBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/submissions", "{}");
        gate.Check($"calibrations-{leg}-submit-401-anonymous", anonSubmit.StatusCode == HttpStatusCode.Unauthorized && anonSubmitBody.Contains("校准候选提交需要有效 API Key", StringComparison.Ordinal), anonSubmitBody);
        var (wrongKeySubmit, wrongKeySubmitBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/submissions", "{}", Bearer("nope"));
        gate.Check($"calibrations-{leg}-submit-401-unknown-key", wrongKeySubmit.StatusCode == HttpStatusCode.Unauthorized, wrongKeySubmitBody);
        var (anonList, anonListBody) = await gate.SendAsync(origin, HttpMethod.Get, "/api/v1/calibrations/submissions");
        gate.Check($"calibrations-{leg}-review-401-anonymous", anonList.StatusCode == HttpStatusCode.Unauthorized && anonListBody.Contains("校准审核需要审核密钥", StringComparison.Ordinal), anonListBody);
        var (plainKeyList, plainKeyListBody) = await gate.SendAsync(origin, HttpMethod.Get, "/api/v1/calibrations/submissions", null, Bearer(AlphaKey));
        gate.Check($"calibrations-{leg}-review-403-plain-key", plainKeyList.StatusCode == HttpStatusCode.Forbidden && plainKeyListBody.Contains("当前凭据没有校准审核权限", StringComparison.Ordinal), plainKeyListBody);
        var (xApiKeyList, xApiKeyListBody) = await gate.SendAsync(origin, HttpMethod.Get, "/api/v1/calibrations/submissions", null, ("X-API-Key", ReviewKey));
        gate.Check($"calibrations-{leg}-review-x-api-key-accepted", xApiKeyList.StatusCode == HttpStatusCode.OK && Gate.Parse(xApiKeyListBody).GetProperty("submissions").GetArrayLength() == 0, xApiKeyListBody);

        // Submit a valid candidate.
        var bundle1 = Candidate("gate-bundle", 1);
        var (submitted, submittedBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/submissions",
            Body(new { bundle = bundle1, note = "Initial production candidate" }), Bearer(AlphaKey));
        var submittedJson = Gate.Parse(submittedBody);
        gate.Check($"calibrations-{leg}-submit-201", submitted.StatusCode == HttpStatusCode.Created, submittedBody);
        gate.Check($"calibrations-{leg}-submit-shape",
            submittedJson.GetProperty("id").GetString() == "gate-bundle" &&
            submittedJson.GetProperty("revision").GetInt32() == 1 &&
            submittedJson.GetProperty("status").GetString() == "pending" &&
            submittedJson.GetProperty("digest").GetString() == CalibrationGovernanceRules.Digest(bundle1) &&
            submittedJson.GetProperty("submittedBy").GetString() == alpha,
            submittedBody);

        // Submission validation parity (Node file-version texts, "；" joiner).
        var (duplicate, duplicateBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/submissions", Body(new { bundle = bundle1 }), Bearer(AlphaKey));
        gate.Check($"calibrations-{leg}-submit-409-duplicate", duplicate.StatusCode == HttpStatusCode.Conflict && duplicateBody.Contains("该 bundle revision 已经提交", StringComparison.Ordinal), duplicateBody);
        // A valid synthetic bundle (validator: synthetic ⇒ demonstration-only) still fails the server-side provenance gate.
        var synthetic = Mutate(bundle1, node => { node["provenance"] = "synthetic-conformance"; node["models"]![0]!["status"] = "demonstration-only"; });
        var (syntheticResponse, syntheticBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/submissions", Body(new { bundle = synthetic }), Bearer(AlphaKey));
        gate.Check($"calibrations-{leg}-submit-400-provenance", syntheticResponse.StatusCode == HttpStatusCode.BadRequest && syntheticBody.Contains("服务端只接受具有真实数据来源声明的候选校准包", StringComparison.Ordinal), syntheticBody);
        var active = Mutate(Candidate("gate-bundle", 5), node => node["models"]![0]!["status"] = "active");
        var (activeResponse, activeBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/submissions", Body(new { bundle = active }), Bearer(AlphaKey));
        gate.Check($"calibrations-{leg}-submit-400-not-candidate", activeResponse.StatusCode == HttpStatusCode.BadRequest && activeBody.Contains("提交到审批队列的模型必须全部为 candidate", StringComparison.Ordinal), activeBody);
        var invalid = Mutate(Candidate("gate-bundle", 5), node => { node.AsObject().Remove("models"); node["version"] = 2; });
        var (invalidResponse, invalidBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/submissions", Body(new { bundle = invalid }), Bearer(AlphaKey));
        gate.Check($"calibrations-{leg}-submit-400-validation-joined",
            invalidResponse.StatusCode == HttpStatusCode.BadRequest && invalidBody.Contains("version 必须是 1；models 至少需要一项", StringComparison.Ordinal),
            invalidBody);
        var (noBundle, noBundleBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/submissions", "{\"note\":\"x\"}", Bearer(AlphaKey));
        gate.Check($"calibrations-{leg}-submit-400-missing-bundle", noBundle.StatusCode == HttpStatusCode.BadRequest && noBundleBody.Contains("bundle 必须是对象", StringComparison.Ordinal), noBundleBody);
        var (badJson, badJsonBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/submissions", "{nope", Bearer(AlphaKey));
        gate.Check($"calibrations-{leg}-submit-400-invalid-json", badJson.StatusCode == HttpStatusCode.BadRequest && badJsonBody.Contains("invalid_json", StringComparison.Ordinal), badJsonBody);
        var huge = "{\"note\":\"" + new string('x', 2 * 1024 * 1024 + 64 * 1024 + 16) + "\"}";
        var (tooLarge, tooLargeBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/submissions", huge, Bearer(AlphaKey));
        gate.Check($"calibrations-{leg}-submit-413", tooLarge.StatusCode == HttpStatusCode.RequestEntityTooLarge && tooLargeBody.Contains("请求体过大", StringComparison.Ordinal), tooLargeBody);

        // Review validation order: 403 → decision → reason → self-approval → 404.
        var reviewPath = "/api/v1/calibrations/gate-bundle/revisions/1/review";
        var (plainReview, plainReviewBody) = await gate.SendAsync(origin, HttpMethod.Post, reviewPath, Body(new { decision = "approve", reason = Reason }), Bearer(AlphaKey));
        gate.Check($"calibrations-{leg}-review-403-plain-key", plainReview.StatusCode == HttpStatusCode.Forbidden, plainReviewBody);
        var (maybe, maybeBody) = await gate.SendAsync(origin, HttpMethod.Post, reviewPath, Body(new { decision = "maybe", reason = Reason }), Bearer(ReviewKey));
        gate.Check($"calibrations-{leg}-review-400-decision", maybe.StatusCode == HttpStatusCode.BadRequest && maybeBody.Contains("decision 必须是 approve 或 reject", StringComparison.Ordinal), maybeBody);
        var (shortReason, shortReasonBody) = await gate.SendAsync(origin, HttpMethod.Post, reviewPath, Body(new { decision = "approve", reason = "short" }), Bearer(ReviewKey));
        gate.Check($"calibrations-{leg}-review-400-reason", shortReason.StatusCode == HttpStatusCode.BadRequest && shortReasonBody.Contains("审核原因至少需要 10 个字符", StringComparison.Ordinal), shortReasonBody);
        var (betaSubmit, betaSubmitBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/submissions", Body(new { bundle = Candidate("gate-bundle", 2), note = 42 }), Bearer(BetaKey));
        gate.Check($"calibrations-{leg}-submit-201-beta", betaSubmit.StatusCode == HttpStatusCode.Created && Gate.Parse(betaSubmitBody).GetProperty("submittedBy").GetString() == beta, betaSubmitBody);
        var (selfApprove, selfApproveBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/gate-bundle/revisions/2/review", Body(new { decision = "approve", reason = Reason }), Bearer(BetaKey));
        gate.Check($"calibrations-{leg}-review-409-self-approval", selfApprove.StatusCode == HttpStatusCode.Conflict && selfApproveBody.Contains("提交者不能审批自己提交的校准包", StringComparison.Ordinal), selfApproveBody);
        var (missing, missingBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/nope/revisions/1/review", Body(new { decision = "approve", reason = Reason }), Bearer(ReviewKey));
        gate.Check($"calibrations-{leg}-review-404", missing.StatusCode == HttpStatusCode.NotFound && missingBody.Contains("校准包提交不存在", StringComparison.Ordinal), missingBody);
        var (badRoute, _) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/bad$id/revisions/1/review", Body(new { decision = "approve", reason = Reason }), Bearer(ReviewKey));
        gate.Check($"calibrations-{leg}-review-route-constraint-404", badRoute.StatusCode == HttpStatusCode.NotFound, badRoute.StatusCode);

        // Approve rev 1 → catalog publishes the active bundle; submission keeps the candidate bundle (Node file semantics).
        var (approved, approvedBody) = await gate.SendAsync(origin, HttpMethod.Post, reviewPath, Body(new { decision = "approve", reason = Reason }), Bearer(ReviewKey));
        var approvedJson = Gate.Parse(approvedBody);
        gate.Check($"calibrations-{leg}-review-200-approve",
            approved.StatusCode == HttpStatusCode.OK &&
            approvedJson.GetProperty("status").GetString() == "approved" &&
            approvedJson.GetProperty("reviewedBy").GetString() == reviewer &&
            approvedJson.GetProperty("reviewReason").GetString() == Reason &&
            approvedJson.GetProperty("revision").GetInt32() == 1,
            approvedBody);
        var published = CalibrationGovernanceRules.Publish(bundle1);
        var (catalog1, catalog1Body) = await gate.SendAsync(origin, HttpMethod.Get, "/api/v1/calibrations");
        var item = Gate.Parse(catalog1Body).GetProperty("items")[0];
        gate.Check($"calibrations-{leg}-catalog-published",
            catalog1.StatusCode == HttpStatusCode.OK &&
            item.GetProperty("id").GetString() == "gate-bundle" &&
            item.GetProperty("revision").GetInt32() == 1 &&
            item.GetProperty("bundle").GetProperty("models")[0].GetProperty("status").GetString() == "active" &&
            item.GetProperty("digest").GetString() == CalibrationGovernanceRules.Digest(published) &&
            item.GetProperty("approvedBy").GetString() == reviewer,
            catalog1Body);
        var (again, againBody) = await gate.SendAsync(origin, HttpMethod.Post, reviewPath, Body(new { decision = "reject", reason = Reason }), Bearer(ReviewKey));
        gate.Check($"calibrations-{leg}-review-409-already-reviewed", again.StatusCode == HttpStatusCode.Conflict && againBody.Contains("该提交已经完成审核", StringComparison.Ordinal), againBody);
        var (stats1, stats1Body) = await gate.SendAsync(origin, HttpMethod.Get, "/api/v1/calibrations/stats");
        gate.Check($"calibrations-{leg}-stats-1-1", stats1.StatusCode == HttpStatusCode.OK && stats1Body.Contains("\"approved\":1", StringComparison.Ordinal) && stats1Body.Contains("\"pending\":1", StringComparison.Ordinal), stats1Body);

        var (list, listBody) = await gate.SendAsync(origin, HttpMethod.Get, "/api/v1/calibrations/submissions", null, Bearer(ReviewKey));
        var submissions = Gate.Parse(listBody).GetProperty("submissions");
        gate.Check($"calibrations-{leg}-list-newest-first",
            list.StatusCode == HttpStatusCode.OK && submissions.GetArrayLength() == 2 &&
            submissions[0].GetProperty("key").GetString() == "gate-bundle@2" &&
            submissions[1].GetProperty("key").GetString() == "gate-bundle@1",
            listBody);
        var approvedRecord = submissions[1];
        var pendingRecord = submissions[0];
        gate.Check($"calibrations-{leg}-list-record-shape",
            approvedRecord.GetProperty("status").GetString() == "approved" &&
            approvedRecord.GetProperty("reviewedBy").GetString() == reviewer &&
            approvedRecord.GetProperty("bundle").GetProperty("models")[0].GetProperty("status").GetString() == "candidate" &&
            approvedRecord.GetProperty("note").GetString() == "Initial production candidate" &&
            approvedRecord.GetProperty("events").GetArrayLength() == 2 &&
            approvedRecord.GetProperty("events")[1].GetProperty("action").GetString() == "approved" &&
            approvedRecord.GetProperty("events")[1].GetProperty("actor").GetString() == reviewer &&
            pendingRecord.GetProperty("note").GetString() == "42" &&
            !pendingRecord.TryGetProperty("reviewedBy", out _) &&
            pendingRecord.GetProperty("events")[0].GetProperty("reason").GetString() == "42",
            listBody);

        // Monotonic revisions: the duplicate check wins for an already-submitted key (Node order), so use
        // a fresh, lower revision of a published bundle to reach the "must be higher" rule.
        var (staleDuplicate, staleDuplicateBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/submissions", Body(new { bundle = Candidate("gate-bundle", 1) }), Bearer(AlphaKey));
        gate.Check($"calibrations-{leg}-submit-409-duplicate-before-revision", staleDuplicate.StatusCode == HttpStatusCode.Conflict && staleDuplicateBody.Contains("该 bundle revision 已经提交", StringComparison.Ordinal), staleDuplicateBody);
        await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/submissions", Body(new { bundle = Candidate("mono-bundle", 2) }), Bearer(AlphaKey));
        var (approveMono, approveMonoBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/mono-bundle/revisions/2/review", Body(new { decision = "approve", reason = Reason }), Bearer(ReviewKey));
        gate.Check($"calibrations-{leg}-review-200-approve-mono", approveMono.StatusCode == HttpStatusCode.OK, approveMonoBody);
        var (stale, staleBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/submissions", Body(new { bundle = Candidate("mono-bundle", 1) }), Bearer(AlphaKey));
        gate.Check($"calibrations-{leg}-submit-409-revision-not-higher", stale.StatusCode == HttpStatusCode.Conflict && staleBody.Contains("新提交的 revision 必须高于当前已发布版本", StringComparison.Ordinal), staleBody);
        await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/submissions", Body(new { bundle = Candidate("gate-bundle", 3) }), Bearer(AlphaKey));
        await Task.Delay(5, ct);
        await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/submissions", Body(new { bundle = Candidate("gate-bundle", 4) }), Bearer(AlphaKey));
        var (approve4, approve4Body) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/gate-bundle/revisions/4/review", Body(new { decision = "approve", reason = Reason }), Bearer(ReviewKey));
        gate.Check($"calibrations-{leg}-review-200-approve-4", approve4.StatusCode == HttpStatusCode.OK, approve4Body);
        var (approve3, approve3Body) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/gate-bundle/revisions/3/review", Body(new { decision = "approve", reason = Reason }), Bearer(ReviewKey));
        gate.Check($"calibrations-{leg}-review-409-approve-lower", approve3.StatusCode == HttpStatusCode.Conflict && approve3Body.Contains("审批版本不高于当前已发布版本", StringComparison.Ordinal), approve3Body);
        var (rejected, rejectedBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/gate-bundle/revisions/3/review", Body(new { decision = "reject", reason = Reason }), Bearer(ReviewKey));
        gate.Check($"calibrations-{leg}-review-200-reject", rejected.StatusCode == HttpStatusCode.OK && Gate.Parse(rejectedBody).GetProperty("status").GetString() == "rejected", rejectedBody);
        var (catalog4, catalog4Body) = await gate.SendAsync(origin, HttpMethod.Get, "/api/v1/calibrations");
        var items4 = Gate.Parse(catalog4Body).GetProperty("items");
        gate.Check($"calibrations-{leg}-catalog-latest-revision-ordered",
            items4.GetArrayLength() == 2 &&
            items4[0].GetProperty("id").GetString() == "gate-bundle" && items4[0].GetProperty("revision").GetInt32() == 4 &&
            items4[1].GetProperty("id").GetString() == "mono-bundle" && items4[1].GetProperty("revision").GetInt32() == 2,
            catalog4Body);
        var storeStats = await store.StatsAsync(ct);
        gate.Check($"calibrations-{leg}-stats-after-reviews", storeStats.Approved == 2 && storeStats.Pending == 1, storeStats);

        // Eviction: max 3 → after reject 1 & 2 and a 4th submission, the earliest-updated non-pending goes.
        var evictStore = storeFactory(3, "evict");
        var evictApp = await gate.StartApiAsync(DirectSettings, builder => builder.Services.AddSingleton(evictStore), CalibrationGovernanceEndpoints.Map, secret: "");
        var evictOrigin = Gate.Origin(evictApp);
        for (var revision = 1; revision <= 3; revision++)
        {
            await gate.SendAsync(evictOrigin, HttpMethod.Post, "/api/v1/calibrations/submissions", Body(new { bundle = Candidate("evict-bundle", revision) }), Bearer(AlphaKey));
            await Task.Delay(5, ct); // distinct createdAt so "newest first" is unambiguous on both legs
        }
        await gate.SendAsync(evictOrigin, HttpMethod.Post, "/api/v1/calibrations/evict-bundle/revisions/1/review", Body(new { decision = "reject", reason = Reason }), Bearer(ReviewKey));
        await Task.Delay(5, ct);
        await gate.SendAsync(evictOrigin, HttpMethod.Post, "/api/v1/calibrations/evict-bundle/revisions/2/review", Body(new { decision = "reject", reason = Reason }), Bearer(ReviewKey));
        var (fourth, fourthBody) = await gate.SendAsync(evictOrigin, HttpMethod.Post, "/api/v1/calibrations/submissions", Body(new { bundle = Candidate("evict-bundle", 4) }), Bearer(AlphaKey));
        gate.Check($"calibrations-{leg}-evict-submit-201", fourth.StatusCode == HttpStatusCode.Created, fourthBody);
        var evicted = await evictStore.ListSubmissionsAsync(ct);
        var keys = string.Join(",", evicted.Select(static record => record.Key));
        gate.Check($"calibrations-{leg}-evict-oldest-non-pending", keys == "evict-bundle@4,evict-bundle@3,evict-bundle@2", keys);

        if (store is FileCalibrationGovernanceStore fileStore)
        {
            // Restart: a new store over the same file sees the published catalog; the file is Node-shaped.
            var reopened = new FileCalibrationGovernanceStore(fileStore.StateFilePath);
            var releases = await reopened.ListApprovedAsync(ct);
            gate.Check($"calibrations-{leg}-survives-restart", releases.Count == 2 && releases[0].Id == "gate-bundle" && releases[0].Revision == 4, releases.Count);
            using var document = JsonDocument.Parse(await File.ReadAllTextAsync(fileStore.StateFilePath, ct));
            var root = document.RootElement;
            var stateSubmissions = root.GetProperty("submissions");
            var rev1 = stateSubmissions.GetProperty("gate-bundle@1");
            gate.Check($"calibrations-{leg}-state-file-shape",
                root.GetProperty("format").GetString() == "forgex-calibration-service-state" &&
                root.GetProperty("version").GetInt32() == 1 &&
                stateSubmissions.EnumerateObject().Count() == 5 &&
                root.GetProperty("approved").EnumerateObject().Count() == 2 &&
                root.GetProperty("approved").GetProperty("gate-bundle").GetProperty("revision").GetInt32() == 4 &&
                rev1.GetProperty("key").GetString() == "gate-bundle@1" &&
                rev1.GetProperty("reviewedBy").GetString() == reviewer &&
                !stateSubmissions.GetProperty("gate-bundle@2").TryGetProperty("reviewedBy", out _) &&
                string.Join(",", rev1.EnumerateObject().Select(static property => property.Name)) ==
                    "key,id,revision,status,digest,bundle,createdAt,updatedAt,submittedBy,note,events,reviewedBy,reviewReason",
                string.Join(",", rev1.EnumerateObject().Select(static property => property.Name)));
        }

        await store.ProbeAsync(ct);
        gate.Check($"calibrations-{leg}-probe", true);
    }

    private static async Task RunNodeFixtureCompatibilityAsync(Gate gate)
    {
        gate.Section("calibrations-node-fixture: Node calibrations.json read/write compatibility (A1)");
        var ct = CancellationToken.None;
        var directory = gate.TempDir("calibrations-node-fixture");
        var statePath = Path.Combine(directory, "calibrations.json");
        File.Copy(Path.Combine(AppContext.BaseDirectory, "fixtures", "node-calibrations.json"), statePath);
        var fixture = Gate.Fixture("node-calibrations.json");

        var store = new FileCalibrationGovernanceStore(statePath);
        var approved = await store.ListApprovedAsync(ct);
        var fixtureRelease = fixture.GetProperty("approved").GetProperty("fixture-bundle");
        gate.Check("calibrations-node-fixture-approved",
            approved.Count == 1 && approved[0].Id == "fixture-bundle" && approved[0].Revision == 1 &&
            approved[0].Digest == fixtureRelease.GetProperty("digest").GetString() &&
            approved[0].Digest == CalibrationGovernanceRules.Digest(approved[0].Bundle) &&
            approved[0].ApprovedBy == "22222222" && approved[0].ApprovedAt == fixtureRelease.GetProperty("approvedAt").GetInt64(),
            approved.Count);
        var submissions = await store.ListSubmissionsAsync(ct);
        gate.Check("calibrations-node-fixture-submissions",
            submissions.Count == 3 &&
            submissions[0].Key == "fixture-rejected@1" && submissions[0].Status == "rejected" && submissions[0].ReviewedBy == "22222222" &&
            submissions[1].Key == "fixture-bundle@2" && submissions[1].Status == "pending" && submissions[1].ReviewedBy is null &&
            submissions[2].Key == "fixture-bundle@1" && submissions[2].Status == "approved" && submissions[2].Events.Count == 2 &&
            submissions.All(static record => record.Digest == CalibrationGovernanceRules.Digest(record.Bundle)),
            string.Join(",", submissions.Select(static record => record.Key)));
        var stats = await store.StatsAsync(ct);
        gate.Check("calibrations-node-fixture-stats", stats is { Approved: 1, Pending: 1 }, stats);

        // Continue governance on the Node-written state: approve the pending revision 2, then add a submission.
        var review = await store.ReviewAsync("fixture-bundle", 2, JsonSerializer.SerializeToElement("approve"), JsonSerializer.SerializeToElement(Reason), "22222222", ct);
        gate.Check("calibrations-node-fixture-review", review.Ok && review.Submission!.Status == "approved", review.Error);
        var submit = await store.SubmitAsync(Candidate("fixture-extra", 1), null, "44444444", ct);
        gate.Check("calibrations-node-fixture-submit", submit.Ok && submit.Submission!.Note == string.Empty, submit.Error);
        using var document = JsonDocument.Parse(await File.ReadAllTextAsync(statePath, ct));
        var root = document.RootElement;
        gate.Check("calibrations-node-fixture-file-preserved",
            root.GetProperty("format").GetString() == "forgex-calibration-service-state" &&
            root.GetProperty("version").GetInt32() == 1 &&
            root.GetProperty("submissions").EnumerateObject().Count() == 4 &&
            JsonElement.DeepEquals(root.GetProperty("submissions").GetProperty("fixture-rejected@1"), fixture.GetProperty("submissions").GetProperty("fixture-rejected@1")) &&
            root.GetProperty("approved").GetProperty("fixture-bundle").GetProperty("revision").GetInt32() == 2 &&
            root.GetProperty("approved").GetProperty("fixture-bundle").GetProperty("bundle").GetProperty("models")[0].GetProperty("status").GetString() == "active" &&
            root.GetProperty("submissions").GetProperty("fixture-extra@1").GetProperty("events")[0].GetProperty("reason").GetString() == string.Empty,
            root.GetProperty("submissions").EnumerateObject().Count());

        // An unrecognised state file is refused instead of being wiped.
        var foreignPath = Path.Combine(directory, "foreign.json");
        await File.WriteAllTextAsync(foreignPath, "{\"format\":\"something-else\",\"version\":1}", ct);
        var refused = false;
        try
        {
            await new FileCalibrationGovernanceStore(foreignPath).StatsAsync(ct);
        }
        catch (InvalidDataException)
        {
            refused = true;
        }
        gate.Check("calibrations-node-fixture-foreign-refused", refused);
    }

    private static async Task RunTrustedChannelAsync(Gate gate)
    {
        gate.Section("calibrations-trusted: actor headers over the trusted sidecar channel (C# has no keys)");
        var store = new FileCalibrationGovernanceStore(Path.Combine(gate.TempDir("calibrations-trusted"), "calibrations.json"));
        var app = await gate.StartApiAsync(new Dictionary<string, string?>(), builder => builder.Services.AddSingleton<ICalibrationGovernanceStore>(store), CalibrationGovernanceEndpoints.Map);
        var origin = Gate.Origin(app);
        var tenant = Gate.Tenant('a');
        var owner = Gate.Owner('a');

        var (catalog, catalogBody) = await gate.SendAsync(origin, HttpMethod.Get, "/api/v1/calibrations");
        gate.Check("calibrations-trusted-catalog-public", catalog.StatusCode == HttpStatusCode.OK, catalogBody);
        var (statsResponse, statsBody) = await gate.SendAsync(origin, HttpMethod.Get, "/api/v1/calibrations/stats");
        gate.Check("calibrations-trusted-stats-public", statsResponse.StatusCode == HttpStatusCode.OK, statsBody);

        var (direct, directBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/submissions", "{}");
        gate.Check("calibrations-trusted-direct-401", direct.StatusCode == HttpStatusCode.Unauthorized && directBody.Contains("internal_auth_required", StringComparison.Ordinal), directBody);
        var (noActor, noActorBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/submissions", Body(new { bundle = Candidate("trusted-bundle", 1) }), Gate.Trusted(tenant, owner));
        gate.Check("calibrations-trusted-missing-actor-401", noActor.StatusCode == HttpStatusCode.Unauthorized && noActorBody.Contains("校准候选提交需要有效 API Key", StringComparison.Ordinal), noActorBody);
        var (badActor, badActorBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/submissions", Body(new { bundle = Candidate("trusted-bundle", 1) }), Gate.Trusted(tenant, owner, "XYZ", "submitter"));
        gate.Check("calibrations-trusted-invalid-actor-400", badActor.StatusCode == HttpStatusCode.BadRequest && badActorBody.Contains("invalid_caller_context", StringComparison.Ordinal), badActorBody);
        var (badRole, badRoleBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/submissions", Body(new { bundle = Candidate("trusted-bundle", 1) }), Gate.Trusted(tenant, owner, "0123abcd", "admin"));
        gate.Check("calibrations-trusted-invalid-role-400", badRole.StatusCode == HttpStatusCode.BadRequest && badRoleBody.Contains("invalid_caller_context", StringComparison.Ordinal), badRoleBody);
        var (roleMismatch, roleMismatchBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/submissions", Body(new { bundle = Candidate("trusted-bundle", 1) }), Gate.Trusted(tenant, owner, "0123abcd", "reviewer"));
        gate.Check("calibrations-trusted-role-mismatch-401", roleMismatch.StatusCode == HttpStatusCode.Unauthorized, roleMismatchBody);
        var (badTenant, badTenantBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/submissions", Body(new { bundle = Candidate("trusted-bundle", 1) }), Gate.Trusted("tn_bad", owner, "0123abcd", "submitter"));
        gate.Check("calibrations-trusted-invalid-tenant-400", badTenant.StatusCode == HttpStatusCode.BadRequest && badTenantBody.Contains("invalid_caller_context", StringComparison.Ordinal), badTenantBody);

        var (submitted, submittedBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/submissions", Body(new { bundle = Candidate("trusted-bundle", 1) }), Gate.Trusted(tenant, owner, "0123abcd", "submitter"));
        gate.Check("calibrations-trusted-submit-201", submitted.StatusCode == HttpStatusCode.Created && Gate.Parse(submittedBody).GetProperty("submittedBy").GetString() == "0123abcd", submittedBody);
        var (listAsSubmitter, listAsSubmitterBody) = await gate.SendAsync(origin, HttpMethod.Get, "/api/v1/calibrations/submissions", null, Gate.Trusted(tenant, owner, "0123abcd", "submitter"));
        gate.Check("calibrations-trusted-list-role-mismatch-401", listAsSubmitter.StatusCode == HttpStatusCode.Unauthorized && listAsSubmitterBody.Contains("校准审核需要审核密钥", StringComparison.Ordinal), listAsSubmitterBody);
        var (listAsReviewer, listAsReviewerBody) = await gate.SendAsync(origin, HttpMethod.Get, "/api/v1/calibrations/submissions", null, Gate.Trusted(tenant, owner, "89abcdef", "reviewer"));
        gate.Check("calibrations-trusted-list-200", listAsReviewer.StatusCode == HttpStatusCode.OK && Gate.Parse(listAsReviewerBody).GetProperty("submissions").GetArrayLength() == 1, listAsReviewerBody);
        var (review, reviewBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/trusted-bundle/revisions/1/review", Body(new { decision = "approve", reason = Reason }), Gate.Trusted(tenant, owner, "89abcdef", "reviewer"));
        gate.Check("calibrations-trusted-review-200", review.StatusCode == HttpStatusCode.OK && Gate.Parse(reviewBody).GetProperty("reviewedBy").GetString() == "89abcdef", reviewBody);
        var (selfReview, selfReviewBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/calibrations/trusted-bundle/revisions/1/review", Body(new { decision = "approve", reason = Reason }), Gate.Trusted(tenant, owner, "0123abcd", "reviewer"));
        gate.Check("calibrations-trusted-review-409-already", selfReview.StatusCode == HttpStatusCode.Conflict, selfReviewBody);
    }

    private static JsonElement Candidate(string id, int revision)
    {
        var template = Gate.Fixture("node-calibrations.json").GetProperty("submissions").GetProperty("fixture-bundle@2").GetProperty("bundle");
        return Mutate(template, node =>
        {
            node["id"] = id;
            node["revision"] = revision;
            node["models"]![0]!["id"] = id + "-pla";
        });
    }

    private static JsonElement Mutate(JsonElement element, Action<JsonNode> mutate)
    {
        var node = JsonNode.Parse(element.GetRawText())!;
        mutate(node);
        return JsonSerializer.SerializeToElement(node);
    }

    private static string Body(object value) => JsonSerializer.Serialize(value);

    private static (string Name, string Value) Bearer(string key) => ("Authorization", "Bearer " + key);

    private static string Sha8(string key) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..8];

    private static string RandomTenant() => "tn_" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
}
