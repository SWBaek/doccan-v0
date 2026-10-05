async page => {
  const base = 'http://127.0.0.1:52742';
  const get = async path => (await page.request.get(base+'/api/'+path)).json();
  await page.goto(base);
  await page.locator('[data-ref="#/texts/0"]').click();
  await page.locator('#reason').fill('Isolated UI review-state test; not an original-source judgment');
  const results=[];
  for(const [op,state] of [['keep','kept'],['defer','deferred']]) {
    await page.locator('#'+op).click();
    await page.locator('[data-approve]').click();
    await page.waitForFunction(()=>document.getElementById('dialog-content').textContent.includes('대기 중인 제안이 없습니다'));
    await page.locator('#close-dialog').click();
    const info=await get('item?ref='+encodeURIComponent('#/texts/0'));
    if(info.reviews['#/texts/0'].state!==state)throw Error('Review state did not persist: '+state);
    results.push(state);
  }
  for(let i=0;i<2;i++) {
    await page.locator('#history').click();
    await page.locator('#undo').click();
    await page.waitForFunction(()=>!document.getElementById('dialog').open);
    await page.waitForFunction(()=>document.getElementById('message').textContent.includes('되돌렸습니다'));
  }
  await page.locator('#keep').click();
  await page.locator('[data-reject]').click();
  await page.waitForFunction(()=>document.getElementById('dialog-content').textContent.includes('대기 중인 제안이 없습니다'));
  await page.locator('#close-dialog').click();
  if(Object.keys((await get('bootstrap')).reviews).length)throw Error('Review states not restored');
  return {result:'PASS',approved_states:results,undone:2,rejected:true};
}
