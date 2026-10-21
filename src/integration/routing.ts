export const aiCommands = new Set(['ask','reset','status','help']);
export const commandOwner = (name: string) => name === 'sleep' ? 'sleep' : name==='nickname' ? 'nickname' : aiCommands.has(name) ? 'ai' : undefined;
export class DispatchGate {
  private seen = new Map<string,number>();
  claim(key: string) {
    const now = Date.now();
    for (const [id,time] of this.seen) if (time < now - 15 * 60000) this.seen.delete(id);
    if (this.seen.has(key)) return false;
    this.seen.set(key,now);
    if (this.seen.size > 5000) this.seen.delete(this.seen.keys().next().value!);
    return true;
  }
}
