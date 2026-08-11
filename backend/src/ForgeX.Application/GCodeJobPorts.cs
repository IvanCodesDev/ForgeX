using ForgeX.Domain;

namespace ForgeX.Application;

public sealed record StoredContentObject(string Sha256, long Bytes);

public sealed record CreateJobResult(GCodeJobRecord Job, bool Created, bool Conflict);

public sealed record JobRepositoryHealth(
    string Provider,
    int SchemaVersion,
    bool Ready,
    long RecordCount,
    string? ErrorCode = null);

public sealed record JobBackupSummary(
    string Format,
    string Provider,
    int RepositorySchemaVersion,
    long JobCount,
    DateTimeOffset CreatedAtUtc);

public interface IContentObjectStore
{
    Task<StoredContentObject> PutAsync(Stream source, long maxBytes, CancellationToken cancellationToken);
    Task<Stream> OpenReadAsync(string sha256, CancellationToken cancellationToken);
    Task<bool> ExistsAsync(string sha256, CancellationToken cancellationToken);
    Task<bool> ProbeWritableAsync(CancellationToken cancellationToken);
}

public interface IGCodeJobRepository
{
    Task<CreateJobResult> CreateOrGetAsync(GCodeJobRecord candidate, CancellationToken cancellationToken);
    Task<GCodeJobRecord?> GetAsync(string id, CancellationToken cancellationToken);
    Task<GCodeJobRecord?> GetOwnedAsync(string tenantId, string ownerId, string id, CancellationToken cancellationToken);
    Task<IReadOnlyList<GCodeJobRecord>> ListAsync(CancellationToken cancellationToken);
    Task<GCodeJobRecord> SaveAsync(GCodeJobRecord job, CancellationToken cancellationToken);
}

public interface IGCodeJobRepositoryMaintenance
{
    Task<JobRepositoryHealth> ProbeAsync(CancellationToken cancellationToken);
    Task<JobBackupSummary> BackupAsync(Stream destination, CancellationToken cancellationToken);
    Task<JobBackupSummary> VerifyBackupAsync(Stream source, CancellationToken cancellationToken);
    Task<JobBackupSummary> RestoreAsync(Stream source, CancellationToken cancellationToken);
}

public interface IGCodeJobQueue
{
    ValueTask EnqueueAsync(string jobId, CancellationToken cancellationToken);
    IAsyncEnumerable<string> ReadAllAsync(CancellationToken cancellationToken);
    bool IsAccepting { get; }
}
