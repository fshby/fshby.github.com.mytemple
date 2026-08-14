using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace MyTempleInstaller
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            if (args.Length > 0 && (args[0] == "/uninstall" || args[0] == "-u"))
                Application.Run(new UninstallForm());
            else
                Application.Run(new InstallForm(args.Length > 0 && (args[0] == "/update" || args[0] == "-update")));
        }
    }

    // ── 共享常量 ──────────────────────────────────────
    static class AppConst
    {
        public const string APP_NAME = "MyTempleKnowledge";
        public const string APP_TITLE = "MyTemple Knowledge";
        public const string APP_VERSION = "1.8.31";
        public static readonly string InstallDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), APP_NAME);
        public static readonly string UserDataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), APP_NAME + "Data");
    }

    // ── 品牌头部面板（渐变 + Logo + 标题） ────────────
    class BrandHeader : Panel
    {
        readonly string _subtitle;
        public BrandHeader(string subtitle)
        {
            _subtitle = subtitle;
            Height = 96;
            Dock = DockStyle.Top;
            DoubleBuffered = true;
            Paint += OnPaint;
        }
        void OnPaint(object s, PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var brush = new LinearGradientBrush(ClientRectangle, Color.FromArgb(99, 102, 241), Color.FromArgb(139, 92, 246), 90f))
                g.FillRectangle(brush, ClientRectangle);
            // 尝试加载嵌入的 ICO logo
            try
            {
                var asm = Assembly.GetExecutingAssembly();
                using (var stream = asm.GetManifestResourceStream("logo1.ico"))
                {
                    if (stream != null)
                    {
                        var logo = new Icon(stream, 56, 56);
                        g.DrawIcon(logo, new Rectangle(24, 20, 56, 56));
                    }
                }
            }
            catch { /* 无 logo 时仅显示文字 */ }
            // 标题
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAlias;
            using (var titleFont = new Font("Microsoft YaHei UI", 18F, FontStyle.Bold))
                g.DrawString(AppConst.APP_TITLE, titleFont, Brushes.White, 92, 22);
            using (var subFont = new Font("Microsoft YaHei UI", 9.5F))
            using (var subBrush = new SolidBrush(Color.FromArgb(220, 255, 255, 255)))
                g.DrawString(_subtitle, subFont, subBrush, 92, 54);
        }
    }

    // ── 安装主窗体 ────────────────────────────────────
    class InstallForm : Form
    {
        ProgressBar _progress;
        Label _statusLabel;
        Button _installBtn;
        Button _cancelBtn;
        CheckBox _shortcutChk;
        CheckBox _launchChk;
        Panel _nodePanel;
        Button _downloadNodeBtn;
        Button _recheckNodeBtn;
        Label _nodeStatusLabel;
        readonly bool _updateMode;
        bool _installStarted;

        public InstallForm(bool updateMode = false)
        {
            _updateMode = updateMode;
            Text = AppConst.APP_TITLE + " 安装程序";
            ClientSize = new Size(520, 420);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.White;
            try
            {
                var asm = Assembly.GetExecutingAssembly();
                using (var stream = asm.GetManifestResourceStream("logo1.ico"))
                    if (stream != null) Icon = new Icon(stream);
            }
            catch { }

            var header = new BrandHeader("企业级 Markdown 知识管理平台 · v" + AppConst.APP_VERSION);
            Controls.Add(header);

            // 欢迎文字
            var welcome = new Label
            {
                Text = "即将安装 " + AppConst.APP_TITLE + "。\n点击「开始安装」继续，安装过程自动完成。",
                Location = new Point(32, 116),
                Size = new Size(456, 48),
                Font = new Font("Microsoft YaHei UI", 10F),
                ForeColor = Color.FromArgb(55, 65, 81),
                TextAlign = ContentAlignment.MiddleLeft,
            };
            Controls.Add(welcome);

            // Node.js 依赖检查面板（默认隐藏）
            _nodePanel = new Panel
            {
                Location = new Point(32, 180),
                Size = new Size(456, 90),
                BackColor = Color.FromArgb(254, 242, 242),
                Visible = false,
            };
            _nodeStatusLabel = new Label
            {
                Text = "未检测到 Node.js 运行环境。\n本软件依赖 Node.js 运行，请先安装后重新检测。",
                Location = new Point(12, 10),
                Size = new Size(432, 40),
                Font = new Font("Microsoft YaHei UI", 9F),
                ForeColor = Color.FromArgb(185, 28, 28),
            };
            _nodePanel.Controls.Add(_nodeStatusLabel);
            _downloadNodeBtn = new Button
            {
                Text = "下载 Node.js",
                Location = new Point(12, 56),
                Size = new Size(120, 28),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(99, 102, 241),
                ForeColor = Color.White,
            };
            _downloadNodeBtn.FlatAppearance.BorderSize = 0;
            _downloadNodeBtn.Click += (s, e) => Process.Start("https://nodejs.org/");
            _nodePanel.Controls.Add(_downloadNodeBtn);
            _recheckNodeBtn = new Button
            {
                Text = "重新检测",
                Location = new Point(142, 56),
                Size = new Size(100, 28),
                FlatStyle = FlatStyle.Flat,
            };
            _recheckNodeBtn.Click += (s, e) => CheckNodeAndProceed();
            _nodePanel.Controls.Add(_recheckNodeBtn);
            Controls.Add(_nodePanel);

            // 选项面板
            var optPanel = new Panel
            {
                Location = new Point(32, 186),
                Size = new Size(456, 72),
            };
            _shortcutChk = new CheckBox
            {
                Text = "创建桌面快捷方式",
                Location = new Point(0, 8),
                Size = new Size(220, 24),
                Font = new Font("Microsoft YaHei UI", 9.5F),
                Checked = false,
            };
            optPanel.Controls.Add(_shortcutChk);
            _launchChk = new CheckBox
            {
                Text = "安装完成后启动应用",
                Location = new Point(0, 36),
                Size = new Size(220, 24),
                Font = new Font("Microsoft YaHei UI", 9.5F),
                Checked = false,
            };
            optPanel.Controls.Add(_launchChk);
            Controls.Add(optPanel);

            // 进度条
            _progress = new ProgressBar
            {
                Location = new Point(32, 280),
                Size = new Size(456, 22),
                Style = ProgressBarStyle.Continuous,
                Minimum = 0,
                Maximum = 100,
                Value = 0,
            };
            Controls.Add(_progress);

            // 状态文字
            _statusLabel = new Label
            {
                Text = "准备就绪",
                Location = new Point(32, 308),
                Size = new Size(456, 24),
                Font = new Font("Microsoft YaHei UI", 9F),
                ForeColor = Color.FromArgb(107, 114, 128),
            };
            Controls.Add(_statusLabel);

            // 按钮
            _installBtn = new Button
            {
                Text = "开始安装",
                Location = new Point(288, 350),
                Size = new Size(100, 36),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(99, 102, 241),
                ForeColor = Color.White,
                Font = new Font("Microsoft YaHei UI", 10F, FontStyle.Bold),
            };
            _installBtn.FlatAppearance.BorderSize = 0;
            _installBtn.Click += (s, e) => StartInstall();
            Controls.Add(_installBtn);

            _cancelBtn = new Button
            {
                Text = "取消",
                Location = new Point(398, 350),
                Size = new Size(90, 36),
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Microsoft YaHei UI", 10F),
            };
            _cancelBtn.Click += (s, e) => Close();
            Controls.Add(_cancelBtn);

            AcceptButton = _installBtn;
            CancelButton = _cancelBtn;

            Shown += (s, e) => CheckNodeAndProceed();
        }

        string ResolveNodePath()
        {
            var candidates = new System.Collections.Generic.List<string>();
            Action<string> addPath = value =>
            {
                if (string.IsNullOrWhiteSpace(value)) return;
                var expanded = Environment.ExpandEnvironmentVariables(value.Trim().Trim('"'));
                if (!string.IsNullOrWhiteSpace(expanded) && !candidates.Contains(expanded)) candidates.Add(expanded);
            };

            // The installer process may have started before Node.js was installed.
            // Read both live and registry PATH values so recheck sees the new install.
            foreach (var path in (Environment.GetEnvironmentVariable("PATH") ?? string.Empty).Split(Path.PathSeparator))
                if (!string.IsNullOrWhiteSpace(path)) addPath(Path.Combine(path, "node.exe"));
            try
            {
                var userPath = Registry.GetValue(
                    @"HKEY_CURRENT_USER\Environment", "Path", string.Empty) as string;
                var machinePath = Registry.GetValue(
                    @"HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Session Manager\Environment", "Path", string.Empty) as string;
                foreach (var path in (userPath ?? string.Empty).Split(Path.PathSeparator))
                    if (!string.IsNullOrWhiteSpace(path)) addPath(Path.Combine(path, "node.exe"));
                foreach (var path in (machinePath ?? string.Empty).Split(Path.PathSeparator))
                    if (!string.IsNullOrWhiteSpace(path)) addPath(Path.Combine(path, "node.exe"));
            }
            catch { /* Registry access can be restricted; fixed paths still cover normal installs. */ }

            addPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"));
            addPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"));
            addPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe"));
            addPath(@"C:\Program Files\nodejs\node.exe");
            addPath(@"C:\Program Files (x86)\nodejs\node.exe");
            addPath(@"D:\node\node.exe");

            foreach (var candidate in candidates)
            {
                if (!File.Exists(candidate)) continue;
                try
                {
                    var psi = new ProcessStartInfo(candidate, "--version")
                    {
                        CreateNoWindow = true,
                        UseShellExecute = false,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                    };
                    using (var process = Process.Start(psi))
                    {
                        if (process == null) continue;
                        process.WaitForExit(3000);
                        if (process.ExitCode == 0) return candidate;
                    }
                }
                catch { }
            }
            return null;
        }

        bool NodeAvailable()
        {
            return !string.IsNullOrWhiteSpace(ResolveNodePath());
        }

        void CheckNodeAndProceed()
        {
            _recheckNodeBtn.Enabled = false;
            _nodeStatusLabel.Text = "正在重新检测 Node.js 运行环境…";
            Application.DoEvents();
            if (NodeAvailable())
            {
                _nodePanel.Visible = false;
                _installBtn.Enabled = true;
                if (_updateMode && !_installStarted)
                {
                    _installStarted = true;
                    _shortcutChk.Checked = false;
                    _launchChk.Checked = true;
                    BeginInvoke((MethodInvoker)delegate { StartInstall(); });
                }
                _statusLabel.Text = "环境检测通过，可以开始安装。";
            }
            else
            {
                _nodePanel.Visible = true;
                _installBtn.Enabled = false;
                _statusLabel.Text = "请先安装 Node.js 运行环境。";
            }
            _recheckNodeBtn.Enabled = true;
        }

        void StartInstall()
        {
            _installBtn.Enabled = false;
            _cancelBtn.Enabled = false;
            _shortcutChk.Enabled = false;
            _launchChk.Enabled = false;
            new Thread(RunInstall).Start();
        }

        void RunInstall()
        {
            var steps = new Action[]
            {
                () => { SetStatus("正在停止旧进程…", 5); InstallerCore.StopOldProcesses(); Thread.Sleep(300); },
                () => { SetStatus("正在解压安装文件…", 20); string temp = InstallerCore.ExtractPayload(); Thread.Sleep(200);
                        InstallerCore.CopyInstallationFiles(temp, AppConst.InstallDir);
                        InstallerCore.CleanupTemp(temp); },
                () => { SetStatus("正在初始化用户数据…", 60); InstallerCore.InitializeUserData(AppConst.InstallDir, AppConst.UserDataDir); },
                () => { SetStatus("正在创建快捷方式…", 80);
                        if (_shortcutChk.Checked) InstallerCore.CreateDesktopShortcut(AppConst.InstallDir);
                        InstallerCore.RegisterUninstall(AppConst.InstallDir); },
                () => { SetStatus("正在清理…", 95); Thread.Sleep(200); },
                () => { SetStatus("安装完成！", 100); },
            };
            try
            {
                foreach (var step in steps) step();
                // 若勾选立即启动，先拉起应用再退出安装器，避免界面残留。
                if (_launchChk.Checked)
                    InstallerCore.StartApplication(AppConst.InstallDir);
                Invoke((MethodInvoker)delegate
                {
                    _statusLabel.Text = "安装完成！";
                    _progress.Value = 100;
                    _installBtn.Text = "完成";
                    _installBtn.Enabled = true;
                    _cancelBtn.Text = "退出";
                    _cancelBtn.Enabled = true;
                    _installBtn.Click -= (s, ev) => StartInstall();
                    _installBtn.Click += (s, ev) => { DialogResult = DialogResult.OK; Close(); Application.Exit(); };
                    _cancelBtn.Click -= (s, ev) => Close();
                    _cancelBtn.Click += (s, ev) => { DialogResult = DialogResult.Cancel; Close(); Application.Exit(); };
                    // 短暂展示完成状态后自动退出安装界面。
                    var autoClose = new System.Windows.Forms.Timer { Interval = 1200 };
                    autoClose.Tick += (s, ev) =>
                    {
                        autoClose.Stop();
                        DialogResult = DialogResult.OK;
                        Close();
                        Application.Exit();
                    };
                    autoClose.Start();
                });
            }
            catch (Exception ex)
            {
                Invoke((MethodInvoker)delegate
                {
                    _statusLabel.Text = "安装失败：" + ex.Message;
                    _installBtn.Enabled = true;
                    _cancelBtn.Enabled = true;
                    _shortcutChk.Enabled = true;
                    _launchChk.Enabled = true;
                });
            }
        }

        void SetStatus(string text, int pct)
        {
            Invoke((MethodInvoker)delegate
            {
                _statusLabel.Text = text;
                _progress.Value = pct;
            });
        }
    }

    // ── 卸载窗体 ──────────────────────────────────────
    class UninstallForm : Form
    {
        ProgressBar _progress;
        Label _statusLabel;
        Button _uninstallBtn;
        Button _cancelBtn;
        CheckBox _deleteDataChk;

        public UninstallForm()
        {
            Text = AppConst.APP_TITLE + " 卸载程序";
            ClientSize = new Size(480, 340);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.White;
            try
            {
                var asm = Assembly.GetExecutingAssembly();
                using (var stream = asm.GetManifestResourceStream("logo1.ico"))
                    if (stream != null) Icon = new Icon(stream);
            }
            catch { }

            var header = new BrandHeader("卸载程序");
            Controls.Add(header);

            var info = new Label
            {
                Text = "即将卸载 " + AppConst.APP_TITLE + "。\n卸载后用户文档数据将保留，可勾选下方选项一并删除。",
                Location = new Point(32, 116),
                Size = new Size(416, 48),
                Font = new Font("Microsoft YaHei UI", 10F),
                ForeColor = Color.FromArgb(55, 65, 81),
            };
            Controls.Add(info);

            _deleteDataChk = new CheckBox
            {
                Text = "同时删除用户文档数据",
                Location = new Point(32, 176),
                Size = new Size(220, 24),
                Font = new Font("Microsoft YaHei UI", 9.5F),
                Checked = false,
            };
            Controls.Add(_deleteDataChk);

            _progress = new ProgressBar
            {
                Location = new Point(32, 220),
                Size = new Size(416, 22),
                Style = ProgressBarStyle.Continuous,
            };
            Controls.Add(_progress);

            _statusLabel = new Label
            {
                Text = "准备卸载",
                Location = new Point(32, 248),
                Size = new Size(416, 24),
                Font = new Font("Microsoft YaHei UI", 9F),
                ForeColor = Color.FromArgb(107, 114, 128),
            };
            Controls.Add(_statusLabel);

            _uninstallBtn = new Button
            {
                Text = "开始卸载",
                Location = new Point(248, 282),
                Size = new Size(100, 36),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(220, 38, 38),
                ForeColor = Color.White,
                Font = new Font("Microsoft YaHei UI", 10F, FontStyle.Bold),
            };
            _uninstallBtn.FlatAppearance.BorderSize = 0;
            _uninstallBtn.Click += (s, e) => StartUninstall();
            Controls.Add(_uninstallBtn);

            _cancelBtn = new Button
            {
                Text = "取消",
                Location = new Point(358, 282),
                Size = new Size(90, 36),
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Microsoft YaHei UI", 10F),
            };
            _cancelBtn.Click += (s, e) => Close();
            Controls.Add(_cancelBtn);
        }

        void StartUninstall()
        {
            _uninstallBtn.Enabled = false;
            _cancelBtn.Enabled = false;
            _deleteDataChk.Enabled = false;
            new Thread(RunUninstall).Start();
        }

        void RunUninstall()
        {
            var steps = new Action[]
            {
                () => { SetStatus("停止运行中的程序…", 20); InstallerCore.StopOldProcesses(); Thread.Sleep(300); },
                () => { SetStatus("删除安装目录…", 50);
                        if (Directory.Exists(AppConst.InstallDir)) InstallerCore.DeleteDirectory(AppConst.InstallDir); },
                () => { SetStatus("移除快捷方式…", 70); InstallerCore.RemoveDesktopShortcut(); },
                () => { SetStatus("取消注册…", 85); InstallerCore.UnregisterUninstall(); },
                () => { SetStatus("卸载完成！", 100);
                        if (_deleteDataChk.Checked && Directory.Exists(AppConst.UserDataDir))
                            InstallerCore.DeleteDirectory(AppConst.UserDataDir); },
            };
            try
            {
                foreach (var step in steps) step();
                Invoke((MethodInvoker)delegate
                {
                    _statusLabel.Text = "卸载完成！";
                    _progress.Value = 100;
                    DialogResult = DialogResult.OK;
                    Close();
                });
            }
            catch (Exception ex)
            {
                Invoke((MethodInvoker)delegate { _statusLabel.Text = "卸载出错：" + ex.Message; });
            }
        }

        void SetStatus(string text, int pct)
        {
            Invoke((MethodInvoker)delegate
            {
                _statusLabel.Text = text;
                _progress.Value = pct;
            });
        }
    }

    // ── 安装核心逻辑（线程安全，无 UI 依赖） ──────────
    static class InstallerCore
    {
        public static void StopOldProcesses()
        {
            try
            {
                foreach (var p in Process.GetProcessesByName(AppConst.APP_NAME))
                    try { p.Kill(); p.WaitForExit(2000); } catch { }
                foreach (var p in Process.GetProcessesByName("node"))
                {
                    try
                    {
                        if (p.MainModule != null && p.MainModule.FileName.IndexOf("node", StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            foreach (ProcessModule m in p.Modules)
                            {
                                if (m.FileName.IndexOf("server.js", StringComparison.OrdinalIgnoreCase) >= 0)
                                {
                                    try { p.Kill(); p.WaitForExit(2000); } catch { }
                                    break;
                                }
                            }
                        }
                    }
                    catch { }
                }
            }
            catch { }
        }

        public static string ExtractPayload()
        {
            string tempDir = Path.Combine(Path.GetTempPath(), AppConst.APP_NAME + "_install_" + DateTime.Now.Ticks);
            Directory.CreateDirectory(tempDir);
            var asm = Assembly.GetExecutingAssembly();
            using (var stream = asm.GetManifestResourceStream("payload.zip"))
            {
                if (stream == null) throw new Exception("未找到安装数据包");
                using (var archive = new ZipArchive(stream))
                    archive.ExtractToDirectory(tempDir);
            }
            return tempDir;
        }

        public static void CopyInstallationFiles(string sourceDir, string installDir)
        {
            if (Directory.Exists(installDir)) DeleteDirectory(installDir);
            Directory.CreateDirectory(installDir);
            foreach (var file in Directory.GetFiles(sourceDir))
            {
                var name = Path.GetFileName(file);
                if (name.Equals("workspaces.json", StringComparison.OrdinalIgnoreCase)) continue;
                File.Copy(file, Path.Combine(installDir, name), true);
            }
            foreach (var dir in Directory.GetDirectories(sourceDir))
                CopyDirectory(dir, Path.Combine(installDir, Path.GetFileName(dir)));
        }

        public static void InitializeUserData(string installDir, string userDataDir)
        {
            if (!Directory.Exists(userDataDir)) Directory.CreateDirectory(userDataDir);
            var userDocs = Path.Combine(userDataDir, "docs");
            var sourceDir = Path.Combine(userDataDir, "source");
            if (!Directory.Exists(userDocs))
            {
                var appDocs = Path.Combine(installDir, "docs");
                if (Directory.Exists(appDocs)) CopyDirectory(appDocs, userDocs);
                else
                {
                    Directory.CreateDirectory(userDocs);
                    File.WriteAllText(Path.Combine(userDocs, "README.md"),
                        "# MyTemple Knowledge\n\n欢迎使用 MyTemple Knowledge 知识库管理工具。\n");
                }
            }
            if (!Directory.Exists(sourceDir)) Directory.CreateDirectory(sourceDir);
            var wsConfig = Path.Combine(userDataDir, "workspaces.json");
            if (!File.Exists(wsConfig))
            {
                var root = userDocs.Replace("\\", "\\\\");
                File.WriteAllText(wsConfig, "{\"workspaces\":[{\"id\":\"default\",\"name\":\"默认 docs\",\"root\":\"" +
                    root + "\",\"visible\":true,\"mdOnly\":true,\"builtin\":true,\"lastUsed\":" +
                    DateTime.Now.Ticks + "}],\"defaultWorkspaceId\":\"default\"}");
            }
        }

        public static void CreateDesktopShortcut(string installDir)
        {
            var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            var shortcutPath = Path.Combine(desktop, AppConst.APP_TITLE + ".lnk");
            var targetPath = Path.Combine(installDir, AppConst.APP_NAME + ".exe");
            string iconPath = Path.Combine(installDir, "logo1.ico");
            if (!File.Exists(iconPath)) iconPath = Path.Combine(installDir, "logo.ico");
            if (!File.Exists(iconPath)) iconPath = targetPath;
            var ps = string.Format(
                "$s=New-Object -ComObject WScript.Shell;" +
                "$sc=$s.CreateShortcut('{0}');" +
                "$sc.TargetPath='{1}';$sc.WorkingDirectory='{2}';" +
                "$sc.Description='{3}';$sc.IconLocation='{4}';$sc.Save()",
                shortcutPath, targetPath, installDir, AppConst.APP_TITLE, iconPath);
            var psi = new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -Command \"" + ps + "\"")
            {
                CreateNoWindow = true,
                UseShellExecute = false,
            };
            using (var p = Process.Start(psi)) { p.WaitForExit(); if (p.ExitCode != 0) throw new Exception("创建快捷方式失败"); }
        }

        public static void RemoveDesktopShortcut()
        {
            var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            var shortcutPath = Path.Combine(desktop, AppConst.APP_TITLE + ".lnk");
            if (File.Exists(shortcutPath)) File.Delete(shortcutPath);
        }

        public static void RegisterUninstall(string installDir)
        {
            try
            {
                string uninstallExe = Path.Combine(installDir, AppConst.APP_NAME + "_Setup.exe");
                if (!File.Exists(uninstallExe)) uninstallExe = Assembly.GetExecutingAssembly().Location;
                using (var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + AppConst.APP_NAME))
                {
                    key.SetValue("DisplayName", AppConst.APP_TITLE);
                    key.SetValue("DisplayVersion", AppConst.APP_VERSION);
                    key.SetValue("InstallLocation", installDir);
                    key.SetValue("UninstallString", "\"" + uninstallExe + "\" /uninstall");
                    key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                    key.SetValue("Publisher", "MyTemple");
                    key.SetValue("UrlInfoAbout", "https://mytemple.fshby.cc");
                }
            }
            catch { }
        }

        public static void UnregisterUninstall()
        {
            try { Registry.CurrentUser.DeleteSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + AppConst.APP_NAME, false); }
            catch { }
        }

        public static void StartApplication(string installDir)
        {
            try { Process.Start(Path.Combine(installDir, AppConst.APP_NAME + ".exe")); }
            catch { }
        }

        public static void CleanupTemp(string tempDir)
        {
            try { if (Directory.Exists(tempDir)) Directory.Delete(tempDir, true); }
            catch { }
        }

        public static void DeleteDirectory(string path)
        {
            try
            {
                var dir = new DirectoryInfo(path);
                foreach (var f in dir.GetFiles()) { f.IsReadOnly = false; f.Delete(); }
                foreach (var d in dir.GetDirectories()) DeleteDirectory(d.FullName);
                dir.Delete();
            }
            catch { }
        }

        static void CopyDirectory(string source, string target)
        {
            Directory.CreateDirectory(target);
            foreach (var file in Directory.GetFiles(source))
                File.Copy(file, Path.Combine(target, Path.GetFileName(file)), true);
            foreach (var dir in Directory.GetDirectories(source))
                CopyDirectory(dir, Path.Combine(target, Path.GetFileName(dir)));
        }
    }
}
