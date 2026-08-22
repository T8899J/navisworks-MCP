using System.Text.Json;
using NavisworksMcp.Desktop.Models;

namespace NavisworksMcp.Desktop.Services;

internal interface IConversationSessionRepository
{
    SessionLoadResult Load();
    bool TrySave(IReadOnlyCollection<ChatSessionSnapshot> snapshots);
}

internal interface ISettingsRepository
{
    AppSettingsSnapshot? Load();
    bool TrySave(AppSettingsSnapshot snapshot);
}

internal enum SessionLoadSource
{
    None,
    Primary,
    Backup,
    Unavailable
}

internal sealed record SessionLoadResult(
    IReadOnlyList<ChatSessionSnapshot> Snapshots,
    SessionLoadSource Source,
    bool CanPersist)
{
    public static SessionLoadResult Empty { get; } =
        new([], SessionLoadSource.None, CanPersist: true);

    public static SessionLoadResult Unavailable { get; } =
        new([], SessionLoadSource.Unavailable, CanPersist: false);
}

internal sealed class JsonConversationSessionRepository(
    string primaryPath,
    string backupPath) : IConversationSessionRepository
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        WriteIndented = true
    };

    public SessionLoadResult Load()
    {
        var primaryExists = File.Exists(primaryPath);
        var backupExists = File.Exists(backupPath);
        if (!primaryExists && !backupExists)
            return SessionLoadResult.Empty;

        if (TryRead(primaryPath, out var primarySnapshots))
            return new SessionLoadResult(primarySnapshots, SessionLoadSource.Primary, CanPersist: true);

        if (TryRead(backupPath, out var backupSnapshots))
            return new SessionLoadResult(backupSnapshots, SessionLoadSource.Backup, CanPersist: true);

        // A future schema or damaged files must never be replaced by an empty history.
        return SessionLoadResult.Unavailable;
    }

    public bool TrySave(IReadOnlyCollection<ChatSessionSnapshot> snapshots)
    {
        ArgumentNullException.ThrowIfNull(snapshots);

        try
        {
            var json = JsonSerializer.Serialize(snapshots, SerializerOptions);
            AtomicTextFile.WriteAllText(primaryPath, json);
            AtomicTextFile.WriteAllText(backupPath, json);
            return true;
        }
        catch (Exception ex) when (IsPersistenceException(ex))
        {
            return false;
        }
    }

    private static bool TryRead(string path, out List<ChatSessionSnapshot> snapshots)
    {
        snapshots = [];
        if (!File.Exists(path))
            return false;

        try
        {
            snapshots = JsonSerializer.Deserialize<List<ChatSessionSnapshot>>(
                File.ReadAllText(path)) ?? [];
            return true;
        }
        catch (Exception ex) when (IsPersistenceException(ex))
        {
            return false;
        }
    }

    private static bool IsPersistenceException(Exception exception)
        => exception is IOException
            or UnauthorizedAccessException
            or JsonException
            or NotSupportedException;
}

internal sealed class JsonSettingsRepository(string settingsPath) : ISettingsRepository
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        WriteIndented = true
    };

    public AppSettingsSnapshot? Load()
    {
        if (!File.Exists(settingsPath))
            return null;

        try
        {
            return JsonSerializer.Deserialize<AppSettingsSnapshot>(
                File.ReadAllText(settingsPath));
        }
        catch (Exception ex) when (ex is IOException
                                   or UnauthorizedAccessException
                                   or JsonException
                                   or NotSupportedException)
        {
            return null;
        }
    }

    public bool TrySave(AppSettingsSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);

        try
        {
            AtomicTextFile.WriteAllText(
                settingsPath,
                JsonSerializer.Serialize(snapshot, SerializerOptions));
            return true;
        }
        catch (Exception ex) when (ex is IOException
                                   or UnauthorizedAccessException
                                   or JsonException
                                   or NotSupportedException)
        {
            return false;
        }
    }
}

internal static class AtomicTextFile
{
    public static void WriteAllText(string path, string content)
    {
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrWhiteSpace(directory))
            Directory.CreateDirectory(directory);

        var temporaryPath = $"{path}.{Environment.ProcessId}.{Guid.NewGuid():N}.tmp";
        try
        {
            File.WriteAllText(temporaryPath, content);
            File.Move(temporaryPath, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporaryPath))
                File.Delete(temporaryPath);
        }
    }
}
