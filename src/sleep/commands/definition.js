import { SlashCommandBuilder } from 'discord.js';

export const sleepCommand = new SlashCommandBuilder()
  .setName('sleep')
  .setDescription('Control the sleep companion in voice')
  .addSubcommand((sub) => sub
    .setName('join')
    .setDescription('Join your voice channel and stay there')
    .addStringOption((option) => option
      .setName('mode')
      .setDescription('Start silently, with rain, or with sunny birdsong')
      .addChoices({ name: 'Silent', value: 'silent' }, { name: 'Rain', value: 'rain' }, { name: 'Sunny birdsong', value: 'sunny' })))
  .addSubcommandGroup((group) => group
    .setName('sunny')
    .setDescription('Play fresh morning birdsong without leaving voice')
    .addSubcommand((sub) => sub.setName('on').setDescription('Start sunny morning birds and gentle outdoor ambience'))
    .addSubcommand((sub) => sub.setName('off').setDescription('Stop ambience and stay silently in voice')))
  .addSubcommandGroup((group) => group
    .setName('rain')
    .setDescription('Control rain without leaving voice')
    .addSubcommand((sub) => sub.setName('on').setDescription('Start rain'))
    .addSubcommand((sub) => sub.setName('off').setDescription('Stop rain and stay silently'))
    .addSubcommand((sub) => sub.setName('mild-thunder').setDescription('Select gentle rain with mild distant thunder'))
    .addSubcommand((sub) => sub.setName('style').setDescription('Choose a rain scene or gently changing variety')
      .addStringOption((option) => option.setName('scene').setDescription('Rain sound to play')
        .setRequired(true).addChoices(
          { name: 'Variety: changing rain + distant thunder', value: 'variety' },
          { name: 'Mild thunder rain', value: 'mild-thunder' },
          { name: 'Soft rain', value: 'soft' },
          { name: 'Forest rain', value: 'forest' },
          { name: 'Inside the house', value: 'indoor' },
          { name: 'Rain on glass', value: 'glass' },
          { name: 'Heavier rain', value: 'heavy' },
        ))))
  .addSubcommand((sub) => sub.setName('status').setDescription('Show voice and audio status'))
  .addSubcommand((sub) => sub.setName('leave').setDescription('Leave voice and do not rejoin'));
