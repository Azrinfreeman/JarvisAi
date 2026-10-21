import { SlashCommandBuilder } from 'discord.js';
import { sleepCommand } from './sleep/commands/definition.js';

export const commands = [
  new SlashCommandBuilder().setName('ask').setDescription('Ask the server AI assistant')
    .addStringOption(option => option.setName('prompt').setDescription('Your question (optional with an image)').setMaxLength(4000))
    .addAttachmentOption(option => option.setName('image').setDescription('Screenshot or image (PNG/JPEG/WEBP/BMP/GIF/AVIF/TIFF), up to 14 MB'))
    .addBooleanOption(option => option.setName('private').setDescription('Only you can see the answer (default: public)')),
  new SlashCommandBuilder().setName('reset').setDescription('Delete your saved conversation in this channel'),
  new SlashCommandBuilder().setName('status').setDescription('Show the bot provider and selected model'),
  new SlashCommandBuilder().setName('help').setDescription('Explain server chat and privacy'),
].map(command => command.toJSON());
export const combinedCommands = [...commands,sleepCommand.toJSON(),
  new SlashCommandBuilder().setName('nickname').setDescription('Change a server nickname (owner or Manage Nicknames only)')
    .addUserOption(option=>option.setName('member').setDescription('Server member to rename').setRequired(true))
    .addStringOption(option=>option.setName('name').setDescription('Exact new server nickname').setMinLength(1).setMaxLength(32).setRequired(true)).toJSON(),
];
