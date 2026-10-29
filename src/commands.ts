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
  new SlashCommandBuilder().setName('voice-summary').setDescription('Listen with consent, review voice transcripts and summarize recent discussion')
    .addSubcommand(command=>command.setName('start').setDescription('Controller: announce listening using the configured consent mode')
      .addBooleanOption(option=>option.setName('allow-test-audio').setDescription('Allow explicitly requested short audio review exports (announced to everyone)')))
    .addSubcommand(command=>command.setName('consent').setDescription('Opt in to the announced listening session in your voice channel'))
    .addSubcommand(command=>command.setName('withdraw').setDescription('Withdraw consent, stop listening and clear pending audio/results'))
    .addSubcommand(command=>command.setName('stop').setDescription('Controller: stop listening and clear pending audio/results'))
    .addSubcommand(command=>command.setName('status').setDescription('Show listening, consent, coverage and speech API usage'))
    .addSubcommand(command=>command.setName('summarize').setDescription('Summarize the last four or five minutes in this voice channel’s text chat')
      .addIntegerOption(option=>option.setName('minutes').setDescription('Complete voice window (default from Settings)').addChoices({name:'4 minutes',value:4},{name:'5 minutes',value:5})))
    .addSubcommand(command=>command.setName('transcript').setDescription('Review the raw recognized words from recent voice conversation')
      .addIntegerOption(option=>option.setName('minutes').setDescription('Complete voice window (default from Settings)').addChoices({name:'4 minutes',value:4},{name:'5 minutes',value:5})))
    .addSubcommand(command=>command.setName('test').setDescription('Check recognition on a short captured window; raw transcript for review')
      .addIntegerOption(option=>option.setName('seconds').setDescription('Recent seconds to transcribe (default 30)').setMinValue(10).setMaxValue(60))
      .addBooleanOption(option=>option.setName('audio').setDescription('Also export test audio, only if announced and consented at session start'))).toJSON(),
  new SlashCommandBuilder().setName('nickname').setDescription('Change a server nickname (owner or Manage Nicknames only)')
    .addUserOption(option=>option.setName('member').setDescription('Server member to rename').setRequired(true))
    .addStringOption(option=>option.setName('name').setDescription('Exact new server nickname').setMinLength(1).setMaxLength(32).setRequired(true)).toJSON(),
];
