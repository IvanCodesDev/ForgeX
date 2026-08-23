using System.Text.Json;
using System.Text.Json.Serialization;

namespace ForgeX.Contracts;

/// <summary>
/// Share creation request. The caller (trusted Node proxy during migration, or a
/// future first-party client) submits the completed report snapshot directly;
/// task lookup and ownership checks happen before this call.
/// </summary>
public sealed record ShareCreateRequestDto(
    [property: JsonPropertyName("report")] JsonElement Report,
    [property: JsonPropertyName("question")] string? Question,
    [property: JsonPropertyName("engine")] string? Engine,
    [property: JsonPropertyName("upstreamTaskId")] string? UpstreamTaskId,
    [property: JsonPropertyName("ttlMs")] long? TtlMs);

/// <summary>
/// Mirrors the Node response shape byte-for-byte in key names: the migration
/// proxy passes this through and only rewrites <c>publicUrl</c> to its own origin.
/// <c>expiresAt</c> stays epoch milliseconds for parity with the Node store.
/// </summary>
public sealed record ShareCreateResponseDto(
    [property: JsonPropertyName("publicUrl")] string PublicUrl,
    [property: JsonPropertyName("token")] string Token,
    [property: JsonPropertyName("revokeKey")] string RevokeKey,
    [property: JsonPropertyName("expiresAt")] long ExpiresAt,
    [property: JsonPropertyName("note")] string? Note);

public sealed record ShareRevokeRequestDto(
    [property: JsonPropertyName("revokeKey")] string? RevokeKey);

public sealed record ShareRevokeResponseDto(
    [property: JsonPropertyName("revoked")] bool Revoked);
