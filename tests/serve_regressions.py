"""Test-only server: opt-in filesystem fault injection, never on user workspaces."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from candoc import core
from candoc.server import make_server

data = (core.ROOT/'verification/browser-data/fixes-20261006').resolve()
assert data.is_relative_to((core.ROOT/'verification/browser-data').resolve())
real_atomic = core.atomic


def controlled_atomic(path, content):
    control = data/'export-fault.json'
    config = json.loads(control.read_text('utf-8')) if control.exists() else {}
    if Path(path).resolve().parent == data/'work' and Path(path).name == config.get('file'):
        raise PermissionError('Injected test-only export failure')
    return real_atomic(path, content)


core.atomic = controlled_atomic
server = make_server(data, 52742)
print(f'Test Asset only: {data} on http://127.0.0.1:52742', flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
    server.store.close()
