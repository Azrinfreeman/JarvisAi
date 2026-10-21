// One isolated synthetic inference through the same IPC worker. No Discord posts.
import { once } from 'node:events';
import { AIClient } from '../src/integration/ai-client.js';
const client=new AIClient();
const identity={guildId:'100000000000000001',channelId:'100000000000000002',userId:'100000000000000003',visibility:'private' as const};
client.start();
try {
  const signal=AbortSignal.timeout(60000);
  while (client.status.phase!=='ready') {
    if (client.status.phase==='unavailable') throw new Error(client.status.label);
    await once(client,'status',{signal});
  }
  let deliveries=0;
  await client.ask({identity,prompt:'For a synthetic integration check: what is 17 + 25? Keep the answer to one short sentence.',
    eventKey:`interaction:100000000000000004:${BigInt(Date.now())*10000n}`},async payload=>{
    deliveries++;
    const text=payload.content+JSON.stringify(payload.embeds ?? []);
    if (!text.includes('42')) throw new Error('Synthetic arithmetic answer was unexpected.');
  });
  if (deliveries!==1) throw new Error('Unexpected delivery count');
  await client.reset(identity);
  console.log(`Live subscription worker check passed: ${client.status.label}; one acknowledged answer; synthetic history reset; no Discord messages posted.`);
} finally { client.close(); }
