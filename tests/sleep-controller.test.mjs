import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { isController } from '../src/sleep/auth/controller.js';

function member(id, bits = 0n, roleIds = []) {
  return {
    id,
    permissions: { has: (bit) => (bits & bit) === bit },
    roles: { cache: roleIds.map((roleId) => ({ id: roleId })) },
  };
}

test('owner, server manager, administrator, and configured role are authorized', () => {
  const roles = new Set(['controller']);
  assert.equal(isController(member('owner'), 'owner', roles), true);
  assert.equal(isController(member('manager', PermissionFlagsBits.ManageGuild), 'owner', roles), true);
  assert.equal(isController(member('admin', PermissionFlagsBits.Administrator), 'owner', roles), true);
  assert.equal(isController(member('helper', 0n, ['controller']), 'owner', roles), true);
});

test('ordinary member remains unauthorized', () => {
  assert.equal(isController(member('visitor'), 'owner', new Set(['controller'])), false);
});
