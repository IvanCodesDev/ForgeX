using System.Security.Cryptography;

namespace ForgeX.Infrastructure;

public sealed record StoredObject(string Sha256, long Bytes, string Path);

/// <summary>Streams an upload into a private content-addressed store without buffering it in memory.</summary>
public sealed class ContentAddressedObjectStore
{
    private readonly string _root;

    public ContentAddressedObjectStore(string root)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(root);
        _root = Path.GetFullPath(root);
        Directory.CreateDirectory(_root);
    }

    public async Task<StoredObject> PutAsync(Stream source, long maxBytes, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maxBytes);

        var temporary = Path.Combine(_root, $".{Guid.NewGuid():N}.partial");
        long total = 0;
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        try
        {
            await using (var destination = new FileStream(
                temporary,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                1024 * 1024,
                FileOptions.Asynchronous | FileOptions.SequentialScan))
            {
                var buffer = new byte[1024 * 1024];
                while (true)
                {
                    var read = await source.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
                    if (read == 0) break;
                    total = checked(total + read);
                    if (total > maxBytes) throw new InvalidDataException("GCODE_TOO_LARGE");
                    hash.AppendData(buffer.AsSpan(0, read));
                    await destination.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
                }
                await destination.FlushAsync(cancellationToken).ConfigureAwait(false);
            }

            var sha256 = Convert.ToHexStringLower(hash.GetHashAndReset());
            var finalPath = Path.Combine(_root, sha256[..2], sha256);
            Directory.CreateDirectory(Path.GetDirectoryName(finalPath)!);
            if (File.Exists(finalPath)) File.Delete(temporary);
            else File.Move(temporary, finalPath);
            return new StoredObject(sha256, total, finalPath);
        }
        catch
        {
            if (File.Exists(temporary)) File.Delete(temporary);
            throw;
        }
    }
}
