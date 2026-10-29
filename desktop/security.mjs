import { resolve, join, relative, isAbsolute } from 'node:path';

export const appURL = 'rainbot://app/';
export const allowedOperations = new Set(['status','settings','saveSettings','localSpeechStatus','localSpeechSetup','localSpeechCancel','voiceSummaryStatus','management','freshManagement','start','stop','operation',
  'clearStaleLocks','testDiscord','testAI','testAIResponse','registerCommands','authStatus','authConnect','authSwitch','authDisconnect','authCancel','importSelect','importCommit']);
export function validSender(event, window) {
  return !!window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
    && event.senderFrame.url.split('#')[0] === appURL;
}
export function validateRequest(operation, argument) {
  if (!allowedOperations.has(operation) || !argument || typeof argument !== 'object' || Array.isArray(argument)
    || Buffer.byteLength(JSON.stringify(argument)) > 16384) throw new Error('Invalid desktop request.');
  if (operation === 'operation') {
    if (Object.keys(argument).length !== 1 || typeof argument.id !== 'string' || !/^[a-f\d-]{36}$/.test(argument.id)) throw new Error('Invalid operation ID.');
  } else if (operation === 'importCommit') {
    if (Object.keys(argument).length !== 1 || typeof argument.ticket !== 'string' || !/^[a-f\d-]{36}$/.test(argument.ticket)) throw new Error('Invalid import ticket.');
  } else if (operation !== 'saveSettings' && Object.keys(argument).length) throw new Error('This action does not accept arguments.');
}
const resources = new Map([['/','index.html'],['/app.js','app.js'],['/styles.css','styles.css'],['/transport.js','transport.js'],['/rainbot.png','rainbot.png']]);
export function resourcePath(url, root) {
  const parsed=new URL(url);
  if (parsed.protocol !== 'rainbot:' || parsed.host !== 'app' || parsed.username || parsed.password || parsed.search) return;
  const name=resources.get(parsed.pathname);
  if (!name) return;
  const path=join(root,name), rel=relative(resolve(root),resolve(path));
  return !isAbsolute(rel) && !rel.startsWith('..') ? path : undefined;
}
export function authURL(value) {
  const url=new URL(value);
  if (url.protocol !== 'https:' || url.host !== 'auth.openai.com' || url.pathname !== '/api/accounts/authorize' || url.username || url.password || url.hash) throw new Error('Unsupported sign-in destination.');
  return url.href;
}
