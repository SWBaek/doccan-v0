async page => {
 const base='http://127.0.0.1:52742';
 const get=async p=>(await page.request.get(base+'/api/'+p)).json();
 const boot=await get('bootstrap');
 if(boot.workspace_id!=='f0d654c764d2a0b5')throw Error('Not the authorized conversation test Asset');
 let count=0;
 for(;;){
  const h=await get('history'),undone=new Set(h.filter(e=>e.kind==='undo').map(e=>e.undoes));
  if(!h.some(e=>e.kind==='apply'&&!undone.has(e.seq)))break;
  if(count++>30)throw Error('Unexpected history length');
  const result=await page.request.post(base+'/api/undo',{headers:{'X-Candoc-Token':boot.token},data:{revision:(await get('bootstrap')).revision}});
  if(!result.ok())throw Error(await result.text());
 }
 return {restored:count,revision:(await get('bootstrap')).revision,reviews:(await get('bootstrap')).reviews};
}
