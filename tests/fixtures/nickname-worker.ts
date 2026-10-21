process.send!({type:'status',status:{phase:'ready',label:'Nickname IPC fixture'}});
process.on('message',(message:any)=>{
  if (message.type==='shutdown') process.exit(0);
  if (message.type==='ask') {
    const request=message.input.nickname ?? {targetId:'777777777777777777',nickname:'Unexpected'};
    process.send!({type:'nickname',id:message.id,request});
    process.send!({type:'nickname',id:message.id,request});
  }
  if (message.type==='nickname_result') {
    if (message.error) process.send!({type:'failed',id:message.id,error:message.error});
    else process.send!({type:'result',id:message.id,payload:{content:message.result}});
  }
  if (message.type==='delivered') process.send!({type:'done',id:message.id});
});
process.on('disconnect',()=>process.exit(0));
