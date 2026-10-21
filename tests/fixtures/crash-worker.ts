import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const dir=process.env.AI_DATA_DIR!;
mkdirSync(dir,{recursive:true});
writeFileSync(join(dir,'runtime.lock'),String(process.pid));
process.send!({type:'status',status:{phase:'ready',label:'Crash test worker'}});
process.on('message',(message:any) => {
  if (message.type === 'shutdown') process.exit(0);
  if (message.type === 'ask') {
    if (!existsSync(join(dir,'crashed'))) { writeFileSync(join(dir,'crashed'),'once'); process.exit(1); }
    process.send!({type:'result',id:message.id,payload:{content:'Recovered'}});
  }
  if (message.type === 'delivered') process.send!({type:'done',id:message.id});
});
process.on('disconnect',()=>process.exit(0));
