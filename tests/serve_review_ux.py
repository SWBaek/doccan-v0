"""Isolated UI redesign fixture. No real model calls; port 52742 only."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from candoc import core
from candoc.core import ROOT, initialize
from candoc.codex_rpc import StdioRPC
from candoc.server import make_server

parser = argparse.ArgumentParser()
parser.add_argument('--case', choices=['main','acceptance','safety','safety-final','final'], default='main')
case = parser.parse_args().case
data = (ROOT/'verification/browser-data'/('review-ux-20261006-'+case)).resolve()
assert data.is_relative_to((ROOT/'verification/browser-data').resolve())
if not (data/'manifest.json').exists(): initialize(ROOT/'IEEE-1547-2018-document-assets.zip', data)
state = ROOT/'verification/review-ux-20261006/browser-state'/case
atomic = core.atomic

def controlled_atomic(path, content):
    control = data/'export-fault.json'
    config = json.loads(control.read_text('utf-8')) if control.exists() else {}
    if Path(path).resolve().parent == data/'work' and Path(path).name == config.get('file'):
        raise PermissionError('Injected UI export failure')
    return atomic(path, content)
core.atomic = controlled_atomic

def factory(exe,cwd,on_event,on_request,on_exit,*,overrides=None):
    return StdioRPC(exe,cwd,on_event,on_request,on_exit,timeout=5,
        command=[sys.executable,str(ROOT/'tests/fake_codex.py'),'--state',str(state/'fake'),'--overrides',json.dumps(overrides or {})])

server = make_server(data,52742,{'codex_executable':'synthetic-only','project_dir':ROOT,'state_dir':state,'model':None},rpc_factory=factory)
print('Synthetic UI / isolated Asset http://127.0.0.1:52742 / '+case,flush=True)
try: server.serve_forever()
except KeyboardInterrupt: pass
finally: server.server_close();server.store.close()
