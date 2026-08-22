using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Input;
using NavisworksMcp.Console.Bridge;
using NavisworksMcp.Desktop.Models;
using NavisworksMcp.Desktop.Runtime;
using NavisworksMcp.Desktop.Services;

namespace NavisworksMcp.Desktop.ViewModels;

internal sealed class MainViewModel : INotifyPropertyChanged, IDisposable
{
    private const int FixedContextWindowTokens = 16384;

    private readonly ApplicationRuntimeContext _runtimeContext;
    private readonly IConversationSessionRepository _sessionRepository;
    private readonly ISettingsRepository _settingsRepository;
    private readonly BridgeClient _bridge;
    private readonly CancellationTokenSource _cts = new();
    private OllamaClient? _llm;
    private CancellationTokenSource? _llmConnectCts;
    private CancellationTokenSource? _turnCts;
    private ChatSessionItem? _currentSession;
    private Guid? _lastActiveSessionId;
    private bool _canPersistSessions = true;

    private static readonly HashSet<string> AllowedAgentTools = new(StringComparer.Ordinal)
    {
        "navisworks_status",
        "navisworks_get_document",
        "navisworks_get_selection",
        "navisworks_find_items",
        "navisworks_get_item_properties",
        "navisworks_select_items",
        "navisworks_set_visibility",
        "navisworks_list_viewpoints",
        "navisworks_activate_viewpoint"
    };

    // ── Bound properties ───────────────────────────────

    private string _input = "";
    public string Input
    {
        get => _input;
        set
        {
            _input = value;
            OnPropertyChanged();
            CommandManager.InvalidateRequerySuggested();
        }
    }

    private bool _isBusy;
    public bool IsBusy
    {
        get => _isBusy;
        set
        {
            _isBusy = value;
            OnPropertyChanged();
            CommandManager.InvalidateRequerySuggested();
        }
    }

    private string _llmModel = "qwen3.5:9b-q4_K_M";
    public string LlmModel
    {
        get => _llmModel;
        private set
        {
            _llmModel = value;
            OnPropertyChanged();
            OnPropertyChanged(nameof(SettingsModel));
            OnPropertyChanged(nameof(ModelReasoningSummary));
        }
    }

    private string _reasoningMode = "deep";
    public string ReasoningMode
    {
        get => _reasoningMode;
        private set
        {
            _reasoningMode = value;
            OnPropertyChanged();
            OnPropertyChanged(nameof(ReasoningLabel));
            OnPropertyChanged(nameof(ModelReasoningSummary));
            OnPropertyChanged(nameof(IsFastReasoning));
            OnPropertyChanged(nameof(IsDeepReasoning));
        }
    }

    public string ReasoningLabel => ReasoningMode == "deep" ? "深度" : "快速";
    public string ModelReasoningSummary => $"{LlmModel}  {ReasoningLabel}";
    public bool IsFastReasoning => ReasoningMode == "fast";
    public bool IsDeepReasoning => ReasoningMode == "deep";

    private int _contextTokensUsed;
    public int ContextTokensUsed
    {
        get => _contextTokensUsed;
        private set
        {
            _contextTokensUsed = Math.Clamp(value, 0, FixedContextWindowTokens);
            OnPropertyChanged();
            OnPropertyChanged(nameof(ContextTokensRemaining));
            OnPropertyChanged(nameof(ContextUsagePercent));
            OnPropertyChanged(nameof(ContextUsagePercentLabel));
            OnPropertyChanged(nameof(ContextUsageTokensLabel));
            OnPropertyChanged(nameof(ContextRemainingLabel));
        }
    }

    public int ContextWindowTokens => FixedContextWindowTokens;
    public int ContextTokensRemaining => FixedContextWindowTokens - ContextTokensUsed;
    public double ContextUsagePercent =>
        ContextTokensUsed * 100d / FixedContextWindowTokens;
    public string ContextUsagePercentLabel => $"{ContextUsagePercent:0}% 已用";
    public string ContextUsageTokensLabel =>
        $"已用 {ContextTokensUsed:N0} tokens，共 16K";
    public string ContextRemainingLabel =>
        $"剩余 {ContextTokensRemaining:N0} tokens";

    private ObservableCollection<ChatMessage> _messages = new();
    public ObservableCollection<ChatMessage> Messages
    {
        get => _messages;
        private set { _messages = value; OnPropertyChanged(); }
    }

    private ObservableCollection<ConversationTurnItem> _conversationTurns = new();
    public ObservableCollection<ConversationTurnItem> ConversationTurns
    {
        get => _conversationTurns;
        private set { _conversationTurns = value; OnPropertyChanged(); }
    }

    public ObservableCollection<ChatSessionItem> Sessions { get; } = new();
    public ObservableCollection<string> AvailableModels { get; } = new();
    public ObservableCollection<ManagedExtensionItem> Plugins { get; } = new();
    public ObservableCollection<ManagedExtensionItem> Skills { get; } = new();
    public string ConversationSavePath => _runtimeContext.AppDataPathProvider.RootDirectory;
    public string ConversationSaveFile => _runtimeContext.SessionsFile;
    public string RuntimeProfileLabel =>
        $"{_runtimeContext.AppDataPathProvider.BuildConfiguration} · {_runtimeContext.AppDataPathProvider.SourceDescription}";
    public string RuntimeDiagnostics => _runtimeContext.BuildDiagnosticReport(
        NavisworksStatus,
        EndpointReader.GetDefaultEndpointFile());

    public string SettingsModel
    {
        get => LlmModel;
        set => SelectModel(value, closeModelMenu: false);
    }

    private bool _isSettingsOpen;
    public bool IsSettingsOpen
    {
        get => _isSettingsOpen;
        private set { _isSettingsOpen = value; OnPropertyChanged(); }
    }

    private bool _isDiagnosticsOpen;
    public bool IsDiagnosticsOpen
    {
        get => _isDiagnosticsOpen;
        private set { _isDiagnosticsOpen = value; OnPropertyChanged(); }
    }

    private string _settingsPage = "conversation";
    public bool ShowConversationSettings => _settingsPage == "conversation";
    public bool ShowShortcutsSettings => _settingsPage == "shortcuts";
    public bool ShowModelSettings => _settingsPage == "model";
    public bool ShowExtensionsSettings => _settingsPage == "extensions";

    private string _extensionPage = "plugins";
    public bool ShowPlugins => _extensionPage == "plugins";
    public bool ShowMcp => _extensionPage == "mcp";
    public bool ShowSkills => _extensionPage == "skills";

    private string _newPluginName = "";
    public string NewPluginName
    {
        get => _newPluginName;
        set
        {
            _newPluginName = value;
            OnPropertyChanged();
            CommandManager.InvalidateRequerySuggested();
        }
    }

    private string _newSkillName = "";
    public string NewSkillName
    {
        get => _newSkillName;
        set
        {
            _newSkillName = value;
            OnPropertyChanged();
            CommandManager.InvalidateRequerySuggested();
        }
    }

    public bool HasActiveSession => _currentSession is not null;

    private string _currentSessionTitle = "新对话";
    public string CurrentSessionTitle
    {
        get => _currentSessionTitle;
        private set { _currentSessionTitle = value; OnPropertyChanged(); }
    }

    private bool _isModelMenuOpen;
    public bool IsModelMenuOpen
    {
        get => _isModelMenuOpen;
        set { _isModelMenuOpen = value; OnPropertyChanged(); }
    }

    private bool _isAddingModel;
    public bool IsAddingModel
    {
        get => _isAddingModel;
        private set { _isAddingModel = value; OnPropertyChanged(); }
    }

    private string _newModelName = "";
    public string NewModelName
    {
        get => _newModelName;
        set
        {
            _newModelName = value;
            OnPropertyChanged();
            CommandManager.InvalidateRequerySuggested();
        }
    }

    private bool _llmConnected;
    public bool LlmConnected
    {
        get => _llmConnected;
        private set { _llmConnected = value; OnPropertyChanged(); }
    }

    private string _llmStatus = "未连接";
    public string LlmStatus
    {
        get => _llmStatus;
        private set { _llmStatus = value; OnPropertyChanged(); }
    }

    private bool _navisworksConnected;
    public bool NavisworksConnected
    {
        get => _navisworksConnected;
        private set { _navisworksConnected = value; OnPropertyChanged(); }
    }

    private string _navisworksStatus = "Navisworks 未连接";
    public string NavisworksStatus
    {
        get => _navisworksStatus;
        private set
        {
            _navisworksStatus = value;
            OnPropertyChanged();
            OnPropertyChanged(nameof(RuntimeDiagnostics));
        }
    }

    // ── Commands ────────────────────────────────────────

    public ICommand SendCommand { get; }
    public ICommand StopGenerationCommand { get; }
    public ICommand ConnectLlmCommand { get; }
    public ICommand ToggleModelMenuCommand { get; }
    public ICommand SelectModelCommand { get; }
    public ICommand SelectReasoningModeCommand { get; }
    public ICommand ShowAddModelCommand { get; }
    public ICommand AddModelCommand { get; }
    public ICommand NewChatCommand { get; }
    public ICommand SelectSessionCommand { get; }
    public ICommand DeleteSessionCommand { get; }
    public ICommand OpenSettingsCommand { get; }
    public ICommand CloseSettingsCommand { get; }
    public ICommand OpenDiagnosticsCommand { get; }
    public ICommand CloseDiagnosticsCommand { get; }
    public ICommand SelectSettingsPageCommand { get; }
    public ICommand SelectExtensionPageCommand { get; }
    public ICommand AddPluginCommand { get; }
    public ICommand AddSkillCommand { get; }
    public ICommand RemoveExtensionCommand { get; }

    // ── Constructor ────────────────────────────────────

    public MainViewModel(
        ApplicationRuntimeContext runtimeContext,
        IConversationSessionRepository sessionRepository,
        ISettingsRepository settingsRepository)
    {
        _runtimeContext = runtimeContext ?? throw new ArgumentNullException(nameof(runtimeContext));
        _sessionRepository = sessionRepository ?? throw new ArgumentNullException(nameof(sessionRepository));
        _settingsRepository = settingsRepository ?? throw new ArgumentNullException(nameof(settingsRepository));
        _bridge = new BridgeClient();

        LoadSettings();
        if (!AvailableModels.Contains(LlmModel, StringComparer.OrdinalIgnoreCase))
            AvailableModels.Add(LlmModel);

        SendCommand = new AsyncRelayCommand(
            _ => SendAsync(),
            _ => !IsBusy && !string.IsNullOrWhiteSpace(Input),
            ReportCommandError);
        StopGenerationCommand = new RelayCommand(
            _ => _turnCts?.Cancel(),
            _ => IsBusy && _turnCts is not null);
        ConnectLlmCommand = new AsyncRelayCommand(
            _ => ConnectLlmAsync(showConversationMessage: true),
            _ => !IsBusy,
            ReportCommandError);
        ToggleModelMenuCommand = new AsyncRelayCommand(
            _ => ToggleModelMenuAsync(),
            onError: ReportCommandError);
        SelectModelCommand = new RelayCommand(
            model => SelectModel(model as string),
            _ => !IsBusy);
        SelectReasoningModeCommand = new RelayCommand(
            mode => SelectReasoningMode(mode as string),
            _ => !IsBusy);
        ShowAddModelCommand = new RelayCommand(_ => IsAddingModel = true);
        AddModelCommand = new RelayCommand(
            _ => AddModel(),
            _ => !string.IsNullOrWhiteSpace(NewModelName));
        NewChatCommand = new RelayCommand(
            _ => CreateNewSessionFromUserAction(),
            _ => !IsBusy);
        SelectSessionCommand = new RelayCommand(
            session => ActivateSession(session as ChatSessionItem),
            _ => !IsBusy);
        DeleteSessionCommand = new RelayCommand(
            session => DeleteSession(session as ChatSessionItem),
            _ => !IsBusy);
        OpenSettingsCommand = new RelayCommand(_ =>
        {
            IsDiagnosticsOpen = false;
            IsSettingsOpen = true;
        });
        CloseSettingsCommand = new RelayCommand(_ => IsSettingsOpen = false);
        OpenDiagnosticsCommand = new RelayCommand(_ =>
        {
            IsSettingsOpen = false;
            OnPropertyChanged(nameof(RuntimeDiagnostics));
            IsDiagnosticsOpen = true;
        });
        CloseDiagnosticsCommand = new RelayCommand(_ => IsDiagnosticsOpen = false);
        SelectSettingsPageCommand = new RelayCommand(page => SelectSettingsPage(page as string));
        SelectExtensionPageCommand = new RelayCommand(page => SelectExtensionPage(page as string));
        AddPluginCommand = new RelayCommand(
            _ => AddExtension("plugin"),
            _ => !string.IsNullOrWhiteSpace(NewPluginName));
        AddSkillCommand = new RelayCommand(
            _ => AddExtension("skill"),
            _ => !string.IsNullOrWhiteSpace(NewSkillName));
        RemoveExtensionCommand = new RelayCommand(item => RemoveExtension(item as ManagedExtensionItem));

        _ = PollStatusAsync();
        LoadSessions();
        if (Sessions.Count > 0)
        {
            var restoredSession = Sessions.FirstOrDefault(session => session.Id == _lastActiveSessionId)
                ?? Sessions[0];
            ActivateSession(restoredSession);
        }
        else
        {
            _lastActiveSessionId = null;
        }

        // 无历史会话时不自动创建；首次发送时由 SendAsync 创建。
        _ = ConnectLlmAsync(showConversationMessage: false, lockUi: false);
    }

    // ── Sessions ───────────────────────────────────────

    private void CreateNewSessionFromUserAction()
    {
        CreateAndActivateSession();
    }

    private ChatSessionItem CreateAndActivateSession()
    {
        var session = new ChatSessionItem(
            Guid.NewGuid(),
            "新对话",
            "尚无消息",
            DateTimeOffset.Now,
            new ObservableCollection<ChatMessage>());

        AttachSession(session);
        Sessions.Insert(0, session);
        ActivateSession(session);
        SaveSessions();
        return session;
    }

    private void ActivateSession(ChatSessionItem? session)
    {
        if (ReferenceEquals(session, _currentSession))
            return;

        foreach (var item in Sessions)
            item.IsActive = session is not null && ReferenceEquals(item, session);

        _currentSession = session;
        Messages = session?.Messages ?? new ObservableCollection<ChatMessage>();
        RebuildConversationTurns();
        CurrentSessionTitle = session?.Title ?? "";
        ContextTokensUsed = session?.ContextTokensUsed ?? 0;
        Input = "";
        OnPropertyChanged(nameof(HasActiveSession));
        CommandManager.InvalidateRequerySuggested();
        _lastActiveSessionId = session?.Id;
        SaveSettings();

        _llm?.Dispose();
        _llm = null;
        if (session is not null && LlmConnected)
            _llm = CreateClientForSession(session);
    }

    private void DeleteSession(ChatSessionItem? session)
    {
        if (session is null)
            return;

        var answer = MessageBox.Show(
            $"确定删除会话“{session.Title}”吗？\n此操作无法撤销。",
            "删除会话",
            MessageBoxButton.YesNo,
            MessageBoxImage.Warning,
            MessageBoxResult.No);
        if (answer != MessageBoxResult.Yes)
            return;

        var wasCurrent = ReferenceEquals(session, _currentSession);
        Sessions.Remove(session);

        if (wasCurrent)
        {
            if (Sessions.Count == 0)
                ActivateSession(null);
            else
                ActivateSession(Sessions[0]);
        }

        SaveSessions();
    }

    private OllamaClient CreateClientForSession(ChatSessionItem session)
    {
        var client = CreateConfiguredClient();
        client.RestoreHistory(session.Messages
            .Where(message => message.Role is "user" or "ai")
            .Where(message => !message.IsTransient)
            .Where(message => !IsLegacyAgentActionMessage(message))
            .Select(message => new LlmHistoryEntry(
                message.Role == "user" ? "user" : "assistant",
                message.Content)));
        return client;
    }

    private void AttachSession(ChatSessionItem session)
    {
        session.Messages.CollectionChanged += (_, _) => SessionMessagesChanged(session);
    }

    private void SessionMessagesChanged(ChatSessionItem session)
    {
        var firstUserMessage = session.Messages.FirstOrDefault(message => message.Role == "user");
        if (session.Title == "新对话" && firstUserMessage is not null)
        {
            session.Title = BuildSessionTitle(firstUserMessage.Content);
            if (ReferenceEquals(session, _currentSession))
                CurrentSessionTitle = session.Title;
        }

        var latest = session.Messages.LastOrDefault(message =>
            (message.Role is "user" or "ai" or "error") &&
            !message.IsTransient);
        session.Preview = latest is null
            ? "尚无消息"
            : BuildSessionPreview(latest.Content);
        session.UpdatedAt = DateTimeOffset.Now;

        if (ReferenceEquals(session, _currentSession))
            RebuildConversationTurns();

        var index = Sessions.IndexOf(session);
        if (index > 0)
            Sessions.Move(index, 0);

        SaveSessions();
    }

    private void LoadSessions()
    {
        var loadResult = _sessionRepository.Load();
        _canPersistSessions = loadResult.CanPersist;
        if (!loadResult.CanPersist || loadResult.Source == SessionLoadSource.None)
            return;

        try
        {
            var loadedSessions = new List<ChatSessionItem>();
            var removedLegacyIntermediateMessages = false;
            foreach (var snapshot in loadResult.Snapshots
                         .OrderByDescending(item => item.UpdatedAt)
                         .Take(30))
            {
                var sourceMessages = snapshot.Messages?.OfType<ChatMessage>()
                    ?? Enumerable.Empty<ChatMessage>();
                var visibleMessages = RemoveLegacyConversationNoise(sourceMessages)
                    .Where(message => !message.IsTransient && message.Content != "思考中...")
                    .TakeLast(100)
                    .ToList();
                removedLegacyIntermediateMessages |= visibleMessages.Count != (snapshot.Messages?.Count ?? 0);
                var messages = new ObservableCollection<ChatMessage>(
                    visibleMessages);
                var session = new ChatSessionItem(
                    snapshot.Id == Guid.Empty ? Guid.NewGuid() : snapshot.Id,
                    string.IsNullOrWhiteSpace(snapshot.Title) ? "新对话" : snapshot.Title,
                    string.IsNullOrWhiteSpace(snapshot.Preview) ? "尚无消息" : snapshot.Preview,
                    snapshot.UpdatedAt == default ? DateTimeOffset.Now : snapshot.UpdatedAt,
                    messages)
                {
                    ContextTokensUsed = Math.Clamp(snapshot.ContextTokensUsed, 0, FixedContextWindowTokens)
                };
                AttachSession(session);
                loadedSessions.Add(session);
            }

            foreach (var session in loadedSessions)
                Sessions.Add(session);

            if (loadResult.Source == SessionLoadSource.Backup || removedLegacyIntermediateMessages)
                SaveSessions();
        }
        catch (Exception ex) when (ex is InvalidOperationException or ArgumentException)
        {
            // Keep the files untouched if a future/invalid snapshot cannot be materialized.
            Sessions.Clear();
            _canPersistSessions = false;
        }
    }

    private void SaveSessions()
    {
        if (!_canPersistSessions)
            return;

        var snapshots = Sessions
            .OrderByDescending(session => session.UpdatedAt)
            .Take(30)
            .Select(session => new ChatSessionSnapshot(
                session.Id,
                session.Title,
                session.Preview,
                session.UpdatedAt,
                session.Messages.TakeLast(100).ToList(),
                session.ContextTokensUsed))
            .ToList();

        _sessionRepository.TrySave(snapshots);
    }

    private static string BuildSessionTitle(string content)
    {
        var singleLine = string.Join(" ", content
            .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
            .Trim();
        return singleLine.Length <= 22 ? singleLine : singleLine[..22] + "…";
    }

    private static IEnumerable<ChatMessage> RemoveLegacyConversationNoise(
        IEnumerable<ChatMessage> messages)
    {
        var hideFollowingToolResult = false;

        foreach (var message in messages)
        {
            if (message.Role == "system" &&
                (message.Content.StartsWith("✅ Ollama 已连接", StringComparison.Ordinal) ||
                 message.Content.StartsWith("直接输入问题", StringComparison.Ordinal)))
            {
                continue;
            }

            if (IsLegacyAgentActionMessage(message))
            {
                hideFollowingToolResult = true;
                continue;
            }

            if (hideFollowingToolResult && message.Role == "tool")
            {
                hideFollowingToolResult = false;
                continue;
            }

            hideFollowingToolResult = false;
            yield return message;
        }
    }

    private static bool IsLegacyAgentActionMessage(ChatMessage message)
    {
        if (message.Role != "ai")
            return false;

        return message.Content.StartsWith("🔍 搜索：", StringComparison.Ordinal) ||
               message.Content.StartsWith("👁 ", StringComparison.Ordinal) ||
               message.Content.StartsWith("🔧 ", StringComparison.Ordinal) ||
               message.Content is
                   "🖱 选择中..." or
                   "📋 获取属性..." or
                   "📡 检查状态..." or
                   "📄 获取文档..." or
                   "📌 获取选中项...";
    }

    private static string BuildSessionPreview(string content)
    {
        var singleLine = string.Join(" ", content
            .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
            .Trim();
        return singleLine.Length <= 36 ? singleLine : singleLine[..36] + "…";
    }

    private void RebuildConversationTurns()
    {
        var turns = new List<ConversationTurnItem>();
        for (var index = 0; index < Messages.Count; index++)
        {
            var userMessage = Messages[index];
            if (userMessage.Role != "user")
                continue;

            var nextUserIndex = index + 1;
            while (nextUserIndex < Messages.Count && Messages[nextUserIndex].Role != "user")
                nextUserIndex++;

            var assistantMessage = Messages
                .Skip(index + 1)
                .Take(nextUserIndex - index - 1)
                .LastOrDefault(message =>
                    (message.Role is "ai" or "error") &&
                    !message.IsTransient);

            turns.Add(new ConversationTurnItem(
                userMessage,
                BuildNavigationPreview(userMessage.Content, 88),
                assistantMessage is null
                    ? "等待模型回复"
                    : BuildNavigationPreview(assistantMessage.Content, 150)));
        }

        ConversationTurns = new ObservableCollection<ConversationTurnItem>(turns);
    }

    private static string BuildNavigationPreview(string content, int maxLength)
    {
        var singleLine = string.Join(" ", content
            .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
            .Trim();
        return singleLine.Length <= maxLength
            ? singleLine
            : singleLine[..maxLength] + "…";
    }

    // ── Settings and extensions ────────────────────────

    private void SelectSettingsPage(string? page)
    {
        if (page is not ("conversation" or "shortcuts" or "model" or "extensions"))
            return;

        _settingsPage = page;
        OnPropertyChanged(nameof(ShowConversationSettings));
        OnPropertyChanged(nameof(ShowShortcutsSettings));
        OnPropertyChanged(nameof(ShowModelSettings));
        OnPropertyChanged(nameof(ShowExtensionsSettings));
    }

    private void SelectExtensionPage(string? page)
    {
        if (page is not ("plugins" or "mcp" or "skills"))
            return;

        _extensionPage = page;
        OnPropertyChanged(nameof(ShowPlugins));
        OnPropertyChanged(nameof(ShowMcp));
        OnPropertyChanged(nameof(ShowSkills));
    }

    private void AddExtension(string type)
    {
        var name = type == "plugin" ? NewPluginName.Trim() : NewSkillName.Trim();
        if (string.IsNullOrWhiteSpace(name))
            return;

        var target = type == "plugin" ? Plugins : Skills;
        if (target.Any(item => string.Equals(item.Name, name, StringComparison.OrdinalIgnoreCase)))
            return;

        var item = new ManagedExtensionItem(Guid.NewGuid(), name, type, true);
        AttachExtension(item);
        target.Add(item);

        if (type == "plugin")
            NewPluginName = "";
        else
            NewSkillName = "";

        SaveSettings();
    }

    private void RemoveExtension(ManagedExtensionItem? item)
    {
        if (item is null)
            return;

        var target = item.Type == "plugin" ? Plugins : Skills;
        target.Remove(item);
        SaveSettings();
    }

    private void AttachExtension(ManagedExtensionItem item)
    {
        item.PropertyChanged += (_, args) =>
        {
            if (args.PropertyName == nameof(ManagedExtensionItem.IsEnabled))
                SaveSettings();
        };
    }

    private void LoadSettings()
    {
        try
        {
            var snapshot = _settingsRepository.Load();
            if (snapshot is null)
                return;

            if (!string.IsNullOrWhiteSpace(snapshot.SelectedModel))
                _llmModel = snapshot.SelectedModel;
            if (snapshot.ReasoningMode is "fast" or "deep")
                _reasoningMode = snapshot.ReasoningMode;
            _lastActiveSessionId = snapshot.ActiveSessionId;

            foreach (var model in snapshot.Models.Where(model => !string.IsNullOrWhiteSpace(model)))
            {
                if (!AvailableModels.Contains(model, StringComparer.OrdinalIgnoreCase))
                    AvailableModels.Add(model);
            }

            foreach (var item in snapshot.Plugins)
            {
                AttachExtension(item);
                Plugins.Add(item);
            }

            foreach (var item in snapshot.Skills)
            {
                AttachExtension(item);
                Skills.Add(item);
            }
        }
        catch
        {
            Plugins.Clear();
            Skills.Clear();
        }
    }

    private void SaveSettings()
    {
        var snapshot = new AppSettingsSnapshot(
            LlmModel,
            AvailableModels.ToList(),
            Plugins.ToList(),
            Skills.ToList(),
            ReasoningMode,
            _lastActiveSessionId);

        _settingsRepository.TrySave(snapshot);
    }

    // ── LLM ────────────────────────────────────────────

    private async Task ToggleModelMenuAsync()
    {
        IsModelMenuOpen = !IsModelMenuOpen;
        if (!IsModelMenuOpen)
        {
            IsAddingModel = false;
            NewModelName = "";
            return;
        }

        using var client = new OllamaClient(model: LlmModel);
        var result = await client.ListInstalledModelsAsync(_cts.Token);
        if (!result.IsSuccess)
            return;

        foreach (var model in result.Models)
        {
            if (!AvailableModels.Contains(model, StringComparer.OrdinalIgnoreCase))
                AvailableModels.Add(model);
        }
    }

    private void SelectModel(string? model, bool closeModelMenu = true)
    {
        if (string.IsNullOrWhiteSpace(model))
            return;

        if (IsBusy)
        {
            // A turn or connection attempt is in flight; snap the settings ComboBox back.
            OnPropertyChanged(nameof(SettingsModel));
            return;
        }

        var modelChanged = !string.Equals(LlmModel, model, StringComparison.OrdinalIgnoreCase);
        if (modelChanged)
        {
            _llm?.Dispose();
            _llm = null;
            LlmModel = model;
            LlmConnected = false;
            LlmStatus = "未连接";
        }

        if (closeModelMenu)
        {
            IsModelMenuOpen = false;
            IsAddingModel = false;
            NewModelName = "";
        }

        SaveSettings();

        if (modelChanged)
            _ = ConnectLlmAsync(showConversationMessage: false, lockUi: false);
    }

    private void SelectReasoningMode(string? mode)
    {
        if (IsBusy || mode is not ("fast" or "deep") || mode == ReasoningMode)
        {
            IsModelMenuOpen = false;
            return;
        }

        _llm?.Dispose();
        _llm = null;
        ReasoningMode = mode;
        LlmConnected = false;
        LlmStatus = "未连接";
        IsModelMenuOpen = false;
        SaveSettings();
        _ = ConnectLlmAsync(showConversationMessage: false, lockUi: false);
    }

    private void AddModel()
    {
        var model = NewModelName.Trim();
        if (string.IsNullOrWhiteSpace(model))
            return;

        if (!AvailableModels.Contains(model, StringComparer.OrdinalIgnoreCase))
            AvailableModels.Add(model);

        SelectModel(model);
    }

    private async Task ConnectLlmAsync(bool showConversationMessage, bool lockUi = true)
    {
        if (IsBusy && _llmConnectCts is null)
            return;

        var connectionCts = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token);
        _llmConnectCts?.Cancel();
        _llmConnectCts = connectionCts;
        // Background probes (startup, model switch) must not freeze the whole
        // UI in its busy state; only the explicit "connect" command locks it.
        if (lockUi)
            IsBusy = true;
        LlmStatus = "连接中...";
        var candidate = CreateConfiguredClient();

        try
        {
            var connection = await candidate.CheckConnectionAsync(connectionCts.Token);
            if (!ReferenceEquals(_llmConnectCts, connectionCts))
            {
                candidate.Dispose();
                return;
            }

            if (connection.IsSuccess)
            {
                candidate.RestoreHistory(Messages
                    .Where(message => message.Role is "user" or "ai")
                    .Where(message => !message.IsTransient)
                    .Where(message => !IsLegacyAgentActionMessage(message))
                    .Select(message => new LlmHistoryEntry(
                        message.Role == "user" ? "user" : "assistant",
                        message.Content)));
                _llm?.Dispose();
                _llm = candidate;
                LlmConnected = true;
                LlmStatus = "已连接";
                if (showConversationMessage)
                {
                    Messages.Add(new ChatMessage
                    {
                        Role = "system",
                        Content = $"✅ {connection.Message}"
                    });
                }
            }
            else
            {
                candidate.Dispose();
                LlmConnected = false;
                LlmStatus = "连接失败";
                if (showConversationMessage)
                {
                    Messages.Add(new ChatMessage
                    {
                        Role = "error",
                        Content = $"❌ {connection.Message}"
                    });
                }
            }
        }
        catch (OperationCanceledException)
        {
            candidate.Dispose();
        }
        finally
        {
            if (ReferenceEquals(_llmConnectCts, connectionCts))
            {
                _llmConnectCts = null;
                // Only clear the flag this method set; a user turn that
                // started meanwhile owns IsBusy now and must keep it.
                if (lockUi)
                    IsBusy = false;
            }

            connectionCts.Dispose();
        }
    }

    // ── Send ───────────────────────────────────────────

    private async Task SendAsync()
    {
        var text = Input.Trim();
        if (string.IsNullOrWhiteSpace(text) || IsBusy) return;

        if (_currentSession is null)
            CreateAndActivateSession();

        Input = "";

        if (text.Equals("clear", StringComparison.OrdinalIgnoreCase))
        {
            Messages.Clear();
            _llm?.ClearHistory();
            ContextTokensUsed = 0;
            if (_currentSession is not null)
                _currentSession.ContextTokensUsed = 0;
            Messages.Add(new ChatMessage { Role = "system", Content = "对话已清空。" });
            return;
        }

        IsBusy = true;

        Messages.Add(new ChatMessage { Role = "user", Content = text });

        var turnCts = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token);
        _turnCts = turnCts;
        try
        {
            if (_llm?.IsConfigured == true)
            {
                await SendWithLlmAsync(text, turnCts.Token);
            }
            else
            {
                Messages.Add(new ChatMessage
                {
                    Role = "system",
                    Content = "本地模型未连接。请启动 Ollama 并点击侧栏的「连接」，连接成功后再发送。"
                });
            }
        }
        catch (OperationCanceledException) when (turnCts.IsCancellationRequested)
        {
            Messages.Add(new ChatMessage { Role = "system", Content = "已停止生成。" });
        }
        catch (Exception ex)
        {
            Messages.Add(new ChatMessage { Role = "error", Content = $"错误：{ex.Message}" });
        }
        finally
        {
            if (ReferenceEquals(_turnCts, turnCts))
                _turnCts = null;
            turnCts.Dispose();
            IsBusy = false;
        }
    }

    private async Task SendWithLlmAsync(string text, CancellationToken cancellationToken)
    {
        var streaming = new ChatMessage { Role = "ai", Content = "思考中...", IsTransient = true };
        Messages.Add(streaming);

        LlmRunResult result;
        try
        {
            result = await _llm!.RunAgentAsync(
                text,
                ExecuteToolForAgentAsync,
                update => ApplyStreamUpdate(streaming, update),
                cancellationToken);
        }
        catch
        {
            Messages.Remove(streaming);
            throw;
        }

        if (result.ContextTokensUsed > 0)
        {
            ContextTokensUsed = result.ContextTokensUsed;
            if (_currentSession is not null)
                _currentSession.ContextTokensUsed = ContextTokensUsed;
        }

        if (result.IsCancelled)
        {
            if (string.IsNullOrWhiteSpace(result.Message))
            {
                Messages.Remove(streaming);
            }
            else
            {
                streaming.Content = result.Message;
                streaming.IsTransient = false;
            }

            Messages.Add(new ChatMessage { Role = "system", Content = "已停止生成。" });
            NotifyCurrentSessionChanged();
            return;
        }

        if (result.IsSuccess)
        {
            streaming.Content = result.Message;
            streaming.IsTransient = false;
            NotifyCurrentSessionChanged();
        }
        else
        {
            Messages.Remove(streaming);
            Messages.Add(new ChatMessage { Role = "error", Content = result.Message });
        }
    }

    private static void ApplyStreamUpdate(ChatMessage message, LlmStreamUpdate update)
    {
        switch (update.Kind)
        {
            case LlmStreamKind.Thinking:
                // The chain lives in its own collapsible block; the content
                // keeps only the placeholder header until real text streams.
                if (!string.IsNullOrEmpty(update.Text))
                    message.ThinkingText = update.Text;
                if (message.Content != "思考中..." && !message.Content.StartsWith("⏳", StringComparison.Ordinal))
                    message.Content = "思考中...";
                break;
            case LlmStreamKind.Tool:
                message.Content = BuildToolProgressText(message.Content, update.Text);
                break;
            default:
                message.Content = update.Text;
                break;
        }
    }

    private static string BuildToolProgressText(string current, string toolName)
    {
        var progressLine = $"⏳ 正在调用 {toolName}...";
        if (string.IsNullOrWhiteSpace(current) ||
            current.StartsWith("思考中...", StringComparison.Ordinal) ||
            current.StartsWith("⏳", StringComparison.Ordinal))
        {
            return progressLine;
        }

        // Keep this round's streamed commentary visible above the tool status line.
        var baseText = current;
        var markerIndex = baseText.LastIndexOf("\n\n⏳", StringComparison.Ordinal);
        if (markerIndex >= 0)
            baseText = baseText[..markerIndex];
        return baseText + "\n\n" + progressLine;
    }

    private void NotifyCurrentSessionChanged()
    {
        // Streaming mutates message content in place, which never raises
        // CollectionChanged; refresh preview/order/persistence explicitly.
        if (_currentSession is not null)
            SessionMessagesChanged(_currentSession);
    }

    private OllamaClient CreateConfiguredClient() => new(
        model: LlmModel,
        think: IsDeepReasoning,
        contextWindow: FixedContextWindowTokens,
        numPredict: IsDeepReasoning ? 4096 : 1024);

    private async Task<string> ExecuteToolForAgentAsync(
        LlmToolCall toolCall,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        if (!AllowedAgentTools.Contains(toolCall.Name))
        {
            return JsonSerializer.Serialize(new
            {
                status = "error",
                tool = toolCall.Name,
                summary = "工具不在允许列表中。",
                next_actions = new[] { "改用已注册的 Navisworks 工具。" }
            });
        }

        var parameters = toolCall.Arguments.ToDictionary(
            entry => entry.Key,
            entry => entry.Value,
            StringComparer.Ordinal);

        try
        {
            var result = await _bridge.CallAsync(toolCall.Name, parameters, cancellationToken);
            MarkNavisworksAvailable();

            // The raw result is all the model needs (it must reference itemIds);
            // the human-readable FormatResult summary is only for the CLI echo.
            // Sending both doubled every tool result inside the context window.
            return JsonSerializer.Serialize(new
            {
                status = "success",
                tool = toolCall.Name,
                result
            });
        }
        catch (BridgeException ex)
        {
            var summary = $"❌ {ex.Message}";

            return JsonSerializer.Serialize(new
            {
                status = "error",
                tool = toolCall.Name,
                code = ex.Code,
                summary = ex.Message,
                next_actions = new[]
                {
                    "确认 Navisworks Manage 2023 已启动。",
                    "确认模型文档已打开，并已加载 Navisworks MCP 插件。"
                }
            });
        }
    }

    // ── Status polling ─────────────────────────────────

    private async Task PollStatusAsync()
    {
        while (!_cts.Token.IsCancellationRequested)
        {
            try
            {
                var result = await _bridge.CallAsync("navisworks_status", null, _cts.Token);
                UpdateNavisworksStatus(result);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception)
            {
                NavisworksConnected = false;
                NavisworksStatus = "Navisworks 未连接";
            }
            try { await Task.Delay(5000, _cts.Token); }
            catch (OperationCanceledException) { break; }
        }
    }

    private void UpdateNavisworksStatus(object? result)
    {
        if (result is not JsonElement obj)
            return;

        var connected = obj.TryGetProperty("connected", out var value) && value.GetBoolean();
        NavisworksConnected = connected;

        if (!connected)
        {
            NavisworksConnected = false;
            NavisworksStatus = "Navisworks 未连接";
            return;
        }

        var documentTitle = TryStr(obj, "documentTitle");
        NavisworksStatus = string.IsNullOrWhiteSpace(documentTitle)
            ? "Navisworks 已连接"
            : documentTitle;
    }

    private void MarkNavisworksAvailable()
    {
        NavisworksConnected = true;
        if (NavisworksStatus == "Navisworks 未连接")
            NavisworksStatus = "Navisworks 已连接";
    }

    // ── Helpers ────────────────────────────────────────

    private static string TryStr(JsonElement obj, string key)
        => obj.TryGetProperty(key, out var v) ? v.GetString() ?? "" : "";

    // ── INotifyPropertyChanged ─────────────────────────

    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnPropertyChanged([CallerMemberName] string? name = null)
        => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));

    private void ReportCommandError(Exception ex)
        => Messages.Add(new ChatMessage { Role = "error", Content = $"错误：{ex.Message}" });

    public void Dispose()
    {
        SaveSessions();
        SaveSettings();
        _cts.Cancel();
        _llm?.Dispose();
        _bridge.Dispose();

        // _cts is deliberately not disposed: it holds no unmanaged resources
        // and never uses CancelAfter, so there is nothing to leak, while
        // fire-and-forget tasks (status polling, LLM connect) may still read
        // _cts.Token after the window closes — a disposed CTS would make the
        // Token getter throw ObjectDisposedException.
    }
}

// ── RelayCommand ───────────────────────────────────────

internal sealed class RelayCommand : ICommand
{
    private readonly Action<object?> _execute;
    private readonly Func<object?, bool>? _canExecute;
    public RelayCommand(Action<object?> execute, Func<object?, bool>? canExecute = null)
    { _execute = execute; _canExecute = canExecute; }
    public bool CanExecute(object? parameter) => _canExecute?.Invoke(parameter) ?? true;
    public void Execute(object? parameter) => _execute(parameter);
    public event EventHandler? CanExecuteChanged
    {
        add => CommandManager.RequerySuggested += value;
        remove => CommandManager.RequerySuggested -= value;
    }
}

// Wraps async command bodies so faults surface as UI errors instead of
// escaping into an async-void continuation and crashing the dispatcher.
internal sealed class AsyncRelayCommand : ICommand
{
    private readonly Func<object?, Task> _execute;
    private readonly Func<object?, bool>? _canExecute;
    private readonly Action<Exception>? _onError;

    public AsyncRelayCommand(
        Func<object?, Task> execute,
        Func<object?, bool>? canExecute = null,
        Action<Exception>? onError = null)
    {
        _execute = execute;
        _canExecute = canExecute;
        _onError = onError;
    }

    public bool CanExecute(object? parameter) => _canExecute?.Invoke(parameter) ?? true;

    public async void Execute(object? parameter)
    {
        try
        {
            await _execute(parameter);
        }
        catch (OperationCanceledException)
        {
            // Cancellation during shutdown or a superseded operation is not an error.
        }
        catch (Exception ex)
        {
            _onError?.Invoke(ex);
        }
    }

    public event EventHandler? CanExecuteChanged
    {
        add => CommandManager.RequerySuggested += value;
        remove => CommandManager.RequerySuggested -= value;
    }
}
