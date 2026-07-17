using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

class MyTempleLauncher
{
    const string APP_NAME = "MyTempleKnowledge";
    const string APP_TITLE = "MyTemple Knowledge";
    const int DEFAULT_PORT = 4173;

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

        if (!EnsureNodeJS())
        {
            MessageBox.Show("未找到 Node.js，请先安装 Node.js 18+", APP_TITLE, MessageBoxButtons.OK, MessageBoxIcon.Error);
            Process.Start("https://nodejs.org/zh-cn/download/");
            return;
        }

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