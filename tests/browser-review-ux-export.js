async page => {
 const base='http://127.0.0.1:52742',b=await(await page.request.get(base+'/api/bootstrap')).json(),headers={'X-Candoc-Token':b.token};
 const read=async()=>(await page.request.get(base+'/api/conversation/state',{headers})).json();
 const before=await read();
 await page.locator('[data-decision="승인해"]').click();
 await page.waitForFunction(()=>!document.querySelector('#export-warning').hidden,null,{timeout:60000});
 await page.waitForFunction(()=>document.querySelector('#header-progress').textContent==='일시정지');
 const after=await read();
 if(after.revision!==before.revision+1 || after.export.state!=='pending' || after.export.files['document.json']!==before.revision)throw Error('Export failure not accurately exposed');
 await page.screenshot({path:'verification/review-ux-20261006/after-export-pending.png'});
 if(!(await page.locator('#export-detail').textContent()).includes('재승인할 필요는 없습니다'))throw Error('Missing recovery guidance');
 return {pass:true,committedRevision:after.revision,documentFileRevision:after.export.files['document.json'],paused:after.mode==='paused',sourceScope:before.current.refs.length};
}
