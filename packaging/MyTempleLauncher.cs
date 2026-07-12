using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

namespace MyTempleKnowledge
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new LauncherForm());
        }
    }

    internal sealed class LauncherForm : Form
    {
        private const int DefaultPort = 4173;

        private readonly Label titleLabel;
        private readonly Label statusLabel;
        private readonly Button openButton;
        private readonly Button closeButton;
        private Process serverProcess;
        private string currentUrl;

        public LauncherForm()
        {
            Text = "\u0053\u0044\u0058\u004c \u6587\u6863\u77e5\u8bc6\u5e93";
            Width = 430;
            Height = 210;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ShowInTaskbar = true;

            titleLabel = new Label
            {
                Left = 24,
                Top = 22,
                Width = 360,
                Height = 30,
                Font = new Font("Segoe UI", 14, FontStyle.Bold),
                Text = "Markdown \u6587\u6863\u77e5\u8bc6\u5e93"
            };

            statusLabel = new Label
            {
                Left = 25,
                Top = 64,
                Width = 360,
                Height = 42,
                Font = new Font("Segoe UI", 10),
                Text = "\u6b63\u5728\u542f\u52a8\u672c\u5730\u670d\u52a1..."
            };

            openButton = new Button
            {
                Left = 25,
                Top = 124,
                Width = 150,
                Height = 34,
                Text = "\u6253\u5f00\u77e5\u8bc6\u5e93",
                Enabled = false
            };
            openButton.Click += delegate { OpenBrowser(); };

            closeButton = new Button
            {
                Left = 190,
                Top = 124,
                Width = 150,
                Height = 34,
                Text = "\u5173\u95ed\u5e76\u9000\u51fa"
            };
            closeButton.Click += delegate { Close(); };

            Controls.Add(titleLabel);
            Controls.Add(statusLabel);
            Controls.Add(openButton);
            Controls.Add(closeButton);

            Shown += delegate { ThreadPool.QueueUserWorkItem(delegate { StartApplication(); }); };
            FormClosing += OnFormClosing;
        }

        private void StartApplication()
        {
            try
            {
                string appDir = AppDomain.CurrentDomain.BaseDirectory;
                string serverFile = Path.Combine(appDir, "server.js");
                if (!File.Exists(serverFile))
                {
                    Fail("\u6ca1\u6709\u627e\u5230 server.js\u3002\n\n\u8bf7\u786e\u8ba4\u7a0b\u5e8f\u6587\u4ef6\u5b8c\u6574\uff0c\u6216\u91cd\u65b0\u8fd0\u884c\u5b89\u88c5\u7a0b\u5e8f\u3002");
                    return;
                }

                string node = FindNode();
                if (node == null)
                {
                    Fail("\u5f53\u524d\u7535\u8111\u6ca1\u6709\u68c0\u6d4b\u5230 Node.js \u8fd0\u884c\u73af\u5883\u3002\n\n\u8bf7\u5148\u5b89\u88c5 Node.js 18 \u6216\u66f4\u9ad8\u7248\u672c\uff0c\u7136\u540e\u91cd\u65b0\u542f\u52a8\u672c\u7a0b\u5e8f\u3002\n\n\u4e0b\u8f7d\u5730\u5740\uff1ahttps://nodejs.org/");
                    return;
                }

                int port = FindAvailablePort(DefaultPort);
                string dataRoot = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "MyTempleKnowledgeData");
                string docsRoot = Path.Combine(dataRoot, "docs");
                string sourceRoot = Path.Combine(dataRoot, "source");
                EnsureDataRoot(appDir, docsRoot, sourceRoot);

                serverProcess = StartServer(node, serverFile, appDir, docsRoot, sourceRoot, port);
                serverProcess.EnableRaisingEvents = true;
                serverProcess.Exited += delegate
                {
                    SafeUi(delegate
                    {
                        statusLabel.Text = "\u540e\u53f0\u670d\u52a1\u5df2\u505c\u6b62\u3002";
                        openButton.Enabled = false;
                    });
                };

                currentUrl = "http://localhost:" + port + "/";
                WaitForServer(currentUrl);
                SafeUi(delegate
                {
                    statusLabel.Text = "\u5df2\u542f\u52a8\uff1a" + currentUrl + "\n\u5173\u95ed\u6b64\u7a97\u53e3\u5373\u53ef\u505c\u6b62\u540e\u53f0\u670d\u52a1\u3002";
                    openButton.Enabled = true;
                });
                OpenBrowser();
            }
            catch (Exception ex)
            {
                Fail("\u542f\u52a8\u5931\u8d25\uff1a\n\n" + ex.Message);
            }
        }

        private void EnsureDataRoot(string appDir, string docsRoot, string sourceRoot)
        {
            Directory.CreateDirectory(docsRoot);
            Directory.CreateDirectory(sourceRoot);

            string bundledDocs = Path.Combine(appDir, "docs");
            if (Directory.GetFileSystemEntries(docsRoot).Length == 0 && Directory.Exists(bundledDocs))
            {
                CopyDirectory(bundledDocs, docsRoot);
            }

            string bundledSource = Path.Combine(appDir, "source");
            if (Directory.GetFileSystemEntries(sourceRoot).Length == 0 && Directory.Exists(bundledSource))
            {
                CopyDirectory(bundledSource, sourceRoot);
            }
        }

        private void CopyDirectory(string source, string target)
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
                File.Copy(file, destination, false);
            }
        }

        private Process StartServer(string node, string serverFile, string appDir, string docsRoot, string sourceRoot, int port)
        {
            var info = new ProcessStartInfo
            {
                FileName = node,
                Arguments = "\"" + serverFile + "\"",
                WorkingDirectory = appDir,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            info.EnvironmentVariables["PORT"] = port.ToString();
            info.EnvironmentVariables["MYTEMPLE_DOCS_ROOT"] = docsRoot;
            info.EnvironmentVariables["MYTEMPLE_SOURCE_ROOT"] = sourceRoot;
            return Process.Start(info);
        }

        private void OpenBrowser()
        {
            if (String.IsNullOrEmpty(currentUrl)) return;
            try
            {
                Process.Start(currentUrl);
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            try
            {
                if (serverProcess != null && !serverProcess.HasExited)
                {
                    serverProcess.Kill();
                    serverProcess.WaitForExit(2000);
                }
            }
            catch
            {
            }
        }

        private void SafeUi(Action action)
        {
            if (IsDisposed) return;
            if (InvokeRequired) BeginInvoke(action);
            else action();
        }

        private void Fail(string message)
        {
            SafeUi(delegate
            {
                statusLabel.Text = "\u542f\u52a8\u5931\u8d25";
                openButton.Enabled = false;
                MessageBox.Show(message, Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
            });
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

        private static int FindAvailablePort(int preferred)
        {
            if (IsPortFree(preferred)) return preferred;
            for (int port = preferred + 1; port < preferred + 50; port++)
            {
                if (IsPortFree(port)) return port;
            }
            return preferred;
        }

        private static bool IsPortFree(int port)
        {
            try
            {
                var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, port);
                listener.Start();
                listener.Stop();
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static void WaitForServer(string url)
        {
            for (int i = 0; i < 30; i++)
            {
                try
                {
                    var request = WebRequest.Create(url);
                    request.Timeout = 500;
                    using (request.GetResponse())
                    {
                        return;
                    }
                }
                catch
                {
                    Thread.Sleep(250);
                }
            }
        }
    }
}
