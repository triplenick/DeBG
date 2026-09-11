"""Start the embedded rembg CLI with its virtual environment's GPU DLLs loaded."""
import webbrowser
import gc
import threading
import time


def prepare_runtime():
    import onnxruntime as ort

    if "CUDAExecutionProvider" in ort.get_available_providers():
        # pip's NVIDIA wheels are not on the Windows DLL search path. Let ORT
        # find the libraries matching its own CUDA build before creating sessions.
        # Older ORT versions can still use their existing system DLL setup.
        if hasattr(ort, "preload_dlls"):
            ort.preload_dlls(directory="")


def low_memory_cuda_providers():
    # Avoid cuDNN's large exhaustive-search workspace and arena over-allocation.
    return [("CUDAExecutionProvider", {
        "cudnn_conv_algo_search": "HEURISTIC",
        "cudnn_conv_use_max_workspace": "0",
        "arena_extend_strategy": "kSameAsRequested",
    }), "CPUExecutionProvider"]


class SingleModelSessions:
    """rembg may cache handles forever; only one handle owns a live ORT session.

    Loading and prediction share a lock so a model switch cannot release a
    session during inference, including after a client request has timed out.
    """
    def __init__(self, factory):
        self.factory = factory
        self.active_handle = None
        self.active_session = None
        self.lock = threading.Lock()

    def new_session(self, model_name, *args, **kwargs):
        owner = self

        class Handle:
            def predict(self, image, *predict_args, **predict_kwargs):
                with owner.lock:
                    if owner.active_handle is not self:
                        # Drop the last strong reference before constructing the next
                        # model. Handles cached by rembg never retain GPU allocations.
                        owner.active_session = None
                        owner.active_handle = None
                        gc.collect()
                        started = time.perf_counter()
                        owner.active_session = owner.factory(model_name, *args, **kwargs)
                        owner.active_handle = self
                        print(f"[model] Loaded {model_name} in {time.perf_counter() - started:.2f}s; "
                              f"providers={owner.active_session.inner_session.get_providers()}", flush=True)
                    started = time.perf_counter()
                    try:
                        return owner.active_session.predict(image, *predict_args, **predict_kwargs)
                    finally:
                        print(f"[model] {model_name} inference {time.perf_counter() - started:.2f}s", flush=True)

        return Handle()


def configure_sessions():
    import importlib
    import onnxruntime as ort
    command = importlib.import_module("rembg.commands.s_command")
    original = command.new_session

    def new_session(model_name, *args, **kwargs):
        if ((model_name == "bria-rmbg" or model_name.startswith("birefnet-"))
                and "providers" not in kwargs
                and "CUDAExecutionProvider" in ort.get_available_providers()):
            kwargs["providers"] = low_memory_cuda_providers()
        return original(model_name, *args, **kwargs)

    command.new_session = SingleModelSessions(new_session).new_session


def main():
    prepare_runtime()
    configure_sessions()
    # rembg opens '/' even with --no-ui; Electron already owns the UI.
    # BROWSER does not reliably suppress Python's Windows browser handler.
    webbrowser.open = lambda *args, **kwargs: False
    from rembg.cli import main as rembg_main

    rembg_main()


if __name__ == "__main__":
    main()
