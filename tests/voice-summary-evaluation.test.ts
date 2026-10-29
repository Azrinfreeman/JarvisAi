import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTranscripts, editDistance } from '../src/voice-summary/evaluation.js';

test('Malay evaluation preserves negation mistakes and groups accent samples independently',()=>{
  const result=evaluateTranscripts([{group:'Sabah clean',reference:'Bah, kita tak boleh buat esok.',recognized:'bah kita boleh buat esok'},
    {group:'Standard clean',reference:'Pukul sembilan malam.',recognized:'PUKUL sembilan malam!'}]);
  assert.equal(result.groups[0]!.wordEdits,1);assert.equal(result.groups[0]!.WER,1/6);
  assert.equal(result.groups[1]!.WER,0);assert.equal(result.groups[1]!.CER,0);
  assert.equal(JSON.stringify(result).includes('kita'),false);
});

test('evaluation reports insertions on empty recognition and validates reference inputs',()=>{
  assert.equal(editDistance(['satu','dua'],[]),2);assert.equal(editDistance([],['satu']),1);
  const result=evaluateTranscripts([{group:'noisy',reference:'Sembilan malam',recognized:''}]);assert.equal(result.groups[0]!.WER,1);
  for(const value of [[],null,[{group:'test',reference:'...',recognized:'satu'}]])assert.throws(()=>evaluateTranscripts(value));
});
