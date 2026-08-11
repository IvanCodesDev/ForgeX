using ForgeX.Domain;

namespace ForgeX.Application;

public sealed record StoredContentObject(string Sha256, long Bytes);

public sealed record CreateJobResult(GCodeJobRecord Job, bool Created, bool Conflict);

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
    Task<IReadOnlyList<GCodeJobRecord>> ListAsync(CancellationToken cancellationToken);
    Task<GCodeJobRecord> SaveAsync(GCodeJobRecord job, CancellationToken cancellationToken);
}

public interface IGCodeJobQueue
{
    ValueTask EnqueueAsync(string jobId, CancellationToken cancellationToken);
    IAsyncEnumerable<string> ReadAllAsync(CancellationToken cancellationToken);
    bool IsAccepting { get; }
}
