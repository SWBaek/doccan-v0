async page => {
  const base='http://127.0.0.1:52742';
  const get=async path=>(await page.request.get(base+'/api/'+path)).json();
  await page.goto(base);
  const s=await get('bootstrap');
  const cell=(await get('item?ref=%23%2Ftables%2F0&cell=0')).item.data.table_cells[0];
  const p=await (await page.request.post(base+'/api/propose',{headers:{'X-Candoc-Token':s.token},data:{asset_id:s.asset.asset_id,revision:s.revision,ref:'#/tables/0',op:'keep',cell:0,reason:'Before-fix reproduction on temporary Asset'}})).json();
  await page.locator('#proposals').click();
  const card=page.locator('.proposal').filter({has:page.locator(`[data-approve="${p.id}"]`)});
  await card.waitFor();
  const approvalContainsCellText=(await card.innerText()).includes(cell.text);
  await card.locator('[data-view]').click();
  await page.waitForFunction(()=>document.getElementById('ref').textContent==='#/tables/0');
  const selectedCell=await page.locator('#cell').inputValue();
  const region=await page.locator('#location-note').textContent();
  await page.locator('#proposals').click();
  await page.locator(`[data-reject="${p.id}"]`).click();
  return {proposal:p.id,approvalContainsCellText,selectedCell,region,expectedCell:'0',expectedText:cell.text};
}
