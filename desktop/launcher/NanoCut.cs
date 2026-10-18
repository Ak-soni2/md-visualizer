// NanoCut desktop launcher (PLAN_PHASE3.md §5). Compiled by desktop/build_windows.py with the .NET Framework csc.exe
// that ships with Windows; no other tool or runtime is needed.
//
// Starts the bundled Python backend (python\python.exe -m uvicorn webapp.backend.app.main:app) hidden on a free local
// port, waits until it answers, opens the workstation in its own app window (Edge or Chrome app mode, else the default
// browser), sits in the notification area (open again / logs / quit), and stops the backend a few minutes after the last
// window was closed: open pages poll /api/health, the launcher reads /api/desktop/idle. A crashed backend is restarted.
// A second start waits until the backend answers before opening a window. One instance at a time. Log: %LOCALAPPDATA%\NanoCut\logs\launcher.log and server.log.
//
//   NanoCut.exe            normal start
//   NanoCut.exe --check    start the backend, check /api/health and /api/ovito/status, stop; exit code 0 = OK
//   NanoCut.exe --browser  use the default browser instead of an app window
//   NanoCut.exe --no-update   skip the update check (also: environment variable NANOCUT_NO_UPDATE=1)
//
// Updates: after start the launcher asks GitHub for the latest release of BuildInfo.Repo (built by the CI workflow on
// every push to main). When it is newer than BuildInfo.Version it offers to install it: the installer is downloaded,
// run silently into this folder with /launch, and the app restarts. "No" skips that version.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("NanoCut Studio")]
[assembly: AssemblyDescription("Nanometric cutting MD: deck generator, OVITO analysis, Graph Studio")]

static class NanoCut
{
    static string AppDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
    static string DataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NanoCut");
    static string LogDir = Path.Combine(DataDir, "logs");
    static Process server;
    static StreamWriter serverLog;

    static void Log(string msg)
    {
        try { File.AppendAllText(Path.Combine(LogDir, "launcher.log"), DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss ") + msg + Environment.NewLine); } catch { }
    }

    static int FreePort(int preferred)
    {
        foreach (int p in new[] { preferred, 0 })
        {
            try { var l = new TcpListener(IPAddress.Loopback, p); l.Start(); int port = ((IPEndPoint)l.LocalEndpoint).Port; l.Stop(); return port; }
            catch { }
        }
        return preferred;
    }

    static string Get(string url, int timeoutMs)
    {
        var req = (HttpWebRequest)WebRequest.Create(url);
        req.Timeout = timeoutMs; req.Proxy = null;
        using (var r = req.GetResponse()) using (var s = new StreamReader(r.GetResponseStream())) return s.ReadToEnd();
    }

    static bool StartServer(int port)
    {
        string py = Path.Combine(AppDir, "python", "python.exe"), app = Path.Combine(AppDir, "app");
        if (!File.Exists(py)) { MessageBox.Show("The bundled Python was not found:\n" + py + "\n\nReinstall NanoCut.", "NanoCut", MessageBoxButtons.OK, MessageBoxIcon.Error); return false; }
        var psi = new ProcessStartInfo(py, "-m uvicorn webapp.backend.app.main:app --host 127.0.0.1 --port " + port)
        { WorkingDirectory = app, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        psi.EnvironmentVariables["PYTHONHOME"] = Path.Combine(AppDir, "python");
        psi.EnvironmentVariables["PYTHONPATH"] = app;
        psi.EnvironmentVariables["PYTHONNOUSERSITE"] = "1";
        psi.EnvironmentVariables["PYTHONUTF8"] = "1";
        psi.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
        psi.EnvironmentVariables["NANOCUT_DESKTOP"] = "1";
        psi.EnvironmentVariables.Remove("PYTHONSTARTUP");
        serverLog = new StreamWriter(Path.Combine(LogDir, "server.log"), false) { AutoFlush = true };
        server = new Process { StartInfo = psi };
        server.OutputDataReceived += (s, e) => { if (e.Data != null) lock (serverLog) serverLog.WriteLine(e.Data); };
        server.ErrorDataReceived += (s, e) => { if (e.Data != null) lock (serverLog) serverLog.WriteLine(e.Data); };
        server.Start();
        server.BeginOutputReadLine(); server.BeginErrorReadLine();
        Log("server pid " + server.Id + " port " + port);
        return true;
    }

    static bool WaitHealthy(int port, int seconds, Action<string> status)
    {
        var sw = Stopwatch.StartNew();
        while (sw.Elapsed.TotalSeconds < seconds)
        {
            if (server.HasExited) { Log("server exited with code " + server.ExitCode); return false; }
            try { Get("http://127.0.0.1:" + port + "/api/health", 3000); return true; } catch { }
            if (status != null) status(string.Format("Starting the analysis engine… {0:0} s", sw.Elapsed.TotalSeconds));
            Thread.Sleep(400);
        }
        return false;
    }

    static void StopServer()
    {
        try
        {
            if (server != null && !server.HasExited)
            {
                // the backend starts an OVITO worker process: stop the whole tree
                var k = Process.Start(new ProcessStartInfo("taskkill", "/T /F /PID " + server.Id) { CreateNoWindow = true, UseShellExecute = false });
                k.WaitForExit(10000);
            }
        }
        catch (Exception e) { Log("stop: " + e.Message); }
    }

    static string FindBrowser()
    {
        string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
               la = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        foreach (var p in new[] {
            Path.Combine(pf86, @"Microsoft\Edge\Application\msedge.exe"), Path.Combine(pf, @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(pf, @"Google\Chrome\Application\chrome.exe"), Path.Combine(pf86, @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(la, @"Google\Chrome\Application\chrome.exe") })
            if (File.Exists(p)) return p;
        return null;
    }

    static void Out(string line)
    {
        Console.WriteLine(line);
        try { File.AppendAllText(Path.Combine(LogDir, "check.log"), line + Environment.NewLine); } catch { }
    }

    static int Check()
    {
        try { File.Delete(Path.Combine(LogDir, "check.log")); } catch { }
        Directory.CreateDirectory(LogDir);
        int port = FreePort(8611);
        if (!StartServer(port)) return 2;
        try
        {
            if (!WaitHealthy(port, 180, null)) { Out("FAIL: backend did not start (see " + Path.Combine(LogDir, "server.log") + ")"); return 1; }
            Out("health: " + Get("http://127.0.0.1:" + port + "/api/health", 10000));
            Out("ovito:  " + Get("http://127.0.0.1:" + port + "/api/ovito/status", 180000));
            Out("app:    " + Get("http://127.0.0.1:" + port + "/app/", 10000).Length + " bytes");
            Out("OK");
            return 0;
        }
        catch (Exception e) { Out("FAIL: " + e.Message); return 1; }
        finally { StopServer(); }
    }

    static int Port;
    static string Url, BrowserExe;
    static NotifyIcon Tray;
    const int IdleLimitS = 180;                 // no request from any window for this long (page polls every 15 s) -> stop
    const int StartTimeoutS = 300;              // first start on a new PC can be slow (antivirus scans ~10,000 files)

    static void OpenWindow()
    {
        try
        {
            if (BrowserExe != null)
                Process.Start(new ProcessStartInfo(BrowserExe, string.Format("--app=\"{0}\" --user-data-dir=\"{1}\" --no-first-run --no-default-browser-check --window-size=1440,900",
                    Url, Path.Combine(DataDir, "window"))) { UseShellExecute = false });
            else Process.Start(Url);
            Log("window opened " + (BrowserExe ?? "default browser") + " " + Url);
        }
        catch (Exception e) { Log("open window: " + e.Message); try { Process.Start(Url); } catch { } }
    }

    static bool Healthy(int port)
    {
        try { Get("http://127.0.0.1:" + port + "/api/health", 3000); return true; } catch { return false; }
    }

    [STAThread]
    static int Main(string[] args)
    {
        Directory.CreateDirectory(LogDir);
        bool check = Array.IndexOf(args, "--check") >= 0, useBrowser = Array.IndexOf(args, "--browser") >= 0;
        if (check) return Check();
        Application.EnableVisualStyles();
        BrowserExe = useBrowser ? null : FindBrowser();
        string portFile = Path.Combine(DataDir, "port.txt");
        bool first;
        using (var mutex = new Mutex(true, @"Local\NanoCutWorkstation", out first))
        {
            if (!first)
            {
                // NanoCut Studio is already starting or running: wait until its server answers, then open a window.
                // (Opening the page before the server listens is what shows "refused to connect".)
                var sw = Stopwatch.StartNew();
                while (sw.Elapsed.TotalSeconds < StartTimeoutS)
                {
                    int p;
                    if (File.Exists(portFile) && int.TryParse(File.ReadAllText(portFile).Trim(), out p) && Healthy(p))
                    {
                        Url = "http://127.0.0.1:" + p + "/app/";
                        OpenWindow();
                        return 0;
                    }
                    Thread.Sleep(500);
                }
                MessageBox.Show("NanoCut Studio is still starting. Please wait a moment and open it again.", "NanoCut Studio", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 0;
            }
            try { File.Delete(portFile); } catch { }                         // a stale file of a crashed run
            var splash = new Form { Text = "NanoCut Studio " + BuildInfo.Version, Width = 440, Height = 150, StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false };
            Icon icon = null;
            try { icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); splash.Icon = icon; } catch { }
            var lab = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Segoe UI", 10f), Text = "Starting NanoCut Studio…" };
            splash.Controls.Add(lab);
            splash.Show(); Application.DoEvents();
            Port = FreePort(8600);
            if (!StartServer(Port)) return 1;
            bool ok = WaitHealthy(Port, StartTimeoutS, x => { lab.Text = x + "\n(the first start on a new computer takes longer)"; Application.DoEvents(); });
            splash.Close();
            if (!ok)
            {
                MessageBox.Show("The NanoCut Studio engine did not start.\n\nPlease send this file to the developer:\n" + Path.Combine(LogDir, "server.log"),
                    "NanoCut Studio", MessageBoxButtons.OK, MessageBoxIcon.Error);
                StopServer(); return 1;
            }
            File.WriteAllText(portFile, Port.ToString());
            Url = "http://127.0.0.1:" + Port + "/app/";
            OpenWindow();
            try
            {
                // the server lives as long as a window uses it: every open page polls /api/health; the launcher stays in
                // the notification area (open again, logs, quit) and stops the server a few minutes after the last
                // window was closed (never while an analysis job runs). A crashed server is restarted.
                var menu = new ContextMenu();
                menu.MenuItems.Add("Open NanoCut Studio", (x, e) => OpenWindow());
                menu.MenuItems.Add("Show log files", (x, e) => Process.Start("explorer.exe", "\"" + LogDir + "\""));
                menu.MenuItems.Add("-");
                menu.MenuItems.Add("Quit NanoCut Studio", (x, e) => Application.ExitThread());
                Tray = new NotifyIcon { Icon = icon ?? SystemIcons.Application, Text = "NanoCut Studio " + BuildInfo.Version, ContextMenu = menu, Visible = true };
                Tray.DoubleClick += (x, e) => OpenWindow();
                Tray.ShowBalloonTip(6000, "NanoCut Studio is running", "Closed the window by mistake? Double-click this icon. Right-click → Quit to stop it.", ToolTipIcon.Info);
                StartUpdateCheck(args, null);
                int restarts = 0;
                var timer = new System.Windows.Forms.Timer { Interval = 10000 };
                timer.Tick += (x, e) =>
                {
                    if (server.HasExited)
                    {
                        Log("server exited unexpectedly, code " + server.ExitCode);
                        if (restarts++ < 3 && StartServer(Port) && WaitHealthy(Port, 120, null))
                        {
                            Tray.ShowBalloonTip(5000, "NanoCut Studio", "The engine was restarted. Reload the page (F5) if it shows an error.", ToolTipIcon.Warning);
                            return;
                        }
                        timer.Stop();
                        MessageBox.Show("The NanoCut Studio engine stopped.\n\nDetails: " + Path.Combine(LogDir, "server.log"), "NanoCut Studio", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        Application.ExitThread();
                        return;
                    }
                    try
                    {
                        string j = Get("http://127.0.0.1:" + Port + "/api/desktop/idle", 5000);
                        double idle = double.Parse(Regex.Match(j, "\"idle_s\"\\s*:\\s*([0-9.]+)").Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture);
                        int jobs = int.Parse(Regex.Match(j, "\"jobs_running\"\\s*:\\s*([0-9]+)").Groups[1].Value);
                        if (idle > IdleLimitS && jobs == 0) { Log("no window for " + idle + " s: stopping"); timer.Stop(); Application.ExitThread(); }
                    }
                    catch (Exception ex) { Log("idle check: " + ex.Message); }
                };
                timer.Start();
                Application.Run();
            }
            finally
            {
                if (Tray != null) Tray.Visible = false;
                StopServer(); try { File.Delete(portFile); } catch { } Log("stopped");
            }
        }
        return 0;
    }

    // ------------------------------------------------------------------------------------------ updates
    static long[] Ver(string v)
    {
        var parts = v.TrimStart('v', 'V').Split('.');
        var o = new long[4];
        for (int i = 0; i < Math.Min(4, parts.Length); i++) long.TryParse(parts[i], out o[i]);
        return o;
    }
    static bool Newer(string a, string b)
    {
        long[] x = Ver(a), y = Ver(b);
        for (int i = 0; i < 4; i++) if (x[i] != y[i]) return x[i] > y[i];
        return false;
    }

    static void StartUpdateCheck(string[] args, Action closeWindow)
    {
        if (Array.IndexOf(args, "--no-update") >= 0 || Environment.GetEnvironmentVariable("NANOCUT_NO_UPDATE") == "1") return;
        var t = new Thread(() =>
        {
            try
            {
                Thread.Sleep(4000);
                ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
                var req = (HttpWebRequest)WebRequest.Create("https://api.github.com/repos/" + BuildInfo.Repo + "/releases/latest");
                req.UserAgent = "NanoCut-Studio-launcher"; req.Accept = "application/vnd.github+json"; req.Timeout = 15000;
                string json;
                using (var r = req.GetResponse()) using (var sr = new StreamReader(r.GetResponseStream())) json = sr.ReadToEnd();
                string tag = Regex.Match(json, "\"tag_name\"\\s*:\\s*\"([^\"]+)\"").Groups[1].Value;
                string asset = Regex.Match(json, "\"browser_download_url\"\\s*:\\s*\"([^\"]*/" + Regex.Escape(BuildInfo.Asset) + ")\"").Groups[1].Value;
                Log("update check: installed " + BuildInfo.Version + ", latest " + tag);
                if (tag == "" || asset == "" || !Newer(tag, BuildInfo.Version)) return;
                string skip = Path.Combine(DataDir, "skip_version.txt");
                if (File.Exists(skip) && File.ReadAllText(skip).Trim() == tag) return;
                var ans = MessageBox.Show("A new version of NanoCut Studio is available.\n\nInstalled: " + BuildInfo.Version + "\nAvailable: " + tag.TrimStart('v') +
                    "\n\nDownload and install it now? NanoCut Studio closes and restarts by itself (about a minute).\n\nNo = skip this version.",
                    "NanoCut Studio update", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Information, MessageBoxDefaultButton.Button1, MessageBoxOptions.DefaultDesktopOnly);
                if (ans == DialogResult.No) { File.WriteAllText(skip, tag); return; }
                if (ans != DialogResult.Yes) return;
                string setup = Path.Combine(Path.GetTempPath(), "NanoCut-Studio-update-" + tag + ".exe");
                using (var wc = new WebClient()) { wc.Headers["User-Agent"] = "NanoCut-Studio-launcher"; wc.DownloadFile(asset, setup); }
                Log("update downloaded " + setup);
                if (closeWindow != null) closeWindow();
                StopServer();
                Process.Start(new ProcessStartInfo(setup, "/S /D=\"" + AppDir + "\" /launch") { UseShellExecute = false });
                Environment.Exit(0);
            }
            catch (Exception e) { Log("update check failed: " + e.Message); }
        }) { IsBackground = true };
        t.Start();
    }
}
