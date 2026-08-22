using System.Reflection;
using System.Text;

namespace NavisworksMcp.Desktop.Runtime;

internal sealed class ApplicationRuntimeContext
{
    private readonly DateTimeOffset _startedAt = DateTimeOffset.Now;

    private ApplicationRuntimeContext(IAppDataPathProvider appDataPathProvider)
    {
        AppDataPathProvider = appDataPathProvider;
        SessionsFile = Path.Combine(appDataPathProvider.RootDirectory, "sessions.json");
        SessionsBackupFile = Path.Combine(appDataPathProvider.RootDirectory, "sessions.backup.json");
        SettingsFile = Path.Combine(appDataPathProvider.RootDirectory, "settings.json");
        StartupLogFile = Path.Combine(appDataPathProvider.RootDirectory, "startup.log");

        var assembly = Assembly.GetEntryAssembly() ?? typeof(ApplicationRuntimeContext).Assembly;
        var informationalVersion = assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
            .InformationalVersion;
        var versionParts = informationalVersion?.Split('+', 2)
            ?? [assembly.GetName().Version?.ToString() ?? "未知"];

        Version = versionParts[0];
        Commit = versionParts.Length == 2 && !string.IsNullOrWhiteSpace(versionParts[1])
            ? versionParts[1]
            : "不可用";
        ExecutablePath = Environment.ProcessPath ?? assembly.Location;
        UserIdentity = string.IsNullOrWhiteSpace(Environment.UserDomainName)
            ? Environment.UserName
            : $"{Environment.UserDomainName}\\{Environment.UserName}";
    }

    public IAppDataPathProvider AppDataPathProvider { get; }
    public string SessionsFile { get; }
    public string SessionsBackupFile { get; }
    public string SettingsFile { get; }
    public string StartupLogFile { get; }
    public string Version { get; }
    public string Commit { get; }
    public string ExecutablePath { get; }
    public string UserIdentity { get; }
    public string StartupLogStatus { get; private set; } = "尚未写入";

    public static ApplicationRuntimeContext Create(IAppDataPathProvider appDataPathProvider)
    {
        ArgumentNullException.ThrowIfNull(appDataPathProvider);
        Directory.CreateDirectory(appDataPathProvider.RootDirectory);
        return new ApplicationRuntimeContext(appDataPathProvider);
    }

    public void WriteStartupLog()
    {
        try
        {
            // The entry is only persisted if the append below succeeds. Setting
            // the optimistic value first keeps the persisted diagnostic block
            // consistent with the state observed by the running application.
            StartupLogStatus = "已写入";
            var entry = BuildDiagnosticReport(
                navisworksStatus: "启动时尚未检查",
                bridgeEndpointFile: "启动时尚未解析");
            File.AppendAllText(
                StartupLogFile,
                entry + Environment.NewLine + Environment.NewLine,
                new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        }
        catch (Exception ex) when (ex is IOException
                                   or UnauthorizedAccessException
                                   or NotSupportedException)
        {
            StartupLogStatus = $"写入失败：{ex.Message}";
        }
    }

    public string BuildDiagnosticReport(string navisworksStatus, string bridgeEndpointFile)
    {
        var sessionLastWrite = File.Exists(SessionsFile)
            ? File.GetLastWriteTime(SessionsFile).ToString("yyyy-MM-dd HH:mm:ss")
            : "文件不存在";

        return string.Join(
            Environment.NewLine,
            $"启动时间：{_startedAt:yyyy-MM-dd HH:mm:ss zzz}",
            $"版本：{Version}",
            $"Commit：{Commit}",
            $"构建配置：{AppDataPathProvider.BuildConfiguration}",
            $"数据目录来源：{AppDataPathProvider.SourceDescription}",
            $"进程 ID：{Environment.ProcessId}",
            $"当前用户：{UserIdentity}",
            $"EXE：{ExecutablePath}",
            $"数据目录：{AppDataPathProvider.RootDirectory}",
            $"会话文件：{SessionsFile}",
            $"会话文件最后修改：{sessionLastWrite}",
            $"设置文件：{SettingsFile}",
            $"启动日志：{StartupLogFile}",
            $"启动日志状态：{StartupLogStatus}",
            $"Bridge 端点：{bridgeEndpointFile}",
            $"Navisworks：{navisworksStatus}");
    }
}
