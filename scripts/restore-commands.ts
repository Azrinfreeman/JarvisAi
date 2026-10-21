import { readFileSync } from 'node:fs';
import { REST, Routes } from 'discord.js';
import { required, snowflake } from '../src/config.js';
import { safeError } from '../src/errors.js';
try {
  const path=process.argv[2];
  if (!path) throw new Error('Specify the pre-cutover command snapshot path.');
  const saved=JSON.parse(readFileSync(path,'utf8'));
  const app=snowflake('DISCORD_APPLICATION_ID'),guild=snowflake('DISCORD_GUILD_ID');
  if (saved.applicationId!==app || saved.guildId!==guild || !Array.isArray(saved.guildCommands)) throw new Error('Command snapshot identity mismatch.');
  if (!process.argv.includes('--apply')) {
    console.log('Preview: restore saved guild command definitions and remove only new ask/reset/status/help/nickname commands absent from the snapshot. Global and unrelated commands remain intact. Add --apply only for rollback.');
  } else {
    const rest=new REST({version:'10'}).setToken(required('DISCORD_BOT_TOKEN'));
    const before=new Set(saved.guildCommands.map((c:any)=>c.name));
    for (const command of saved.guildCommands) {
      const body=Object.fromEntries(['name','type','name_localizations','description','description_localizations','options','default_member_permissions','nsfw'].filter(key=>command[key]!==undefined).map(key=>[key,command[key]]));
      await rest.post(Routes.applicationGuildCommands(app,guild),{body});
    }
    const current:any=await rest.get(Routes.applicationGuildCommands(app,guild));
    for (const command of current) if (['ask','reset','status','help','nickname'].includes(command.name)&&!before.has(command.name)) {
      await rest.delete(Routes.applicationGuildCommand(app,guild,command.id));
    }
    console.log('Restored pre-cutover guild command definitions; preserved global and unrelated commands.');
  }
} catch(error) { console.error(safeError(error)); process.exitCode=1; }
