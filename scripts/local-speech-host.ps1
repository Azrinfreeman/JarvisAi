param(
  [Parameter(Mandatory=$true)][string]$EngineDirectory,
  [Parameter(Mandatory=$true)][string]$ModelPath,
  [ValidateRange(1024,65535)][int]$Port,
  [ValidatePattern('^/[a-f0-9-]{36}$')][string]$RequestPath,
  [ValidateSet('cpu','vulkan')][string]$Device,
  [ValidateRange(1,16)][int]$Threads = 4
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
public static class RainBotSpeechHost {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags; public UIntPtr Minimum, Maximum;
    public uint Processes; public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int Run(string directory, string model, int port, string prefix, string device, int threads) {
    IntPtr job=CreateJobObject(IntPtr.Zero,null);
    if(job==IntPtr.Zero)throw new InvalidOperationException("Cannot create speech process job.");
    Process process=null;
    try {
      ExtendedLimits limits=new ExtendedLimits(); limits.Basic.Flags=0x2000;
      if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))))throw new InvalidOperationException("Cannot configure speech process job.");
      ProcessStartInfo start=new ProcessStartInfo();
      start.FileName=System.IO.Path.Combine(directory,"whisper-server.exe");start.WorkingDirectory=directory;
      start.Arguments="-m \""+model+"\" --host 127.0.0.1 --port "+port+" --request-path "+prefix+" --inference-path /inference -l auto -t "+threads+(device=="cpu"?" --no-gpu":"");
      start.UseShellExecute=false;start.CreateNoWindow=true;start.RedirectStandardInput=true;start.RedirectStandardOutput=true;start.RedirectStandardError=true;
      process=new Process();process.StartInfo=start;
      process.OutputDataReceived+=(sender,args)=>{if(args.Data!=null)Console.Out.WriteLine(args.Data);};
      process.ErrorDataReceived+=(sender,args)=>{if(args.Data!=null)Console.Error.WriteLine(args.Data);};
      process.Start();
      if(!AssignProcessToJobObject(job,process.Handle))throw new InvalidOperationException("Cannot contain speech process lifetime.");
      process.BeginOutputReadLine();process.BeginErrorReadLine();
      Process owned=process;
      Task exited=Task.Run(()=>owned.WaitForExit());
      Task inputClosed=Task.Run(()=>Console.In.ReadToEnd());
      Task.WhenAny(exited,inputClosed).GetAwaiter().GetResult();
      return process.HasExited?process.ExitCode:0;
    } finally {
      CloseHandle(job);
      if(process!=null){try{if(!process.HasExited){process.Kill();process.WaitForExit(5000);}}catch{}process.Dispose();}
    }
  }
}
'@
exit [RainBotSpeechHost]::Run([IO.Path]::GetFullPath($EngineDirectory),[IO.Path]::GetFullPath($ModelPath),$Port,$RequestPath,$Device,$Threads)
