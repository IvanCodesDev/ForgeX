using System.Security.Cryptography;
using ForgeX.Application;

namespace ForgeX.Infrastructure;

/// <summary>Streams an upload into a private content-addressed store without buffering it in memory.</summary>
public sealed class ContentAddressedObjectStore : IContentObjectStore
{
    private readonly string _root;

    public ContentAddressedObjectStore(string root)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(root);
        _root = Path.GetFullPath(root);
    }

    public async Task<StoredContentObject> PutAsync(Stream source, long maxBytes, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maxBytes);

        Directory.CreateDirectory(_root);
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
            if (File.Exists(finalPath))
            {
                File.Delete(temporary);
            }
            else
            {
                try
                {
                    File.Move(temporary, finalPath);
                }
                catch (IOException) when (File.Exists(finalPath))
                {
                    File.Delete(temporary);
                }
            }
            return new StoredContentObject(sha256, total);
        }
        catch
        {
            if (File.Exists(temporary)) File.Delete(temporary);
            throw;
        }
    }

    public Task<Stream> OpenReadAsync(string sha256, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var path = ObjectPath(sha256);
        Stream stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            64 * 1024,
            FileOptions.Asynchronous | FileOptions.SequentialScan);
        return Task.FromResult(stream);
    }

    public Task<bool> ExistsAsync(string sha256, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(File.Exists(ObjectPath(sha256)));
    }

    public async Task<bool> ProbeWritableAsync(CancellationToken cancellationToken)
    {
        var probe = Path.Combine(_root, $".{Guid.NewGuid():N}.probe");
        try
        {
            Directory.CreateDirectory(_root);
            await File.WriteAllBytesAsync(probe, [], cancellationToken).ConfigureAwait(false);
            File.Delete(probe);
            return true;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private string ObjectPath(string sha256)
    {
        if (sha256.Length != 64 || sha256.Any(static character => !char.IsAsciiHexDigit(character)))
        {
            throw new ArgumentException("SHA-256 must contain exactly 64 hexadecimal characters.", nameof(sha256));
        }

        var normalized = sha256.ToLowerInvariant();
        return Path.Combine(_root, normalized[..2], normalized);
    }
}
