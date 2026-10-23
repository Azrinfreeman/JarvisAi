import './bootstrap.js';
import { REST, Routes } from 'discord.js';
import { required, snowflake } from './config.js';
import { combinedCommands } from './commands.js';
import { safeError } from './errors.js';

try {
  const applicationId = snowflake('DISCORD_APPLICATION_ID');
  const guildId = snowflake('DISCORD_GUILD_ID');
  const rest = new REST({ version: '10' }).setToken(required('DISCORD_BOT_TOKEN'));
  // Preserve unrelated commands on an existing bot application.
  for (const command of combinedCommands) {
    await rest.post(Routes.applicationGuildCommands(applicationId, guildId), { body: command });
  }
  console.log('Registered /ask, /reset, /status, /help, /sleep and /nickname; unrelated commands preserved.');
} catch (error) { console.error(safeError(error)); process.exitCode = 1; }
