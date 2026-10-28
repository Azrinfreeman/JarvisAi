const { contextBridge, ipcRenderer } = require('electron');
const call = (operation, argument = {}) => ipcRenderer.invoke('rainbot',operation,argument);
contextBridge.exposeInMainWorld('rainbot',Object.freeze({
  status:()=>call('status'),settings:()=>call('settings'),saveSettings:body=>call('saveSettings',body),
  management:()=>call('management'),freshManagement:()=>call('freshManagement'),
  start:()=>call('start'),stop:()=>call('stop'),operation:id=>call('operation',{id}),
  clearStaleLocks:()=>call('clearStaleLocks'),
  testDiscord:()=>call('testDiscord'),testAI:()=>call('testAI'),testAIResponse:()=>call('testAIResponse'),
  registerCommands:()=>call('registerCommands'),authStatus:()=>call('authStatus'),authConnect:()=>call('authConnect'),
  authSwitch:()=>call('authSwitch'),authDisconnect:()=>call('authDisconnect'),authCancel:()=>call('authCancel'),
  importSelect:()=>call('importSelect'),importCommit:ticket=>call('importCommit',{ticket}),
}));
