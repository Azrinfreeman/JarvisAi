import { REST, Routes, PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { botConfig, snowflake } from '../src/config.js';
import { safeError } from '../src/errors.js';
try {
  const config=botConfig(),app=snowflake('DISCORD_APPLICATION_ID');
  const rest=new REST({version:'10'}).setToken(config.token);
  const application:any=await rest.get('/oauth2/applications/@me');
  const guildCommands:any=await rest.get(Routes.applicationGuildCommands(app,config.guildId));
  const names=guildCommands.map((c:any)=>c.name);
  if (!['ask','reset','status','help','sleep','nickname'].every(name=>names.includes(name))) throw new Error('Combined commands are missing.');
  const roles:any=await rest.get(Routes.guildRoles(config.guildId));
  const me:any=await rest.get(Routes.guildMember(config.guildId,app));
  const bits=roles.filter((r:any)=>r.id===config.guildId||me.roles.includes(r.id)).reduce((b:bigint,r:any)=>b|BigInt(r.permissions),0n);
  const canManageNicknames=new PermissionsBitField(bits).has(PermissionFlagsBits.ManageNicknames);
  const health=JSON.parse(readFileSync('data/runtime-status.json','utf8'));
  if (Date.now()-Date.parse(health.at)>30000 || health.stopped || !health.discordReady || health.ai.phase!=='ready') throw new Error('Combined runtime is not healthy or its status is stale.');
  const messageContent=!!(application.flags&((1<<18)|(1<<19)));
  const previous=existsSync('data/deployment.json')?JSON.parse(readFileSync('data/deployment.json','utf8')):{};
  const preflight=JSON.parse(readFileSync('data/preflight.json','utf8'));
  const deployment={...previous,verifiedAt:new Date().toISOString(),frontendPid:health.pid,
    workerPid:Number(readFileSync('data/ai/runtime.lock','utf8').trim()),
    preCutoverCommandBackup:previous.preCutoverCommandBackup || preflight.commandBackup,
    commandNames:names,messageContent,canManageNicknames,ai:health.ai.label,sleep:health.sleep};
  writeFileSync('data/deployment.json',JSON.stringify(deployment,null,2));
  console.log(JSON.stringify(deployment,null,2));
} catch(error) { console.error(safeError(error)); process.exitCode=1; }
