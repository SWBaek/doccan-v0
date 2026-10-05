async page => {
 const base='http://127.0.0.1:52742',check=(v,m)=>{if(!v)throw Error(m)},get=async p=>(await page.request.get(base+'/api/'+p)).json();
 const boot=await get('bootstrap'),baseline=await get('document');
 const post=async(p,data)=>(await page.request.post(base+'/api/'+p,{headers:{'X-Candoc-Token':boot.token},data})).json();
 await page.goto(base);await page.evaluate(()=>{for(const k of Object.keys(localStorage))if(k.startsWith('candoc-batch-v1:')||k.startsWith('candoc-review-v1:'))localStorage.removeItem(k)});await page.reload();await page.locator("#issues").click();
 await page.waitForFunction(()=>document.querySelector('#diagnostic-progress').textContent.includes('개 묶음'));
 await page.setViewportSize({width:1366,height:768});
 await page.locator('#diagnose').click();await page.waitForFunction(()=>document.querySelector('#diagnostic-status').textContent.includes('진단 완료'));
 await page.waitForFunction(()=>!document.querySelector('#batch-apply').disabled);
 const data=await get('diagnostics'),g=data.groups.find(g=>g.kind==='margin'&&g.evidence.pattern==='IEEE Std 1547-2018');
 await page.locator('#diagnostic-list summary').click();await page.locator(`[data-group="${g.id}"]`).click();
 const first=g.targets[0],last=g.targets.at(-1);await page.waitForFunction(ref=>window.candocChatContext()?.ref===ref,first.ref);
 check((await page.evaluate(()=>window.candocChatContext())).group_id===g.id,'Chat group selected');
 await page.waitForFunction(()=>[...document.querySelectorAll('[data-representative]')].every(c=>c.width>0&&c.height>0));
 await page.locator('#crop').waitFor({state:'visible'});await page.screenshot({path:'verification/conversation-20261006/batch-overview.png'});
 await page.locator('.diagnostic-representatives [data-inspect]').last().click();await page.waitForFunction(ref=>window.candocChatContext()?.ref===ref,last.ref);
 await page.locator('#crop').waitFor({state:'visible'});check(await page.locator('#crop').isVisible(),'Representative crop visible');
 await page.locator('#diagnostic-targets > summary').click();
 await page.locator(`[data-include="${last.ref}"]`).uncheck();
 await page.locator(`.diagnostic-target [data-inspect="${first.ref}"]`).click();await page.waitForFunction(ref=>window.candocChatContext()?.ref===ref,first.ref);
 const loc=(await get('item?ref='+encodeURIComponent(first.ref))).locations[0];
 check(Math.abs(loc.rect.y-(loc.size.height-loc.bbox.t))<.00001,'BOTTOMLEFT element origin');
 const included=g.targets.length-1;
 check((await page.locator('#batch-selected').innerText()).includes('선택 '+included),'Exception excluded');
 await page.screenshot({path:'verification/conversation-20261006/batch-review.png'});
 await page.locator('#batch-apply').click();await page.locator('#batch-confirm').waitFor();
 const p=await page.evaluate(()=>JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('candoc-batch-v1:')))).preview);
 const preview=await get('batch?id='+p);check(preview.targets.length===included,'Exact targets count');check(!preview.targets.some(t=>t.ref===last.ref),'Exception absent from exact preview');
 check(await page.locator('.batch-exact article').count()===included,'Every exact target rendered');
 // Original comparison never closes or changes the fixed approval batch.
 await page.locator('.batch-exact [data-inspect]').first().click();check(await page.locator('#batch-confirm').isVisible(),'Preview remains next to source');
 await page.locator('#batch-confirm').check();await page.waitForFunction(()=>!document.querySelector('#batch-approve').disabled);await page.locator('#crop').waitFor({state:'visible'});await page.screenshot({path:'verification/conversation-20261006/batch-approval.png'});
 await page.locator('#batch-approve').click();await page.waitForFunction(()=>document.querySelector('#batch-preview').textContent.includes('처리 결과'));
 const after=await get('document'),revision=(await get('bootstrap')).revision;
 check(revision===boot.revision+1,'One batch one revision');
 for(const t of preview.targets){const v=after.texts[Number(t.ref.split('/').at(-1))];check(v.label==='page_header'&&v.content_layer==='furniture','Every target updated');check(v.text===t.before.text&&v.orig===t.before.orig,'Source content retained');}
 check(JSON.stringify(after.texts[Number(last.ref.split('/').at(-1))])===JSON.stringify(baseline.texts[Number(last.ref.split('/').at(-1))]),'Exception unchanged');
 await page.reload();await page.waitForFunction(()=>document.querySelector('#batch-preview').textContent.includes('처리 결과'));
 check((await get('batch?id='+p)).status==='applied','Durable applied state after reload');
 await page.locator('#history').click();await page.locator('#undo').click();await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('되돌렸습니다'));
 check(JSON.stringify(await get('document'))===JSON.stringify(baseline),'One undo restores entire batch exactly');
 const valid=await get('validate');check(valid.unchanged_source_files===168&&valid.references_checked===6307,'Source and reference integrity');
 await page.screenshot({path:'verification/conversation-20261006/batch-undone.png'});
 return {pass:true,groups:data.groups.map(g=>({id:g.id,kind:g.kind,targets:g.targets.length})),approved:included,excluded:last.ref,revision,undoRevision:(await get('bootstrap')).revision,validation:valid};
}
