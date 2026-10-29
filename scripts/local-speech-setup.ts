import { join } from 'node:path';
import { LocalSpeechSetup } from '../src/voice-summary/local-setup.js';
import { stateRoot } from '../src/app-paths.js';
import { safeError } from '../src/errors.js';

const root=process.argv.includes('--desktop') ? join(process.env.LOCALAPPDATA!,'RainBot') : stateRoot;
const setup=new LocalSpeechSetup(root);
const cancel=()=>setup.cancel();process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
let last=-10;
const progress=setInterval(()=>{void setup.status().then(status=>{if(status.progress>=last+10){last=status.progress;console.log(`${status.progress}% — ${status.message}`);}});},2000);
try {
  console.log((await setup.begin()).message);
  const status=await setup.wait();console.log(`${status.state}: ${status.message}`);
  if(status.state!=='ready')process.exitCode=1;
} catch(error) {console.error(safeError(error));process.exitCode=1;}
finally {clearInterval(progress);process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
