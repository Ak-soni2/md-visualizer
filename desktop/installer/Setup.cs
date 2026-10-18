// NanoCut installer and uninstaller (PLAN_PHASE3.md §5). Compiled by desktop/build_windows.py with the .NET Framework
// csc.exe that ships with Windows. The application is a ZIP appended to this executable, followed by a 24-byte trailer
// ("NCPAYLD1", payload offset, payload length; little-endian int64). Per-user install: no administrator rights.
//
//   NanoCut-Setup.exe                              install with a small dialog
//   NanoCut-Setup.exe /S [/D=<folder>] [/noshortcuts] [/noregistry] [/nolaunch]   silent install
//   Uninstall.exe [/S]                            (this program without payload, copied into the install folder)
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("NanoCut Setup")]
[assembly: AssemblyProduct("NanoCut MD workstation")]
[assembly: AssemblyVersion("0.3.0.0")]

static class Setup
{
    const string Name = "NanoCut", Publisher = "NanoCut (IIT Jodhpur BTP)", Magic = "NCPAYLD1";
    const string UninstKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\NanoCut";
    static string Version = "0.3.0";
    static string Self = Assembly.GetExecutingAssembly().Location;

    static string DefaultDir()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", Name);
    }

    // a read-only window onto the ZIP inside this executable (ZipArchive needs a seekable stream that starts at the ZIP)
    class Window : Stream
    {
        readonly Stream s; readonly long off, len; long pos;
        public Window(Stream s, long off, long len) { this.s = s; this.off = off; this.len = len; }
        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return true; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { return len; } }
        public override long Position { get { return pos; } set { pos = value; } }
        public override void Flush() { }
        public override int Read(byte[] b, int o, int c)
        {
            if (pos >= len) return 0;
            if (c > len - pos) c = (int)(len - pos);
            s.Position = off + pos;
            int n = s.Read(b, o, c); pos += n; return n;
        }
        public override long Seek(long o, SeekOrigin w) { pos = w == SeekOrigin.Begin ? o : w == SeekOrigin.Current ? pos + o : len + o; return pos; }
        public override void SetLength(long v) { throw new NotSupportedException(); }
        public override void Write(byte[] b, int o, int c) { throw new NotSupportedException(); }
    }

    static bool Payload(Stream f, out long off, out long len)
    {
        off = len = 0;
        if (f.Length < 24) return false;
        var t = new byte[24];
        f.Position = f.Length - 24; f.Read(t, 0, 24);
        if (Encoding.ASCII.GetString(t, 0, 8) != Magic) return false;
        off = BitConverter.ToInt64(t, 8); len = BitConverter.ToInt64(t, 16);
        return off > 0 && off + len + 24 == f.Length;
    }

    static string Arg(string[] args, string prefix)
    {
        foreach (var a in args) if (a.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return a.Substring(prefix.Length).Trim('"');
        return null;
    }
    static bool Has(string[] args, string flag) { foreach (var a in args) if (string.Equals(a, flag, StringComparison.OrdinalIgnoreCase)) return true; return false; }

    static void StopRunning(string dir)
    {
        // a running NanoCut (its Python backend and OVITO worker) would keep files locked
        foreach (var p in Process.GetProcesses())
        {
            try
            {
                string path = p.MainModule.FileName;
                if (path.StartsWith(dir, StringComparison.OrdinalIgnoreCase)) { p.Kill(); p.WaitForExit(5000); }
            }
            catch { }
        }
    }

    static void Install(Stream f, long off, long len, string dir, bool shortcuts, bool registry, Action<int, string> progress)
    {
        Directory.CreateDirectory(dir);
        StopRunning(dir);
        foreach (var sub in new[] { "python", "app" })                      // an older version: replace, never mix
        {
            string d = Path.Combine(dir, sub);
            if (Directory.Exists(d)) { progress(0, "Removing the previous version…"); Directory.Delete(d, true); }
        }
        long total = 0, done = 0;
        using (var zip = new ZipArchive(new Window(f, off, len), ZipArchiveMode.Read))
        {
            foreach (var e in zip.Entries) total += e.Length;
            string root = Path.GetFullPath(dir) + Path.DirectorySeparatorChar;
            int i = 0;
            foreach (var e in zip.Entries)
            {
                string target = Path.GetFullPath(Path.Combine(dir, e.FullName));
                if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("bad path in package: " + e.FullName);
                if (e.FullName.EndsWith("/")) { Directory.CreateDirectory(target); continue; }
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                e.ExtractToFile(target, true);
                done += e.Length;
                if (++i % 50 == 0) progress((int)(done * 100 / Math.Max(1, total)), e.FullName);
            }
        }
        File.Copy(Self, Path.Combine(dir, "Uninstall.exe.tmp"), true);       // the uninstaller = this program without payload
        TrimPayload(Path.Combine(dir, "Uninstall.exe.tmp"), off, Path.Combine(dir, "Uninstall.exe"));
        string exe = Path.Combine(dir, "NanoCut.exe");
        if (shortcuts)
        {
            progress(100, "Creating shortcuts…");
            string menu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), Name);
            Directory.CreateDirectory(menu);
            Shortcut(Path.Combine(menu, "NanoCut.lnk"), exe, dir, "NanoCut MD workstation");
            Shortcut(Path.Combine(menu, "Uninstall NanoCut.lnk"), Path.Combine(dir, "Uninstall.exe"), dir, "Remove NanoCut");
            Shortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "NanoCut.lnk"), exe, dir, "NanoCut MD workstation");
        }
        if (registry)
        {
            using (var k = Registry.CurrentUser.CreateSubKey(UninstKey))
            {
                k.SetValue("DisplayName", "NanoCut MD workstation");
                k.SetValue("DisplayVersion", Version);
                k.SetValue("Publisher", Publisher);
                k.SetValue("InstallLocation", dir);
                k.SetValue("DisplayIcon", exe);
                k.SetValue("UninstallString", "\"" + Path.Combine(dir, "Uninstall.exe") + "\"");
                k.SetValue("QuietUninstallString", "\"" + Path.Combine(dir, "Uninstall.exe") + "\" /S");
                k.SetValue("EstimatedSize", (int)(total / 1024), RegistryValueKind.DWord);
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
        }
    }

    static void TrimPayload(string src, long off, string dst)
    {
        using (var i = File.OpenRead(src)) using (var o = File.Create(dst))
        {
            var buf = new byte[1 << 20]; long left = off;
            while (left > 0) { int n = i.Read(buf, 0, (int)Math.Min(buf.Length, left)); if (n <= 0) break; o.Write(buf, 0, n); left -= n; }
        }
        File.Delete(src);
    }

    static void Shortcut(string lnk, string target, string workdir, string desc)
    {
        Type t = Type.GetTypeFromProgID("WScript.Shell");
        object sh = Activator.CreateInstance(t);
        object sc = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, sh, new object[] { lnk });
        Type st = sc.GetType();
        st.InvokeMember("TargetPath", BindingFlags.SetProperty, null, sc, new object[] { target });
        st.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, sc, new object[] { workdir });
        st.InvokeMember("Description", BindingFlags.SetProperty, null, sc, new object[] { desc });
        st.InvokeMember("IconLocation", BindingFlags.SetProperty, null, sc, new object[] { Path.Combine(workdir, "NanoCut.exe") + ",0" });
        st.InvokeMember("Save", BindingFlags.InvokeMethod, null, sc, null);
    }

    static int Uninstall(bool silent)
    {
        string dir = Path.GetDirectoryName(Self);
        if (!silent && MessageBox.Show("Remove NanoCut from " + dir + "?\n\nYour dump files and results elsewhere are not touched.", "Uninstall NanoCut",
                MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return 1;
        StopRunning(Path.Combine(dir, "python"));
        string menu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), Name);
        try { if (Directory.Exists(menu)) Directory.Delete(menu, true); } catch { }
        try { File.Delete(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "NanoCut.lnk")); } catch { }
        try { Registry.CurrentUser.DeleteSubKeyTree(UninstKey, false); } catch { }
        // this program runs from the folder: a short-lived cmd removes the folder after it has exited
        Process.Start(new ProcessStartInfo("cmd.exe", "/c ping -n 3 127.0.0.1 >nul & rmdir /s /q \"" + dir + "\"") { CreateNoWindow = true, UseShellExecute = false });
        if (!silent) MessageBox.Show("NanoCut was removed.", "Uninstall NanoCut", MessageBoxButtons.OK, MessageBoxIcon.Information);
        return 0;
    }

    [STAThread]
    static int Main(string[] args)
    {
        bool silent = Has(args, "/S");
        FileStream f = File.OpenRead(Self);
        long off, len;
        if (!Payload(f, out off, out len)) { f.Dispose(); return Uninstall(silent); }
        string dir = Arg(args, "/D=") ?? DefaultDir();
        bool shortcuts = !Has(args, "/noshortcuts"), registry = !Has(args, "/noregistry");
        if (silent)
        {
            try { Install(f, off, len, dir, shortcuts, registry, (p, m) => { }); Console.WriteLine("installed to " + dir); return 0; }
            catch (Exception e) { Console.Error.WriteLine(e); try { File.WriteAllText(Path.Combine(Path.GetTempPath(), "nanocut-setup-error.txt"), e.ToString()); } catch { } return 1; }
            finally { f.Dispose(); }
        }
        Application.EnableVisualStyles();
        var form = new Form { Text = "Install NanoCut " + Version, Width = 560, Height = 300, StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false };
        try { form.Icon = Icon.ExtractAssociatedIcon(Self); } catch { }
        var font = new Font("Segoe UI", 9.5f);
        var head = new Label { Text = "NanoCut MD workstation — deck generator, OVITO analysis, research graphs.\nEverything it needs (Python, OVITO, libraries) is included; no internet and no administrator rights are needed.", Left = 16, Top = 14, Width = 510, Height = 48, Font = font };
        var dl = new Label { Text = "Install folder", Left = 16, Top = 72, Width = 100, Font = font };
        var box = new TextBox { Text = dir, Left = 16, Top = 94, Width = 420, Font = font };
        var browse = new Button { Text = "Browse…", Left = 444, Top = 92, Width = 82, Font = font };
        browse.Click += (s, e) => { using (var d = new FolderBrowserDialog { SelectedPath = box.Text }) if (d.ShowDialog() == DialogResult.OK) box.Text = Path.Combine(d.SelectedPath, Name); };
        var desk = new CheckBox { Text = "Start-menu and desktop shortcuts", Checked = true, Left = 16, Top = 128, Width = 300, Font = font };
        var bar = new ProgressBar { Left = 16, Top = 162, Width = 510, Height = 18 };
        var status = new Label { Left = 16, Top = 186, Width = 510, Height = 20, Font = font, AutoEllipsis = true };
        var go = new Button { Text = "Install", Left = 350, Top = 216, Width = 86, Font = font };
        var cancel = new Button { Text = "Cancel", Left = 440, Top = 216, Width = 86, Font = font };
        cancel.Click += (s, e) => form.Close();
        bool installed = false;
        go.Click += (s, e) =>
        {
            if (installed) { Process.Start(Path.Combine(box.Text, "NanoCut.exe")); form.Close(); return; }
            go.Enabled = browse.Enabled = box.Enabled = desk.Enabled = false; cancel.Enabled = false;
            string target = box.Text; bool sc = desk.Checked;
            var th = new Thread(() =>
            {
                try
                {
                    Install(f, off, len, target, sc, true, (p, m) => form.BeginInvoke((Action)(() => { bar.Value = Math.Min(100, p); status.Text = m; })));
                    installed = true;
                    form.BeginInvoke((Action)(() => { bar.Value = 100; status.Text = "Installed in " + target; go.Text = "Start"; go.Enabled = true; cancel.Text = "Close"; cancel.Enabled = true; }));
                }
                catch (Exception ex)
                {
                    form.BeginInvoke((Action)(() => { status.Text = "Failed: " + ex.Message; cancel.Enabled = true; MessageBox.Show(ex.ToString(), "NanoCut Setup", MessageBoxButtons.OK, MessageBoxIcon.Error); }));
                }
            }) { IsBackground = true };
            th.Start();
        };
        form.Controls.AddRange(new Control[] { head, dl, box, browse, desk, bar, status, go, cancel });
        Application.Run(form);
        f.Dispose();
        return installed ? 0 : 1;
    }
}
