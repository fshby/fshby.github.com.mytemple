using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
using System.IO.Compression;
using Microsoft.Win32;

class SelfExtractInstaller
{
    const string APP_NAME = "MyTempleKnowledge";
    const string APP_TITLE = "MyTemple Knowledge";
    const string APP_VERSION = "1.0.0";

    static void Main(string[] args)
    {
        // 检查是否是卸载模式
        if (args.Length > 0 && (args[0] == "/uninstall" || args[0] == "-u"))
        {
            Uninstall();
            return;
        }

        Console.Title = APP_TITLE + " 安装程序 v" + APP_VERSION;
        Console.WriteLine("========================================");
        Console.WriteLine("  " + APP_TITLE + " 安装程序");
        Console.WriteLine("  版本: " + APP_VERSION);
        Console.WriteLine("========================================");
        Console.WriteLine("");

        string installDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), APP_NAME);
        string userDataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), APP_NAME + "Data");

        Console.WriteLine("安装路径: " + installDir);
        Console.WriteLine("数据路径: " + userDataDir);
        Console.WriteLine("");

        Console.WriteLine("[1/6] 停止旧进程...");
        StopOldProcesses();
        Thread.Sleep(1000);

        Console.WriteLine("[2/6] 解压安装文件...");
        string tempDir = ExtractPayload();
        Thread.Sleep(500);

        Console.WriteLine("[3/6] 复制安装文件...");
        CopyInstallationFiles(tempDir, installDir);
        Thread.Sleep(500);

        Console.WriteLine("[4/6] 初始化用户数据...");
        InitializeUserData(installDir, userDataDir);
        Thread.Sleep(500);

        Console.WriteLine("[5/6] 创建快捷方式和注册卸载...");
        CreateDesktopShortcut(installDir);
        RegisterUninstall(installDir);
        Thread.Sleep(500);

        Console.WriteLine("[6/6] 清理临时文件...");
        CleanupTemp(tempDir);

        Console.WriteLine("");
        Console.WriteLine("========================================");
        Console.WriteLine("  安装完成!");
        Console.WriteLine("========================================");
        Console.WriteLine("");

        Console.Write("是否立即启动应用? (Y/N): ");
        string input = Console.ReadLine();
        if (input == "Y" || input == "y")
        {
            Console.WriteLine("正在启动应用...");
            StartApplication(installDir);
        }
        else
        {
            Console.WriteLine("安装完成。双击桌面快捷方式启动应用。");
        }

        Console.WriteLine("");
        Console.WriteLine("按任意键退出...");
        Console.ReadKey();
    }

    static void Uninstall()
    {
        Console.Title = APP_TITLE + " 卸载程序";
        Console.WriteLine("========================================");
        Console.WriteLine("  " + APP_TITLE + " 卸载程序");
        Console.WriteLine("========================================");
        Console.WriteLine("");

        string installDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), APP_NAME);
        string userDataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), APP_NAME + "Data");

        Console.WriteLine("安装路径: " + installDir);
        Console.WriteLine("数据路径: " + userDataDir);
        Console.WriteLine("");

        Console.WriteLine("[1/4] 停止运行中的程序...");
        StopOldProcesses();
        Thread.Sleep(1000);

        Console.WriteLine("[2/4] 删除安装目录...");
        if (Directory.Exists(installDir))
        {
            DeleteDirectory(installDir);
            Console.WriteLine("  已删除: " + installDir);
        }

        Console.WriteLine("[3/4] 移除快捷方式...");
        string desktopPath = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        string shortcutPath = Path.Combine(desktopPath, APP_TITLE + ".lnk");
        if (File.Exists(shortcutPath))
        {
            File.Delete(shortcutPath);
            Console.WriteLine("  已移除桌面快捷方式");
        }

        Console.WriteLine("[4/4] 取消注册卸载...");
        UnregisterUninstall();

        Console.WriteLine("");
        Console.WriteLine("========================================");
        Console.WriteLine("  卸载完成!");
        Console.WriteLine("========================================");
        Console.WriteLine("");
        Console.WriteLine("注意：用户文档数据目录已保留:");
        Console.WriteLine("  " + userDataDir);
        Console.WriteLine("");

        Console.Write("是否同时删除用户文档数据? (Y/N): ");
        string input = Console.ReadLine();
        if (input == "Y" || input == "y")
        {
            if (Directory.Exists(userDataDir))
            {
                DeleteDirectory(userDataDir);
                Console.WriteLine("  已删除用户数据");
            }
        }

        Console.WriteLine("");
        Console.WriteLine("按任意键退出...");
        Console.ReadKey();
    }

    static void RegisterUninstall(string installDir)
    {
        try
        {
            string uninstallExe = Path.Combine(installDir, APP_NAME + "_Setup.exe");
            if (!File.Exists(uninstallExe))
            {
                uninstallExe = Assembly.GetExecutingAssembly().Location;
            }

            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + APP_NAME))
            {
                if (key != null)
                {
                    key.SetValue("DisplayName", APP_TITLE);
                    key.SetValue("DisplayVersion", APP_VERSION);
                    key.SetValue("InstallLocation", installDir);
                    key.SetValue("UninstallString", "\"" + uninstallExe + "\" /uninstall");
                    key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                    key.SetValue("Publisher", "MyTemple");
                    key.SetValue("UrlInfoAbout", "https://github.com");
                }
            }
            Console.WriteLine("  已注册到程序和功能");
        }
        catch (Exception ex)
        {
            Console.WriteLine("  警告: 注册卸载失败 - " + ex.Message);
        }
    }

    static void UnregisterUninstall()
    {
        try
        {
            Registry.CurrentUser.DeleteSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + APP_NAME, false);
            Console.WriteLine("  已取消注册");
        }
        catch (Exception ex)
        {
            Console.WriteLine("  警告: 取消注册失败 - " + ex.Message);
        }
    }

    static string ExtractPayload()
    {
        try
        {
            string tempDir = Path.Combine(Path.GetTempPath(), APP_NAME + "_install_" + DateTime.Now.Ticks.ToString());
            Directory.CreateDirectory(tempDir);

            Assembly assembly = Assembly.GetExecutingAssembly();
            using (Stream stream = assembly.GetManifestResourceStream("payload.zip"))
            {
                if (stream == null)
                {
                    Console.WriteLine("  错误: 未找到嵌入的资源");
                    throw new Exception("payload.zip not found in resources");
                }

                using (ZipArchive archive = new ZipArchive(stream))
                {
                    archive.ExtractToDirectory(tempDir);
                }
            }

            Console.WriteLine("  解压完成: " + tempDir);
            return tempDir;
        }
        catch (Exception ex)
        {
            Console.WriteLine("  错误: 解压失败 - " + ex.Message);
            throw;
        }
    }

    static void StopOldProcesses()
    {
        try
        {
            foreach (Process process in Process.GetProcessesByName(APP_NAME))
            {
                Console.WriteLine("  停止进程: " + process.ProcessName + " (PID: " + process.Id + ")");
                try { process.Kill(); process.WaitForExit(2000); } catch { }
            }

            foreach (Process process in Process.GetProcessesByName("node"))
            {
                try
                {
                    if (process.MainModule != null && process.MainModule.FileName.IndexOf("node", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        foreach (ProcessModule module in process.Modules)
                        {
                            if (module.FileName.IndexOf("server.js", StringComparison.OrdinalIgnoreCase) >= 0)
                            {
                                Console.WriteLine("  停止 Node.js 服务 (PID: " + process.Id + ")");
                                try { process.Kill(); process.WaitForExit(2000); } catch { }
                                break;
                            }
                        }
                    }
                }
                catch { }
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("  警告: 清理进程时出错 - " + ex.Message);
        }
    }

    static void CleanupTemp(string tempDir)
    {
        try
        {
            if (Directory.Exists(tempDir))
            {
                Directory.Delete(tempDir, true);
                Console.WriteLine("  已清理临时文件");
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("  警告: 清理临时文件失败 - " + ex.Message);
        }
    }

    static void CopyInstallationFiles(string sourceDir, string installDir)
    {
        try
        {
            if (Directory.Exists(installDir))
            {
                Console.WriteLine("  清理旧安装目录...");
                DeleteDirectory(installDir);
            }

            Directory.CreateDirectory(installDir);

            // 复制文件，但跳过 workspaces.json
            foreach (string file in Directory.GetFiles(sourceDir))
            {
                string fileName = Path.GetFileName(file);
                if (fileName.Equals("workspaces.json", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                string destFile = Path.Combine(installDir, fileName);
                File.Copy(file, destFile, true);
                Console.WriteLine("  复制: " + fileName);
            }

            // 复制子目录
            foreach (string dir in Directory.GetDirectories(sourceDir))
            {
                string dirName = Path.GetFileName(dir);
                string destDir = Path.Combine(installDir, dirName);
                CopyDirectory(dir, destDir);
            }

            Console.WriteLine("  复制完成");
        }
        catch (Exception ex)
        {
            Console.WriteLine("  错误: 复制文件失败 - " + ex.Message);
            throw;
        }
    }

    static void DeleteDirectory(string path)
    {
        try
        {
            DirectoryInfo dir = new DirectoryInfo(path);
            foreach (FileInfo file in dir.GetFiles())
            {
                file.IsReadOnly = false;
                file.Delete();
            }
            foreach (DirectoryInfo subDir in dir.GetDirectories())
            {
                DeleteDirectory(subDir.FullName);
            }
            dir.Delete();
        }
        catch { }
    }

    static void CopyDirectory(string source, string target)
    {
        Directory.CreateDirectory(target);
        foreach (string file in Directory.GetFiles(source))
        {
            string destFile = Path.Combine(target, Path.GetFileName(file));
            File.Copy(file, destFile, true);
            Console.WriteLine("  复制: " + Path.GetFileName(file));
        }
        foreach (string dir in Directory.GetDirectories(source))
        {
            string destDir = Path.Combine(target, Path.GetFileName(dir));
            CopyDirectory(dir, destDir);
        }
    }

    static void InitializeUserData(string installDir, string userDataDir)
    {
        try
        {
            if (!Directory.Exists(userDataDir))
            {
                Directory.CreateDirectory(userDataDir);
            }

            string userDocsPath = Path.Combine(userDataDir, "docs");
            string sourcePath = Path.Combine(userDataDir, "source");

            if (!Directory.Exists(userDocsPath))
            {
                string appDocsPath = Path.Combine(installDir, "docs");
                if (Directory.Exists(appDocsPath))
                {
                    CopyDirectory(appDocsPath, userDocsPath);
                    Console.WriteLine("  初始化文档目录");
                }
                else
                {
                    Directory.CreateDirectory(userDocsPath);
                    string readmeContent = "# MyTemple Knowledge\n\n欢迎使用 MyTemple Knowledge 知识库管理工具。\n\n## 功能特性\n\n- Markdown 文档编辑\n- 阅读模式\n- 目录导航\n- 全局搜索\n- 知识图谱\n";
                    File.WriteAllText(Path.Combine(userDocsPath, "README.md"), readmeContent);
                    Console.WriteLine("  创建默认文档");
                }
            }

            if (!Directory.Exists(sourcePath))
            {
                Directory.CreateDirectory(sourcePath);
                Console.WriteLine("  创建源文件目录");
            }

            string workspacesConfig = Path.Combine(userDataDir, "workspaces.json");
            if (!File.Exists(workspacesConfig))
            {
                string docsRoot = userDocsPath.Replace("\\", "\\\\");
                string workspacesJson = "{\"workspaces\":[{\"id\":\"default\",\"name\":\"默认 docs\",\"root\":\"" + docsRoot + "\",\"visible\":true,\"mdOnly\":true,\"builtin\":true,\"lastUsed\":" + DateTime.Now.Ticks + "}],\"defaultWorkspaceId\":\"default\"}";
                File.WriteAllText(workspacesConfig, workspacesJson);
                Console.WriteLine("  创建工作区配置");
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("  警告: 初始化用户数据失败 - " + ex.Message);
        }
    }

    static void CreateDesktopShortcut(string installDir)
    {
        try
        {
            string desktopPath = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            string shortcutPath = Path.Combine(desktopPath, APP_TITLE + ".lnk");

            if (File.Exists(shortcutPath))
            {
                File.Delete(shortcutPath);
                Console.WriteLine("  更新桌面快捷方式");
            }
            else
            {
                Console.WriteLine("  创建桌面快捷方式");
            }

            string targetPath = Path.Combine(installDir, APP_NAME + ".exe");
            CreateShortcut(shortcutPath, targetPath, installDir, APP_TITLE);
        }
        catch (Exception ex)
        {
            Console.WriteLine("  警告: 创建快捷方式失败 - " + ex.Message);
        }
    }

    static void CreateShortcut(string shortcutPath, string targetPath, string workingDir, string description)
    {
        string iconPath = Path.Combine(workingDir, "logo.ico");
        if (!File.Exists(iconPath))
        {
            iconPath = targetPath;
        }

        string psScript = string.Format(
            "$shell = New-Object -ComObject WScript.Shell; " +
            "$shortcut = $shell.CreateShortcut('{0}'); " +
            "$shortcut.TargetPath = '{1}'; " +
            "$shortcut.WorkingDirectory = '{2}'; " +
            "$shortcut.Description = '{3}'; " +
            "$shortcut.IconLocation = '{4}'; " +
            "$shortcut.Save()",
            shortcutPath, targetPath, workingDir, description, iconPath
        );

        ProcessStartInfo psi = new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -Command \"" + psScript + "\"");
        psi.CreateNoWindow = true;
        psi.UseShellExecute = false;

        using (Process p = Process.Start(psi))
        {
            p.WaitForExit();
            if (p.ExitCode != 0)
            {
                throw new Exception("PowerShell 执行失败，退出码: " + p.ExitCode);
            }
        }
    }

    static void StartApplication(string installDir)
    {
        try
        {
            string exePath = Path.Combine(installDir, APP_NAME + ".exe");
            Process.Start(exePath);
        }
        catch (Exception ex)
        {
            Console.WriteLine("  错误: 启动应用失败 - " + ex.Message);
        }
    }
}