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


def main():
    prepare_runtime()
    # rembg opens '/' even with --no-ui; Electron already owns the UI.
    # BROWSER does not reliably suppress Python's Windows browser handler.
    webbrowser.open = lambda *args, **kwargs: False
    from rembg.cli import main as rembg_main

    rembg_main()


if __name__ == "__main__":
    main()
