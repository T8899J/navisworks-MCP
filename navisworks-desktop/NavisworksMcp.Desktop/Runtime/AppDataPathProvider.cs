namespace NavisworksMcp.Desktop.Runtime;

internal interface IAppDataPathProvider
{
    string RootDirectory { get; }
    string BuildConfiguration { get; }
    string SourceDescription { get; }
}

internal static class AppDataPathProviderFactory
{
    public const string DataDirectoryEnvironmentVariable = "NAVISWORKS_MCP_DESKTOP_DATA_DIR";
    public const string DataDirectoryArgument = "--data-dir";

    public static IAppDataPathProvider Create(IReadOnlyList<string> arguments)
    {
        ArgumentNullException.ThrowIfNull(arguments);

        var commandLineDirectory = ReadCommandLineDirectory(arguments);
        if (!string.IsNullOrWhiteSpace(commandLineDirectory))
        {
            return new FixedAppDataPathProvider(
                NormalizeDirectory(commandLineDirectory),
                GetBuildConfiguration(),
                $"命令行 {DataDirectoryArgument}");
        }

        var environmentDirectory = Environment.GetEnvironmentVariable(
            DataDirectoryEnvironmentVariable);
        if (!string.IsNullOrWhiteSpace(environmentDirectory))
        {
            return new FixedAppDataPathProvider(
                NormalizeDirectory(environmentDirectory),
                GetBuildConfiguration(),
                $"环境变量 {DataDirectoryEnvironmentVariable}");
        }

        var localAppData = Environment.GetFolderPath(
            Environment.SpecialFolder.LocalApplicationData);
        var applicationDirectory = GetBuildConfiguration() == "Debug"
            ? "NavisworksMcpDesktop.Debug"
            : "NavisworksMcpDesktop";

        return new FixedAppDataPathProvider(
            Path.Combine(localAppData, applicationDirectory),
            GetBuildConfiguration(),
            "构建配置默认值");
    }

    private static string? ReadCommandLineDirectory(IReadOnlyList<string> arguments)
    {
        for (var index = 0; index < arguments.Count; index++)
        {
            var argument = arguments[index];
            if (string.Equals(argument, DataDirectoryArgument, StringComparison.OrdinalIgnoreCase))
            {
                if (index + 1 >= arguments.Count || string.IsNullOrWhiteSpace(arguments[index + 1]))
                    throw new ArgumentException($"{DataDirectoryArgument} 后必须提供目录路径。");

                return arguments[index + 1];
            }

            var prefix = DataDirectoryArgument + "=";
            if (argument.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                var value = argument[prefix.Length..];
                if (string.IsNullOrWhiteSpace(value))
                    throw new ArgumentException($"{DataDirectoryArgument} 后必须提供目录路径。");

                return value;
            }
        }

        return null;
    }

    private static string NormalizeDirectory(string directory)
    {
        var expanded = Environment.ExpandEnvironmentVariables(directory.Trim());
        if (string.IsNullOrWhiteSpace(expanded))
            throw new ArgumentException("应用数据目录不能为空。", nameof(directory));

        var fullPath = Path.GetFullPath(expanded);
        if (File.Exists(fullPath))
            throw new IOException($"应用数据目录指向了文件：{fullPath}");

        return Path.TrimEndingDirectorySeparator(fullPath);
    }

    private static string GetBuildConfiguration()
    {
#if DEBUG
        return "Debug";
#else
        return "Production";
#endif
    }

    private sealed class FixedAppDataPathProvider(
        string rootDirectory,
        string buildConfiguration,
        string sourceDescription) : IAppDataPathProvider
    {
        public string RootDirectory { get; } = rootDirectory;
        public string BuildConfiguration { get; } = buildConfiguration;
        public string SourceDescription { get; } = sourceDescription;
    }
}
