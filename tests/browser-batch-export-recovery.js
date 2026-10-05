async page => {
 const base='http://127.0.0.1:52742',check=(v,m)=>{if(!v)throw Error(m)},get=async p=>(await page.request.get(base+'/api/'+p)).json();
 const before=await get('bootstrap'),history=(await get('history')).length;
 await page.locator('#reexport').click();await page.waitForFunction(()=>document.querySelector('#export-warning').hidden);
 const after=await get('bootstrap');check(after.revision===before.revision&&after.export.state==='synced','Reexport no new revision');check((await get('history')).length===history,'No repeated approval/history');
 await page.locator('#history').click();await page.locator('#undo').click();await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('되돌렸습니다'));
 const valid=await get('validate');check(valid.unchanged_source_files===168,'Source preserved');
 await page.screenshot({path:'verification/batch-20261006/export-recovered.png'});
 return {pass:true,reexportRevision:after.revision,undoRevision:valid.revision,export:valid.export};
}
