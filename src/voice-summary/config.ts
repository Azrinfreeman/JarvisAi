import { UserError } from '../errors.js';

export function voiceConfig(env: NodeJS.ProcessEnv = process.env) {
  const enabled = env.VOICE_SUMMARY_ENABLED === 'true';
  const consentMode = env.VOICE_SUMMARY_CONSENT_MODE ?? 'individual';
  const provider=env.VOICE_SUMMARY_PROVIDER?.trim()||'local';
  const localDevice=env.VOICE_SUMMARY_LOCAL_DEVICE?.trim()||'vulkan';
  const model = provider==='local' ? 'large-v3-q5_0' : env.VOICE_SUMMARY_MODEL?.trim() || 'gpt-transcribe';
  const languages = (env.VOICE_SUMMARY_LANGUAGES || 'ms,en').split(',').map(value => value.trim());
  const minutes = Number(env.VOICE_SUMMARY_MINUTES || 5);
  const monthlyMinutes = Number(env.VOICE_SUMMARY_MONTHLY_MINUTES || 60);
  const glossary = env.VOICE_SUMMARY_GLOSSARY?.trim() || '';
  const language = env.VOICE_SUMMARY_LANGUAGE?.trim() || 'Malay';
  if (!['individual','server'].includes(consentMode) || !['local','openai'].includes(provider) || !['vulkan','cpu'].includes(localDevice)
    || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(model) || languages.length > 5
    || languages.some(value => !/^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(value))
    || ![4,5].includes(minutes) || !Number.isInteger(monthlyMinutes) || monthlyMinutes < 1 || monthlyMinutes > 10000
    || glossary.length > 1000 || /[<>\r\n\x00-\x1f]/.test(glossary) || !language || language.length > 80) {
    throw new UserError('Invalid voice-summary settings. Check language hints, glossary, model and usage limits.');
  }
  return {enabled,consentMode:consentMode as 'individual'|'server',provider:provider as 'local'|'openai',localDevice:localDevice as 'cpu'|'vulkan',model,languages,minutes,monthlyMinutes,glossary,language,key:provider==='openai' ? env.VOICE_SUMMARY_API_KEY || '' : ''};
}

export type VoiceConfig = ReturnType<typeof voiceConfig>;
