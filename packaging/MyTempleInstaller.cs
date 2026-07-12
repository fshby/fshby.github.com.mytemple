using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Management;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

namespace MyTempleKnowledgeInstaller
{
    internal static class Program
    {
        private const string AppFolderName = "MyTempleKnowledge";
        private const string ShortcutName = "Markdown \u6587\u6863\u77e5\u8bc6\u5e93.lnk";

        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            if (FindNode() == null)
            {
                MessageBox.Show(
                    "\u5f53\u524d\u7535\u8111\u6ca1\u6709\u68c0\u6d4b\u5230 Node.js \u8fd0\u884c\u73af\u5883\u3002\n\n\u8bf7\u5148\u5b89\u88c5 Node.js 18 \u6216\u66f4\u9ad8\u7248\u672c\uff0c\u7136\u540e\u91cd\u65b0\u8fd0\u884c\u672c\u5b89\u88c5\u7a0b\u5e8f\u3002\n\n\u4e0b\u8f7d\u5730\u5740\uff1ahttps://nodejs.org/",
                    "\u7f3a\u5c11\u4f9d\u8d56\u73af\u5883",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
                return;
            }

            try
            {
                string installRoot = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    AppFolderName);
                bool firstInstall = !Directory.Exists(installRoot);
                string dataRoot = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "MyTempleKnowledgeData");
                StopRunningApp(installRoot);
                MigrateUserData(installRoot, dataRoot);

                if (Directory.Exists(installRoot))
                {
                    DeleteDirectoryWithRetry(installRoot);
                }
                Directory.CreateDirectory(installRoot);

                string zipPath = Path.Combine(Path.GetTempPath(), "mytemple-payload-" + Guid.NewGuid().ToString("N") + ".zip");
                ExtractResource("payload.zip", zipPath);
                ZipFile.ExtractToDirectory(zipPath, installRoot);
                File.Delete(zipPath);

                string launcher = Path.Combine(installRoot, "MyTempleKnowledge.exe");
                if (!File.Exists(launcher))
                {
                    throw new FileNotFoundException("MyTempleKnowledge.exe was not found after install.");
                }

                bool shortcutCreated = EnsureShortcut(launcher, installRoot, firstInstall);
                Process.Start(new ProcessStartInfo
                {
                    FileName = launcher,
                    WorkingDirectory = installRoot,
                    UseShellExecute = true
                });

                string message = shortcutCreated
                    ? "\u5df2\u5b8c\u6210\u9996\u6b21\u5b89\u88c5\u5e76\u542f\u52a8\u3002\n\n\u684c\u9762\u5df2\u521b\u5efa\u5feb\u6377\u65b9\u5f0f\uff1aMarkdown \u6587\u6863\u77e5\u8bc6\u5e93"
                    : "\u5df2\u5b8c\u6210\u66f4\u65b0\u5e76\u542f\u52a8\u3002\n\n\u5df2\u68c0\u6d4b\u5230\u73b0\u6709\u684c\u9762\u5feb\u6377\u65b9\u5f0f\uff0c\u672c\u6b21\u4e0d\u91cd\u590d\u521b\u5efa\u3002";
                MessageBox.Show(
                    message,
                    "\u5b89\u88c5\u5b8c\u6210",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            }
            catch (IOException ex)
            {
                MessageBox.Show(
                    "\u5b89\u88c5\u5931\u8d25\u3002\n\n\u5b89\u88c5\u5668\u5df2\u5c1d\u8bd5\u81ea\u52a8\u5173\u95ed\u65e7\u7248\u7a0b\u5e8f\uff0c\u4f46\u4ecd\u6709\u6587\u4ef6\u88ab\u5360\u7528\u3002\n\u8bf7\u68c0\u67e5\u4efb\u52a1\u680f\u6216\u4efb\u52a1\u7ba1\u7406\u5668\u4e2d\u7684\u6587\u6863\u77e5\u8bc6\u5e93\u7a97\u53e3\uff0c\u5173\u95ed\u540e\u518d\u8bd5\u3002\n\n" + ex.Message,
                    "Markdown \u6587\u6863\u77e5\u8bc6\u5e93",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "\u5b89\u88c5\u5931\u8d25\uff1a\n\n" + ex.Message,
                    "Markdown \u6587\u6863\u77e5\u8bc6\u5e93",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
        }

        private static void StopRunningApp(string installRoot)
        {
            foreach (Process process in Process.GetProcessesByName("MyTempleKnowledge"))
            {
                TryCloseProcess(process);
            }

            string normalizedRoot = Path.GetFullPath(installRoot).TrimEnd('\\').ToLowerInvariant();
            try
            {
                using (var searcher = new ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'node.exe'"))
                {
                    foreach (ManagementObject item in searcher.Get())
                    {
                        string commandLine = Convert.ToString(item["CommandLine"]) ?? "";
                        string normalizedCommand = commandLine.ToLowerInvariant();
                        if (!normalizedCommand.Contains("mytempleknowledge") && !normalizedCommand.Contains(normalizedRoot))
                        {
                            continue;
                        }
                        object pidValue = item["ProcessId"];
                        if (pidValue == null) continue;
                        int pid = Convert.ToInt32(pidValue);
                        TryCloseProcess(Process.GetProcessById(pid));
                    }
                }
            }
            catch
            {
            }

            Thread.Sleep(500);
        }

        private static void TryCloseProcess(Process process)
        {
            try
            {
                if (process.HasExited) return;
                if (process.MainWindowHandle != IntPtr.Zero)
                {
                    process.CloseMainWindow();
                    if (process.WaitForExit(2000)) return;
                }
                process.Kill();
                process.WaitForExit(3000);
            }
            catch
            {
            }
            finally
            {
                try { process.Dispose(); } catch { }
            }
        }

        private static void DeleteDirectoryWithRetry(string path)
        {
            IOException lastIo = null;
            UnauthorizedAccessException lastAccess = null;
            for (int attempt = 0; attempt < 6; attempt++)
            {
                try
                {
                    Directory.Delete(path, true);
                    return;
                }
                catch (IOException ex)
                {
                    lastIo = ex;
                }
                catch (UnauthorizedAccessException ex)
                {
                    lastAccess = ex;
                }
                Thread.Sleep(500);
            }
            if (lastIo != null) throw lastIo;
            if (lastAccess != null) throw lastAccess;
        }

        private static void ExtractResource(string resourceName, string outputPath)
        {
            Assembly assembly = Assembly.GetExecutingAssembly();
            using (Stream input = assembly.GetManifestResourceStream(resourceName))
            {
                if (input == null)
                {
                    throw new InvalidOperationException("Embedded payload was not found.");
                }
                using (FileStream output = File.Create(outputPath))
                {
                    input.CopyTo(output);
                }
            }
        }

        private static bool EnsureShortcut(string launcher, string installRoot, bool firstInstall)
        {
            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            string shortcut = Path.Combine(desktop, ShortcutName);

            if (!firstInstall || File.Exists(shortcut))
            {
                return false;
            }

            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(shellType);
            object link = shellType.InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, shell, new object[] { shortcut });
            Type linkType = link.GetType();
            linkType.InvokeMember("TargetPath", System.Reflection.BindingFlags.SetProperty, null, link, new object[] { launcher });
            linkType.InvokeMember("WorkingDirectory", System.Reflection.BindingFlags.SetProperty, null, link, new object[] { installRoot });
            linkType.InvokeMember("IconLocation", System.Reflection.BindingFlags.SetProperty, null, link, new object[] { launcher + ",0" });
            linkType.InvokeMember("Description", System.Reflection.BindingFlags.SetProperty, null, link, new object[] { "Markdown \u6587\u6863\u77e5\u8bc6\u5e93" });
            linkType.InvokeMember("Save", System.Reflection.BindingFlags.InvokeMethod, null, link, null);
            return true;
        }

        private static void MigrateUserData(string installRoot, string dataRoot)
        {
            string dataDocs = Path.Combine(dataRoot, "docs");
            string dataSource = Path.Combine(dataRoot, "source");
            Directory.CreateDirectory(dataDocs);
            Directory.CreateDirectory(dataSource);

            string oldDocs = Path.Combine(installRoot, "docs");
            if (Directory.Exists(oldDocs) && Directory.GetFileSystemEntries(dataDocs).Length == 0)
            {
                CopyDirectory(oldDocs, dataDocs);
            }

            string oldSource = Path.Combine(installRoot, "source");
            if (Directory.Exists(oldSource) && Directory.GetFileSystemEntries(dataSource).Length == 0)
            {
                CopyDirectory(oldSource, dataSource);
            }
        }

        private static void CopyDirectory(string source, string target)
        {
            Directory.CreateDirectory(target);
            foreach (string dir in Directory.GetDirectories(source, "*", SearchOption.AllDirectories))
            {
                Directory.CreateDirectory(dir.Replace(source, target));
            }
            foreach (string file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
            {
                string destination = file.Replace(source, target);
                Directory.CreateDirectory(Path.GetDirectoryName(destination));
                if (!File.Exists(destination))
                {
                    File.Copy(file, destination, false);
                }
            }
        }

        private static string FindNode()
        {
            string[] candidates =
            {
                "node.exe",
                @"D:\node\node.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe")
            };

            foreach (string candidate in candidates)
            {
                string found = ResolveExecutable(candidate);
                if (found != null && IsNodeUsable(found)) return found;
            }
            return null;
        }

        private static string ResolveExecutable(string executable)
        {
            if (File.Exists(executable)) return executable;

            string path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string part in path.Split(Path.PathSeparator))
            {
                try
                {
                    string full = Path.Combine(part.Trim(), executable);
                    if (File.Exists(full)) return full;
                }
                catch
                {
                }
            }
            return null;
        }

        private static bool IsNodeUsable(string node)
        {
            try
            {
                var info = new ProcessStartInfo
                {
                    FileName = node,
                    Arguments = "--version",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    CreateNoWindow = true
                };
                using (Process process = Process.Start(info))
                {
                    if (process == null) return false;
                    process.WaitForExit(2500);
                    return process.ExitCode == 0;
                }
            }
            catch
            {
                return false;
            }
        }
    }
}
