"""Create real CLI proposals for the isolated browser regression server."""
import json
from pathlib import Path
import subprocess
import sys
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT/'verification/browser-data/fixes-20261006'
OUT = ROOT/'verification/fixes-20261006'
BASE = 'http://127.0.0.1:52742'
session = json.load(urlopen(BASE+'/api/bootstrap'))
scenario = sys.argv[1]
if scenario == 'export':
    proposals = [('CLI export failure', {'op':'cell','ref':'#/tables/0','cell':0,'value':'Regression approved cell'})]
    (DATA/'export-fault.json').write_text('{"file":"document.json"}', 'utf-8')
elif scenario == 'stale':
    proposals = [
        ('CLI independent A', {'op':'text','ref':'#/texts/0','value':'Regression approved A'}),
        ('CLI independent B', {'op':'text','ref':'#/texts/1','value':'Regression approved B'}),
        ('CLI competing C', {'op':'type','ref':'#/texts/0','value':'section_header','level':2}),
    ]
else:
    raise ValueError('Unknown regression scenario')
created = []
for index, (reason, change) in enumerate(proposals):
    request = {**change, 'asset_id':session['asset']['asset_id'], 'revision':session['revision'], 'reason':reason}
    path = OUT/f'{scenario}-proposal-{index}.json'
    path.write_text(json.dumps(request, ensure_ascii=False, indent=2), 'utf-8')
    result = subprocess.run([sys.executable, '-m', 'candoc.cli', '--url', BASE, 'propose', str(path)],
                            cwd=ROOT, capture_output=True, text=True, encoding='utf-8', check=True)
    p = json.loads(result.stdout)
    created.append({'id':p['id'],'reason':reason,'revision':p['request']['revision']})
(OUT/f'{scenario}-cli-created.json').write_text(json.dumps(created, indent=2),'utf-8')
print(json.dumps(created))
