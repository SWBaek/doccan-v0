async page => {
 const base='http://127.0.0.1:52742',b=await(await page.request.get(base+'/api/bootstrap')).json(),headers={'X-Candoc-Token':b.token};
 const get=async path=>(await page.request.get(base+'/api/'+path,{headers})).json();
 const events=(await get('history')).length;
 await page.locator('#reexport').click();
 await page.waitForFunction(()=>document.querySelector('#export-warning').hidden,null,{timeout:60000});
 if((await get('bootstrap')).revision!==b.revision || (await get('history')).length!==events)throw Error('File recovery added a document change');
 await page.waitForFunction(()=>document.querySelector('#conversation-status').textContent.includes('문서 파일 저장을 복구'));
 await page.screenshot({path:'verification/review-ux-20261006/after-export-recovered.png'});
 await page.locator('#tools-toggle').click();await page.locator('#history').click();await page.locator('#undo').click();
 await page.waitForFunction(n=>document.querySelector('#asset').title.endsWith('revision '+n),b.revision+1);
 return {pass:true,recoveredWithoutNewHistory:true,finalRevision:(await get('bootstrap')).revision,validation:await get('validate')};
}
