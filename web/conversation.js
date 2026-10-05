/* Human messages enter the app gate. Model output is display-only text. */
(() => {
  const $ = id => document.getElementById(id);
  const bridge = () => window.candocBatchBridge;
  let state, catalog = [], busy = false, token, key, pending, lastRun, revision, stopped=false;
  const modes = {idle:'시작 전',diagnosing:'전체 문서 진단 중',thinking:'Codex 답변 중',awaiting:'판단 대기',discussing:'대화 중',advancing:'다음 문제 준비',paused:'일시정지',error:'확인 필요'};
  const node = (tag,value,cls) => { const e=document.createElement(tag);e.textContent=value;if(cls)e.className=cls;return e; };
  const compact = c => { if(!c)return null;const r={asset_id:c.asset_id,revision:c.revision,ref:c.ref,cell:c.cell};if(c.group_id)r.group_id=c.group_id;return r; };
  const targetLabel = c => c ? `${c.ref||'문서'}${c.cell!==null?' · 셀 '+c.cell:''} · revision ${c.revision}` : '검수 시작 후 대상이 연결됩니다.';
  async function api(path, body) {
    const response = await fetch('/api/conversation/'+path,{method:body===undefined?'GET':'POST',headers:{'X-Candoc-Token':token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const value=await response.json();
    if(!response.ok){ if(response.status===403)token=(await (await fetch('/api/bootstrap')).json()).token;throw Error(value.error||'대화 요청 실패'); }
    return value;
  }
  function show(value){document.body.classList.toggle('conversation-open',value);$('conversation-panel').hidden=!value;localStorage.setItem('candoc-conversation-open',String(value));}
  window.candocConversationShow=show;
  $('conversation-toggle').onclick=()=>show(true);
  for(const id of ['chat-toggle','document-view','search-form','work-resume','suspects','proposals'])$(id).addEventListener(id==='search-form'?'submit':'click',()=>show(false));
  function efforts(preferred){
    const m=catalog.find(m=>m.model===$('conversation-model').value);
    $('conversation-effort').replaceChildren(...(m?.supportedReasoningEfforts||[]).map(e=>{const o=node('option',e.reasoningEffort);o.value=e.reasoningEffort;o.title=e.description;return o;}));
    if(m && [...$('conversation-effort').options].some(o=>o.value===(preferred||m.defaultReasoningEffort)))$('conversation-effort').value=preferred||m.defaultReasoningEffort;
  }
  $('conversation-model').onchange=()=>{efforts();buttons();};
  $('conversation-effort').onchange=buttons;
  async function guarded(fn){if(busy)return;busy=true;buttons();$('conversation-error').textContent='';try{await fn();await refresh();}catch(e){$('conversation-error').textContent=e.message;}finally{busy=false;buttons();}}
  function buttons(){
    if(!state)return;
    const running=['thinking','diagnosing','advancing'].includes(state.mode), ready=!!state.settings;
    $('conversation-models').disabled=busy||running;
    $('conversation-model').disabled=busy||running||!catalog.length;
    $('conversation-effort').disabled=busy||running||!catalog.length;
    $('conversation-configure').disabled=busy||running||!catalog.length||!$('conversation-effort').value;
    for(const a of ['start','next','previous','retry','resume'])$('conversation-'+a).disabled=busy||running||!ready;
    $('conversation-start').disabled=busy||running||(!ready&&(!catalog.length||!$('conversation-effort').value));
    $('conversation-resume').disabled ||= !['paused','error'].includes(state.mode);
    $('conversation-retry').disabled ||= state.mode!=='error';
    $('conversation-pause').disabled=busy||['idle','paused'].includes(state.mode);
    $('conversation-send').disabled=busy||!!pending||!['awaiting','discussing'].includes(state.mode);
    $('conversation-check').hidden=!pending;
    $('conversation-check').disabled=busy;
    target();
  }
  function target(){
    $('conversation-target').textContent= $('conversation-inspect').checked
      ? '새 질문 대상: '+targetLabel(window.candocChatContext?.())
      : '이 대화의 고정 대상: '+targetLabel(compact(state?.current?.context)||state?.context);
  }
  async function inspect(c, ref=c.ref, cell=c.cell){
    await bridge().navigate(c.locations?.[0]?.page||1,ref,cell??null);
    show(true);
  }
  function sourceButton(c,label,ref,cell){const b=node('button',label||'이 설명의 원본 영역 보기');b.type='button';b.onclick=()=>guarded(()=>inspect(c,ref??c.ref,cell===undefined?c.cell:cell));return b;}
  function changeText(item, cell){
    if(cell!==null&&cell!==undefined)return item.data.table_cells[cell].text;
    const labels={section_header:'절 제목',page_header:'페이지 머리말',page_footer:'페이지 꼬리말',text:'텍스트',paragraph:'문단'};
    return `${item.text||'표·구조 검토'}\n분류: ${labels[item.label]||item.label} · 계층: ${item.content_layer==='furniture'?'머리말·꼬리말':item.content_layer==='body'?'본문':item.content_layer}${item.level?' · 제목 단계 '+item.level:''}`;
  }
  function offerCard(o){
    const p=o.proposal, card=node('article','');card.dataset.offer=o.id;
    if(state.current?.id===o.id){card.classList.add('conversation-current');card.append(node('small',state.can_approve?'지금 답변으로 판단할 수정안':'다시 확인이 필요한 이전 수정안'));}
    const targets=p.targets||[{ref:p.request.ref,before:p.before,after:p.after,page:o.context.locations?.[0]?.page}];
    const actions={apply:'재분류',keep:'유지',defer:'보류',text:'내용 교정',cell:'셀 교정',type:'분류 교정'}, statuses={pending:'승인 대기',applied:'반영됨',stale:'재검수 필요',undone:'되돌림'};
    card.append(node('strong',`${p.title||'선택 항목 수정안'} · ${targets.length}항목 · ${actions[p.action||p.request?.op]||''} · ${statuses[p.status]||p.status}`));
    const representative=targets[0];
    if(p.action==='apply')card.append(node('p',`텍스트 유지 · ${representative.before.label} → ${representative.after.label} · 계층 ${representative.before.content_layer} → ${representative.after.content_layer}${representative.before.level?' · 제목 단계 제거':''}`,'conversation-diff'));
    card.append(node('small',`수정안 ${o.proposal_id} · 버전 ${o.version.slice(0,12)}`));
    card.append(node('p',p.reason||p.request?.reason||''));
    const details=document.createElement('details');details.append(node('summary',`정확한 전체 대상·현재 내용·수정안 ${targets.length}개 펼치기`));
    for(const t of targets){const row=node('article','');row.append(sourceButton(o.context,`${t.page||'?'}쪽 · ${t.ref} 원본`,t.ref,p.request?.cell??null));row.append(node('pre',`현재: ${changeText(t.before,p.request?.cell)}\n수정안: ${changeText(t.after,p.request?.cell)}`));details.append(row);}
    // A representative is visible without forcing the user through a long list.
    const t=targets[0];card.append(sourceButton(o.context,`${t.page||'?'}쪽 대표 원본`,t.ref,p.request?.cell??null));
    card.append(node('pre',`현재: ${changeText(t.before,p.request?.cell)}\n수정안: ${changeText(t.after,p.request?.cell)}`));card.append(details);
    if(p.conflicts?.length)card.append(node('p','내용 또는 검수 이력이 바뀌었습니다. 재진단 후 새 제안을 받으세요.','error'));
    if(p.status==='pending' && (!state.can_approve || state.current?.id!==o.id)){
      const b=node('button','이 수정안으로 다시 확인');b.type='button';b.disabled=['thinking','paused','diagnosing','advancing'].includes(state.mode);b.onclick=()=>control('present',{offer:o.id});card.append(b);
    }
    return card;
  }
  function render(){
    $('conversation-setting').textContent=state.settings?`현재 선택: ${state.settings.model} / ${state.settings.effort} · 변경은 다음 턴부터`:'모델과 Reasoning effort를 선택해야 시작할 수 있습니다.';
    $('conversation-status').textContent=`${modes[state.mode]} · ${state.note}${state.mode==='diagnosing'?` (${state.job.done}/${state.job.total}쪽)`:''}`;
    const transcript=$('conversation-transcript'), bottom=transcript.scrollHeight-transcript.scrollTop-transcript.clientHeight<80,scroll=transcript.scrollTop;
    const fragment=document.createDocumentFragment();
    const runs=state.chat.runs;
    for(const run of runs){
      const card=node('article','', 'conversation-turn');card.dataset.run=run.id;
      card.append(node('small',`${targetLabel(run.target)} · ${run.target.execution?.model||'?'} / ${run.target.execution?.effort||'?'} · ${run.status}`));
      card.append(sourceButton(run.target));
      card.append(node('p',run.message,'conversation-user'));
      card.append(node('pre',run.output||'실행 응답을 기다리고 있습니다.'));
      if(run.error)card.append(node('p',run.error,'error'));
      fragment.append(card);
    }
    // Human decisions and document receipts are not model-generated prose.
    for(const m of state.messages.filter(m=>m.result||!runs.some(r=>r.message===m.message))){
      const card=node('article','', 'conversation-receipt');card.append(node('p',m.message));
      card.append(node('small',m.result?`앱 확인: revision ${m.result.revision} DB 반영${m.result.undone?' · 이후 되돌림':''}`:'앱이 수신한 메시지 · 적용 이력 없음'));fragment.append(card);
    }
    if(!runs.length)fragment.append(node('p','검수를 시작하면 에이전트가 전체 문서의 첫 의심 항목을 가져옵니다. 원본을 보며 질문하거나 수정안을 조정하세요.'));
    transcript.replaceChildren(fragment);transcript.scrollTop=bottom?transcript.scrollHeight:scroll;
    const offers=state.offers.length?state.offers:state.current?[state.current]:[];
    const signature=JSON.stringify(offers.map(o=>[o.id,o.proposal.status,o.proposal.undone_revision]))+state.mode+state.generation;
    if($('conversation-offer').dataset.signature!==signature){$('conversation-offer').replaceChildren(...offers.map(offerCard));$('conversation-offer').dataset.signature=signature;}
    buttons();
  }
  async function refresh(){
    const next=await api('state');state=next;render();
    if(revision!==undefined && revision!==state.revision){await bridge().refresh();bridge().showExport(state.export);}
    revision=state.revision;
    const run=state.chat.runs.at(-1);
    if(run && run.id!==lastRun && run.target.ref && document.body.classList.contains('conversation-open')){lastRun=run.id;await inspect(run.target);}
  }
  function control(action,extra={}){return guarded(async()=>{
    if(action==='start'&&catalog.length)await api('settings',{model:$('conversation-model').value,effort:$('conversation-effort').value});
    await api('control',{action,...extra});
  });}
  for(const action of ['start','pause','resume','retry','previous','next'])$('conversation-'+action).onclick=()=>control(action);
  $('conversation-models').onclick=()=>guarded(async()=>{
    catalog=[];$('conversation-model').replaceChildren();$('conversation-effort').replaceChildren();
    const result=await api('models',{});catalog=result.models;
    $('conversation-model').replaceChildren(...catalog.map(m=>{const o=node('option',m.displayName||m.model);o.value=m.model;return o;}));
    const preferred=result.selected?.model||catalog.find(m=>m.isDefault)?.model;
    if(catalog.some(m=>m.model===preferred))$('conversation-model').value=preferred;
    efforts(result.selected?.effort);
    if(!catalog.length)throw Error('사용 가능한 모델이 없습니다. 다른 모델로 대체하지 않습니다.');
  });
  $('conversation-configure').onclick=()=>guarded(()=>api('settings',{model:$('conversation-model').value,effort:$('conversation-effort').value}));
  function savePending(value){pending=value;if(value)sessionStorage.setItem(key,JSON.stringify(value));else sessionStorage.removeItem(key);}
  async function send(){await api('message',pending);savePending(null);$('conversation-input').value='';localStorage.removeItem(key+':draft');$('conversation-inspect').checked=false;}
  $('conversation-form').onsubmit=e=>{e.preventDefault();if($('conversation-send').disabled||!$('conversation-input').value.trim())return;
    const inspect=$('conversation-inspect').checked;
    const context=inspect?compact(window.candocChatContext?.()):compact(state.current?.context)||state.context;
    if(!context){$('conversation-error').textContent='질문할 항목을 먼저 선택하세요.';return;}
    savePending({id:crypto.randomUUID(),message:$('conversation-input').value,presentation:state.current?.id||null,generation:state.generation,context,inspect,selection:compact(window.candocChatContext?.())});guarded(send);
  };
  $('conversation-check').onclick=()=>guarded(async()=>{await refresh();if(state.messages.some(m=>m.id===pending.id)){savePending(null);return;}await send();});
  $('conversation-input').oninput=()=>localStorage.setItem(key+':draft',$('conversation-input').value);
  $('conversation-inspect').onchange=target;
  window.addEventListener('candoc-selection',target);
  window.addEventListener('pagehide',()=>stopped=true);
  // The group list is optional navigation. Opening a group in the conversation is explicit.
  document.addEventListener('click',e=>{const b=e.target.closest('[data-conversation-group]');if(b){show(true);control('group',{group:b.dataset.conversationGroup});}});
  (async()=>{
    const boot=await(await fetch('/api/bootstrap')).json();token=boot.token;key=`candoc-conversation:${boot.workspace_id}:${boot.asset.asset_id}`;
    try{pending=JSON.parse(sessionStorage.getItem(key));}catch{}
    $('conversation-input').value=localStorage.getItem(key+':draft')||'';
    show(localStorage.getItem('candoc-conversation-open')!=='false');
    while(!stopped){try{await refresh();}catch(e){$('conversation-error').textContent='상태 확인 실패: '+e.message;}await new Promise(r=>setTimeout(r,1000));}
  })().catch(e=>$('conversation-error').textContent=e.message);
})();
