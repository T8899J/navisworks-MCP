using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Text.Json.Serialization;

namespace NavisworksMcp.Desktop.Models;

public sealed class ChatSessionItem : INotifyPropertyChanged
{
    private string _title;
    private string _preview;
    private DateTimeOffset _updatedAt;
    private bool _isActive;

    public ChatSessionItem(
        Guid id,
        string title,
        string preview,
        DateTimeOffset updatedAt,
        ObservableCollection<ChatMessage> messages)
    {
        Id = id;
        _title = title;
        _preview = preview;
        _updatedAt = updatedAt;
        Messages = messages;
    }

    public Guid Id { get; }
    public ObservableCollection<ChatMessage> Messages { get; }
    public int ContextTokensUsed { get; set; }

    public string Title
    {
        get => _title;
        set { _title = value; OnPropertyChanged(); }
    }

    public string Preview
    {
        get => _preview;
        set { _preview = value; OnPropertyChanged(); }
    }

    public DateTimeOffset UpdatedAt
    {
        get => _updatedAt;
        set
        {
            _updatedAt = value;
            OnPropertyChanged();
            OnPropertyChanged(nameof(UpdatedLabel));
        }
    }

    public string UpdatedLabel => UpdatedAt.LocalDateTime.Date == DateTime.Today
        ? UpdatedAt.LocalDateTime.ToString("HH:mm")
        : UpdatedAt.LocalDateTime.ToString("MM-dd");

    public bool IsActive
    {
        get => _isActive;
        set { _isActive = value; OnPropertyChanged(); }
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    private void OnPropertyChanged([CallerMemberName] string? name = null)
        => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}

public sealed record ChatSessionSnapshot(
    Guid Id,
    string Title,
    string Preview,
    DateTimeOffset UpdatedAt,
    List<ChatMessage>? Messages,
    int ContextTokensUsed = 0);

public sealed class ManagedExtensionItem : INotifyPropertyChanged
{
    private bool _isEnabled;

    public ManagedExtensionItem(Guid id, string name, string type, bool isEnabled)
    {
        Id = id;
        Name = name;
        Type = type;
        _isEnabled = isEnabled;
    }

    public Guid Id { get; init; }
    public string Name { get; init; }
    public string Type { get; init; }

    public bool IsEnabled
    {
        get => _isEnabled;
        set
        {
            if (_isEnabled == value)
                return;

            _isEnabled = value;
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(IsEnabled)));
        }
    }

    public string TypeLabel => Type == "plugin" ? "插件" : "技能";
    public event PropertyChangedEventHandler? PropertyChanged;
}

public sealed record AppSettingsSnapshot(
    string SelectedModel,
    List<string> Models,
    List<ManagedExtensionItem> Plugins,
    List<ManagedExtensionItem> Skills,
    string? ReasoningMode = null,
    Guid? ActiveSessionId = null);

public sealed class ChatMessage : INotifyPropertyChanged
{
    private string _content = "";
    private string _thinkingText = "";
    private bool _isCopied;

    public string Role { get; set; } = "";

    public string Content
    {
        get => _content;
        set
        {
            if (_content == value)
                return;

            _content = value;
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(Content)));
        }
    }

    // A live streaming placeholder is never restored into model context.
    public bool IsTransient { get; set; }

    // Display-only reasoning is persisted for review but never sent back to the model.
    public string ThinkingText
    {
        get => _thinkingText;
        set
        {
            if (_thinkingText == value)
                return;

            _thinkingText = value;
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(ThinkingText)));
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(HasThinking)));
        }
    }

    [JsonIgnore]
    public bool HasThinking => !string.IsNullOrEmpty(ThinkingText);

    [JsonIgnore]
    public bool IsCopied
    {
        get => _isCopied;
        set
        {
            if (_isCopied == value)
                return;

            _isCopied = value;
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(IsCopied)));
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(CopyToolTip)));
        }
    }

    [JsonIgnore]
    public string CopyToolTip => IsCopied ? "已复制" : "复制";

    [JsonIgnore]
    public string Sender => Role switch
    {
        "user" => "你",
        "ai" => "助手",
        "tool" => "工具",
        "system" => "系统",
        "error" => "错误",
        _ => ""
    };

    [JsonIgnore]
    public bool ShowSender => Role is "user" or "ai" or "tool";

    public event PropertyChangedEventHandler? PropertyChanged;
}

public sealed record ConversationTurnItem(
    ChatMessage Anchor,
    string UserPreview,
    string AssistantPreview);
