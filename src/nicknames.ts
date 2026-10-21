import { PermissionFlagsBits, escapeMarkdown, Routes, type Guild } from 'discord.js';
import { authorized, type botConfig } from './config.js';
import { Conversations } from './storage.js';
import { RequestQueue } from './queue.js';
import { UserError } from './errors.js';
import { validateNicknameRequest, type NicknameRequest } from './nickname-request.js';

type Config=ReturnType<typeof botConfig>;
export class Nicknames {
  constructor(private config:Config,private events:Conversations,private queue=new RequestQueue(4,2000)) {}
  async checkActor(guild:Guild,actorId:string,channelId:string) {
    if (guild.id!==this.config.guildId) throw new UserError('Nickname changes are restricted to the configured server.');
    await guild.roles.fetch();
    const actor=await guild.members.fetch({user:actorId,force:true});
    if (!authorized(this.config,{guildId:guild.id,userId:actorId,channelId,roles:[...actor.roles.cache.keys()]})) throw new UserError('You do not have access to this bot in this channel.');
    if (actorId!==this.config.ownerId && !actor.permissions.has(PermissionFlagsBits.ManageNicknames)) {
      throw new UserError('Only the configured bot owner or members with Manage Nicknames can ask me to change nicknames.');
    }
    return actor;
  }
  async change(guild:Guild,actorId:string,channelId:string,eventKey:string,request:NicknameRequest,signal?:AbortSignal,announce?:(content:string)=>Promise<unknown>):Promise<string> {
    validateNicknameRequest(request);
    if (!/^(message|interaction):\d{17,20}:\d{17,20}$/.test(eventKey)) throw new UserError('Invalid nickname request event.');
    return this.queue.run(`${guild.id}:${request.targetId}`,async()=>{
      signal?.throwIfAborted();
      const actor=await this.checkActor(guild,actorId,channelId);
      const me=await guild.members.fetchMe({force:true});
      const target=await guild.members.fetch({user:request.targetId,force:true});
      if (!me.permissions.has(PermissionFlagsBits.ManageNicknames)) throw new UserError('RainBot needs the Manage Nicknames permission in this server.');
      if (target.id===guild.ownerId) throw new UserError('Discord does not let bots rename the server owner.');
      if (!target.manageable || me.roles.highest.comparePositionTo(target.roles.highest)<=0) throw new UserError('Move RainBot’s role above this member’s highest role before changing their nickname.');
      if (actorId!==this.config.ownerId && actorId!==guild.ownerId && actorId!==target.id && actor.roles.highest.comparePositionTo(target.roles.highest)<=0) {
        throw new UserError('You can only rename members below your highest role.');
      }
      signal?.throwIfAborted();
      if (!this.events.claimEvent(`nickname:${eventKey}`)) return 'This nickname request was already processed. No additional change was made.';
      if (target.nickname===request.nickname) return `<@${target.id}> already has the server nickname **${escapeMarkdown(request.nickname)}** bah.`;
      try {
        const result=await guild.client.rest.patch(Routes.guildMember(guild.id,target.id),{
          body:{nick:request.nickname},reason:`Requested by member ${actorId}; event ${eventKey}`,signal,
        }) as {nick?:string};
        if (result.nick!==request.nickname) throw new Error('Nickname response did not confirm the requested value');
      }
      catch(error) {
        const code=(error as {code?:number})?.code;
        if (code===50013 || code===50001) throw new UserError('Discord denied the nickname change. Check RainBot’s Manage Nicknames permission and role position.');
        throw new UserError('Discord did not confirm the nickname change. Check the member’s current nickname before sending a new request.');
      }
      const confirmation=`Requested by <@${actorId}>: <@${target.id}> now has the server nickname **${escapeMarkdown(request.nickname)}**.`;
      if (announce) {
        try { await announce(confirmation); }
        catch { return `${confirmation}\nThe nickname changed, but I could not post the public confirmation in this channel.`; }
      }
      return confirmation;
    },`${guild.id}:${actorId}`);
  }
}
