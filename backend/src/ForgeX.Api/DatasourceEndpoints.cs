using System.Text.Json;
using ForgeX.Contracts;
using ForgeX.Infrastructure;

namespace ForgeX.Api;

/// <summary>
/// Stage 8.4: owner-scoped datasource read (mounted only when
/// Datasources:Provider=postgres). Serves the metadata snapshot of a persisted
/// forgex.datasources row under the caller's RLS context; wrong tenant/owner and
/// expired records read as the same stable not-found. The Node-only builtin
/// "sample" datasource is never persisted, so its id — like every id outside the
/// ds_ + 24-hex schema shape — is rejected without touching the database.
/// </summary>
internal static class DatasourceEndpoints
{
    public static async Task<IResult> GetAsync(
        HttpContext context,
        string id,
        PostgresDatasourceRepository datasources)
    {
        var caller = CallerContextBoundary.GetRequired(context);
        if (!PostgresDatasourceRepository.IsPersistedId(id))
        {
            return NotFound(context);
        }

        var record = await datasources.GetAsync(caller.TenantId, caller.OwnerId, id, context.RequestAborted);
        return record is null ? NotFound(context) : Results.Json(ToSnapshot(record));
    }

    internal static DatasourceSnapshotDto ToSnapshot(DatasourceRecord record)
    {
        int rowCount;
        using (var rows = JsonDocument.Parse(record.RowsJson))
        {
            rowCount = rows.RootElement.GetArrayLength();
        }

        using var warnings = JsonDocument.Parse(record.WarningsJson);
        using var provenance = JsonDocument.Parse(record.ProvenanceJson);
        return new DatasourceSnapshotDto(
            record.Id,
            record.Name,
            rowCount,
            record.ContentSha256,
            warnings.RootElement.Clone(),
            provenance.RootElement.Clone(),
            record.CreatedAt,
            record.ExpiresAt);
    }

    internal static IResult NotFound(HttpContext context) =>
        ApiProblemResults.Create(context, 404, "datasource_not_found", "Datasource not found");
}
