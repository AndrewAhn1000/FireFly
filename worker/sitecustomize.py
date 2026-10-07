"""Loaded by Python on startup in the installed app (its bundled Python has this folder on its path): when
FireFly has downloaded a CUDA build of PyTorch for the card (electron/gpu.cjs), FIREFLY_GPU_TORCH names its
folder, which then comes before the bundled CPU build. Without it, nothing changes."""
import os
import sys

_gpu = os.environ.get('FIREFLY_GPU_TORCH')
if _gpu and os.path.isdir(os.path.join(_gpu, 'torch')):
    sys.path.insert(0, _gpu)
