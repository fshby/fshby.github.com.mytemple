using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Text;
using System.Windows.Forms;
using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class MyTempleLauncher
{
    private const string AppName = "MyTempleKnowledge";
    private const string AppTitle = "MyTemple Knowledge";
    private const string MutexName = "MyTempleKnowledge.SingleInstance";
    private const int DefaultPort = 4173;
        private const string UpdateUrl = "https://mytemple.fshby.cc/version.json";
    private const string WindowProfileFolder = "launcher-profile";

    [STAThread]
    private static void Main(string[] args)
    {
        EnableHighDpi();
        bool createdNew;
        using (var mutex = new Mutex(true, MutexName, out createdNew))
        {
            if (!createdNew)
            {
                MessageBox.Show("MyTemple Knowledge is already running.", AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.ThreadException += HandleThreadException;
            AppDomain.CurrentDomain.UnhandledException += HandleUnhandledException;

            using (var context = new LauncherContext())
            {
                Application.Run(context);
            }
        }
    }

    private static void EnableHighDpi()
    {
        // Per-monitor V2 prevents Windows from bitmap-scaling the entire WebView2
        // surface on 125%/150% displays, which otherwise makes all text appear soft.
        try
        {
            SetProcessDpiAwarenessContext(new IntPtr(-4));
            return;
        }
        catch { }

        try { SetProcessDPIAware(); } catch { }
    }

    [DllImport("user32.dll")]
    private static extern IntPtr SetProcessDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    private static void HandleThreadException(object sender, ThreadExceptionEventArgs e)
    {
        LauncherContext.WriteGlobalLog("error", "UI exception: " + e.Exception);
        MessageBox.Show(e.Exception.Message, AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    private static void HandleUnhandledException(object sender, UnhandledExceptionEventArgs e)
    {
        Exception ex = e.ExceptionObject as Exception;
        LauncherContext.WriteGlobalLog("error", "Fatal exception: " + (ex == null ? "unknown" : ex.ToString()));
    }

    private sealed class LauncherContext : ApplicationContext
    {
        private readonly string installDir;
        private readonly string dataDir;
        private readonly string logDir;
        private readonly string serverScript;
        private readonly string nodePath;
        private string appUrl;
        private readonly NotifyIcon trayIcon;
        private readonly System.Windows.Forms.Timer watchdogTimer;
        private readonly object gate = new object();
        private readonly object logGate = new object();
        private Process nodeProcess;
        private Form mainWindow;
        private WebView2 webView;
        private volatile bool shuttingDown;
        private volatile bool restarting;
        private int port;
        private int uiThreadId;
        private SynchronizationContext uiContext;
        private string currentVersion = "1.0.0";
        private int startupUpdateCheckStarted;
        private int updateCheckRunning;

        public LauncherContext()
        {
            uiThreadId = Thread.CurrentThread.ManagedThreadId;
            uiContext = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
            installDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            if (string.IsNullOrWhiteSpace(installDir))
            {
                installDir = AppDomain.CurrentDomain.BaseDirectory;
            }

            dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), AppName + "Data");
            logDir = Path.Combine(dataDir, "logs");
            serverScript = Path.Combine(installDir, "server.js");
            nodePath = ResolveNodePath();
            Directory.CreateDirectory(dataDir);
            Directory.CreateDirectory(logDir);
            Directory.CreateDirectory(Path.Combine(dataDir, "source"));
            Directory.CreateDirectory(Path.Combine(dataDir, WindowProfileFolder));
            EnsureSeedData();
            LoadCurrentVersion();
            ClearWebView2CacheIfVersionChanged();

            WriteLog("info", "Launcher starting. version=" + currentVersion);

            if (string.IsNullOrWhiteSpace(nodePath))
            {
                MessageBox.Show("Node.js was not found. Please install Node.js 18+ first.", AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
                ExitThread();
                return;
            }

            if (!File.Exists(serverScript))
            {
                MessageBox.Show("server.js was not found in the installation directory.", AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
                ExitThread();
                return;
            }

            port = FindAvailablePort();
            appUrl = BuildAppUrl(port);
            StartNodeServer();
            WaitForServerReady();
            trayIcon = CreateTrayIcon();
            watchdogTimer = new System.Windows.Forms.Timer();
            watchdogTimer.Interval = 2500;
            watchdogTimer.Tick += WatchdogTick;
            watchdogTimer.Start();
            LaunchBrowserWindow();
        }

        protected override void ExitThreadCore()
        {
            shuttingDown = true;
            try
            {
                if (watchdogTimer != null)
                {
                    watchdogTimer.Stop();
                    watchdogTimer.Dispose();
                }
            }
            catch { }
            CloseBrowserWindow();
            StopNodeServer();
            if (trayIcon != null)
            {
                trayIcon.Visible = false;
                trayIcon.Dispose();
            }
            WriteLog("info", "Launcher stopped.");
            base.ExitThreadCore();
        }

        private NotifyIcon CreateTrayIcon()
        {
            var menu = new ContextMenuStrip();
            menu.Items.Add("Open window", null, delegate { LaunchBrowserWindow(); });
            menu.Items.Add("Open logs", null, delegate { OpenFolder(logDir); });
            menu.Items.Add("Restart server", null, delegate { RestartAll(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Check updates", null, delegate { ThreadPool.QueueUserWorkItem(delegate { SafeCheckForUpdates(true); }); });
            menu.Items.Add("Exit", null, delegate { ExitThread(); });

            var icon = new NotifyIcon();
            icon.Icon = ExtractIcon();
            icon.Text = AppTitle;
            icon.Visible = true;
            icon.ContextMenuStrip = menu;
            icon.DoubleClick += delegate { LaunchBrowserWindow(); };
            return icon;
        }

        private Icon ExtractIcon()
        {
            try
            {
                string iconPath = Path.Combine(installDir, "logo1.ico");
                if (!File.Exists(iconPath)) iconPath = Path.Combine(installDir, "logo.ico");
                if (File.Exists(iconPath))
                {
                    return new Icon(iconPath);
                }
            }
            catch { }
            return SystemIcons.Application;
        }

        private void LoadCurrentVersion()
        {
            try
            {
                string versionPath = Path.Combine(installDir, "version.json");
                if (!File.Exists(versionPath)) return;
                string json = File.ReadAllText(versionPath);
                string parsed = ParseJsonString(json, "version");
                if (!string.IsNullOrWhiteSpace(parsed))
                {
                    currentVersion = parsed;
                }
            }
            catch (Exception ex)
            {
                WriteLog("warn", "Failed to load version metadata: " + ex.Message);
            }
        }

        private void ClearWebView2CacheIfVersionChanged()
        {
            try
            {
                string versionStampPath = Path.Combine(dataDir, ".webview-version");
                string storedVersion = File.Exists(versionStampPath)
                    ? File.ReadAllText(versionStampPath).Trim()
                    : "";
                if (storedVersion == currentVersion) return;

                // 仅清理 HTTP/Service Worker 缓存子目录，保留 Local Storage / IndexedDB / Cookies，
                // 避免版本升级时清空用户习惯（主题、字体、缩放、最近文档、AI 设置、图片主题背景等）。
                string webviewProfile = Path.Combine(dataDir, WindowProfileFolder, "webview2");
                if (Directory.Exists(webviewProfile))
                {
                    WriteLog("info", "Clearing WebView2 HTTP cache only (preserving user data) due to version change (" + storedVersion + " -> " + currentVersion + ").");
                    string[] cacheSubDirs = System.IO.Directory.GetDirectories(webviewProfile, "*", System.IO.SearchOption.AllDirectories);
                    foreach (string sub in cacheSubDirs)
                    {
                        string name = System.IO.Path.GetFileName(sub);
                        if (name.IndexOf("Cache", StringComparison.OrdinalIgnoreCase) >= 0
                            || name.IndexOf("Service Worker", StringComparison.OrdinalIgnoreCase) >= 0
                            || name.IndexOf("GPUCache", StringComparison.OrdinalIgnoreCase) >= 0
                            || name.IndexOf("Code Cache", StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            DeleteDirectorySafe(sub);
                        }
                    }
                }
                File.WriteAllText(versionStampPath, currentVersion ?? "");
            }
            catch (Exception ex)
            {
                WriteLog("warn", "Failed to clear WebView2 cache: " + ex.Message);
            }
        }

        private void DeleteDirectorySafe(string path)
        {
            try
            {
                foreach (string file in Directory.GetFiles(path, "*", SearchOption.AllDirectories))
                {
                    try { File.SetAttributes(file, FileAttributes.Normal); File.Delete(file); } catch { }
                }
                Directory.Delete(path, true);
            }
            catch { }
        }

        private void EnsureSeedData()
        {
            string installedDocs = Path.Combine(installDir, "docs");
            string userDocs = Path.Combine(dataDir, "docs");
            if (Directory.Exists(userDocs)) return;
            if (Directory.Exists(installedDocs))
            {
                CopyDirectory(installedDocs, userDocs);
                return;
            }
            Directory.CreateDirectory(userDocs);
        }

        private void CopyDirectory(string source, string destination)
        {
            Directory.CreateDirectory(destination);
            foreach (string file in Directory.GetFiles(source))
            {
                File.Copy(file, Path.Combine(destination, Path.GetFileName(file)), true);
            }
            foreach (string directory in Directory.GetDirectories(source))
            {
                CopyDirectory(directory, Path.Combine(destination, Path.GetFileName(directory)));
            }
        }

        private string ResolveNodePath()
        {
            string[] candidates =
            {
                "node.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"),
                @"C:\Program Files\nodejs\node.exe",
                @"D:\node\node.exe"
            };

            foreach (string candidate in candidates)
            {
                try
                {
                    var psi = new ProcessStartInfo(candidate, "--version");
                    psi.UseShellExecute = false;
                    psi.CreateNoWindow = true;
                    psi.RedirectStandardOutput = true;
                    using (var process = Process.Start(psi))
                    {
                        if (process != null && process.WaitForExit(3000) && process.ExitCode == 0)
                        {
                            return candidate;
                        }
                    }
                }
                catch { }
            }
            return string.Empty;
        }

        private string ResolveBrowserPath()
        {
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string[] candidates =
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(localAppData, "Google", "Chrome", "Application", "chrome.exe")
            };

            foreach (string candidate in candidates)
            {
                if (File.Exists(candidate)) return candidate;
            }
            return string.Empty;
        }

        private int FindAvailablePort()
        {
            for (int candidate = DefaultPort; candidate < DefaultPort + 100; candidate++)
            {
                try
                {
                    var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, candidate);
                    listener.Start();
                    listener.Stop();
                    return candidate;
                }
                catch { }
            }
            return DefaultPort;
        }

        private string BuildAppUrl(int value)
        {
            return "http://127.0.0.1:" + value + "/";
        }

        private void StartNodeServer()
        {
            lock (gate)
            {
                if (nodeProcess != null && !nodeProcess.HasExited) return;
                appUrl = BuildAppUrl(port);

                var psi = new ProcessStartInfo(nodePath, "--max-old-space-size=384 --expose-gc \"" + serverScript + "\"");
                psi.WorkingDirectory = installDir;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = Encoding.UTF8;
                psi.StandardErrorEncoding = Encoding.UTF8;
                psi.EnvironmentVariables["PORT"] = port.ToString();
                psi.EnvironmentVariables["HOST"] = "127.0.0.1";
                psi.EnvironmentVariables["DATA_DIR"] = dataDir;
                psi.EnvironmentVariables["MYTEMPLE_DATA_ROOT"] = dataDir;
                psi.EnvironmentVariables["NODE_ENV"] = "production";

                var process = new Process();
                process.StartInfo = psi;
                process.EnableRaisingEvents = true;
                process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
                {
                    if (!string.IsNullOrWhiteSpace(e.Data))
                    {
                        WriteLog("info", "[node] " + e.Data);
                    }
                };
                process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
                {
                    if (!string.IsNullOrWhiteSpace(e.Data))
                    {
                        WriteLog("warn", "[node] " + e.Data);
                    }
                };
                process.Exited += delegate
                {
                    WriteLog("warn", "Node process exited.");
                };

                if (!process.Start())
                {
                    throw new InvalidOperationException("Failed to start node server.");
                }
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                nodeProcess = process;
                WriteLog("info", "Node server started on port " + port + ", pid=" + process.Id);
            }
        }

        private void WaitForServerReady()
        {
            Exception lastError = null;
            DateTime deadline = DateTime.Now.AddSeconds(25);
            while (DateTime.Now < deadline)
            {
                if (nodeProcess != null && nodeProcess.HasExited)
                {
                    throw new InvalidOperationException("Node server exited during startup.");
                }
                try
                {
                    var request = (HttpWebRequest)WebRequest.Create(appUrl);
                    request.Method = "GET";
                    request.Timeout = 1200;
                    request.ReadWriteTimeout = 1200;
                    using (var response = (HttpWebResponse)request.GetResponse())
                    {
                        if ((int)response.StatusCode >= 200 && (int)response.StatusCode < 500)
                        {
                            return;
                        }
                    }
                }
                catch (Exception ex)
                {
                    lastError = ex;
                    Thread.Sleep(250);
                }
            }
            throw new TimeoutException("Node server did not become ready. " + (lastError == null ? string.Empty : lastError.Message));
        }

        private void LaunchBrowserWindow()
        {
            if (Thread.CurrentThread.ManagedThreadId != uiThreadId)
            {
                uiContext.Post(delegate { LaunchBrowserWindow(); }, null);
                return;
            }
            lock (gate)
            {
                if (mainWindow != null)
                {
                    if (mainWindow.WindowState == FormWindowState.Minimized) mainWindow.WindowState = FormWindowState.Normal;
                    mainWindow.Show();
                    mainWindow.BringToFront();
                    return;
                }

                Rectangle screenRect = Screen.PrimaryScreen.WorkingArea;
                int winW = Math.Min(1280, screenRect.Width - 40);
                int winH = Math.Min(860, screenRect.Height - 40);
                int winX = screenRect.X + (screenRect.Width - winW) / 2;
                int winY = screenRect.Y + (screenRect.Height - winH) / 2;

                var formBg = Color.FromArgb(37, 40, 39);
                mainWindow = new AppForm
                {
                    Text = AppTitle,
                    Icon = ExtractIcon(),
                    StartPosition = FormStartPosition.Manual,
                    Location = new Point(winX, winY),
                    Size = new Size(winW, winH),
                    MinimumSize = new Size(640, 480),
                    BackColor = formBg,
                    FormBorderStyle = FormBorderStyle.Sizable,
                    ShowInTaskbar = true,
                };
                // splashBox 只负责遮住 WebView2 的初始化空白，首个页面完成后立即隐藏。
                // 不能把开机图长期留在 WebView2 后面，否则窗口快速缩放时 GPU 重绘间隙
                // 会把开机图重新合成出来，造成主题背景穿帮。
                var splashBox = new PictureBox
                {
                    Dock = DockStyle.None,
                    SizeMode = PictureBoxSizeMode.Zoom,
                    BackColor = formBg,
                    CausesValidation = false,
                };
                try
                {
                    string logoPath = Path.Combine(installDir, "boot.png");
                    if (!File.Exists(logoPath)) logoPath = Path.Combine(installDir, "logo.png");
                    if (File.Exists(logoPath)) splashBox.Image = Image.FromFile(logoPath);
                }
                catch { }
                mainWindow.Controls.Add(splashBox);
                splashBox.BringToFront();
                splashBox.Bounds = mainWindow.ClientRectangle;

                webView = new WebView2 { Dock = DockStyle.Fill, CreationProperties = null, BackColor = formBg };
                mainWindow.Controls.Add(webView);
                webView.BringToFront();
                splashBox.BringToFront();

                // Resize 防抖：窗口拖拽过程中每帧都触发 Resize，Chromium 无法跟上。
                // 原生图层只在启动期间存在，后续缩放不会再次显示开机图。
                System.Windows.Forms.Timer resizeDebouncer = null;
                mainWindow.Resize += delegate
                {
                    if (splashBox != null && !splashBox.IsDisposed && splashBox.Visible)
                    {
                        splashBox.Bounds = mainWindow.ClientRectangle;
                        splashBox.Invalidate();
                    }
                    if (resizeDebouncer == null)
                    {
                        resizeDebouncer = new System.Windows.Forms.Timer { Interval = 150 };
                        resizeDebouncer.Tick += (st, ev) =>
                        {
                            resizeDebouncer.Stop();
                            if (webView != null && !webView.IsDisposed && webView.Handle != IntPtr.Zero)
                            {
                                mainWindow.SuspendLayout();
                                webView.PerformLayout();
                                webView.Invalidate();
                                mainWindow.ResumeLayout();
                            }
                        };
                    }
                    resizeDebouncer.Stop();
                    resizeDebouncer.Start();
                };
                mainWindow.SizeChanged += delegate
                {
                    if (mainWindow.WindowState == FormWindowState.Minimized) return;
                    if (splashBox != null && !splashBox.IsDisposed && splashBox.Visible)
                    {
                        splashBox.Bounds = mainWindow.ClientRectangle;
                        splashBox.Invalidate();
                    }
                };

                mainWindow.FormClosing += delegate(object sender, FormClosingEventArgs args)
                {
                    if (!shuttingDown)
                    {
                        args.Cancel = true;
                        mainWindow.Hide();
                    }
                };
                mainWindow.Show();
                InitializeWebViewAsync(splashBox, formBg);
            }
        }

        private async void InitializeWebViewAsync(PictureBox splashBox, Color formBg)
        {
            try
            {
                string profile = Path.Combine(dataDir, WindowProfileFolder, "webview2", Process.GetCurrentProcess().Id.ToString());
                Directory.CreateDirectory(profile);
                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, profile);
                await webView.EnsureCoreWebView2Async(environment);
                webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
                webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                // WebView2 使用与窗体一致的纯色底，避免启动图隐藏后露出黑底。
                webView.DefaultBackgroundColor = formBg;
                webView.ZoomFactor = 1.0;
                webView.CoreWebView2.NavigationCompleted += delegate
                {
                    if (splashBox == null || splashBox.IsDisposed) return;
                    splashBox.Visible = false;
                    splashBox.Dispose();
                    if (Interlocked.Exchange(ref startupUpdateCheckStarted, 1) == 0)
                    {
                        ThreadPool.QueueUserWorkItem(delegate
                        {
                            Thread.Sleep(1200);
                            SafeCheckForUpdates(false);
                        });
                    }
                };
                webView.CoreWebView2.Navigate(appUrl);
                WriteLog("info", "WebView2 native window started.");
            }
            catch (Exception ex)
            {
                WriteLog("error", "WebView2 initialization failed: " + ex);
                if (splashBox != null && !splashBox.IsDisposed)
                {
                    splashBox.Visible = false;
                }
                MessageBox.Show("WebView2 初始化失败，请安装 Microsoft Edge WebView2 Runtime。" + Environment.NewLine + ex.Message, AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
                CloseBrowserWindow();
            }
        }

        private void CloseBrowserWindow()
        {
            try
            {
                if (webView != null) webView.Dispose();
                if (mainWindow != null) mainWindow.Dispose();
            }
            catch { }
            finally { webView = null; mainWindow = null; }
        }

        private void StopNodeServer()
        {
            lock (gate)
            {
                if (nodeProcess == null) return;
                try
                {
                    if (!nodeProcess.HasExited)
                    {
                        nodeProcess.Kill();
                        nodeProcess.WaitForExit(2000);
                    }
                }
                catch { }
                finally
                {
                    try { nodeProcess.Dispose(); } catch { }
                    nodeProcess = null;
                }
            }
        }

        private void RestartAll()
        {
            if (restarting || shuttingDown) return;
            restarting = true;
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    WriteLog("info", "Manual restart requested.");
                    CloseBrowserWindow();
                    StopNodeServer();
                    port = FindAvailablePort();
                    appUrl = BuildAppUrl(port);
                    StartNodeServer();
                    WaitForServerReady();
                    LaunchBrowserWindow();
                }
                catch (Exception ex)
                {
                    WriteLog("error", "Restart failed: " + ex);
                    MessageBox.Show(ex.Message, AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                finally
                {
                    restarting = false;
                }
            });
        }

        private void WatchdogTick(object sender, EventArgs e)
        {
            if (shuttingDown || restarting) return;

            string requestPath = Path.Combine(dataDir, "update-check-request.txt");
            if (File.Exists(requestPath))
            {
                try { File.Delete(requestPath); } catch { }
                ThreadPool.QueueUserWorkItem(delegate { SafeCheckForUpdates(true); });
            }

            if (nodeProcess == null || nodeProcess.HasExited)
            {
                RestartAll();
                return;
            }
        }

        private void SafeCheckForUpdates(bool force)
        {
            if (Interlocked.Exchange(ref updateCheckRunning, 1) == 1) return;
            try
            {
                string lastCheckPath = Path.Combine(dataDir, "last-update-check.txt");
                string deferredPath = Path.Combine(dataDir, "update-deferred.txt");
                if (!force && File.Exists(lastCheckPath))
                {
                    string[] lastCheckLines = File.ReadAllLines(lastCheckPath);
                    DateTime lastCheck;
                    string checkedVersion = lastCheckLines.Length > 1 ? lastCheckLines[1].Trim() : "";
                    if (DateTime.TryParse(lastCheckLines.Length > 0 ? lastCheckLines[0] : "", out lastCheck)
                        && string.Equals(checkedVersion, currentVersion, StringComparison.OrdinalIgnoreCase))
                    {
                        if ((DateTime.Now - lastCheck).TotalHours < 24)
                        {
                            WriteLog("info", "Update check skipped by 24-hour cache for version " + currentVersion + ".");
                            return;
                        }
                    }
                }

                File.WriteAllText(lastCheckPath, DateTime.Now.ToString("o") + Environment.NewLine + currentVersion);
                string json = DownloadString(UpdateUrl);
                if (string.IsNullOrWhiteSpace(json))
                {
                    WriteLog("warn", "Update check returned no metadata from " + UpdateUrl + ".");
                    return;
                }
                string latestVersion = ParseJsonString(json, "version");
                string downloadUrl = ParseJsonString(json, "downloadUrl");
                if (string.IsNullOrWhiteSpace(latestVersion) || string.IsNullOrWhiteSpace(downloadUrl))
                {
                    WriteLog("warn", "Update metadata is incomplete.");
                    return;
                }
                int comparison = CompareVersions(currentVersion, latestVersion);
                WriteLog("info", "Update check completed. current=" + currentVersion + ", latest=" + latestVersion + ".");
                if (comparison >= 0) return;

                if (!force && File.Exists(deferredPath))
                {
                    string[] deferred = File.ReadAllLines(deferredPath);
                    DateTime deferredAt;
                    string deferredVersion = deferred.Length > 1 ? deferred[1].Trim() : "";
                    if (DateTime.TryParse(deferred.Length > 0 ? deferred[0] : "", out deferredAt)
                        && string.Equals(deferredVersion, latestVersion, StringComparison.OrdinalIgnoreCase)
                        && (DateTime.Now - deferredAt).TotalHours < 24)
                    {
                        WriteLog("info", "Update prompt deferred for 24 hours for version " + latestVersion + ".");
                        return;
                    }
                }

                string releaseNotes = ParseJsonString(json, "latestReleaseNotes");
                if (string.IsNullOrWhiteSpace(releaseNotes)) releaseNotes = ParseJsonString(json, "releaseNotes");
                var result = ShowUpdatePrompt(latestVersion, ParseJsonString(json, "releaseDate"), releaseNotes);

                if (result == DialogResult.Yes)
                {
                    DownloadAndInstallUpdate(downloadUrl, latestVersion);
                }
                else if (result == DialogResult.No)
                {
                    File.WriteAllText(deferredPath, DateTime.Now.ToString("o") + Environment.NewLine + latestVersion);
                    WriteLog("info", "User deferred update " + latestVersion + " for 24 hours.");
                }
            }
            catch (Exception ex)
            {
                WriteLog("warn", "Update check failed: " + ex.Message);
            }
            finally
            {
                Volatile.Write(ref updateCheckRunning, 0);
            }
        }

        private string DownloadString(string url)
        {
            try
            {
                ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
                var request = (HttpWebRequest)WebRequest.Create(url);
                request.Timeout = 10000;
                request.ReadWriteTimeout = 10000;
                using (var response = (HttpWebResponse)request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream()))
                {
                    return reader.ReadToEnd();
                }
            }
            catch
            {
                return null;
            }
        }

        private void OpenExternal(string url)
        {
            try
            {
                Process.Start(url);
            }
            catch
            {
                try
                {
                    var psi = new ProcessStartInfo("cmd.exe", "/c start \"\" \"" + url + "\"");
                    psi.UseShellExecute = false;
                    psi.CreateNoWindow = true;
                    Process.Start(psi);
                }
                catch { }
            }
        }

        private DialogResult ShowUpdatePrompt(string latestVersion, string releaseDate, string releaseNotes)
        {
            DialogResult result = DialogResult.Cancel;
            Action show = delegate
            {
                using (var form = new UpdatePromptForm(AppTitle, currentVersion, latestVersion, releaseDate, releaseNotes, ExtractIcon()))
                {
                    result = form.ShowDialog(mainWindow);
                }
            };
            try
            {
                if (mainWindow != null && !mainWindow.IsDisposed && mainWindow.InvokeRequired) mainWindow.Invoke(show);
                else show();
            }
            catch (Exception ex) { WriteLog("warn", "Update prompt failed: " + ex.Message); }
            return result;
        }

        private void DownloadAndInstallUpdate(string url, string latestVersion)
        {
            string updateDir = Path.Combine(dataDir, "updates");
            Directory.CreateDirectory(updateDir);
            string installerPath = Path.Combine(updateDir, AppName + "_Setup_v" + latestVersion + ".exe");
            try
            {
                bool downloaded = false;
                Action show = delegate
                {
                    using (var form = new UpdateDownloadForm(AppTitle, latestVersion, ExtractIcon()))
                    {
                        form.Shown += delegate
                        {
                            ThreadPool.QueueUserWorkItem(delegate
                            {
                                try
                                {
                                    DownloadFile(url, installerPath, form);
                                    downloaded = true;
                                    form.Complete("下载完成，正在启动安装程序…");
                                }
                                catch (Exception ex)
                                {
                                    try { if (File.Exists(installerPath)) File.Delete(installerPath); } catch { }
                                    form.Fail("下载失败：" + ex.Message);
                                }
                            });
                        };
                        form.ShowDialog(mainWindow);
                    }
                };
                if (mainWindow != null && !mainWindow.IsDisposed && mainWindow.InvokeRequired) mainWindow.Invoke(show); else show();
                if (!downloaded || shuttingDown) return;
                var psi = new ProcessStartInfo(installerPath, "/update") { UseShellExecute = true, WorkingDirectory = updateDir };
                Process.Start(psi);
                WriteLog("info", "Downloaded update installer: " + installerPath);
                if (mainWindow != null && !mainWindow.IsDisposed)
                    mainWindow.BeginInvoke((MethodInvoker)delegate { ExitThread(); });
                else
                    ExitThread();
            }
            catch (Exception ex)
            {
                WriteLog("warn", "Update installation failed: " + ex.Message);
                MessageBox.Show("升级安装启动失败：" + ex.Message, AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void DownloadFile(string url, string targetPath, UpdateDownloadForm form)
        {
            Uri uri = new Uri(url);
            if (uri.Scheme != Uri.UriSchemeHttps || !string.Equals(uri.Host, "mytemple.fshby.cc", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("升级地址不是受信任的官方地址。");
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            var request = (HttpWebRequest)WebRequest.Create(uri);
            request.Timeout = 30000;
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var input = response.GetResponseStream())
            using (var output = File.Create(targetPath))
            {
                long total = response.ContentLength;
                long received = 0;
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    output.Write(buffer, 0, read);
                    received += read;
                    form.Progress(received, total);
                }
            }
        }

        private void OpenFolder(string folder)
        {
            try
            {
                Process.Start("explorer.exe", folder);
            }
            catch
            {
                OpenExternal("file:///" + folder.Replace("\\", "/"));
            }
        }

        private string ParseJsonString(string json, string key)
        {
            if (string.IsNullOrWhiteSpace(json) || string.IsNullOrWhiteSpace(key)) return null;
            string needle = "\"" + key + "\"";
            int keyIndex = json.IndexOf(needle, StringComparison.OrdinalIgnoreCase);
            if (keyIndex < 0) return null;
            int colonIndex = json.IndexOf(':', keyIndex + needle.Length);
            if (colonIndex < 0) return null;
            int startQuote = json.IndexOf('"', colonIndex + 1);
            if (startQuote < 0) return null;
            int endQuote = json.IndexOf('"', startQuote + 1);
            if (endQuote < 0) return null;
            return json.Substring(startQuote + 1, endQuote - startQuote - 1).Trim();
        }

        private int CompareVersions(string left, string right)
        {
            try
            {
                string[] a = left.Split('.');
                string[] b = right.Split('.');
                int count = Math.Max(a.Length, b.Length);
                for (int i = 0; i < count; i++)
                {
                    int av = i < a.Length ? int.Parse(a[i]) : 0;
                    int bv = i < b.Length ? int.Parse(b[i]) : 0;
                    if (av != bv) return av.CompareTo(bv);
                }
                return 0;
            }
            catch
            {
                return string.Compare(left, right, StringComparison.OrdinalIgnoreCase);
            }
        }

        public void WriteLog(string level, string message)
        {
            try
            {
                Directory.CreateDirectory(logDir);
                string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " [" + level.ToUpperInvariant() + "] " + message + Environment.NewLine;
                lock (logGate)
                {
                    File.AppendAllText(Path.Combine(logDir, "launcher.log"), line);
                }
            }
            catch { }
        }

        public static void WriteGlobalLog(string level, string message)
        {
            try
            {
                string root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), AppName + "Data", "logs");
                Directory.CreateDirectory(root);
                string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " [" + level.ToUpperInvariant() + "] " + message + Environment.NewLine;
                File.AppendAllText(Path.Combine(root, "launcher.log"), line);
            }
            catch { }
        }
    }

    private sealed class AppForm : Form
    {
        public AppForm()
        {
            SetStyle(ControlStyles.ResizeRedraw | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        }
    }

    private sealed class UpdatePromptForm : Form
    {
        public UpdatePromptForm(string appTitle, string current, string latest, string date, string notes, Icon icon)
        {
            Text = appTitle + " 更新提示";
            Icon = icon;
            ClientSize = new Size(560, 430);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterParent;
            BackColor = Color.White;

            var title = new Label
            {
                Text = appTitle + " 有新版本可用",
                Location = new Point(28, 24),
                Size = new Size(490, 34),
                Font = new Font("Microsoft YaHei UI", 15F, FontStyle.Bold),
                ForeColor = Color.FromArgb(31, 41, 55)
            };
            Controls.Add(title);
            var version = new Label
            {
                Text = "当前版本  " + current + "    →    最新版本  " + latest + (string.IsNullOrWhiteSpace(date) ? "" : "    " + date),
                Location = new Point(30, 66),
                Size = new Size(500, 28),
                Font = new Font("Microsoft YaHei UI", 9.5F),
                ForeColor = Color.FromArgb(79, 70, 229)
            };
            Controls.Add(version);
            var noteLabel = new Label
            {
                Text = "本次更新内容",
                Location = new Point(30, 108),
                Size = new Size(490, 24),
                Font = new Font("Microsoft YaHei UI", 10F, FontStyle.Bold),
                ForeColor = Color.FromArgb(55, 65, 81)
            };
            Controls.Add(noteLabel);
            var noteBox = new TextBox
            {
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                Text = string.IsNullOrWhiteSpace(notes) ? "完善稳定性与使用体验。" : notes,
                Location = new Point(30, 136),
                Size = new Size(500, 200),
                BackColor = Color.FromArgb(249, 250, 251),
                BorderStyle = BorderStyle.FixedSingle,
                Font = new Font("Microsoft YaHei UI", 9F),
                ForeColor = Color.FromArgb(75, 85, 99)
            };
            Controls.Add(noteBox);

            var confirm = new Button
            {
                Text = "确认升级并下载安装",
                DialogResult = DialogResult.Yes,
                Width = 150,
                Height = 36,
                BackColor = Color.FromArgb(79, 70, 229),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold)
            };
            confirm.FlatAppearance.BorderSize = 0;
            var later = new Button
            {
                Text = "暂不升级（24小时后提醒）",
                DialogResult = DialogResult.No,
                Width = 170,
                Height = 36,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Microsoft YaHei UI", 9F)
            };
            var cancel = new Button
            {
                Text = "取消",
                DialogResult = DialogResult.Cancel,
                Width = 70,
                Height = 36,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Microsoft YaHei UI", 9F)
            };
            var buttons = new FlowLayoutPanel
            {
                Location = new Point(30, 360),
                Size = new Size(500, 44),
                FlowDirection = FlowDirection.RightToLeft,
                WrapContents = false
            };
            buttons.Controls.Add(cancel);
            buttons.Controls.Add(later);
            buttons.Controls.Add(confirm);
            Controls.Add(buttons);
            AcceptButton = confirm;
            CancelButton = cancel;
        }
    }

    private sealed class UpdateDownloadForm : Form
    {
        private readonly Label status;
        private readonly ProgressBar progress;

        public UpdateDownloadForm(string appTitle, string latest, Icon icon)
        {
            Text = appTitle + " 正在升级";
            Icon = icon;
            ClientSize = new Size(470, 190);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ControlBox = false;
            StartPosition = FormStartPosition.CenterParent;
            BackColor = Color.White;
            Controls.Add(new Label
            {
                Text = appTitle + " · 版本 " + latest,
                Location = new Point(28, 24),
                Size = new Size(410, 28),
                Font = new Font("Microsoft YaHei UI", 12F, FontStyle.Bold),
                ForeColor = Color.FromArgb(31, 41, 55)
            });
            status = new Label
            {
                Text = "正在下载升级包…",
                Location = new Point(28, 62),
                Size = new Size(410, 24),
                Font = new Font("Microsoft YaHei UI", 9F),
                ForeColor = Color.FromArgb(75, 85, 99)
            };
            Controls.Add(status);
            progress = new ProgressBar
            {
                Location = new Point(28, 102),
                Size = new Size(410, 22),
                Minimum = 0,
                Maximum = 100,
                Style = ProgressBarStyle.Continuous
            };
            Controls.Add(progress);
        }

        public void Progress(long received, long total)
        {
            if (IsDisposed) return;
            BeginInvoke((MethodInvoker)delegate
            {
                int value = total > 0 ? (int)Math.Min(100, received * 100 / total) : 0;
                progress.Value = value;
                status.Text = total > 0
                    ? "正在下载升级包… " + value + "%"
                    : "正在下载升级包… " + (received / 1024) + " KB";
            });
        }

        public void Complete(string text)
        {
            if (IsDisposed) return;
            BeginInvoke((MethodInvoker)delegate
            {
                progress.Value = 100;
                status.Text = text;
                var timer = new System.Windows.Forms.Timer { Interval = 500 };
                timer.Tick += delegate { timer.Stop(); timer.Dispose(); DialogResult = DialogResult.OK; Close(); };
                timer.Start();
            });
        }

        public void Fail(string text)
        {
            if (IsDisposed) return;
            BeginInvoke((MethodInvoker)delegate
            {
                status.Text = text;
                var timer = new System.Windows.Forms.Timer { Interval = 1200 };
                timer.Tick += delegate { timer.Stop(); timer.Dispose(); DialogResult = DialogResult.Cancel; Close(); };
                timer.Start();
            });
        }
    }
}
