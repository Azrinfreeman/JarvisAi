param([Parameter(Mandatory=$true)][int[]]$ProcessIds)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BotProcessDirectory {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr handle, IntPtr address, byte[] bytes, int size, out IntPtr read);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle, int infoClass, byte[] info, int length, out int returned);
  static byte[] Read(IntPtr handle, long address, int length) {
    byte[] bytes=new byte[length]; IntPtr read;
    if (!ReadProcessMemory(handle,new IntPtr(address),bytes,length,out read) || read.ToInt64()!=length) throw new Exception("Unable to read process directory metadata");
    return bytes;
  }
  public static string Get(int pid) {
    if (IntPtr.Size!=8) throw new Exception("Requires a 64-bit shell and process");
    IntPtr handle=OpenProcess(0x410,false,pid);
    if (handle==IntPtr.Zero) throw new Exception("Process inspection access denied");
    try {
      byte[] info=new byte[48]; int returned;
      if (NtQueryInformationProcess(handle,0,info,info.Length,out returned)!=0) throw new Exception("Cannot query process metadata");
      long peb=BitConverter.ToInt64(info,8);
      long parameters=BitConverter.ToInt64(Read(handle,peb+0x20,8),0);
      byte[] cwd=Read(handle,parameters+0x38,16);
      int length=BitConverter.ToUInt16(cwd,0); long pointer=BitConverter.ToInt64(cwd,8);
      if (length>32768) throw new Exception("Invalid process directory length");
      return System.Text.Encoding.Unicode.GetString(Read(handle,pointer,length));
    } finally { CloseHandle(handle); }
  }
}
'@
foreach ($botPid in $ProcessIds) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $botPid"
  if (-not $process) { throw "Process $botPid is not running" }
  [pscustomobject]@{ ProcessId=$botPid; Directory=[BotProcessDirectory]::Get($botPid); CommandLine=$process.CommandLine }
}
