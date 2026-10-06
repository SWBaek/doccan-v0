async page => {
 const expected=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('review-ux-restart-expected')));
 const base='http://127.0.0.1:52742';await page.reload();
 await page.waitForFunction(()=>document.querySelector('#header-progress').textContent==='일시정지',null,{timeout:60000});
 const b=await(await page.request.get(base+'/api/bootstrap')).json(),headers={'X-Candoc-Token':b.token};
 const read=async()=>(await page.request.get(base+'/api/conversation/state',{headers})).json();
 let s=await read();
 if(s.current.id!==expected.offer || JSON.stringify(s.current.refs)!==JSON.stringify(expected.refs) || JSON.stringify(s.settings)!==JSON.stringify(expected.settings) || s.revision!==expected.revision)throw Error('Restart lost pending proposal or settings');
 if(s.chat.runs.length!==expected.runs)throw Error('Restart replayed a model turn');
 if(await page.locator('#editor-dialog').isVisible())throw Error('Closed manual editor stole focus');
 await page.screenshot({path:'verification/review-ux-20261006/after-restart.png'});
 await page.locator('#conversation-resume').click();
 await page.waitForFunction(()=>document.querySelector('#header-progress').textContent==='대화 중');
 await page.locator('[data-present]').click();
 await page.waitForFunction(()=>document.querySelector('[data-decision]')&&!document.querySelector('[data-decision]').disabled);
 s=await read();if(s.revision!==expected.revision || s.chat.runs.length!==expected.runs)throw Error('Resume resent or applied prior work');
 return {pass:true,revision:s.revision,restoredScope:s.current.refs.length,settings:s.settings,modelTurnReplayed:false,approvalReplayed:false};
}
