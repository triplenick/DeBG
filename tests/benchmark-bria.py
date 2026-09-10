from pathlib import Path
import importlib.util, time, os, sys
os.environ['U2NET_HOME'] = str(Path.home() / 'AppData/Roaming/DeBG/models')
spec = importlib.util.spec_from_file_location('launcher', 'electron/rembg-server.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); m.prepare_runtime()
m.configure_sessions()
import importlib
new_session = importlib.import_module('rembg.commands.s_command').new_session
from PIL import Image
start = time.perf_counter()
session = new_session(sys.argv[1] if len(sys.argv) > 1 else 'bria-rmbg')
print('LOAD', time.perf_counter()-start, 'PROVIDERS', session.inner_session.get_providers(), flush=True)
for i in range(3):
    start = time.perf_counter()
    session.predict(Image.new('RGB', (1200, 1600), (180, 150, 90)))
    print('INFERENCE', i+1, time.perf_counter()-start, flush=True)
