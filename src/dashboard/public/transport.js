'use strict';
// A fixed desktop bridge replaces HTTP; browser sessions keep their existing transport.
window.rainbotRequest = async (path, options = {}) => {
  if (!window.rainbot) return fetch(path,options);
  const method=options.method || 'GET';
  const routes={
    'GET /api/status':()=>window.rainbot.status(),
    'GET /api/session':async()=>({authorized:true,csrf:'desktop'}),
    'GET /api/settings':()=>window.rainbot.settings(),
    'GET /api/voice-summary':()=>window.rainbot.voiceSummaryStatus(),
    'GET /api/voice-summary/local':()=>window.rainbot.localSpeechStatus(),
    'POST /api/voice-summary/local/setup':()=>window.rainbot.localSpeechSetup(),
    'POST /api/voice-summary/local/cancel':()=>window.rainbot.localSpeechCancel(),
    'PUT /api/settings':()=>window.rainbot.saveSettings(JSON.parse(options.body)),
    'GET /api/management':()=>window.rainbot.management(),
    'GET /api/management?fresh=1':()=>window.rainbot.freshManagement(),
    'POST /api/bot/start':()=>window.rainbot.start(),
    'POST /api/bot/stop':()=>window.rainbot.stop(),
    'POST /api/bot/clear-stale-locks':()=>window.rainbot.clearStaleLocks(),
    'POST /api/settings/test-discord':()=>window.rainbot.testDiscord(),
    'POST /api/settings/test-ai':()=>window.rainbot.testAI(),
    'POST /api/settings/test-ai-response':()=>window.rainbot.testAIResponse(),
  };
  let work=routes[`${method} ${path}`];
  const operation=/^\/api\/operations\/([a-f\d-]{36})$/.exec(path);
  if (method === 'GET' && operation) work=()=>window.rainbot.operation(operation[1]);
  try {
    if(!work)throw new Error('Unsupported desktop operation.');
    const value=await work();return {ok:true,status:200,json:async()=>value};
  } catch(error) {return {ok:false,status:400,json:async()=>({error:error.message})};}
};
