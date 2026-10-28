import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { SettingsStore, isRecord, projectRoot } from '../settings.js';
import { DashboardService, emptyRequest } from '../dashboard/service.js';
import { readRuntimeStatus } from '../dashboard/server.js';
import { InstallationImport } from './migration.js';
import { safeError, UserError } from '../errors.js';

export class DesktopController {
  readonly service: DashboardService;
  private login?: AbortController;
  private importer: InstallationImport;
  constructor(readonly settings = new SettingsStore(), private event: (event: {type:string;value:string})=>void = ()=>{}) {
    this.service = new DashboardService(settings);
    this.importer = new InstallationImport(settings.root);
  }
  cancel() { this.login?.abort(); }
  async dispatch(operation: string, argument: unknown = {}) {
    if (!isRecord(argument) || Buffer.byteLength(JSON.stringify(argument)) > 16384) throw new UserError('Invalid desktop request.');
    if (!['saveSettings','operation','importPreview','importCommit'].includes(operation)) emptyRequest(argument);
    switch (operation) {
      case 'status': return readRuntimeStatus(join(this.settings.root,'data/runtime-status.json'));
      case 'settings': return this.settings.view();
      case 'saveSettings':
        if (existsSync(join(this.settings.root,'data/import.pending'))) throw new UserError('Recover the interrupted import before editing settings.');
        return this.service.save(argument);
      case 'management': return this.service.supervisor.status();
      case 'freshManagement': return this.service.supervisor.status(true);
      case 'start':
        if (existsSync(join(this.settings.root,'data/import.pending'))) throw new UserError('An interrupted import needs recovery before starting.');
        return this.service.supervisor.begin('start');
      case 'stop': return this.service.supervisor.begin('stop');
      case 'clearStaleLocks': return this.service.supervisor.clearStaleLocks();
      case 'operation': {
        if (Object.keys(argument).length !== 1 || typeof argument.id !== 'string' || !/^[a-f\d-]{36}$/.test(argument.id)) throw new UserError('Invalid operation ID.');
        const operation=this.service.supervisor.getOperation(argument.id);
        if (!operation) throw new UserError('Operation not found.');
        return operation;
      }
      case 'testDiscord': return this.service.test('discord');
      case 'testAI': return this.service.test('ai');
      case 'testAIResponse': return this.service.test('ai-response');
      case 'registerCommands': return this.service.registerCommands();
      case 'authStatus': return {connected:existsSync(join(this.settings.effective().env.AI_DATA_DIR || join(this.settings.root,'data/ai'),'chatgpt.dpapi'))};
      case 'authCancel': this.cancel(); return {message:'Cancelling sign-in…'};
      case 'authConnect':
      case 'authSwitch':
      case 'authDisconnect': {
        if(this.login)throw new UserError('A sign-in operation is already in progress.');
        const login=operation !== 'authDisconnect' ? new AbortController() : undefined;
        this.login=login;
        return this.service.supervisor.exclusive(async () => {
        const status=await this.service.supervisor.status(true);
        if (status.state !== 'stopped') throw new UserError('Stop the bot and resolve any runtime lock before changing the ChatGPT connection.');
        const {runtimeLock}=await import('../vault.js');
        const release=runtimeLock(this.settings.effective().env.AI_DATA_DIR || join(this.settings.root,'data/ai'));
        let message='';
        try {
          const auth=await import('../auth.js');
          const report=(value: string)=>{message=value;};
          if (login) {
            login!.signal.throwIfAborted();
            await auth.login({signal:login.signal,newAccount:operation === 'authSwitch',message:report,openBrowser:url=>this.event({type:'authUrl',value:url})});
          } else await auth.logout(report);
          return {message};
        } finally {release();}
      }).finally(()=>{if(this.login === login)this.login=undefined;});
      }
      case 'importPreview':
      case 'importCommit': {
        if (Object.keys(argument).length !== 1 || typeof argument.source !== 'string' || argument.source.length > 4096) throw new UserError('Invalid import selection.');
        const source=argument.source;
        return this.service.supervisor.exclusive(async () => {
          const status=await this.service.supervisor.status(true);
          if (status.state !== 'stopped') throw new UserError('Stop this installation before importing.');
          return operation === 'importPreview' ? this.importer.preview(source) : this.importer.commit(source);
        });
      }
      default: throw new UserError('Unknown desktop operation.');
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.send) throw new Error('The desktop controller requires a private parent connection.');
  const controller=new DesktopController(new SettingsStore(projectRoot),event=>process.send?.({event}));
  let pending=0;
  const reply=(message: unknown)=>{if(process.connected)process.send?.(message as object,()=>{});};
  process.on('message',async message=>{
    if (!isRecord(message) || typeof message.id !== 'string' || !/^[a-f\d-]{36}$/.test(message.id) || typeof message.operation !== 'string') return;
    if (++pending > 32) { pending--; reply({id:message.id,error:'Too many desktop requests.'}); return; }
    try { reply({id:message.id,value:await controller.dispatch(message.operation,message.argument)}); }
    catch(error) { reply({id:message.id,error:safeError(error)}); }
    finally {pending--;}
  });
  process.on('disconnect',()=>{controller.cancel(); const timer=setInterval(()=>{if (!pending && !controller.service.supervisor.busy) {clearInterval(timer);process.exit(0);}},100);});
}
