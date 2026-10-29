// Explicit development-only smoke test; excluded from installed applications.
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

export async function runSmoke({window,request,stateRoot,focus,tray}) {
  const output=resolve(stateRoot,'..');await mkdir(output,{recursive:true});
  const errors=[];
  window.webContents.on('console-message',(event,...args)=>{
    const message=event.message || args.find(value=>typeof value === 'string') || '';
    if(message.includes('Uncaught'))errors.push(message);
    if(event.level >= 2)console.error('Renderer:',message);
  });
  async function wait(expression) {
    const until=Date.now()+12000;
    while(Date.now()<until){if(await window.webContents.executeJavaScript(expression))return;await new Promise(resolve=>setTimeout(resolve,100));}
    throw new Error(`UI did not become ready: ${expression}`);
  }
  const js=async code=>{try{return await window.webContents.executeJavaScript(code);}catch(error){console.error('Failed smoke step:',code.slice(0,120));throw error;}};
  const painted=()=>js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await wait('document.getElementById("settings-form").hidden === false && document.getElementById("bot-control").textContent.includes("Complete setup")');
  console.log('Desktop smoke: window and controller ready.');
  assert.equal(await js('typeof window.rainbot.authSwitch'),'function');
  assert.equal(await js('typeof window.rainbot.voiceSummaryStatus'),'function');
  assert.equal(await js('typeof window.rainbot.localSpeechSetup'),'function');
  assert.equal((await request('settings')).values.VOICE_SUMMARY_PROVIDER,'local');
  assert.equal((await request('localSpeechStatus')).state,'missing');
  assert.equal((await request('settings')).values.VOICE_SUMMARY_ENABLED,'false');
  assert.equal(await js('document.getElementById("voice-summary-consent").value'),'individual');
  assert.equal((await request('voiceSummaryStatus')).state,'off');
  assert.equal(await js('document.getElementById("settings-form").elements.namedItem("VOICE_SUMMARY_API_KEY").type'),'password');
  assert.equal(await js('document.getElementById("switch-chatgpt").textContent'),'Use a different ChatGPT account');
  assert.equal(await js('typeof require'),'undefined');
  assert.equal(await js('typeof window.rainbot.exec'),'undefined');
  assert.equal(await js('typeof window.rainbot.request'),'undefined');
  await js('location.hash="overview";navigate();document.getElementById("main").focus();document.dispatchEvent(new KeyboardEvent("keydown",{key:"/",bubbles:true}))');
  await wait('location.hash === "#commands" && document.activeElement.id === "command-search"');
  assert.equal(await js('document.getElementById("page-commands").hidden'),false);
  await js('location.hash="settings"');
  await wait('document.getElementById("page-settings").hidden === false');
  console.log('Desktop smoke: settings view ready.');
  await wait('document.getElementById("switch-chatgpt").hidden === false && document.getElementById("switch-chatgpt").disabled === false');
  await js('document.getElementById("desktop-setup").scrollIntoView({block:"center"})');
  await new Promise(resolve=>setTimeout(resolve,350));
  await painted();
  await writeFile(join(output,'chatgpt-accounts.png'),(await window.webContents.capturePage()).toPNG());
  await js(`(() => {
    const values={DISCORD_APPLICATION_ID:'123456789012345678',DISCORD_GUILD_ID:'223456789012345678',OWNER_DISCORD_ID:'323456789012345678',AI_PROVIDER:'openai',OPENAI_MODEL:'test-model',OPENAI_API_KEY:'synthetic-desktop-key',VOICE_SUMMARY_CONSENT_MODE:'server'};
    for(const [key,value] of Object.entries(values)){const input=document.getElementById('settings-form').elements.namedItem(key);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}
    document.getElementById('save-settings').click();
  })()`);
  await wait('document.getElementById("settings-feedback").textContent.includes("Settings saved") && document.getElementById("settings-form").inert === false');
  assert.equal(await js('document.getElementById("settings-form").elements.namedItem("OPENAI_API_KEY").value'),'');
  const saved=await request('settings');assert.equal(saved.secrets.OPENAI_API_KEY,true);assert.equal(JSON.stringify(saved).includes('synthetic-desktop-key'),false);
  assert.equal(saved.values.VOICE_SUMMARY_CONSENT_MODE,'server');
  assert.ok(saved.missing.includes('DISCORD_BOT_TOKEN'));
  const op=await request('start');
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal((await request('operation',{id:op.id})).status,'failed');
  assert.equal((await request('freshManagement')).state,'stopped');
  console.log('Desktop smoke: protected settings and startup rejection passed.');
  const reloaded=once(window.webContents,'did-finish-load');window.webContents.reload();await reloaded;
  await wait('document.getElementById("settings-form").hidden === false');
  await js('location.hash="settings"');
  await wait('document.getElementById("page-settings").hidden === false');
  await wait('document.getElementById("voice-summary-consent").value === "server"');
  assert.equal(await js('document.getElementById("settings-form").elements.namedItem("OPENAI_API_KEY").value'),'');
  await wait('document.getElementById("desktop-auth-status").textContent === "ChatGPT not connected" && document.getElementById("bot-control").textContent.includes("Complete setup") && document.getElementById("settings-form").elements.namedItem("DISCORD_APPLICATION_ID").value === "123456789012345678"');
  await js('if(document.documentElement.dataset.theme !== "light")document.getElementById("theme-toggle").click()');
  await wait('document.documentElement.dataset.theme === "light"');
  await painted();
  await writeFile(join(output,'settings.png'),(await window.webContents.capturePage()).toPNG());
  await js('document.getElementById("voice-summary-heading").closest("section").scrollIntoView({block:"start"})');
  assert.equal(await js('document.getElementById("local-speech-settings").hidden'),false);
  await painted();
  await writeFile(join(output,'voice-settings.png'),(await window.webContents.capturePage()).toPNG());
  await window.setSize(960,700);await new Promise(resolve=>setTimeout(resolve,250));
  assert.equal(await js('document.documentElement.scrollWidth > innerWidth'),false);
  await js('document.getElementById("theme-toggle").click()');
  await wait('document.documentElement.dataset.theme === "dark"');await new Promise(resolve=>setTimeout(resolve,300));await painted();
  await writeFile(join(output,'settings-dark.png'),(await window.webContents.capturePage()).toPNG());
  assert.equal(tray.isDestroyed(),false);window.close();assert.equal(window.isVisible(),false);focus();assert.equal(window.isVisible(),true);
  assert.equal(errors.length,0);
  await writeFile(join(output,'result.json'),JSON.stringify({passed:true,checks:['real Electron window and sandboxed preload','private Node controller','protected synthetic settings save/reload/redaction','incomplete setup rejects startup','960px layout','light/dark screenshots','close to tray and reopen'],stateRoot},null,2));
  console.log('Desktop UI smoke passed; only isolated synthetic settings were used.');
}
