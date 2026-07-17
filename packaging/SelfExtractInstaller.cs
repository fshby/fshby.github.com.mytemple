using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
using System.IO.Compression;

class SelfExtractInstaller
{
    const string APP_NAME = "MyTempleKnowledge";
    const string APP_TITLE = "MyTemple Knowledge";
    const string APP_VERSION = "1.0.0";

    static void Main(string[] args)
    {
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

        Console.WriteLine("[1/5] 停止旧进程...");
        StopOldProcesses();
        Thread.Sleep(1000);

        Console.WriteLine("[2/5] 解压安装文件...");
        string tempDir = ExtractPayload();
        Thread.Sleep(500);

        Console.WriteLine("[3/5] 复制安装文件...");
        CopyInstallationFiles(tempDir, installDir);
        Thread.Sleep(500);

        Console.WriteLine("[4/5] 初始化用户数据...");
        InitializeUserData(installDir, userDataDir);
        Thread.Sleep(500);

        Console.WriteLine("[5/5] 创建桌面快捷方式...");
        CreateDesktopShortcut(installDir);
        Thread.Sleep(500);

        Console.WriteLine("[6/5] 清理临时文件...");
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

            CopyDirectory(sourceDir, installDir);
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

            string docsPath = Path.Combine(userDataDir, "docs");
            string sourcePath = Path.Combine(userDataDir, "source");

            if (!Directory.Exists(docsPath))
            {
                string appDocsPath = Path.Combine(installDir, "docs");
                if (Directory.Exists(appDocsPath))
                {
                    CopyDirectory(appDocsPath, docsPath);
                    Console.WriteLine("  初始化文档目录");
                }
                else
                {
                    Directory.CreateDirectory(docsPath);
                    string readmeContent = "# MyTemple Knowledge\n\n欢迎使用 MyTemple Knowledge 知识库管理工具。\n\n## 功能特性\n\n- Markdown 文档编辑\n- 阅读模式\n- 目录导航\n- 全局搜索\n- 知识图谱\n";
                    File.WriteAllText(Path.Combine(docsPath, "README.md"), readmeContent);
                    Console.WriteLine("  创建默认文档");
                }
            }

            if (!Directory.Exists(sourcePath))
            {
                Directory.CreateDirectory(sourcePath);
                Console.WriteLine("  创建源文件目录");
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