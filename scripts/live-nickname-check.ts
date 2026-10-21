// One real inference/IPC check with a simulated local action. No Discord mutation.
import { once } from 'node:events';
import { AIClient } from '../src/integration/ai-client.js';
const client=new AIClient();
const identity={guildId:'100000000000000001',channelId:'100000000000000002',userId:'100000000000000003',visibility:'private' as const};
const nickname={targetId:'100000000000000005',nickname:'Integration Test'};
client.start();
try {
  while(client.status.phase!=='ready') {
    if(client.status.phase==='unavailable') throw new Error(client.status.label);
    await once(client,'status',{signal:AbortSignal.timeout(60000)});
  }
  let actions=0,deliveries=0;
  await client.ask({identity,prompt:`bah bolehkan kalau kau tukar nama <@${nickname.targetId}> kepada ${nickname.nickname}`,nickname,
    eventKey:`interaction:100000000000000004:${BigInt(Date.now())*10000n}`},async payload=>{
    deliveries++;if (!payload.content.includes('Simulated nickname action confirmed')) throw new Error('Expected confirmed synthetic output');
  },undefined,async request=>{
    if(request.targetId!==nickname.targetId || request.nickname!==nickname.nickname) throw new Error('Action mismatch');
    actions++;return 'Simulated nickname action confirmed. No Discord member was changed.';
  });
  if(actions!==1||deliveries!==1) throw new Error('Unexpected action or delivery count');
  await client.reset(identity);
  console.log(`Live nickname function/IPC check passed: ${client.status.label}; one simulated action and one delivery; synthetic history reset; no Discord members changed or messages posted.`);
} finally {client.close();}
