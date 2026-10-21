process.send!({type:'status',status:{phase:'ready',label:'Synthetic worker'}});
process.on('message',(message: any) => {
  if (message.type === 'shutdown') process.exit(0);
  if (message.type === 'ask') {
    const result = {type:'result',id:message.id,payload:{content:'One synthetic answer',
      embeds:[{title:'Question',description:'Image',image:{url:'attachment://question.png'}},{title:'Answer',description:'One'}],
      files:[{attachment:Buffer.from([1,2,3]),name:'question.png',description:'Synthetic image transport'}]}};
    process.send!(result); process.send!(result);
  }
  if (message.type === 'delivered') process.send!({type:'done',id:message.id});
});
process.on('disconnect',() => process.exit(0));
