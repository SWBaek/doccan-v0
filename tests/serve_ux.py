"""Browser-only synthetic Codex server. Hard-limited to the test Asset and port."""
import json
from pathlib import Path
import sys

sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from candoc import core
from candoc.core import ROOT,initialize
from candoc.codex_rpc import StdioRPC
from candoc.server import make_server

data=(ROOT/'verification/browser-data/ux-20261006').resolve()
assert data.is_relative_to((ROOT/'verification/browser-data').resolve())
if not (data/'manifest.json').exists():initialize(ROOT/'IEEE-1547-2018-document-assets.zip',data)
state=ROOT/'verification/ux-20261006/browser-state'
real_atomic=core.atomic

def controlled_atomic(path, content):
    control=data/'export-fault.json'
    config=json.loads(control.read_text('utf-8')) if control.exists() else {}
    if Path(path).resolve().parent == data/'work' and Path(path).name == config.get('file'):
        raise PermissionError('Injected test-only export failure')
    return real_atomic(path,content)

core.atomic=controlled_atomic
def factory(executable,cwd,on_event,on_request,on_exit,*,overrides=None):
    return StdioRPC(executable,cwd,on_event,on_request,on_exit,timeout=5,
        command=[sys.executable,str(ROOT/'tests/fake_codex.py'),'--state',str(state/'fake'),
                 '--overrides',json.dumps(overrides or {})])
server=make_server(data,52742,{'codex_executable':'synthetic-only','project_dir':ROOT,'state_dir':state,'model':None},rpc_factory=factory)
print('Synthetic Codex / isolated Asset: http://127.0.0.1:52742',flush=True)
try:server.serve_forever()
except KeyboardInterrupt:pass
finally:server.server_close();server.store.close()
