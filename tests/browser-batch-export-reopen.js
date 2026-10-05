async page => {
 const base='http://127.0.0.1:52742',check=(v,m)=>{if(!v)throw Error(m)},get=async p=>(await page.request.get(base+'/api/'+p)).json();
 await page.reload();await page.locator('#export-warning').waitFor({state:'visible'});
 const s=await get('bootstrap'),history=(await get('history')).length;check(s.export.state==='pending','Restart retained pending state');
 // Fault file is removed by the test operator after this script's preceding restart check.
 return {pass:true,revision:s.revision,export:s.export,historyCount:history};
}
