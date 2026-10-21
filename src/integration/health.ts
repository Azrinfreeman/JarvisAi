import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

export function healthMonitor(path: string, snapshot: () => object) {
  mkdirSync(dirname(path),{recursive:true});
  const delay=monitorEventLoopDelay({resolution:20}); delay.enable();
  let previousCpu=process.cpuUsage(); let previousTime=process.hrtime.bigint();
  const write=(stopped=false) => {
    const cpu=process.cpuUsage(previousCpu); previousCpu=process.cpuUsage();
    const now=process.hrtime.bigint(); const elapsed=Number(now-previousTime)/1000; previousTime=now;
    const value={at:new Date().toISOString(),pid:process.pid,stopped,rssMiB:Math.round(process.memoryUsage().rss/1024/1024),
      cpuPercent:Math.round((cpu.user+cpu.system)/elapsed*1000)/10,eventLoopP95Ms:Math.round(delay.percentile(95)/1e5)/10,...snapshot()};
    try { writeFileSync(path+'.tmp',JSON.stringify(value,null,2)); renameSync(path+'.tmp',path); }
    catch { console.error('Could not update the local runtime health file.'); }
    delay.reset();
  };
  write(); const timer=setInterval(write,10000); timer.unref();
  return () => { clearInterval(timer); write(true); delay.disable(); };
}
