async page => {
 const errors=[];page.on("pageerror",e=>errors.push(e.message));
 await page.setViewportSize({width:1366,height:768});
 await page.reload();await page.locator("#crop").waitFor({state:"visible"});
 const checked=[];
 for(const [trigger,dialog] of [["explore-toggle","explore-dialog"],["manual-toggle","editor-dialog"],["tools-toggle","tools-dialog"]]) {
  await page.locator("#"+trigger).focus();await page.keyboard.press("Enter");
  await page.locator("#"+dialog).waitFor({state:"visible"});
  for(let i=0;i<24;i++) {
   await page.keyboard.press("Tab");
   // Native dialogs allow focus to browser chrome (activeElement becomes body),
   // but background page controls must remain inert.
   if(!await page.evaluate(id=>document.activeElement===document.body || document.getElementById(id).contains(document.activeElement),dialog))throw Error("Background control focused "+dialog);
  }
  // Return from browser chrome, if needed, before testing Escape.
  if(await page.evaluate(()=>document.activeElement===document.body))await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  if(await page.locator("#"+dialog).isVisible())throw Error("Escape failed "+dialog);
  if(!await page.evaluate(id=>document.activeElement.id===id,trigger))throw Error("Focus did not return "+trigger);
  checked.push(dialog);
 }
 await page.locator("#explore-toggle").click();
 await page.locator("[data-inspect]").first().click();
 await page.locator("#explore-dialog").waitFor({state:"hidden"});
 await page.locator("#crop").waitFor({state:"visible"});
 const sizes=[];
 for(const size of [{width:1366,height:768},{width:1920,height:1080},{width:390,height:844}]) {
  await page.setViewportSize(size);
  if(size.width<1000)await page.locator("#view-conversation").click();
  const box=await page.locator("#conversation-input").boundingBox();
  if(!box || box.y<0 || box.y+box.height>size.height)throw Error("Composer outside viewport");
  if(!await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))throw Error("Horizontal overflow");
  sizes.push(size.width);
 }
 if(errors.length)throw Error(errors.join(";"));
 return {pass:true,keyboardBackgroundInertEscapeAndReturn:checked,auxiliarySourceNavigation:true,viewportWidths:sizes,pageErrors:errors};
}
