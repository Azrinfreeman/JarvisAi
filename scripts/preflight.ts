import { REST, Routes, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { botConfig, snowflake } from '../src/config.js';
import { safeError } from '../src/errors.js';
try {
  const config=botConfig(); const appId=snowflake('DISCORD_APPLICATION_ID');
  const rest=new REST({version:'10'}).setToken(config.token);
  const user:any=await rest.get(Routes.user('@me'));
  if (user.id !== appId || !user.bot) throw new Error('Bot identity mismatch.');
  const app:any=await rest.get('/oauth2/applications/@me');
  const guild:any=await rest.get(Routes.guild(config.guildId));
  const member:any=await rest.get(Routes.guildMember(config.guildId,user.id));
  const roles:any=await rest.get(Routes.guildRoles(config.guildId));
  const channels:any=await rest.get(Routes.guildChannels(config.guildId));
  const globals:any=await rest.get(Routes.applicationCommands(appId));
  const commands:any=await rest.get(Routes.applicationGuildCommands(appId,config.guildId));
  const base=roles.filter((r:any)=>r.id===guild.id || member.roles.includes(r.id)).reduce((bits:bigint,r:any)=>bits|BigInt(r.permissions),0n);
  const permission=(channel:any) => {
    let bits=base;
    if (!(bits & PermissionFlagsBits.Administrator)) {
      const overwrites=channel.permission_overwrites || [];
      const apply=(values:any[])=>{ const deny=values.reduce((b:bigint,o:any)=>b|BigInt(o.deny),0n);const allow=values.reduce((b:bigint,o:any)=>b|BigInt(o.allow),0n);bits=(bits&~deny)|allow; };
      apply(overwrites.filter((o:any)=>o.id===guild.id));
      apply(overwrites.filter((o:any)=>o.type===0&&member.roles.includes(o.id)));
      apply(overwrites.filter((o:any)=>o.type===1&&o.id===user.id));
    }
    return new PermissionsBitField(bits);
  };
  const readable=channels.filter((c:any)=>[0,2].includes(c.type)&&permission(c).has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory]));
  const voice=channels.filter((c:any)=>c.type===2&&permission(c).has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.Connect,PermissionFlagsBits.Speak]));
  const messageContent=!!(app.flags & ((1<<18)|(1<<19)));
  mkdirSync('data/backups',{recursive:true});
  const backup={at:new Date().toISOString(),applicationId:appId,guildId:config.guildId,globalCommands:globals,guildCommands:commands};
  const filename=`data/backups/commands-${Date.now()}.json`;
  writeFileSync(filename,JSON.stringify(backup,null,2),{flag:'wx'});
  writeFileSync('data/preflight.json',JSON.stringify({botName:user.username,identityVerified:true,messageContent,readableChannels:readable.length,usableVoiceChannels:voice.length,globalCommands:globals.map((c:any)=>c.name),guildCommands:commands.map((c:any)=>c.name),commandBackup:filename},null,2));
  console.log(JSON.stringify({botName:user.username,identityVerified:true,messageContent,readableChannels:readable.length,usableVoiceChannels:voice.length,globalCommands:globals.map((c:any)=>c.name),guildCommands:commands.map((c:any)=>c.name)},null,2));
} catch(error) { console.error(safeError(error)); process.exitCode=1; }
