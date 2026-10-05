async page => {
 const base='http://127.0.0.1:52742',check=(v,m)=>{if(!v)throw Error(m)};
 const get=async p=>(await page.request.get(base+'/api/'+p)).json();
 await page.goto(base);await page.reload();await page.locator('#items .item').first().waitFor();
 const doc=await get('document'),target=doc.texts.find(t=>t.text.length>1200&&t.prov.length===1&&!t.children.length);
 check(!!target,'Long leaf paragraph fixture');
 await page.locator('#search').fill(target.self_ref);await page.locator('#search-form button').click();await page.locator(`[data-queue="${target.self_ref}"]`).click();await page.waitForFunction(ref=>window.candocChatContext()?.ref===ref,target.self_ref);
 if(await page.locator('#proposal-review').isVisible())await page.locator('#proposal-hide').click();
 if(await page.locator('#draft-warning').isVisible())await page.locator('#draft-rebase').click();
 const edited='TEST 시작 '+target.text+' TEST 끝';
 await page.locator('#edit-value').fill(edited);await page.locator('#reason').fill('긴 문단 양 끝의 차이 표시 시험');await page.locator('#manual-propose').click();
 await page.waitForFunction(()=>document.querySelector('#proposal-content .reason')?.textContent.includes('긴 문단'));
 const p=(await get('proposals')).find(p=>p.status==='pending'&&p.request.reason==='긴 문단 양 끝의 차이 표시 시험');
 check(await page.locator('.diff pre').nth(0).textContent()===target.text,'Long before text exact');
 check(await page.locator('.diff pre').nth(1).textContent()===edited,'Long after text exact');
 check(await page.locator('.diff del').count()===0,'Unchanged middle is not marked removed');
 check(await page.locator('.diff ins').count()>=2,'Separated insertions highlighted');
 await page.setViewportSize({width:1366,height:768});await page.locator(`[data-approve="${p.id}"]`).focus();
 await page.screenshot({path:'verification/ux-20261006/after-laptop-long-paragraph.png'});
 const viewport=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));check(viewport.scroll<=viewport.width,'No horizontal page overflow');
 await page.setViewportSize({width:1920,height:1080});await page.screenshot({path:'verification/ux-20261006/after-desktop-long-paragraph.png'});
 await page.locator(`[data-reject="${p.id}"]`).click();await page.waitForFunction(()=>document.querySelector('#proposal-content [data-status="rejected"]'));
 const exact=await page.evaluate(()=>{const values=['A😀x <script> end','B😃x <tag> end'];return diffMarkup(...values).every((html,i)=>{const node=document.createElement('div');node.innerHTML=html;return node.textContent===values[i]&&!node.querySelector('script,tag')})});
 check(exact,'Diff preserves Unicode and escapes markup');
 const status=await get('bootstrap');
 check(JSON.stringify(await get('document'))===JSON.stringify(doc),'Visual test did not change document');
 return {result:'PASS',long_paragraph:target.self_ref,before_chars:target.text.length,word_diff_exact:true,unicode_escaped:true,viewports:[1366,1920],revision:status.revision};
}
