import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, protocol, session, shell, nativeImage } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { appURL, validSender, validateRequest, resourcePath, authURL } from './security.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const resources=app.isPackaged ? process.resourcesPath : join(here,'.stage');
const smoke=!app.isPackaged && process.argv.includes('--rainbot-smoke');
const stateRoot=smoke ? join(here,'../output/desktop-smoke',`profile-${randomUUID()}`)
  : join(process.env.LOCALAPPDATA || join(app.getPath('home'),'AppData','Local'),'RainBot');
if(!squirrelStartup){mkdirSync(join(stateRoot,'desktop-profile'),{recursive:true});app.setPath('userData',join(stateRoot,'desktop-profile'));}
let window, tray, controller, quitting=false, importSelection, active=0;
const pending=new Map();
const csp="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
protocol.registerSchemesAsPrivileged([{scheme:'rainbot',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);

function request(operation,argument={}) {
  if (!controller?.connected) return Promise.reject(new Error('The desktop controller is unavailable. Reopen RainBot.'));
  if (pending.size >= 32) return Promise.reject(new Error('Too many requests. Wait for the current operation.'));
  const id=randomUUID();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('The operation has not completed. Refresh its status before retrying.'));},operation === 'authConnect' ? 330000 : 60000);
    pending.set(id,{resolve,reject,timer});
    controller.send({id,operation,argument},error=>{if(error) {clearTimeout(timer);pending.delete(id);reject(new Error('The desktop controller disconnected.'));}});
  });
}
function focus() { if (!window) return; window.show(); if(window.isMinimized()) window.restore(); window.focus(); }
async function stopAndQuit() {
  if (active) {focus();return;}
  active++;
  try {
    const state=await request('freshManagement');
    if (state.state !== 'stopped') {
      const operation=await request('stop');
      const deadline=Date.now()+55000;
      let result=operation;
      while (result.status === 'pending' && Date.now() < deadline) {await new Promise(resolve=>setTimeout(resolve,750));result=await request('operation',{id:operation.id});}
      if (result.status !== 'completed') throw new Error(result.message || 'Shutdown is not verified.');
    }
    quitting=true;app.quit();
  } catch(error) {focus();await dialog.showMessageBox(window,{type:'error',message:'RainBot could not stop',detail:error.message});}
  finally {active--;}
}
async function updateTray() {
  if (!tray) return;
  let state;
  try {state=await request('management');} catch {state={state:'blocked'};}
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:'Open RainBot',click:focus},{type:'separator'},
    {label:'Start bot',enabled:state.state === 'stopped' && !state.missing?.length,click:()=>void request('start').catch(showError)},
    {label:'Stop bot',enabled:state.state === 'running',click:()=>void request('stop').catch(showError)},
    {type:'separator'},
    {label:'Quit app (keep bot running)',click:()=>{quitting=true;app.quit();}},
    {label:'Stop bot and quit',click:()=>void stopAndQuit()},
  ]));
}
function showError(error) {focus();void dialog.showMessageBox(window,{type:'error',message:'RainBot needs attention',detail:error.message});}
async function startController() {
  const env={};
  for (const key of ['SystemRoot','SYSTEMROOT','WINDIR','PATH','Path','PATHEXT','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA']) if(process.env[key] !== undefined) env[key]=process.env[key];
  env.RAINBOT_STATE_ROOT=stateRoot;env.RAINBOT_RESOURCE_ROOT=join(resources,'backend');
  // Launch standalone Node directly; Electron's disabled RunAsNode fuse also blocks its fork wrapper.
  controller=spawn(join(resources,'node/node.exe'),[join(resources,'backend/src/desktop/controller.js')],{
    cwd:stateRoot,env,windowsHide:true,shell:false,
    // Electron and standalone Node can use different V8 serialization versions.
    stdio:['ignore','ignore',smoke ? 'inherit' : 'ignore','ipc'],serialization:'json',
  });
  controller.on('message',message=>{
    if (message?.event?.type === 'authUrl') {
      try {void shell.openExternal(authURL(message.event.value)).catch(showError);} catch {showError(new Error('Sign-in destination was rejected.'));}
      return;
    }
    const call=pending.get(message?.id);if(!call)return;
    clearTimeout(call.timer);pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error));else call.resolve(message.value);
  });
  const failed=()=>{
    for (const call of pending.values()) {clearTimeout(call.timer);call.reject(new Error('The desktop controller exited. Reopen RainBot.'));}pending.clear();
    if(!quitting) {
      const error=new Error('The desktop controller exited. The bot may still be running; reopen RainBot to reconnect.');
      if(smoke)console.error(error);else showError(error);
    }
  };
  controller.once('error',failed);controller.once('exit',failed);
}

// Squirrel lifecycle invocations must exit before opening the UI or controller.
if (squirrelStartup) {quitting=true;app.quit();}
else if (!app.requestSingleInstanceLock()) {quitting=true;app.quit();}
else {
  app.on('second-instance',focus);
  app.setAppUserModelId('com.squirrel.RainBot.RainBot');
  app.on('window-all-closed',()=>{});
  app.on('before-quit',event=>{
    if (!quitting) {event.preventDefault();focus();return;}
  });
  app.on('will-quit',()=>{
    tray?.destroy();tray=undefined;
    if(controller?.connected) controller.disconnect();
  });
  void app.whenReady().then(async()=>{
  await mkdir(stateRoot,{recursive:true});
  session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  session.defaultSession.setPermissionCheckHandler(()=>false);
  session.defaultSession.on('will-download',event=>event.preventDefault());
  protocol.handle('rainbot',async req=>{
    const path=resourcePath(req.url,join(resources,'ui'));
    if(!path || req.method !== 'GET')return new Response('Not found',{status:404});
    const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'};
    try {return new Response(await readFile(path),{headers:{'Content-Type':types[path.slice(path.lastIndexOf('.'))] || 'application/octet-stream','Content-Security-Policy':csp,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}});}
    catch {return new Response('Unable to load RainBot',{status:500});}
  });
  await startController();
  window=new BrowserWindow({title:'RainBot',width:1280,height:850,minWidth:760,minHeight:560,show:false,
    icon:join(resources,'ui/rainbot.png'),backgroundColor:'#f5f7fb',
    webPreferences:{preload:join(here,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,devTools:!app.isPackaged,spellcheck:false},
  });
  Menu.setApplicationMenu(null);
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{if(url.split('#')[0] !== appURL)event.preventDefault();});
  window.webContents.on('will-attach-webview',event=>event.preventDefault());
  window.webContents.on('will-prevent-unload',event=>{
    const discard=dialog.showMessageBoxSync(window,{type:'question',message:'Discard unsaved settings?',buttons:['Keep editing','Discard'],defaultId:0,cancelId:0});
    if(discard === 1)event.preventDefault();else {quitting=false;focus();}
  });
  let explainedClose=false;
  try {explainedClose=JSON.parse(await readFile(join(stateRoot,'desktop-ui.json'),'utf8')).explainedClose === true;} catch {}
  window.on('close',event=>{
    if(quitting)return;
    event.preventDefault();window.hide();
    if(!explainedClose){
      explainedClose=true;
      tray.displayBalloon({title:'RainBot is in the system tray',content:'Open RainBot or quit it from the tray menu. Closing the window keeps your bot running.'});
      void writeFile(join(stateRoot,'desktop-ui.json'),JSON.stringify({explainedClose:true})).catch(()=>{});
    }
  });
  window.on('query-session-end',()=>{quitting=true;});
  window.webContents.on('render-process-gone',()=>{if(!quitting){focus();void dialog.showMessageBox(window,{type:'error',message:'The RainBot window stopped responding.',detail:'Reopen the app to reconnect. The bot is managed separately.'});}});
  ipcMain.handle('rainbot',async(event,operation,argument)=>{
    if(!validSender(event,window))throw new Error('Unsupported desktop sender.');
    validateRequest(operation,argument);
    if(operation === 'importSelect') {
      importSelection=undefined;
      const selected=await dialog.showOpenDialog(window,{title:'Select existing RainBot project',properties:['openDirectory']});
      if(selected.canceled)return {cancelled:true};
      const source=selected.filePaths[0];const preview=await request('importPreview',{source});
      importSelection={source,ticket:randomUUID(),at:Date.now()};return {...preview,ticket:importSelection.ticket};
    }
    if(operation === 'importCommit') {
      const selection=importSelection;importSelection=undefined;
      if(!selection || argument.ticket !== selection.ticket || Date.now()-selection.at > 300000)throw new Error('Import selection expired. Select the folder again.');
      return request('importCommit',{source:selection.source});
    }
    return request(operation,argument);
  });
  const image=nativeImage.createFromPath(join(resources,'ui/rainbot.png'));
  tray=new Tray(image.resize({width:20,height:20}));tray.setToolTip('RainBot');tray.on('double-click',focus);tray.on('right-click',()=>void updateTray());
  void updateTray();
  const timer=setInterval(()=>void updateTray(),10000);timer.unref();
  await window.loadURL(appURL);window.show();
  if(smoke) {
    try {const {runSmoke}=await import('./smoke.mjs');await runSmoke({app,window,request,stateRoot,resources,focus,tray});}
    catch(error){console.error(error);await writeFile(join(stateRoot,'../failure.png'),(await window.webContents.capturePage()).toPNG());quitting=true;controller?.disconnect();app.exit(1);}
    finally {quitting=true;app.quit();}
  }
  }).catch(error=>{console.error('RainBot startup failed:',error);quitting=true;app.exit(1);});
}
