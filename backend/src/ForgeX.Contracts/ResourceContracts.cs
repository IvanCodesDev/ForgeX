using System.Text.Json;
using System.Text.Json.Serialization;

namespace ForgeX.Contracts;

// ── Stage 8.6a：数据源 / 知识库端点契约 ─────────────────────────────────────────
// 请求字段一律用 JsonElement? 承接：Node 路由对 name / provenance / topK 等做的是 JS 宽松转换
// （String(name || …)、Number(topK) || 4、claim && typeof claim === "object"），
// 端点层用 JsValue 复现这些语义，而不是让反序列化器在类型不合时直接 400。

public sealed record DatasourceCreateRequestDto(
    [property: JsonPropertyName("name")] JsonElement? Name,
    [property: JsonPropertyName("csv")] JsonElement? Csv,
    [property: JsonPropertyName("provenance")] JsonElement? Provenance);

/// <summary>Mirrors Node POST /api/datasource：rows 是行数，warnings 为空时省略。</summary>
public sealed record DatasourceCreateResponseDto(
    [property: JsonPropertyName("datasourceId")] string DatasourceId,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("rows")] int Rows,
    [property: JsonPropertyName("sha256")] string Sha256,
    [property: JsonPropertyName("deduplicated")] bool Deduplicated,
    [property: JsonPropertyName("provenance")] JsonElement Provenance,
    [property: JsonPropertyName("warnings")] IReadOnlyList<string>? Warnings);

/// <summary>Owner-scoped read used by the Node facade to feed analysis (rows included, csv omitted).</summary>
public sealed record DatasourceReadResponseDto(
    [property: JsonPropertyName("datasourceId")] string DatasourceId,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("rows")] JsonElement Rows,
    [property: JsonPropertyName("contentSha256")] string ContentSha256,
    [property: JsonPropertyName("cacheKey")] string CacheKey,
    [property: JsonPropertyName("provenance")] JsonElement Provenance,
    [property: JsonPropertyName("builtin")] bool Builtin,
    [property: JsonPropertyName("warnings")] IReadOnlyList<string> Warnings,
    [property: JsonPropertyName("createdAt")] long CreatedAt,
    [property: JsonPropertyName("expiresAt")] long? ExpiresAt);

public sealed record KnowledgeCreateRequestDto(
    [property: JsonPropertyName("name")] JsonElement? Name,
    [property: JsonPropertyName("text")] JsonElement? Text);

/// <summary>chunks 与 Node 一致为 text.length（UTF-16 单元数）；retrievalEnabled/note 由 Node 路由按其 AI provider 决定，不在此。</summary>
public sealed record KnowledgeCreateResponseDto(
    [property: JsonPropertyName("knowledgeId")] string KnowledgeId,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("chunks")] int Chunks,
    [property: JsonPropertyName("createdAt")] long CreatedAt,
    [property: JsonPropertyName("expiresAt")] long? ExpiresAt);

public sealed record KnowledgeDocumentDto(
    [property: JsonPropertyName("knowledgeId")] string KnowledgeId,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("text")] string Text,
    [property: JsonPropertyName("createdAt")] long CreatedAt,
    [property: JsonPropertyName("expiresAt")] long? ExpiresAt);

public sealed record KnowledgeListResponseDto(
    [property: JsonPropertyName("docs")] IReadOnlyList<KnowledgeDocumentDto> Docs);

public sealed record KnowledgeSearchRequestDto(
    [property: JsonPropertyName("question")] JsonElement? Question,
    [property: JsonPropertyName("topK")] JsonElement? TopK);

public sealed record KnowledgeSearchHitDto(
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("text")] string Text,
    [property: JsonPropertyName("score")] double Score);

/// <summary>Mirrors Node POST /api/knowledge/search（note 仅在无命中时出现）。</summary>
public sealed record KnowledgeSearchResponseDto(
    [property: JsonPropertyName("question")] string Question,
    [property: JsonPropertyName("docCount")] int DocCount,
    [property: JsonPropertyName("hits")] IReadOnlyList<KnowledgeSearchHitDto> Hits,
    [property: JsonPropertyName("note")] string? Note);

// ── Stage 8.6a：校准治理端点契约（Node routes/calibration.js 四条 + stats）────────────

public sealed record CalibrationEventDto(
    [property: JsonPropertyName("action")] string Action,
    [property: JsonPropertyName("at")] long At,
    [property: JsonPropertyName("actor")] string Actor,
    [property: JsonPropertyName("reason")] string Reason);

/// <summary>Node CalibrationStore 记录原形（reviewedBy / reviewReason 审核前省略）。</summary>
public sealed record CalibrationSubmissionDto(
    [property: JsonPropertyName("key")] string Key,
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("revision")] int Revision,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("digest")] string Digest,
    [property: JsonPropertyName("bundle")] JsonElement Bundle,
    [property: JsonPropertyName("createdAt")] long CreatedAt,
    [property: JsonPropertyName("updatedAt")] long UpdatedAt,
    [property: JsonPropertyName("submittedBy")] string SubmittedBy,
    [property: JsonPropertyName("note")] string Note,
    [property: JsonPropertyName("events")] IReadOnlyList<CalibrationEventDto> Events,
    [property: JsonPropertyName("reviewedBy")] string? ReviewedBy,
    [property: JsonPropertyName("reviewReason")] string? ReviewReason);

public sealed record CalibrationReleaseDto(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("revision")] int Revision,
    [property: JsonPropertyName("digest")] string Digest,
    [property: JsonPropertyName("bundle")] JsonElement Bundle,
    [property: JsonPropertyName("approvedAt")] long ApprovedAt,
    [property: JsonPropertyName("approvedBy")] string ApprovedBy);

/// <summary>GET /api/calibrations：公开目录。</summary>
public sealed record CalibrationCatalogResponseDto(
    [property: JsonPropertyName("format")] string Format,
    [property: JsonPropertyName("version")] int Version,
    [property: JsonPropertyName("items")] IReadOnlyList<CalibrationReleaseDto> Items);

public sealed record CalibrationStatsResponseDto(
    [property: JsonPropertyName("approved")] int Approved,
    [property: JsonPropertyName("pending")] int Pending);

public sealed record CalibrationSubmissionsResponseDto(
    [property: JsonPropertyName("submissions")] IReadOnlyList<CalibrationSubmissionDto> Submissions);

public sealed record CalibrationSubmitRequestDto(
    [property: JsonPropertyName("bundle")] JsonElement? Bundle,
    [property: JsonPropertyName("note")] JsonElement? Note);

public sealed record CalibrationSubmitResponseDto(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("revision")] int Revision,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("digest")] string Digest,
    [property: JsonPropertyName("submittedBy")] string SubmittedBy);

public sealed record CalibrationReviewRequestDto(
    [property: JsonPropertyName("decision")] JsonElement? Decision,
    [property: JsonPropertyName("reason")] JsonElement? Reason);

public sealed record CalibrationReviewResponseDto(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("revision")] int Revision,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("reviewedBy")] string ReviewedBy,
    [property: JsonPropertyName("reviewReason")] string ReviewReason);
