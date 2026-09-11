"""No ONNX/CUDA required: verify rembg's cached handles release old sessions."""
import gc
import importlib.util
from pathlib import Path
import unittest
import threading
from concurrent.futures import ThreadPoolExecutor
import weakref

spec = importlib.util.spec_from_file_location('launcher', Path(__file__).resolve().parents[1] / 'electron/rembg-server.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)

class SessionLifecycleTest(unittest.TestCase):
    def test_switch_releases_previous_and_reuses_current(self):
        created = []
        class Fake:
            def __init__(self, name):
                self.name = name
                self.inner_session = self
            def get_providers(self): return ['CUDAExecutionProvider']
            def predict(self, image, **kwargs): return (self.name, image, kwargs)
        def factory(name, **kwargs):
            gc.collect()
            self.assertTrue(all(ref() is None for ref in created))
            session = Fake(name)
            created.append(weakref.ref(session))
            return session
        cache = launcher.SingleModelSessions(factory)
        a = cache.new_session('birefnet-general')
        b = cache.new_session('bria-rmbg')
        self.assertEqual(len(created), 0)
        self.assertEqual(a.predict('image')[0], 'birefnet-general')
        a.predict('next image')
        self.assertEqual(len(created), 1)
        self.assertEqual(b.predict('image')[0], 'bria-rmbg')
        self.assertIsNone(created[0]())
        a.predict('return to first model')
        self.assertEqual(len(created), 3)
        self.assertIsNone(created[1]())

    def test_switch_waits_for_running_prediction(self):
        entered = threading.Event()
        release = threading.Event()
        requesting_switch = threading.Event()
        loaded = []
        class Fake:
            inner_session = None
            def get_providers(self): return ['CPUExecutionProvider']
            def predict(self, image):
                if image == 'slow':
                    entered.set()
                    if not release.wait(5): raise RuntimeError('test timeout')
                return image
        def factory(name):
            loaded.append(name)
            session = Fake()
            session.inner_session = session
            return session
        cache = launcher.SingleModelSessions(factory)
        a, b = cache.new_session('a'), cache.new_session('b')
        def switch():
            requesting_switch.set()
            return b.predict('next')
        with ThreadPoolExecutor(2) as pool:
            first = pool.submit(a.predict, 'slow')
            self.assertTrue(entered.wait(5))
            second = pool.submit(switch)
            self.assertTrue(requesting_switch.wait(5))
            self.assertEqual(loaded, ['a'])
            release.set()
            self.assertEqual(first.result(5), 'slow')
            self.assertEqual(second.result(5), 'next')
            self.assertEqual(loaded, ['a', 'b'])

    def test_failed_load_can_retry(self):
        attempts = []
        def factory(name):
            attempts.append(name)
            raise RuntimeError('load failed')
        cache = launcher.SingleModelSessions(factory)
        handle = cache.new_session('bria-rmbg')
        for _ in range(2):
            with self.assertRaisesRegex(RuntimeError, 'load failed'):
                handle.predict('image')
            self.assertIsNone(cache.active_session)
            self.assertIsNone(cache.active_handle)
        self.assertEqual(len(attempts), 2)

if __name__ == '__main__': unittest.main()
