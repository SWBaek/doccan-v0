"""Durable diagnostics and immutable, atomic approval batches, outside document JSON."""
import copy
import hashlib
import json
import threading
import uuid
from datetime import datetime, timezone

from .core import dump, resolve, validate, ProposalConflict
from .diagnostics import detect


def stamp(item):
    return hashlib.sha256(json.dumps(item,sort_keys=True,ensure_ascii=False).encode()).hexdigest()


class BatchReview:
    def __init__(self, store):
        self.store=store
        self.worker=None
        self.cancelled=threading.Event()
        store.db.executescript('''CREATE TABLE IF NOT EXISTS diagnostic_groups(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS diagnostic_state(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS diagnostic_decisions(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,payload TEXT NOT NULL);''')
        row=store.db.execute('SELECT payload FROM diagnostic_state').fetchone()
        self.job=json.loads(row[0]) if row else {'status':'idle','done':0,'total':0}
        if self.job['status']=='running':
            self.job.update(status='failed',error='서버 재시작으로 진단이 중단되었습니다. 이전 결과를 유지합니다. 재실행하세요.')
            self._save_job()

    def _save_job(self):
        with self.store.db:
            self.store.db.execute('INSERT OR REPLACE INTO diagnostic_state VALUES(1,?)',(dump(self.job),))

    def close(self):
        self.cancelled.set()
        if self.worker:self.worker.join(timeout=10)

    def start(self):
        with self.store.lock:
            if self.worker and self.worker.is_alive():return self.state()
            revision,doc,_=self.store.current()
            touched=self.store._last_changes()
            self.cancelled.clear()
            self.job={'status':'running','done':0,'total':len(doc['pages']),'revision':revision,'id':uuid.uuid4().hex}
            self._save_job()
            self.worker=threading.Thread(target=self._run,args=(doc,revision,touched),daemon=True)
            self.worker.start()
            return self.state()

    def cancel(self):
        self.cancelled.set()
        return self.state()

    def _run(self,doc,revision,touched):
        try:
            def progress(n,total):
                with self.store.lock:self.job.update(done=n,total=total)
            groups=detect(doc,progress,self.cancelled.is_set)
            with self.store.lock:
                if self.cancelled.is_set():raise InterruptedError('진단을 취소했습니다. 이전 결과를 유지합니다.')
                # Completed results are replaced atomically. Old processed targets
                # remain visible when no longer detected; IDs do not multiply.
                old={r[0]:json.loads(r[1]) for r in self.store.db.execute('SELECT id,payload FROM diagnostic_groups')}
                for g in old.values():
                    for t in g['targets']:
                        t['detected']=False
                        item=resolve(doc,t['ref'])
                        if t['before']!=item:t['previous_before']=t['before']
                        t.update(before=item,version=touched.get(t['ref'],0),locations=self.store.locations(doc,item))
                for g in groups:
                    prior=old.get(g['id'],{});targets={t['ref']:t for t in prior.get('targets',[])}
                    for t in g['targets']:
                        item=resolve(doc,t['ref'])
                        t.update(before=item,version=touched.get(t['ref'],0),detected=True,locations=self.store.locations(doc,item))
                        targets[t['ref']]=t
                    g.update(targets=sorted(targets.values(),key=lambda t:(t['page'] or 0,t['ref'])),revision=revision)
                    old[g['id']]=g
                with self.store.db:
                    for g in old.values():self.store.db.execute('INSERT OR REPLACE INTO diagnostic_groups VALUES(?,?)',(g['id'],dump(g)))
                    self.job.update(status='completed',done=len(doc['pages']),completed=datetime.now(timezone.utc).isoformat())
                    self.store.db.execute('INSERT OR REPLACE INTO diagnostic_state VALUES(1,?)',(dump(self.job),))
        except Exception as exc:
            with self.store.lock:
                self.job.update(status='cancelled' if isinstance(exc,InterruptedError) else 'failed',error=str(exc))
                self._save_job()

    def _group(self,gid):
        row=self.store.db.execute('SELECT payload FROM diagnostic_groups WHERE id=?',(gid,)).fetchone()
        if not row:raise ValueError('Unknown diagnostic group')
        return json.loads(row[0])

    def groups(self):
        revision,doc,_=self.store.current();touched=self.store._last_changes()
        decisions={r[0]:json.loads(r[1]) for r in self.store.db.execute('SELECT id,payload FROM diagnostic_decisions')}
        result=[]
        for row in self.store.db.execute('SELECT payload FROM diagnostic_groups'):
            g=json.loads(row[0])
            for t in g['targets']:
                item=resolve(doc,t['ref']);version=touched.get(t['ref'],0);decision=decisions.get(g['id']+':'+t['ref'])
                t['current']={'label':item.get('label'),'content_layer':item.get('content_layer'),'level':item.get('level'),'text':item.get('text')}
                t['state']='unresolved' if t.get('detected') else 'not_detected'
                if decision:
                    t['decision']=decision
                    t['state']=decision['state'] if decision['version']==version and decision['fingerprint']==stamp(item) else 'recheck'
                t['stale']=t['before']!=item or t['version']!=version
                if t['stale'] and (not decision or t['state']=='recheck'):
                    t['state']='recheck'
                if t['state']=='recheck':
                    t['recheck_reason']='진단/판단 이후 항목의 내용 또는 검수·되돌림 이력이 바뀌었습니다. 재진단 후 최신 원본을 다시 확인하세요.'
            g['counts']={state:sum(t['state']==state for t in g['targets']) for state in ('unresolved','applied','kept','deferred','recheck','not_detected')}
            g['current_revision']=revision
            result.append(g)
        return sorted(result,key=lambda g:(g['priority'],-len(g['targets']),g['id']))

    def state(self):
        with self.store.lock:
            groups=self.groups()
            return {'job':{**copy.deepcopy(self.job),'current_revision':self.store.current()[0]},'groups':groups,'counts':{k:sum(g['counts'][k] for g in groups) for k in ('unresolved','applied','kept','deferred','recheck','not_detected')},
                    'limitation':'탐지한 후보의 처리 현황입니다. 문서 전체 정확성 검증이 아니며, 변환에서 통째로 빠진 내용은 발견하지 못할 수 있습니다.'}

    def _batch(self,bid):
        row=self.store.db.execute('SELECT payload FROM batches WHERE id=?',(bid,)).fetchone()
        if not row:raise ValueError('Unknown batch')
        return json.loads(row[0])

    def view(self,bid):
        with self.store.lock:
            p=self._batch(bid);_,doc,_=self.store.current();touched=self.store._last_changes()
            p['conflicts']=[{'ref':t['ref'],'before':t['before'],'current':resolve(doc,t['ref']),'reason':'대상 내용 또는 검수 이력 변경'} for t in p['targets'] if resolve(doc,t['ref'])!=t['before'] or touched.get(t['ref'],0)!=t['version']]
            if p['status']=='pending' and p['conflicts']:p['status']='stale'
            return p

    def preview(self,req):
        with self.store.lock:
            if set(req)!={'group','refs','action','request_id'}:raise ValueError('Invalid batch request')
            if req['action'] not in ('apply','keep','defer'):raise ValueError('Invalid batch action')
            rid=req['request_id']
            if not isinstance(rid,str) or not 8<=len(rid)<=100:raise ValueError('Invalid request ID')
            row=self.store.db.execute('SELECT payload FROM batches WHERE id=?',(rid,)).fetchone()
            if row:
                p=json.loads(row[0])
                if p['request']!=req:raise ValueError('Request ID reused with different targets')
                return self.view(rid)
            refs=req['refs']
            if not isinstance(refs,list) or not refs or len(refs)!=len(set(refs)):raise ValueError('Select unique targets')
            group=self._group(req['group']);available={t['ref']:t for t in group['targets']}
            revision,doc,_=self.store.current();touched=self.store._last_changes();targets=[];conflicts=[]
            for ref in refs:
                if ref not in available:raise ValueError('Target outside diagnostic group')
                t=available[ref];item=resolve(doc,ref)
                if t['before']!=item or t['version']!=touched.get(ref,0):
                    conflicts.append({'ref':ref,'before':t['before'],'current':item,'baseline_version':t['version'],'current_version':touched.get(ref,0),'reason':'진단 기준이 변경되었습니다. 재진단 후 원본을 다시 확인하세요.'});continue
                after=copy.deepcopy(item)
                if req['action']=='apply':
                    if not t.get('detected') or not t['suggested'] or item.get('children') or not ref.startswith('#/texts/') or item['label'] not in {'text','paragraph','section_header','page_header','page_footer'}:
                        raise ValueError('Review-only target; no supported correction')
                    after.update(label=t['suggested'],content_layer='furniture');after.pop('level',None)
                    if item==after:raise ValueError('No change; run diagnostics again')
                targets.append(dict(ref=ref,page=t['page'],before=item,after=after,version=t['version']))
            if conflicts:raise ProposalConflict('진단 대상 충돌: 아무 항목도 적용하지 않았습니다.',{'id':rid,'status':'stale','conflicts':conflicts})
            candidate=copy.deepcopy(doc)
            for t in targets:
                target=resolve(candidate,t['ref']);target.clear();target.update(t['after'])
            validate(candidate)
            p=dict(id=rid,status='pending',group=group['id'],title=group['title'],reason=group['reason'],action=req['action'],request=req,revision=revision,targets=targets,
                   review_basis='group_decision',individually_reviewed=False)
            with self.store.db:self.store.db.execute('INSERT INTO batches VALUES(?,?)',(rid,dump(p)))
            return self.view(rid)

    def approve(self,bid,*,approval=None):
        with self.store.lock:
            p=self.view(bid)
            if p['status']!='pending':raise ProposalConflict('묶음이 이미 처리되었거나 충돌했습니다. 상태를 확인하세요.',p)
            revision,doc,reviews=self.store.current();old_reviews=copy.deepcopy(reviews)
            self.store.check_original()
            for t in p['targets']:
                item=resolve(doc,t['ref']);item.clear();item.update(t['after'])
                reviews[t['ref']]={'state':{'apply':'corrected_partial','keep':'kept','defer':'deferred'}[p['action']], 'reason':p['reason'],'proposal':bid,'revision':revision+1,'review_basis':'group_decision','individually_reviewed':False}
            validate(doc)
            decisions_before={};decisions_after={}
            for t in p['targets']:
                k=p['group']+':'+t['ref'];row=self.store.db.execute('SELECT payload FROM diagnostic_decisions WHERE id=?',(k,)).fetchone()
                decisions_before[k]=json.loads(row[0]) if row else None
                decisions_after[k]={'state':{'apply':'applied','keep':'kept','defer':'deferred'}[p['action']],'version':revision+1,'fingerprint':stamp(t['after']),'batch':bid,'individually_reviewed':False}
            p['status']='applied';p.pop('conflicts',None)
            event={'seq':revision+1,'kind':'apply','proposal':bid,'ref':p['targets'][0]['ref'],'refs':[t['ref'] for t in p['targets']],'batch':p['targets'],'title':p['title'],'before':p['targets'][0]['before'],'after':p['targets'][0]['after'],'reviews_before':old_reviews,'reviews_after':reviews,'decisions_before':decisions_before,'decisions_after':decisions_after,'time':datetime.now(timezone.utc).isoformat()}
            if approval is not None:event['conversation_approval']=copy.deepcopy(approval)
            with self.store.db:
                self.store.db.execute('UPDATE current SET revision=?,document=?,reviews=? WHERE id=1',(revision+1,dump(doc),dump(reviews)))
                self.store.db.execute('UPDATE batches SET payload=? WHERE id=?',(dump(p),bid))
                self.store.db.execute('INSERT INTO history VALUES(?,?)',(revision+1,dump(event)))
                for k,v in decisions_after.items():self.store.db.execute('INSERT OR REPLACE INTO diagnostic_decisions VALUES(?,?)',(k,dump(v)))
            return {**event,'committed':True,'export':self.store.export()}
