import { readFileSync, statSync } from 'node:fs';
import { evaluateTranscripts } from '../src/voice-summary/evaluation.js';
import { safeError, UserError } from '../src/errors.js';

try {
  const path=process.argv[2];
  if(!path || process.argv.length!==3)throw new UserError('Usage: npm run voice:eval -- path/to/reference-pairs.json');
  if(statSync(path).size>2*1024*1024)throw new UserError('Evaluation input exceeds 2 MiB.');
  let value:unknown;
  try {value=JSON.parse(readFileSync(path,'utf8'));}catch{throw new UserError('Invalid evaluation JSON.');}
  console.log(JSON.stringify(evaluateTranscripts(value),null,2));
} catch(error) {console.error(safeError(error));process.exitCode=1;}
