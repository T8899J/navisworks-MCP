using System.Windows;
using System.Windows.Controls;

namespace NavisworksMcp.Desktop.Controls;

/// <summary>
/// Keeps one message's content and utility actions in the same layout boundary.
/// The control template owns hover/focus visibility so action placement cannot
/// accidentally depend on a Grid inside the rendered message body.
/// </summary>
public sealed class MessageShell : ContentControl
{
    public static readonly DependencyProperty ActionsProperty = DependencyProperty.Register(
        nameof(Actions),
        typeof(object),
        typeof(MessageShell),
        new FrameworkPropertyMetadata(null));

    public static readonly DependencyProperty ActionsHorizontalAlignmentProperty = DependencyProperty.Register(
        nameof(ActionsHorizontalAlignment),
        typeof(HorizontalAlignment),
        typeof(MessageShell),
        new FrameworkPropertyMetadata(HorizontalAlignment.Left));

    public static readonly DependencyProperty ActionsMarginProperty = DependencyProperty.Register(
        nameof(ActionsMargin),
        typeof(Thickness),
        typeof(MessageShell),
        new FrameworkPropertyMetadata(new Thickness(0, 3, 0, 0)));

    public object? Actions
    {
        get => GetValue(ActionsProperty);
        set => SetValue(ActionsProperty, value);
    }

    public HorizontalAlignment ActionsHorizontalAlignment
    {
        get => (HorizontalAlignment)GetValue(ActionsHorizontalAlignmentProperty);
        set => SetValue(ActionsHorizontalAlignmentProperty, value);
    }

    public Thickness ActionsMargin
    {
        get => (Thickness)GetValue(ActionsMarginProperty);
        set => SetValue(ActionsMarginProperty, value);
    }
}
