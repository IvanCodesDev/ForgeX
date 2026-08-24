using System.Text.Json;
using System.Text.Json.Serialization;

namespace ForgeX.Contracts;

/// <summary>
/// Stage 8.4: read-model of a persisted datasource in forgex.datasources. Field names
/// follow the Node upload response (server/routes/datasource.js): rowCount mirrors its
/// "rows" count, sha256 its content digest. Raw rows and CSV text stay off the wire —
/// the compute leg consumes them inside the authority, not through this snapshot.
/// </summary>
public sealed record DatasourceSnapshotDto(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("rowCount")] int RowCount,
    [property: JsonPropertyName("sha256")] string Sha256,
    [property: JsonPropertyName("warnings")] JsonElement Warnings,
    [property: JsonPropertyName("provenance")] JsonElement Provenance,
    [property: JsonPropertyName("createdAtUtc")] DateTimeOffset CreatedAtUtc,
    [property: JsonPropertyName("expiresAtUtc")] DateTimeOffset? ExpiresAtUtc);
