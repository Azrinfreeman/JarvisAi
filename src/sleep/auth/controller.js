import { PermissionFlagsBits } from 'discord.js';

export function isController(member, guildOwnerId, configuredRoleIds) {
  if (member.id === guildOwnerId) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  return member.roles.cache.some((role) => configuredRoleIds.has(role.id));
}
