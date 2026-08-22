using System.Collections.ObjectModel;
using System.Collections.Specialized;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Data;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media.Animation;
using System.Windows.Media;
using System.Windows.Threading;
using NavisworksMcp.Desktop.ViewModels;

namespace NavisworksMcp.Desktop;

public partial class MainWindow : Window
{
    private const int WmSettingChange = 0x001A;
    private const int WmGetMinMaxInfo = 0x0024;
    private const int WmNcRightButtonUp = 0x00A5;
    private const int HitTestCaption = 2;
    private const uint MonitorDefaultToNearest = 0x00000002;
    private const int DwmUseImmersiveDarkMode = 20;
    private const int DwmWindowCornerPreference = 33;
    private const int DwmBorderColor = 34;
    private const int DwmWindowCornerRound = 2;
    private const int DwmColorDefault = unchecked((int)0xFFFFFFFF);
    private const double ChatScrollDurationMilliseconds = 120;
    private const double ChatScrollLineHeight = 16;
    private const double SidebarOpenWidth = 280;
    private const double SidebarCollapsedWidth = 0;

    private readonly MainViewModel _vm;
    private ObservableCollection<ChatMessage>? _observedMessages;
    private HwndSource? _windowSource;
    private ScrollViewer? _chatScrollViewer;
    private double _chatScrollStartOffset;
    private double _chatScrollTargetOffset;
    private long _chatScrollStartTimestamp;
    private bool _isChatScrollAnimating;
    private readonly DispatcherTimer _flyoutCloseTimer;
    private Popup? _pendingFlyoutClose;
    private bool _sidebarOpen = true;
    private int _sidebarAnimationVersion;

    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MinMaxInfo
    {
        public NativePoint Reserved;
        public NativePoint MaxSize;
        public NativePoint MaxPosition;
        public NativePoint MinTrackSize;
        public NativePoint MaxTrackSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo
    {
        public int Size;
        public NativeRect MonitorArea;
        public NativeRect WorkArea;
        public uint Flags;
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(
        IntPtr windowHandle,
        int attribute,
        ref int attributeValue,
        int attributeSize);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr windowHandle, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetMonitorInfo(IntPtr monitorHandle, ref MonitorInfo monitorInfo);

    public MainWindow()
    {
        _flyoutCloseTimer = new DispatcherTimer
        {
            Interval = TimeSpan.FromMilliseconds(180)
        };
        _flyoutCloseTimer.Tick += FlyoutCloseTimer_Tick;
        _vm = new MainViewModel();
        DataContext = _vm;
        InitializeComponent();
        Loaded += OnLoaded;
        SourceInitialized += OnSourceInitialized;
        Closed += OnClosed;
    }

    private void OnLoaded(object sender, RoutedEventArgs e)
    {
        _vm.PropertyChanged += ViewModel_PropertyChanged;
        ObserveMessages(_vm.Messages);
        _chatScrollViewer = FindVisualChild<ScrollViewer>(ChatBox);
        _chatScrollTargetOffset = _chatScrollViewer?.VerticalOffset ?? 0;
        ScrollToLatestMessage();
    }

    private void CopyMessage_Click(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is ChatMessage message &&
            !string.IsNullOrEmpty(message.Content))
        {
            Clipboard.SetText(message.Content);

            if (sender is System.Windows.Controls.Button button)
            {
                // Check-mark feedback for ~2 s (Lucide check), then back to
                // the copy icon. The template swaps icons on Tag="copied".
                button.Tag = "copied";
                var feedback = new System.Windows.Threading.DispatcherTimer(
                    TimeSpan.FromSeconds(2),
                    System.Windows.Threading.DispatcherPriority.Background,
                    (timer, _) =>
                    {
                        ((System.Windows.Threading.DispatcherTimer)timer).Stop();
                        button.Tag = "";
                    },
                    Dispatcher);
                feedback.Start();
            }
        }

        e.Handled = true;
    }

    private void OnClosed(object? sender, EventArgs e)
    {
        if (Application.Current is App app)
            app.ThemeChanged -= App_ThemeChanged;
        _windowSource?.RemoveHook(WindowMessageHook);
        _vm.PropertyChanged -= ViewModel_PropertyChanged;
        if (_observedMessages is not null)
            _observedMessages.CollectionChanged -= Messages_CollectionChanged;
        StopChatScrollAnimation();
        _flyoutCloseTimer.Stop();
        _vm.Dispose();
    }

    private void OnSourceInitialized(object? sender, EventArgs e)
    {
        var handle = new WindowInteropHelper(this).Handle;
        _windowSource = HwndSource.FromHwnd(handle);
        _windowSource?.AddHook(WindowMessageHook);

        if (Application.Current is App app)
            app.ThemeChanged += App_ThemeChanged;

        ApplyNativeWindowAppearance();
    }

    private IntPtr WindowMessageHook(
        IntPtr hwnd,
        int message,
        IntPtr wParam,
        IntPtr lParam,
        ref bool handled)
    {
        if (message == WmGetMinMaxInfo)
        {
            ConstrainMaximizedWindowToWorkArea(hwnd, lParam);
            handled = true;
        }
        else if (message == WmSettingChange && Application.Current is App app)
        {
            app.RefreshSystemTheme();
        }
        else if (message == WmNcRightButtonUp && wParam.ToInt32() == HitTestCaption)
        {
            var packedPosition = lParam.ToInt64();
            var screenPoint = new Point(
                unchecked((short)(packedPosition & 0xFFFF)),
                unchecked((short)((packedPosition >> 16) & 0xFFFF)));
            SystemCommands.ShowSystemMenu(this, screenPoint);
            handled = true;
        }

        return IntPtr.Zero;
    }

    private static void ConstrainMaximizedWindowToWorkArea(IntPtr windowHandle, IntPtr minMaxInfoPointer)
    {
        if (minMaxInfoPointer == IntPtr.Zero)
            return;

        var monitorHandle = MonitorFromWindow(windowHandle, MonitorDefaultToNearest);
        if (monitorHandle == IntPtr.Zero)
            return;

        var monitorInfo = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        if (!GetMonitorInfo(monitorHandle, ref monitorInfo))
            return;

        var minMaxInfo = Marshal.PtrToStructure<MinMaxInfo>(minMaxInfoPointer);
        minMaxInfo.MaxPosition = new NativePoint
        {
            X = monitorInfo.WorkArea.Left - monitorInfo.MonitorArea.Left,
            Y = monitorInfo.WorkArea.Top - monitorInfo.MonitorArea.Top
        };
        minMaxInfo.MaxSize = new NativePoint
        {
            X = monitorInfo.WorkArea.Right - monitorInfo.WorkArea.Left,
            Y = monitorInfo.WorkArea.Bottom - monitorInfo.WorkArea.Top
        };
        Marshal.StructureToPtr(minMaxInfo, minMaxInfoPointer, false);
    }

    private void App_ThemeChanged(object? sender, EventArgs e)
    {
        ApplyNativeWindowAppearance();
    }

    private void ApplyNativeWindowAppearance()
    {
        var handle = _windowSource?.Handle ?? IntPtr.Zero;
        if (handle == IntPtr.Zero)
            return;

        var useDarkMode = Application.Current is App { UsesLightTheme: false } ? 1 : 0;
        _ = DwmSetWindowAttribute(
            handle,
            DwmUseImmersiveDarkMode,
            ref useDarkMode,
            Marshal.SizeOf<int>());

        if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22000))
            return;

        var cornerPreference = DwmWindowCornerRound;
        _ = DwmSetWindowAttribute(
            handle,
            DwmWindowCornerPreference,
            ref cornerPreference,
            Marshal.SizeOf<int>());

        var borderColor = DwmColorDefault;
        _ = DwmSetWindowAttribute(
            handle,
            DwmBorderColor,
            ref borderColor,
            Marshal.SizeOf<int>());
    }

    private void ViewModel_PropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName != nameof(MainViewModel.Messages))
            return;

        ObserveMessages(_vm.Messages);
        ScrollToLatestMessage();
    }

    private void ObserveMessages(ObservableCollection<ChatMessage> messages)
    {
        if (_observedMessages is not null)
            _observedMessages.CollectionChanged -= Messages_CollectionChanged;

        _observedMessages = messages;
        _observedMessages.CollectionChanged += Messages_CollectionChanged;
    }

    private void Messages_CollectionChanged(object? sender, NotifyCollectionChangedEventArgs e)
    {
        if (e.NewItems is not null)
        {
            foreach (ChatMessage message in e.NewItems)
                message.PropertyChanged += Message_PropertyChanged;
        }

        if (e.OldItems is not null)
        {
            foreach (ChatMessage message in e.OldItems)
                message.PropertyChanged -= Message_PropertyChanged;
        }

        ScrollToLatestMessage();
    }

    private void Message_PropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName != nameof(ChatMessage.Content))
            return;

        // Streamed content grows in place without CollectionChanged; follow it
        // only while the user is already reading at the bottom.
        var scrollViewer = _chatScrollViewer;
        if (scrollViewer is null || _isChatScrollAnimating)
            return;

        var distanceFromBottom = scrollViewer.ScrollableHeight - scrollViewer.VerticalOffset;
        if (distanceFromBottom > 64)
            return;

        Dispatcher.BeginInvoke(DispatcherPriority.Background, () =>
        {
            if (_chatScrollViewer is null || _isChatScrollAnimating)
                return;
            _chatScrollViewer.ScrollToEnd();
            _chatScrollTargetOffset = _chatScrollViewer.ScrollableHeight;
        });
    }

    private void ScrollToLatestMessage()
    {
        Dispatcher.BeginInvoke(new Action(() =>
        {
            StopChatScrollAnimation();
            if (ChatBox.Items.Count > 0)
                ChatBox.ScrollIntoView(ChatBox.Items[^1]);

            if (_chatScrollViewer is not null)
                _chatScrollTargetOffset = _chatScrollViewer.VerticalOffset;
        }));
    }

    private void ChatBox_PreviewMouseWheel(object sender, MouseWheelEventArgs e)
    {
        var scrollViewer = _chatScrollViewer ??= FindVisualChild<ScrollViewer>(ChatBox);
        if (scrollViewer is null || scrollViewer.ScrollableHeight <= 0)
            return;

        var wheelNotches = e.Delta / 120.0;
        var configuredLines = SystemParameters.WheelScrollLines;
        var wheelDistance = configuredLines < 0
            ? scrollViewer.ViewportHeight * 0.85 * wheelNotches
            : configuredLines * ChatScrollLineHeight * wheelNotches;
        var baseOffset = _isChatScrollAnimating
            ? _chatScrollTargetOffset
            : scrollViewer.VerticalOffset;

        _chatScrollStartOffset = scrollViewer.VerticalOffset;
        _chatScrollTargetOffset = Math.Clamp(
            baseOffset - wheelDistance,
            0,
            scrollViewer.ScrollableHeight);
        _chatScrollStartTimestamp = Stopwatch.GetTimestamp();

        if (!_isChatScrollAnimating)
        {
            _isChatScrollAnimating = true;
            CompositionTarget.Rendering += AnimateChatScroll;
        }

        e.Handled = true;
    }

    private void AnimateChatScroll(object? sender, EventArgs e)
    {
        if (_chatScrollViewer is null)
        {
            StopChatScrollAnimation();
            return;
        }

        var elapsed = Stopwatch.GetElapsedTime(_chatScrollStartTimestamp).TotalMilliseconds;
        var progress = Math.Clamp(elapsed / ChatScrollDurationMilliseconds, 0, 1);
        var easedProgress = 1 - Math.Pow(1 - progress, 3);
        var offset = _chatScrollStartOffset
            + ((_chatScrollTargetOffset - _chatScrollStartOffset) * easedProgress);
        _chatScrollViewer.ScrollToVerticalOffset(offset);

        if (progress >= 1)
            StopChatScrollAnimation();
    }

    private void StopChatScrollAnimation()
    {
        if (!_isChatScrollAnimating)
            return;

        CompositionTarget.Rendering -= AnimateChatScroll;
        _isChatScrollAnimating = false;
    }

    private static T? FindVisualChild<T>(DependencyObject parent) where T : DependencyObject
    {
        for (var index = 0; index < VisualTreeHelper.GetChildrenCount(parent); index++)
        {
            var child = VisualTreeHelper.GetChild(parent, index);
            if (child is T match)
                return match;

            var nestedMatch = FindVisualChild<T>(child);
            if (nestedMatch is not null)
                return nestedMatch;
        }

        return null;
    }

    private void InputBox_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && (Keyboard.Modifiers & ModifierKeys.Shift) == 0)
        {
            if (_vm.SendCommand.CanExecute(null))
                _vm.SendCommand.Execute(null);

            e.Handled = true;
        }
    }

    private void Window_PreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.B || Keyboard.Modifiers != ModifierKeys.Control)
            return;

        SetSidebarOpen(!_sidebarOpen);
        e.Handled = true;
    }

    private void Window_PreviewMouseDown(object sender, MouseButtonEventArgs e)
    {
        if (_vm.IsModelMenuOpen
            && !ModelMenuButton.IsMouseOver
            && !ModelMenuSurface.IsMouseOver
            && !ModelFlyoutPopup.IsMouseOver
            && !ReasoningFlyoutPopup.IsMouseOver)
        {
            _vm.IsModelMenuOpen = false;
        }
    }

    private void Window_Deactivated(object? sender, EventArgs e)
    {
        _vm.IsModelMenuOpen = false;
    }

    private void TitleBar_MouseRightButtonUp(object sender, MouseButtonEventArgs e)
    {
        if (e.OriginalSource is DependencyObject source
            && FindVisualAncestor<ButtonBase>(source) is not null)
        {
            return;
        }

        SystemCommands.ShowSystemMenu(this, PointToScreen(e.GetPosition(this)));
        e.Handled = true;
    }

    private void ModelFlyoutRow_MouseEnter(object sender, MouseEventArgs e)
    {
        CancelFlyoutClose();
        ReasoningFlyoutPopup.IsOpen = false;
        ModelFlyoutPopup.IsOpen = true;
    }

    private void ReasoningFlyoutRow_MouseEnter(object sender, MouseEventArgs e)
    {
        CancelFlyoutClose();
        ModelFlyoutPopup.IsOpen = false;
        ReasoningFlyoutPopup.IsOpen = true;
    }

    private void ModelFlyout_MouseLeave(object sender, MouseEventArgs e)
        => ScheduleFlyoutClose(ModelFlyoutPopup);

    private void ReasoningFlyout_MouseLeave(object sender, MouseEventArgs e)
        => ScheduleFlyoutClose(ReasoningFlyoutPopup);

    private void FlyoutSurface_MouseEnter(object sender, MouseEventArgs e)
        => CancelFlyoutClose();

    private void ScheduleFlyoutClose(Popup popup)
    {
        _pendingFlyoutClose = popup;
        _flyoutCloseTimer.Stop();
        _flyoutCloseTimer.Start();
    }

    private void CancelFlyoutClose()
    {
        _flyoutCloseTimer.Stop();
        _pendingFlyoutClose = null;
    }

    private void FlyoutCloseTimer_Tick(object? sender, EventArgs e)
    {
        _flyoutCloseTimer.Stop();
        if (_pendingFlyoutClose is not null)
            _pendingFlyoutClose.IsOpen = false;
        _pendingFlyoutClose = null;
    }

    private void ModelMenuPopup_Closed(object? sender, EventArgs e)
    {
        CancelFlyoutClose();
        ModelFlyoutPopup.IsOpen = false;
        ReasoningFlyoutPopup.IsOpen = false;
    }

    private void ConversationTurnMarker_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { DataContext: ConversationTurnItem turn })
            return;

        StopChatScrollAnimation();
        ChatBox.ScrollIntoView(turn.Anchor);
        Dispatcher.BeginInvoke(DispatcherPriority.ContextIdle, () =>
        {
            if (ChatBox.ItemContainerGenerator.ContainerFromItem(turn.Anchor) is not ListBoxItem item)
                return;

            ChatBox.UpdateLayout();
            var scrollViewer = _chatScrollViewer ??= FindVisualChild<ScrollViewer>(ChatBox);
            if (scrollViewer is null)
            {
                item.BringIntoView();
                return;
            }

            var itemTop = item.TranslatePoint(new Point(0, 0), scrollViewer).Y;
            var targetOffset = Math.Clamp(
                scrollViewer.VerticalOffset + itemTop - ChatBox.Padding.Top,
                0,
                scrollViewer.ScrollableHeight);
            scrollViewer.ScrollToVerticalOffset(targetOffset);
            _chatScrollTargetOffset = targetOffset;
        });
    }

    private void ToggleSidebar_Click(object sender, RoutedEventArgs e)
        => SetSidebarOpen(!_sidebarOpen);

    private void SetSidebarOpen(bool isOpen)
    {
        _sidebarOpen = isOpen;
        var targetWidth = isOpen ? SidebarOpenWidth : SidebarCollapsedWidth;
        var animationVersion = ++_sidebarAnimationVersion;
        var currentWidth = SidebarSurface.ActualWidth;

        if (isOpen)
        {
            SidebarSurface.Visibility = Visibility.Visible;
            SidebarSurface.IsHitTestVisible = true;
        }

        SeparatorColumn.Width = new GridLength(isOpen ? 1 : 0);

        SidebarSurface.BeginAnimation(WidthProperty, null);
        SidebarSurface.Width = currentWidth;

        var widthAnimation = new DoubleAnimation(
            currentWidth,
            targetWidth,
            TimeSpan.FromMilliseconds(200))
        {
            EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut }
        };
        widthAnimation.Completed += (_, _) =>
        {
            if (animationVersion != _sidebarAnimationVersion)
                return;

            SidebarSurface.BeginAnimation(WidthProperty, null);
            SidebarSurface.Width = targetWidth;
            if (!isOpen)
            {
                SidebarSurface.IsHitTestVisible = false;
                SidebarSurface.Visibility = Visibility.Collapsed;
            }
        };
        SidebarSurface.BeginAnimation(WidthProperty, widthAnimation);

        SidebarToggleButton.ToolTip = isOpen ? "收起边栏  Ctrl+B" : "展开边栏  Ctrl+B";
    }

    private void Minimize_Click(object sender, RoutedEventArgs e)
        => SystemCommands.MinimizeWindow(this);

    private void Maximize_Click(object sender, RoutedEventArgs e)
    {
        if (WindowState == WindowState.Maximized)
            SystemCommands.RestoreWindow(this);
        else
            SystemCommands.MaximizeWindow(this);
    }

    private void OnComposerSizeChanged(object sender, SizeChangedEventArgs e)
    {
        // Keep the scrollable chat area clear of the floating composer: the
        // bottom padding follows its actual height, so content scrolls right
        // up to the composer's top edge instead of behind a dead band.
        var bottom = ComposerSurface.ActualHeight + 18;
        ChatBox.Padding = new Thickness(0, 22, 0, bottom);
    }

    private void Close_Click(object sender, RoutedEventArgs e)
    {
        SystemCommands.CloseWindow(this);
    }

    private static T? FindVisualAncestor<T>(DependencyObject source)
        where T : DependencyObject
    {
        DependencyObject? current = source;
        while (current is not null)
        {
            if (current is T match)
                return match;

            current = VisualTreeHelper.GetParent(current);
        }

        return null;
    }
}

public sealed class InverseBoolConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, System.Globalization.CultureInfo culture)
        => value is true ? false : true;

    public object ConvertBack(object value, Type targetType, object parameter, System.Globalization.CultureInfo culture)
        => value is true ? false : true;
}

public sealed class ContextUsageDashArrayConverter : IValueConverter
{
    // 20x20 ellipse with a 2px stroke: center radius is (20-2)/2 = 9.
    private const double StrokeRadius = 9;
    private const double Circumference = 2 * Math.PI * StrokeRadius;
    // A single dash pair with a huge gap draws exactly one arc; any finite
    // second dash would paint a second arc and break the progress reading.
    private const double HugeGap = 100_000;

    public object Convert(
        object value,
        Type targetType,
        object parameter,
        System.Globalization.CultureInfo culture)
    {
        var percentage = value is double number ? Math.Clamp(number, 0, 100) : 0;
        var used = Circumference * percentage / 100d;
        var dash = Math.Max(0.01, Math.Min(used, Circumference));
        return new DoubleCollection { dash, HugeGap };
    }

    public object ConvertBack(
        object value,
        Type targetType,
        object parameter,
        System.Globalization.CultureInfo culture)
        => throw new NotSupportedException();
}

public sealed class ValuesEqualConverter : IMultiValueConverter
{
    public object Convert(
        object[] values,
        Type targetType,
        object parameter,
        System.Globalization.CultureInfo culture)
    {
        var areEqual = values.Length >= 2 && Equals(values[0], values[1]);
        return string.Equals(parameter?.ToString(), "Visibility", StringComparison.OrdinalIgnoreCase)
            ? areEqual ? Visibility.Visible : Visibility.Collapsed
            : areEqual;
    }

    public object[] ConvertBack(
        object value,
        Type[] targetTypes,
        object parameter,
        System.Globalization.CultureInfo culture)
        => throw new NotSupportedException();
}

public sealed class ConversationWidthConverter : IValueConverter
{
    private const double ExpandedSidebarFootprint = 281;

    internal static double ContentWidth(double availableWidth) => availableWidth switch
    {
        < 500 => Math.Max(240, availableWidth - 48),
        < 900 => Math.Clamp(availableWidth - 80, 400, 680),
        < 1400 => Math.Clamp(availableWidth - 100, 480, 880),
        _ => Math.Clamp(availableWidth - 120, 560, 920)
    };

    public object Convert(
        object value,
        Type targetType,
        object parameter,
        System.Globalization.CultureInfo culture)
    {
        var availableWidth = value is double number ? number : 820d;
        var mode = parameter?.ToString();
        if (string.Equals(mode, "composer", StringComparison.OrdinalIgnoreCase))
        {
            // Base the composer on the full window minus the expanded sidebar,
            // so toggling the sidebar cannot stretch or squeeze the input.
            return ContentWidth(Math.Max(0, availableWidth - ExpandedSidebarFootprint));
        }

        var contentWidth = ContentWidth(availableWidth);
        if (string.Equals(mode, "rail", StringComparison.OrdinalIgnoreCase))
        {
            return contentWidth + 34;
        }

        if (string.Equals(mode, "user", StringComparison.OrdinalIgnoreCase))
        {
            var minimum = Math.Min(220d, contentWidth);
            var maximum = Math.Min(640d, contentWidth);
            return Math.Clamp(contentWidth * 0.68d, minimum, maximum);
        }

        return contentWidth;
    }

    public object ConvertBack(
        object value,
        Type targetType,
        object parameter,
        System.Globalization.CultureInfo culture)
        => throw new NotSupportedException();
}

// Width of the left gutter: half of the empty space between the centered
// content column and the chat area edge, where the turn markers float.
public sealed class GutterWidthConverter : IValueConverter
{
    public object Convert(
        object value,
        Type targetType,
        object parameter,
        System.Globalization.CultureInfo culture)
    {
        var availableWidth = value is double number ? number : 820d;
        var contentWidth = ConversationWidthConverter.ContentWidth(availableWidth);
        return Math.Clamp((availableWidth - contentWidth) / 2d, 0, 320);
    }

    public object ConvertBack(
        object value,
        Type targetType,
        object parameter,
        System.Globalization.CultureInfo culture)
        => throw new NotSupportedException();
}

// Vertical extent of the turn-marker gutter: top inset plus the floating
// composer's footprint, so markers never sit under the input surface.
public sealed class GutterMarginConverter : IValueConverter
{
    public object Convert(
        object value,
        Type targetType,
        object parameter,
        System.Globalization.CultureInfo culture)
    {
        var composerHeight = value is double number ? number : 90d;
        return new Thickness(0, 22, 0, composerHeight + 18);
    }

    public object ConvertBack(
        object value,
        Type targetType,
        object parameter,
        System.Globalization.CultureInfo culture)
        => throw new NotSupportedException();
}
