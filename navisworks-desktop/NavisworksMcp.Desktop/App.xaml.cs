using System.Windows;
using System.Windows.Data;
using System.Windows.Media;
using Microsoft.Win32;
using NavisworksMcp.Desktop.Runtime;

namespace NavisworksMcp.Desktop;

public partial class App : Application
{
    public bool UsesLightTheme { get; private set; } = true;
    public event EventHandler? ThemeChanged;

    protected override void OnStartup(StartupEventArgs e)
    {
        ApplySystemTheme();
        Resources.MergedDictionaries.Add(new ResourceDictionary
        {
            Source = new Uri("Themes/DarkTheme.xaml", UriKind.Relative)
        });

        base.OnStartup(e);

        try
        {
            var appDataPathProvider = AppDataPathProviderFactory.Create(e.Args);
            var runtimeContext = ApplicationRuntimeContext.Create(appDataPathProvider);
            runtimeContext.WriteStartupLog();

            var mainWindow = new MainWindow(runtimeContext);
            MainWindow = mainWindow;
            mainWindow.Show();
        }
        catch (Exception ex) when (ex is ArgumentException
                                   or IOException
                                   or UnauthorizedAccessException
                                   or NotSupportedException)
        {
            MessageBox.Show(
                $"无法初始化桌面端数据目录。\n\n{ex.Message}",
                "Navisworks MCP 启动失败",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            Shutdown(-1);
        }
    }

    internal void RefreshSystemTheme()
        => Dispatcher.BeginInvoke(ApplySystemTheme);

    private void ApplySystemTheme()
    {
        var isLight = SystemUsesLightTheme();
        var themeChanged = UsesLightTheme != isLight;
        UsesLightTheme = isLight;
        var palette = isLight
            ? new (string Key, string Color)[]
            {
                ("BackgroundBrush", "#FAFAFA"),
                ("SidebarBrush", "#F3F3F3"),
                ("SurfaceBrush", "#FFFFFF"),
                ("SurfaceHoverBrush", "#E8E8E8"),
                ("ComposerBrush", "#F0F0F0"),
                ("ComposerControlBrush", "#E3E3E3"),
                ("ToolSurfaceBrush", "#EEF5EF"),
                ("BorderBrush", "#E0E0E0"),
                ("BorderStrongBrush", "#CFCFCF"),
                ("TextPrimaryBrush", "#202020"),
                ("TextSecondaryBrush", "#555555"),
                ("TextMutedBrush", "#7A7A7A"),
                ("AccentBrush", "#333333"),
                ("AccentDarkBrush", "#C8C8C8"),
                ("AccentMutedBrush", "#E6E6E6"),
                ("SuccessBrush", "#268A5C"),
                ("WarningBrush", "#9B6900"),
                ("ErrorBrush", "#C83F49"),
                ("ErrorMutedBrush", "#FBE8EA"),
                ("ScrollThumbBrush", "#A8A8A8"),
                ("ScrollThumbHoverBrush", "#858585")
            }
            : new (string Key, string Color)[]
            {
                ("BackgroundBrush", "#171717"),
                ("SidebarBrush", "#1D1D1D"),
                ("SurfaceBrush", "#222222"),
                ("SurfaceHoverBrush", "#2B2B2B"),
                ("ComposerBrush", "#252525"),
                ("ComposerControlBrush", "#333333"),
                ("ToolSurfaceBrush", "#202620"),
                ("BorderBrush", "#2F2F2F"),
                ("BorderStrongBrush", "#3B3B3B"),
                ("TextPrimaryBrush", "#ECECEC"),
                ("TextSecondaryBrush", "#B5B5B5"),
                ("TextMutedBrush", "#858585"),
                ("AccentBrush", "#DADADA"),
                ("AccentDarkBrush", "#404040"),
                ("AccentMutedBrush", "#2C2C2C"),
                ("SuccessBrush", "#5DD39E"),
                ("WarningBrush", "#E6B85C"),
                ("ErrorBrush", "#F17A7A"),
                ("ErrorMutedBrush", "#352023"),
                ("ScrollThumbBrush", "#686868"),
                ("ScrollThumbHoverBrush", "#8A8A8A")
            };

        foreach (var (key, colorText) in palette)
        {
            var color = (Color)ColorConverter.ConvertFromString(colorText);
            Resources[key] = new SolidColorBrush(color);
        }

        if (themeChanged)
            ThemeChanged?.Invoke(this, EventArgs.Empty);
    }

    private static bool SystemUsesLightTheme()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return key?.GetValue("AppsUseLightTheme") is not int value || value != 0;
        }
        catch
        {
            return true;
        }
    }
}

public sealed class BoolToVisibilityConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, System.Globalization.CultureInfo culture)
    {
        return value is true ? Visibility.Visible : Visibility.Collapsed;
    }

    public object ConvertBack(object value, Type targetType, object parameter, System.Globalization.CultureInfo culture)
    {
        return value is Visibility v && v == Visibility.Visible;
    }
}
