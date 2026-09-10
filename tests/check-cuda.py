"""Run with DeBG's venv Python and an already-downloaded ONNX model path.

Checks real CUDA execution after the same preload used by the Electron server.
Does not install packages, download models, or modify the runtime environment.
"""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile

import numpy as np
import onnxruntime as ort

launcher = Path(__file__).resolve().parents[1] / "electron" / "rembg-server.py"
spec = importlib.util.spec_from_file_location("debg_server", launcher)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.prepare_runtime()

with tempfile.TemporaryDirectory(prefix="debg-cuda-check-") as tmp:
    options = ort.SessionOptions()
    options.enable_profiling = True
    options.profile_file_prefix = str(Path(tmp) / "profile")
    session = ort.InferenceSession(sys.argv[1], sess_options=options,
                                   providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    try:
        print("ORT:", ort.__version__, "CUDA build:", ort.cuda_version, flush=True)
        print("Active session providers:", session.get_providers(), flush=True)
        assert "CUDAExecutionProvider" in session.get_providers(), "Session fell back to CPU"
        inputs = {}
        for item in session.get_inputs():
            assert item.type == "tensor(float)", f"Unsupported test input: {item.type}"
            # rembg's BiRefNet/BRIA image inputs can expose symbolic spatial axes.
            shape = [1024 if dim in ("height", "width") else dim for dim in item.shape]
            assert all(isinstance(dim, int) and dim > 0 for dim in shape), f"Unsupported input shape: {item.shape}"
            inputs[item.name] = np.zeros(shape, dtype=np.float32)
        session.run(None, inputs)
    finally:
        profile = Path(session.end_profiling())
        del session
    events = json.loads(profile.read_text())
    providers = {}
    for event in events:
        provider = event.get("args", {}).get("provider")
        if provider:
            providers[provider] = providers.get(provider, 0) + 1
    print("Executed nodes by provider:", providers, flush=True)
    assert providers.get("CUDAExecutionProvider", 0) > 0, "No CUDA kernels executed"
    print("PASS: real model inference executed CUDA kernels", flush=True)
