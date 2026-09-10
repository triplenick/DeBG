"""Start the embedded rembg CLI with its virtual environment's GPU DLLs loaded."""
import webbrowser


def prepare_runtime():
    import onnxruntime as ort

    if "CUDAExecutionProvider" in ort.get_available_providers():
        # pip's NVIDIA wheels are not on the Windows DLL search path. Let ORT
        # find the libraries matching its own CUDA build before creating sessions.
        # Older ORT versions can still use their existing system DLL setup.
        if hasattr(ort, "preload_dlls"):
            ort.preload_dlls(directory="")


def bria_providers():
    # Avoid cuDNN's large exhaustive-search workspace and arena over-allocation.
    return [("CUDAExecutionProvider", {
        "cudnn_conv_algo_search": "HEURISTIC",
        "cudnn_conv_use_max_workspace": "0",
        "arena_extend_strategy": "kSameAsRequested",
    }), "CPUExecutionProvider"]


def configure_sessions():
    import importlib
    import onnxruntime as ort
    command = importlib.import_module("rembg.commands.s_command")
    original = command.new_session

    def new_session(model_name, *args, **kwargs):
        if (model_name == "bria-rmbg" and "providers" not in kwargs
                and "CUDAExecutionProvider" in ort.get_available_providers()):
            kwargs["providers"] = bria_providers()
        return original(model_name, *args, **kwargs)

    command.new_session = new_session


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
