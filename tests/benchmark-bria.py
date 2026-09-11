"""Benchmark cached models through the same session handles as the server.

Pass model IDs to test switching, e.g. birefnet-general bria-rmbg birefnet-general.
No downloads are intended; use models already present in DeBG's cache.
"""
from pathlib import Path
import importlib
import importlib.util
import os
import sys
import time

os.environ['U2NET_HOME'] = str(Path.home() / 'AppData/Roaming/DeBG/models')
spec = importlib.util.spec_from_file_location('launcher', Path(__file__).resolve().parents[1] / 'electron/rembg-server.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.prepare_runtime()
module.configure_sessions()
new_session = importlib.import_module('rembg.commands.s_command').new_session
from PIL import Image

handles = {}
for model in sys.argv[1:] or ['bria-rmbg']:
    if model not in handles:
        handles[model] = new_session(model)
    for index in range(3):
        started = time.perf_counter()
        handles[model].predict(Image.new('RGB', (1200, 1600), (180, 150, 90)))
        print('PASS', model, index + 1, 'total seconds', round(time.perf_counter() - started, 3), flush=True)
