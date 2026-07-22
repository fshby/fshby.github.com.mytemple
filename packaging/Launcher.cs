using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;

class MyTempleLauncher
{
    const string APP_NAME = "MyTempleKnowledge";
    const string APP_TITLE = "MyTemple Knowledge";
    const int DEFAULT_PORT = 4173;
    const string VERSION_CHECK_URL = "https://raw.githubusercontent.com/fshby/fshby.github.com.mytemple/master/version.json";
    static string CURRENT_VERSION = "1.0.0";

    static string installDir;
    static string userDataDir;
    static string nodePath;
    static int port;
    static Process nodeProcess;

    static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        installDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
        userDataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), APP_NAME + "Data");

        LoadCurrentVersion();

        if (!EnsureNodeJS())
        {
            MessageBox.Show("未找到 Node.js，请先安装 Node.js 18+", APP_TITLE, MessageBoxButtons.OK, MessageBoxIcon.Error);
            Process.Start("https://nodejs.org/zh-cn/download/");
            return;
        }

        // 检查更新
        CheckForUpdates();

        InitializeUserData();
        port = FindAvailablePort();

        try
        {
            StartServer();
            Thread.Sleep(2000);
            OpenBrowser();

            using (NotifyIcon trayIcon = new NotifyIcon())
            {
                trayIcon.Icon = System.Drawing.Icon.ExtractAssociatedIcon(System.Reflection.Assembly.GetExecutingAssembly().Location);
                trayIcon.Text = APP_TITLE + " - http://localhost:" + port;
                trayIcon.Visible = true;

                ContextMenu contextMenu = new ContextMenu();
                contextMenu.MenuItems.Add("打开主页", (sender, e) => Process.Start("http://localhost:" + port));
                contextMenu.MenuItems.Add("检查更新", (sender, e) => CheckForUpdates(true));
                contextMenu.MenuItems.Add("退出", (sender, e) =>
                {
                    ShutdownServer();
                    trayIcon.Visible = false;
                    Application.Exit();
                });
                trayIcon.ContextMenu = contextMenu;

                trayIcon.DoubleClick += (sender, e) => Process.Start("http://localhost:" + port);

                Application.Run();
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show("启动失败: " + ex.Message, APP_TITLE, MessageBoxButtons.OK, MessageBoxIcon.Error);
            ShutdownServer();
        }
    }

    static void LoadCurrentVersion()
    {
        try
        {
            string versionFile = Path.Combine(installDir, "version.json");
            if (File.Exists(versionFile))
            {
                string json = File.ReadAllText(versionFile);
                CURRENT_VERSION = ParseVersion(json);
            }
        }
        catch
        {
        }
    }

    static void CheckForUpdates(bool force = false)
    {
        try
        {
            string lastCheckFile = Path.Combine(userDataDir, "last_update_check.txt");
            long lastCheck = 0;
            if (File.Exists(lastCheckFile))
            {
                long.TryParse(File.ReadAllText(lastCheckFile), out lastCheck);
            }

            // 每隔24小时检查一次，强制检查时跳过时间限制
            unchecked
            {
                if (!force && (DateTime.Now.Ticks - lastCheck) < 24L * 60 * 60 * 10000000)
                {
                    return;
                }
            }

            // 更新检查时间
            File.WriteAllText(lastCheckFile, DateTime.Now.Ticks.ToString());

            // 下载版本信息
            string versionJson = DownloadString(VERSION_CHECK_URL);
            if (string.IsNullOrEmpty(versionJson))
            {
                return;
            }

            // 解析版本信息
            string latestVersion = ParseVersion(versionJson);
            string downloadUrl = ParseDownloadUrl(versionJson);

            if (string.IsNullOrEmpty(latestVersion) || string.IsNullOrEmpty(downloadUrl))
            {
                return;
            }

            // 比较版本
            if (CompareVersions(CURRENT_VERSION, latestVersion) < 0)
            {
                DialogResult result = MessageBox.Show(
                    string.Format("发现新版本 v{0}，当前版本 v{1}\n\n是否立即更新？", latestVersion, CURRENT_VERSION),
                    APP_TITLE + " - 更新提示",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Information
                );

                if (result == DialogResult.Yes)
                {
                    DownloadAndUpdate(downloadUrl);
                }
            }
        }
        catch (Exception ex)
        {
            // 忽略更新检查错误，不影响正常启动
        }
    }

    static string DownloadString(string url)
    {
        try
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            ServicePointManager.ServerCertificateValidationCallback = (sender, cert, chain, sslPolicyErrors) => true;

            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.Timeout = 10000;
            request.ReadWriteTimeout = 10000;

            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream()))
            {
                return reader.ReadToEnd();
            }
        }
        catch
        {
            return null;
        }
    }

    static string ParseVersion(string json)
    {
        try
        {
            int start = json.IndexOf("\"version\"") + 10;
            int end = json.IndexOf("\"", start);
            return json.Substring(start, end - start).Trim();
        }
        catch
        {
            return null;
        }
    }

    static string ParseDownloadUrl(string json)
    {
        try
        {
            int start = json.IndexOf("\"downloadUrl\"") + 14;
            int end = json.IndexOf("\"", start);
            return json.Substring(start, end - start).Trim();
        }
        catch
        {
            return null;
        }
    }

    static int CompareVersions(string v1, string v2)
    {
        try
        {
            string[] parts1 = v1.Split('.');
            string[] parts2 = v2.Split('.');
            int len = Math.Max(parts1.Length, parts2.Length);

            for (int i = 0; i < len; i++)
            {
                int p1 = i < parts1.Length ? int.Parse(parts1[i]) : 0;
                int p2 = i < parts2.Length ? int.Parse(parts2[i]) : 0;
                if (p1 != p2) return p1.CompareTo(p2);
            }
            return 0;
        }
        catch
        {
            return v1.CompareTo(v2);
        }
    }

    static void DownloadAndUpdate(string downloadUrl)
    {
        try
        {
            string tempExe = Path.Combine(Path.GetTempPath(), APP_NAME + "_update.exe");

            // 删除旧的更新文件
            if (File.Exists(tempExe))
            {
                File.Delete(tempExe);
            }

            using (WebClient client = new WebClient())
            {
                ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
                ServicePointManager.ServerCertificateValidationCallback = (sender, cert, chain, sslPolicyErrors) => true;

                // 创建进度窗口
                Form progressForm = new Form();
                progressForm.Text = APP_TITLE + " - 更新下载";
                progressForm.Size = new System.Drawing.Size(300, 100);
                progressForm.StartPosition = FormStartPosition.CenterScreen;
                progressForm.FormBorderStyle = FormBorderStyle.FixedDialog;
                progressForm.MaximizeBox = false;
                progressForm.MinimizeBox = false;

                ProgressBar progressBar = new ProgressBar();
                progressBar.Location = new System.Drawing.Point(10, 20);
                progressBar.Size = new System.Drawing.Size(260, 20);
                progressBar.Style = ProgressBarStyle.Continuous;
                progressForm.Controls.Add(progressBar);

                Label label = new Label();
                label.Location = new System.Drawing.Point(10, 45);
                label.Size = new System.Drawing.Size(260, 20);
                label.Text = "正在下载更新...";
                progressForm.Controls.Add(label);

                progressForm.Show();

                client.DownloadProgressChanged += (sender, e) =>
                {
                    progressBar.Value = e.ProgressPercentage;
                    label.Text = string.Format("正在下载更新... {0}%", e.ProgressPercentage);
                    progressForm.Update();
                };

                client.DownloadFileCompleted += (sender, e) =>
                {
                    progressForm.Close();

                    if (!e.Cancelled && e.Error == null)
                    {
                        ShutdownServer();

                        ProcessStartInfo psi = new ProcessStartInfo(tempExe);
                        psi.UseShellExecute = true;
                        psi.Verb = "runas";
                        try
                        {
                            Process.Start(psi);
                        }
                        catch
                        {
                            Process.Start(tempExe);
                        }

                        Application.Exit();
                    }
                    else
                    {
                        MessageBox.Show("下载失败，请稍后重试", APP_TITLE, MessageBoxButtons.OK, MessageBoxIcon.Error);
                    }
                };

                client.DownloadFileAsync(new Uri(downloadUrl), tempExe);
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show("更新失败: " + ex.Message, APP_TITLE, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    static bool EnsureNodeJS()
    {
        string[] possiblePaths = {
            "node.exe",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"),
            "D:\\node\\node.exe"
        };

        foreach (string path in possiblePaths)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(path, "--version");
                psi.RedirectStandardOutput = true;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;

                using (Process p = Process.Start(psi))
                {
                    p.WaitForExit(3000);
                    if (p.ExitCode == 0)
                    {
                        nodePath = path;
                        return true;
                    }
                }
            }
            catch { }
        }

        return false;
    }

    static void InitializeUserData()
    {
        if (!Directory.Exists(userDataDir))
        {
            Directory.CreateDirectory(userDataDir);
        }

        string docsPath = Path.Combine(userDataDir, "docs");
        string sourcePath = Path.Combine(userDataDir, "source");

        if (!Directory.Exists(docsPath))
        {
            string appDocsPath = Path.Combine(installDir, "docs");
            if (Directory.Exists(appDocsPath))
            {
                CopyDirectory(appDocsPath, docsPath);
            }
            else
            {
                Directory.CreateDirectory(docsPath);
                string readmeContent = "# MyTemple Knowledge\n\n欢迎使用 MyTemple Knowledge 知识库管理工具。\n\n## 功能特性\n\n- Markdown 文档编辑\n- 阅读模式\n- 目录导航\n- 全局搜索\n- 知识图谱\n";
                File.WriteAllText(Path.Combine(docsPath, "README.md"), readmeContent);
            }
        }

        if (!Directory.Exists(sourcePath))
        {
            Directory.CreateDirectory(sourcePath);
        }
    }

    static void CopyDirectory(string source, string target)
    {
        Directory.CreateDirectory(target);
        foreach (string file in Directory.GetFiles(source))
        {
            File.Copy(file, Path.Combine(target, Path.GetFileName(file)), true);
        }
        foreach (string dir in Directory.GetDirectories(source))
        {
            CopyDirectory(dir, Path.Combine(target, Path.GetFileName(dir)));
        }
    }

    static int FindAvailablePort()
    {
        int p = DEFAULT_PORT;
        while (p < DEFAULT_PORT + 100)
        {
            try
            {
                System.Net.Sockets.TcpListener listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, p);
                listener.Start();
                listener.Stop();
                return p;
            }
            catch { p++; }
        }
        return DEFAULT_PORT;
    }

    static void StartServer()
    {
        string serverPath = Path.Combine(installDir, "server.js");
        if (!File.Exists(serverPath))
        {
            throw new Exception("server.js 未找到");
        }

        ProcessStartInfo psi = new ProcessStartInfo(nodePath, "\"" + serverPath + "\"");
        psi.WorkingDirectory = installDir;
        psi.CreateNoWindow = true;
        psi.UseShellExecute = false;

        psi.EnvironmentVariables["PORT"] = port.ToString();
        psi.EnvironmentVariables["DATA_DIR"] = userDataDir;

        nodeProcess = Process.Start(psi);
    }

    static void ShutdownServer()
    {
        if (nodeProcess != null && !nodeProcess.HasExited)
        {
            try
            {
                nodeProcess.Kill();
                nodeProcess.WaitForExit(2000);
            }
            catch { }
        }
    }

    static void OpenBrowser()
    {
        try
        {
            Process.Start("http://localhost:" + port);
        }
        catch
        {
            ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c start http://localhost:" + port);
            psi.CreateNoWindow = true;
            Process.Start(psi);
        }
    }
}
