import { REST, Routes } from 'discord.js';
import { botConfig, snowflake } from '../src/config.js';
import { safeError } from '../src/errors.js';
try {
  const config=botConfig(),app=snowflake('DISCORD_APPLICATION_ID');
  const rest=new REST({version:'10'}).setToken(config.token);
  const application:any=await rest.get('/oauth2/applications/@me');
  const user:any=await rest.get(Routes.user('@me'));
  const member:any=await rest.get(Routes.guildMember(config.guildId,app));
  const commands:any=await rest.get(Routes.applicationGuildCommands(app,config.guildId));
  const global:any=await rest.get(Routes.applicationCommands(app));
  console.log(JSON.stringify({applicationName:application.name,botName:user.username,serverNickname:member.nick,
    gatewayInteractions:!application.interactions_endpoint_url,
    guildCommands:commands.map((c:any)=>({name:c.name,type:c.type,belongsToConnectedBot:c.application_id===app})),
    globalCommands:global.map((c:any)=>({name:c.name,type:c.type}))},null,2));
} catch(error) {console.error(safeError(error));process.exitCode=1;}
