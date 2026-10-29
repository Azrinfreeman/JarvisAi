import { UserError } from '../errors.js';

export function editDistance(reference:readonly string[],recognized:readonly string[]) {
  let previous=Uint32Array.from({length:recognized.length+1},(_,index)=>index);
  let current=new Uint32Array(recognized.length+1);
  for(let referenceIndex=0;referenceIndex<reference.length;referenceIndex++) {
    current[0]=referenceIndex+1;
    for(let recognizedIndex=0;recognizedIndex<recognized.length;recognizedIndex++) {
      current[recognizedIndex+1]=Math.min(current[recognizedIndex]!+1,previous[recognizedIndex+1]!+1,
        previous[recognizedIndex]!+(reference[referenceIndex]===recognized[recognizedIndex]?0:1));
    }
    [previous,current]=[current,previous];
  }
  return previous[recognized.length]!;
}

export function evaluateTranscripts(value:unknown) {
  if(!Array.isArray(value) || !value.length || value.length>500)throw new UserError('Evaluation requires 1–500 labeled reference/transcript pairs.');
  const groups=new Map<string,{samples:number;words:number;wordEdits:number;characters:number;characterEdits:number}>();
  for(const sample of value) {
    if(!sample || typeof sample!=='object' || typeof sample.group!=='string' || !sample.group.trim() || sample.group.length>80
      || typeof sample.reference!=='string' || !sample.reference.trim() || sample.reference.length>4000
      || typeof sample.recognized!=='string' || sample.recognized.length>4000)throw new UserError('Each evaluation pair needs a bounded group, nonempty reference and recognized text.');
    const normalize=(text:string)=>text.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}\s']/gu,' ').replace(/\s+/g,' ').trim();
    const reference=normalize(sample.reference),recognized=normalize(sample.recognized);
    const referenceWords=reference ? reference.split(' ') : [],recognizedWords=recognized ? recognized.split(' ') : [];
    if(!referenceWords.length)throw new UserError('An evaluation reference must contain words or numbers.');
    const group=groups.get(sample.group)??{samples:0,words:0,wordEdits:0,characters:0,characterEdits:0};
    group.samples++;group.words+=referenceWords.length;group.wordEdits+=editDistance(referenceWords,recognizedWords);
    group.characters+=[...reference].length;group.characterEdits+=editDistance([...reference],[...recognized]);groups.set(sample.group,group);
  }
  return {normalization:'Unicode NFC, lowercase, punctuation replaced by spaces; dialect words, numbers and negations preserved. CER includes normalized spaces.',
    groups:[...groups].map(([group,result])=>({group,...result,WER:result.wordEdits/result.words,CER:result.characterEdits/result.characters})),
    note:'Reference text must be checked against audio by a human. These metrics do not measure summary truth, critical facts, or all-accent support.'};
}
