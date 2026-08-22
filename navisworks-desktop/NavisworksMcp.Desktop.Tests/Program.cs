using System.Text.Json;
using NavisworksMcp.Desktop.Models;
using NavisworksMcp.Desktop.Runtime;
using NavisworksMcp.Desktop.Services;

namespace NavisworksMcp.Desktop.Tests;

internal static class Program
{
    private static readonly (string Name, Action Test)[] Tests =
    [
        ("command line data directory wins over environment", CommandLineDirectoryWins),
        ("session repository falls back to backup", SessionRepositoryFallsBackToBackup),
        ("unreadable session pair disables persistence", UnreadableSessionPairDisablesPersistence),
        ("settings repository round trips", SettingsRepositoryRoundTrips)
    ];

    private static int Main()
    {
        var failures = 0;
        foreach (var (name, test) in Tests)
        {
            try
            {
                test();
                System.Console.WriteLine($"PASS: {name}");
            }
            catch (Exception exception)
            {
                failures++;
                System.Console.Error.WriteLine($"FAIL: {name}");
                System.Console.Error.WriteLine(exception);
            }
        }

        System.Console.WriteLine($"RESULT: {Tests.Length - failures}/{Tests.Length} passed");
        return failures == 0 ? 0 : 1;
    }

    private static void CommandLineDirectoryWins()
    {
        WithTemporaryDirectory(root =>
        {
            var environmentPath = Path.Combine(root, "environment");
            var commandLinePath = Path.Combine(root, "command-line");
            var previousValue = Environment.GetEnvironmentVariable(
                AppDataPathProviderFactory.DataDirectoryEnvironmentVariable);

            try
            {
                Environment.SetEnvironmentVariable(
                    AppDataPathProviderFactory.DataDirectoryEnvironmentVariable,
                    environmentPath);
                var provider = AppDataPathProviderFactory.Create(
                    [AppDataPathProviderFactory.DataDirectoryArgument, commandLinePath]);

                AssertEqual(Path.GetFullPath(commandLinePath), provider.RootDirectory);
                AssertEqual("命令行 --data-dir", provider.SourceDescription);
                AssertEqual("Debug", provider.BuildConfiguration);
            }
            finally
            {
                Environment.SetEnvironmentVariable(
                    AppDataPathProviderFactory.DataDirectoryEnvironmentVariable,
                    previousValue);
            }
        });
    }

    private static void SessionRepositoryFallsBackToBackup()
    {
        WithTemporaryDirectory(root =>
        {
            var primaryPath = Path.Combine(root, "sessions.json");
            var backupPath = Path.Combine(root, "sessions.backup.json");
            var sessionId = Guid.NewGuid();
            var snapshots = new[]
            {
                new ChatSessionSnapshot(
                    sessionId,
                    "测试会话",
                    "测试预览",
                    DateTimeOffset.Now,
                    [new ChatMessage { Role = "user", Content = "你好" }],
                    32)
            };

            File.WriteAllText(primaryPath, "{ invalid json");
            File.WriteAllText(backupPath, JsonSerializer.Serialize(snapshots));
            var repository = new JsonConversationSessionRepository(primaryPath, backupPath);

            var loadResult = repository.Load();
            AssertEqual(SessionLoadSource.Backup, loadResult.Source);
            AssertTrue(loadResult.CanPersist, "backup recovery must remain writable");
            AssertEqual(sessionId, loadResult.Snapshots.Single().Id);
            AssertEqual("{ invalid json", File.ReadAllText(primaryPath));

            AssertTrue(repository.TrySave(loadResult.Snapshots), "recovered history should save");
            AssertEqual(File.ReadAllText(primaryPath), File.ReadAllText(backupPath));
            AssertTrue(!Directory.EnumerateFiles(root, "*.tmp").Any(), "temporary files must be cleaned");
        });
    }

    private static void UnreadableSessionPairDisablesPersistence()
    {
        WithTemporaryDirectory(root =>
        {
            var primaryPath = Path.Combine(root, "sessions.json");
            var backupPath = Path.Combine(root, "sessions.backup.json");
            File.WriteAllText(primaryPath, "not-json-primary");
            File.WriteAllText(backupPath, "not-json-backup");

            var result = new JsonConversationSessionRepository(primaryPath, backupPath).Load();

            AssertEqual(SessionLoadSource.Unavailable, result.Source);
            AssertTrue(!result.CanPersist, "two unreadable files must disable persistence");
            AssertEqual("not-json-primary", File.ReadAllText(primaryPath));
            AssertEqual("not-json-backup", File.ReadAllText(backupPath));
        });
    }

    private static void SettingsRepositoryRoundTrips()
    {
        WithTemporaryDirectory(root =>
        {
            var settingsPath = Path.Combine(root, "settings.json");
            var repository = new JsonSettingsRepository(settingsPath);
            var activeSessionId = Guid.NewGuid();
            var snapshot = new AppSettingsSnapshot(
                "qwen-test",
                ["qwen-test", "another-model"],
                [new ManagedExtensionItem(Guid.NewGuid(), "sample-plugin", "plugin", true)],
                [new ManagedExtensionItem(Guid.NewGuid(), "sample-skill", "skill", false)],
                "fast",
                activeSessionId);

            AssertTrue(repository.TrySave(snapshot), "settings should save");
            var loaded = repository.Load() ?? throw new InvalidOperationException("settings did not load");

            AssertEqual(snapshot.SelectedModel, loaded.SelectedModel);
            AssertEqual(snapshot.ReasoningMode, loaded.ReasoningMode);
            AssertEqual(activeSessionId, loaded.ActiveSessionId);
            AssertEqual("sample-plugin", loaded.Plugins.Single().Name);
            AssertEqual("sample-skill", loaded.Skills.Single().Name);
        });
    }

    private static void WithTemporaryDirectory(Action<string> action)
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            "NavisworksMcpDesktop.Tests",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);

        try
        {
            action(root);
        }
        finally
        {
            if (Directory.Exists(root))
                Directory.Delete(root, recursive: true);
        }
    }

    private static void AssertTrue(bool condition, string message)
    {
        if (!condition)
            throw new InvalidOperationException(message);
    }

    private static void AssertEqual<T>(T expected, T actual)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            throw new InvalidOperationException(
                $"Expected '{expected}', actual '{actual}'.");
        }
    }
}
