using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using NavisworksMcp.Desktop.Models;

namespace NavisworksMcp.Desktop.Views;

public partial class MessageView : UserControl
{
    private readonly DispatcherTimer _copyFeedbackTimer;
    private ChatMessage? _copiedMessage;

    public MessageView()
    {
        InitializeComponent();
        _copyFeedbackTimer = new DispatcherTimer(
            TimeSpan.FromMilliseconds(1800),
            DispatcherPriority.Background,
            CopyFeedbackTimer_Tick,
            Dispatcher);
        Unloaded += MessageView_Unloaded;
    }

    private void CopyMessage_Click(object sender, RoutedEventArgs e)
    {
        if (DataContext is not ChatMessage message || string.IsNullOrEmpty(message.Content))
        {
            e.Handled = true;
            return;
        }

        Clipboard.SetText(message.Content);
        ResetCopyFeedback();
        _copiedMessage = message;
        message.IsCopied = true;
        _copyFeedbackTimer.Start();
        e.Handled = true;
    }

    private void CopyFeedbackTimer_Tick(object? sender, EventArgs e)
        => ResetCopyFeedback();

    private void MessageView_Unloaded(object sender, RoutedEventArgs e)
        => ResetCopyFeedback();

    private void ResetCopyFeedback()
    {
        _copyFeedbackTimer.Stop();
        if (_copiedMessage is not null)
            _copiedMessage.IsCopied = false;
        _copiedMessage = null;
    }
}
