import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { isController } from '../sleep/auth/controller.js';
import { SessionManager } from '../sleep/session/session-manager.js';

export async function handleSleep(interaction: ChatInputCommandInteraction, sessions: SessionManager, controllerRoles: Set<string>) {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({content:'Use this command in a server.',flags:MessageFlags.Ephemeral}); return;
  }
  const command = interaction.options.getSubcommand();
  const group = interaction.options.getSubcommandGroup(false);
  if (command === 'status') {
    await interaction.reply({content:sessions.status(interaction.guildId),flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}}); return;
  }
  await interaction.deferReply({flags:MessageFlags.Ephemeral});
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!isController(member,interaction.guild.ownerId,controllerRoles)) {
    await interaction.editReply('Only the server owner, Administrator, Manage Server or a configured controller role can change sleep sessions.'); return;
  }
  let response: string;
  if (command === 'join') {
    if (!member.voice.channel) { await interaction.editReply('Join a standard voice channel first.'); return; }
    response = await sessions.join(interaction.guild,member.voice.channel,interaction.options.getString('mode') ?? 'silent');
  } else if (command === 'leave') response = await sessions.leave(interaction.guildId);
  else if (['rain','sunny'].includes(group ?? '') && ['on','off'].includes(command)) {
    response = await sessions.setMode(interaction.guildId,command === 'off' ? 'silent' : group!);
  } else if (group === 'rain' && (command === 'style' || command === 'mild-thunder')) {
    response = await sessions.setRainStyle(interaction.guildId,command === 'mild-thunder' ? command : interaction.options.getString('scene',true));
  } else response = 'Unknown sleep command.';
  await interaction.editReply({content:response,allowedMentions:{parse:[]}});
  if (['rain','sunny'].includes(group ?? '') && ['on','off'].includes(command)) {
    try { await interaction.followUp({content:response,allowedMentions:{parse:[]}}); }
    catch { console.error('Sleep announcement could not be posted; audio state is preserved.'); }
  }
}
