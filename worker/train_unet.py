"""UNet binary segmentation trainer.

Usage
-----
  python worker/train_unet.py --data path/to/dataset [options]

Dataset layout accepted
-----------------------
  Flat (auto-split 90/10):
    dataset/
      images/  *.png
      masks/   *.png   (grayscale: 0 = background, non-zero = foreground)

  Pre-split:
    dataset/
      train/
        images/  *.png
        masks/   *.png
      val/
        images/  *.png
        masks/   *.png
"""
from __future__ import annotations

import argparse
import gc
import json
import os
import shutil
import random
import sys
import time
from multiprocessing import Pool
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image
from torch.utils.data import DataLoader, Dataset

# ── reproducibility ───────────────────────────────────────────────────────────

def seed_everything(s: int = 0) -> None:
    random.seed(s)
    np.random.seed(s)
    torch.manual_seed(s)


# ── dataset ───────────────────────────────────────────────────────────────────

IMG_EXTS = {'.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff'}


class SegDataset(Dataset):
    def __init__(
        self,
        img_dir: Path,
        mask_dir: Path,
        img_size: int | tuple[int, int] = 512,
        augment: bool = False,
    ) -> None:
        self.img_dir  = img_dir
        self.mask_dir = mask_dir
        # (width, height): an int is a square, as before
        self.size     = (img_size, img_size) if isinstance(img_size, int) else tuple(img_size)
        self.augment  = augment

        stems = sorted(
            p.stem for p in img_dir.iterdir()
            if p.suffix.lower() in IMG_EXTS
        )
        # pair by stem; try multiple extensions for the mask
        self.pairs: list[tuple[Path, Path]] = []
        for stem in stems:
            img_path = next(
                (img_dir / (stem + ext) for ext in IMG_EXTS if (img_dir / (stem + ext)).exists()),
                None,
            )
            mask_path = next(
                (mask_dir / (stem + ext) for ext in IMG_EXTS if (mask_dir / (stem + ext)).exists()),
                None,
            )
            if img_path and mask_path:
                self.pairs.append((img_path, mask_path))

        if not self.pairs:
            raise RuntimeError(f"No matched image/mask pairs found in {img_dir} / {mask_dir}")

        self._cache: dict | None = None   # decoded once (see cache): paths, and which pair is which row
        self._arrays = None               # the decoded files, opened in each process that reads them

    def __len__(self) -> int:
        return len(self.pairs)

    # Decoding a PNG, and resizing it, every time an epoch reads it was most of an epoch's time (25,902
    # images, about 2 minutes an epoch on a GPU that waited on them): decoded once at the training size
    # into raw files, an epoch only reads them
    def cache(self, folder: Path, indices: list[int] | None, workers: int, label: str) -> None:
        indices = list(range(len(self.pairs))) if indices is None else sorted(set(indices))
        (w, h), size, n = self.size, self.size, len(indices)
        folder.mkdir(parents=True, exist_ok=True)
        images_path, masks_path = folder / f'{label}-images.npy', folder / f'{label}-masks.npy'
        jobs = [(self.pairs[i], size) for i in indices]
        started, step = time.time(), max(1, n // 20)
        # Written in order with ordinary writes, pushed to disk every 512 MB: written through a memory map,
        # Windows doesn't slow the writer to the disk's pace, and 50 GB of decoded 800x600 images filled a
        # 32 GB PC's memory with pages waiting to be written until the whole system froze. A mask is 0 or 1
        # a pixel, so it's kept as bits (8 times smaller). Decoding runs below normal priority, so the PC
        # stays usable meanwhile.
        _below_normal()
        pending = 0
        with open(images_path, 'wb') as fi, open(masks_path, 'wb') as fm, \
                (Pool(workers, initializer=_below_normal) if workers > 1 else _Inline()) as pool:
            np.lib.format.write_array_header_1_0(fi, {'descr': '|u1', 'fortran_order': False, 'shape': (n, h, w, 3)})
            np.lib.format.write_array_header_1_0(fm, {'descr': '|u1', 'fortran_order': False, 'shape': (n, (h * w + 7) // 8)})
            for row, (img, mask) in enumerate(pool.imap(_decode, jobs, chunksize=16)):
                fi.write(np.ascontiguousarray(img).tobytes())
                fm.write(np.packbits(mask.reshape(-1)).tobytes())
                pending += img.nbytes
                if pending >= 512 << 20:
                    for f in (fi, fm):
                        f.flush(); os.fsync(f.fileno())
                    pending = 0
                if (row + 1) % step == 0 or row + 1 == n:
                    print(f"  decoding {label}: {row + 1}/{n} ({time.time() - started:.0f} s)", flush=True)
        _below_normal(False)
        self._cache = {'images': str(images_path), 'masks': str(masks_path), 'rows': {i: r for r, i in enumerate(indices)}, 'shape': (h, w)}
        self._arrays = None

    def __getstate__(self):  # worker processes open the decoded files themselves
        state = self.__dict__.copy()
        state['_arrays'] = None
        return state

    def __getitem__(self, idx: int):
        row = self._cache['rows'].get(idx) if self._cache else None
        if row is not None:
            if self._arrays is None:
                self._arrays = (np.load(self._cache['images'], mmap_mode='r'), np.load(self._cache['masks'], mmap_mode='r'))
            h, w = self._cache['shape']
            img = self._arrays[0][row].astype(np.float32) / 255.0
            mask = np.unpackbits(self._arrays[1][row])[:h * w].reshape(h, w).astype(np.float32)
        else:
            img_path, mask_path = self.pairs[idx]
            img  = np.array(Image.open(img_path).convert('RGB'),  dtype=np.float32) / 255.0
            mask = (np.array(Image.open(mask_path)) > 0).astype(np.float32)
            # Fitted into the training size, keeping proportions
            img  = _resize(img,  self.size, is_mask=False)
            mask = _resize(mask, self.size, is_mask=True)

        if self.augment:
            img, mask = _augment(img, mask)

        # Normalize image with ImageNet stats
        mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
        std  = np.array([0.229, 0.224, 0.225], dtype=np.float32)
        img  = (img - mean) / std

        img_t  = torch.from_numpy(img.transpose(2, 0, 1))          # C H W
        mask_t = torch.from_numpy(mask[np.newaxis])                 # 1 H W
        return img_t, mask_t


def _decode(job: tuple[tuple[Path, Path], tuple[int, int]]) -> tuple[np.ndarray, np.ndarray]:
    """One image and its mask at the training size, as bytes (as __getitem__ makes them from the files)."""
    (img_path, mask_path), size = job
    img = _fit(Image.open(img_path).convert('RGB'), size, Image.BILINEAR)
    mask = _fit(Image.fromarray((np.array(Image.open(mask_path)) > 0).astype(np.uint8)), size, Image.NEAREST)
    return img, mask


def _below_normal(on: bool = True) -> None:
    """This process below normal priority (Windows), so decoding leaves the PC usable; or normal again."""
    if os.name == 'nt':
        import ctypes
        kernel32 = ctypes.windll.kernel32
        kernel32.SetPriorityClass(kernel32.GetCurrentProcess(), 0x4000 if on else 0x20)  # BELOW_NORMAL / NORMAL


class _Inline:
    """A pool of one: decoding in this process."""
    def __enter__(self): return self
    def __exit__(self, *_): return False
    def imap(self, fn, jobs, chunksize=1): return map(fn, jobs)


def decoded_bytes(count: int, size: tuple[int, int]) -> int:
    return count * (size[0] * size[1] * 3 + (size[0] * size[1] + 7) // 8)  # 3 bytes an image pixel, a bit a mask's


def _size(size: int | tuple[int, int]) -> tuple[int, int]:
    return (size, size) if isinstance(size, int) else (int(size[0]), int(size[1]))


def _fit(pil: Image.Image, size: int | tuple[int, int], resample) -> np.ndarray:
    """Fitted into size (width, height) keeping its proportions and centred, the rest black: as the
    runtime fits a game's frames into the model (onnx_node.cpp), so what the model learns from and what
    it sees live are shaped the same. The same proportions are only resized; the same size, as it is."""
    w, h = _size(size)
    if pil.size != (w, h):
        scale = min(w / pil.width, h / pil.height)
        fw, fh = max(1, min(w, round(pil.width * scale))), max(1, min(h, round(pil.height * scale)))
        fitted = pil.resize((fw, fh), resample)
        if (fw, fh) != (w, h):
            canvas = Image.new(pil.mode, (w, h))
            canvas.paste(fitted, ((w - fw) // 2, (h - fh) // 2))
            fitted = canvas
        pil = fitted
    return np.array(pil, dtype=np.uint8)


def _resize(arr: np.ndarray, size: int | tuple[int, int], *, is_mask: bool) -> np.ndarray:
    """Fitted into size (width, height; an int is a square) using PIL (nearest for mask, bilinear for image)."""
    if arr.ndim == 2:
        pil = Image.fromarray(arr.astype(np.uint8))
    else:
        pil = Image.fromarray((arr * 255).clip(0, 255).astype(np.uint8))
    out = _fit(pil, size, Image.NEAREST if is_mask else Image.BILINEAR).astype(np.float32)
    if not is_mask:
        out /= 255.0
    return out


def _augment(img: np.ndarray, mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Flips and colour jitter."""
    if random.random() < 0.5:
        img  = img[:, ::-1, :].copy()
        mask = mask[:, ::-1].copy()
    if random.random() < 0.5:
        img  = img[::-1, :, :].copy()
        mask = mask[::-1, :].copy()
    if random.random() < 0.5:
        factor = np.random.uniform(0.7, 1.3, (1, 1, 3)).astype(np.float32)
        img = (img * factor).clip(0, 1)
    if random.random() < 0.3:
        shift = np.random.uniform(-0.05, 0.05, (1, 1, 3)).astype(np.float32)
        img = (img + shift).clip(0, 1)
    return img, mask


def build_datasets(
    data_root: Path,
    img_size: int,
    val_fraction: float = 0.1,
    seed: int = 0,
    max_samples: int = 0,
) -> tuple[SegDataset, SegDataset]:
    """Return (train_ds, val_ds) from a flat or pre-split directory."""
    rng = random.Random(seed)

    if (data_root / 'train').is_dir() and (data_root / 'val').is_dir():
        # Pre-split layout
        train_ds = SegDataset(data_root / 'train' / 'images', data_root / 'train' / 'masks', img_size, augment=True)
        val_ds   = SegDataset(data_root / 'val'   / 'images', data_root / 'val'   / 'masks', img_size, augment=False)
        if max_samples and max_samples < len(train_ds):
            idx = rng.sample(range(len(train_ds)), max_samples)
            train_ds = _SubsetDataset(train_ds, idx, augment=True)
        return train_ds, val_ds

    # Flat layout — manual split
    ds = SegDataset(data_root / 'images', data_root / 'masks', img_size, augment=False)
    total = min(len(ds), max_samples) if max_samples else len(ds)
    n_val   = max(1, int(total * val_fraction))
    n_train = total - n_val
    indices = list(range(len(ds)))
    rng.shuffle(indices)
    train_idx, val_idx = indices[:n_train], indices[n_train:n_train + n_val]

    train_ds = _SubsetDataset(ds, train_idx, augment=True)
    val_ds   = _SubsetDataset(ds, val_idx,   augment=False)
    return train_ds, val_ds


class _SubsetDataset(Dataset):
    """Thin wrapper that picks indices from a parent dataset and overrides augment."""
    def __init__(self, parent: SegDataset, indices: list[int], augment: bool) -> None:
        self.parent  = parent
        self.indices = indices
        self.augment = augment

    def __len__(self) -> int:
        return len(self.indices)

    def __getitem__(self, idx: int):
        orig_aug      = self.parent.augment
        self.parent.augment = self.augment
        item          = self.parent[self.indices[idx]]
        self.parent.augment = orig_aug
        return item


# ── model ─────────────────────────────────────────────────────────────────────

class _DoubleConv(nn.Module):
    def __init__(self, in_ch: int, out_ch: int) -> None:
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv2d(in_ch, out_ch, 3, padding=1, bias=False),
            nn.BatchNorm2d(out_ch),
            nn.ReLU(inplace=True),
            nn.Conv2d(out_ch, out_ch, 3, padding=1, bias=False),
            nn.BatchNorm2d(out_ch),
            nn.ReLU(inplace=True),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


class UNet(nn.Module):
    def __init__(self, in_ch: int = 3, base: int = 64) -> None:
        super().__init__()
        b = base
        # Encoder
        self.enc1 = _DoubleConv(in_ch, b)
        self.enc2 = _DoubleConv(b,     b * 2)
        self.enc3 = _DoubleConv(b * 2, b * 4)
        self.enc4 = _DoubleConv(b * 4, b * 8)
        self.pool = nn.MaxPool2d(2, 2)
        # Bottleneck
        self.bottleneck = _DoubleConv(b * 8, b * 16)
        # Decoder
        self.up4   = nn.ConvTranspose2d(b * 16, b * 8,  2, stride=2)
        self.dec4  = _DoubleConv(b * 16, b * 8)
        self.up3   = nn.ConvTranspose2d(b * 8,  b * 4,  2, stride=2)
        self.dec3  = _DoubleConv(b * 8,  b * 4)
        self.up2   = nn.ConvTranspose2d(b * 4,  b * 2,  2, stride=2)
        self.dec2  = _DoubleConv(b * 4,  b * 2)
        self.up1   = nn.ConvTranspose2d(b * 2,  b,      2, stride=2)
        self.dec1  = _DoubleConv(b * 2,  b)
        # Head
        self.head  = nn.Conv2d(b, 1, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        s1 = self.enc1(x)
        s2 = self.enc2(self.pool(s1))
        s3 = self.enc3(self.pool(s2))
        s4 = self.enc4(self.pool(s3))
        b  = self.bottleneck(self.pool(s4))
        x  = self.dec4(torch.cat([_pad_to(self.up4(b),  s4), s4], 1))
        x  = self.dec3(torch.cat([_pad_to(self.up3(x),  s3), s3], 1))
        x  = self.dec2(torch.cat([_pad_to(self.up2(x),  s2), s2], 1))
        x  = self.dec1(torch.cat([_pad_to(self.up1(x),  s1), s1], 1))
        return self.head(x)


def _pad_to(x: torch.Tensor, ref: torch.Tensor) -> torch.Tensor:
    """Pad x so its spatial dims match ref (handles odd input sizes)."""
    dy = ref.size(2) - x.size(2)
    dx = ref.size(3) - x.size(3)
    if dy > 0 or dx > 0:
        x = F.pad(x, [dx // 2, dx - dx // 2, dy // 2, dy - dy // 2])
    return x


# ── loss & metrics ────────────────────────────────────────────────────────────

def dice_loss(logits: torch.Tensor, targets: torch.Tensor, eps: float = 1e-6) -> torch.Tensor:
    p = torch.sigmoid(logits)
    inter = (p * targets).sum(dim=(1, 2, 3))
    union = p.sum(dim=(1, 2, 3)) + targets.sum(dim=(1, 2, 3))
    return (1.0 - (2.0 * inter + eps) / (union + eps)).mean()


def seg_loss(logits: torch.Tensor, targets: torch.Tensor) -> torch.Tensor:
    return F.binary_cross_entropy_with_logits(logits, targets) + dice_loss(logits, targets)


@torch.no_grad()
def iou_score(logits: torch.Tensor, targets: torch.Tensor, threshold: float = 0.5) -> float:
    pred  = (torch.sigmoid(logits) > threshold).float()
    inter = (pred * targets).sum().item()
    union = (pred + targets).clamp(max=1).sum().item()
    return inter / union if union > 0 else 1.0


# ── training loop ─────────────────────────────────────────────────────────────

def run_epoch(
    model: nn.Module,
    loader: DataLoader,
    optimizer: torch.optim.Optimizer | None,
    device: torch.device,
    *,
    train: bool,
    progress_cb=None,
    report_every_sec: float = 2.0,
    pause_path: Path | None = None,
) -> tuple[float, float]:
    model.train(train)
    total_loss = total_iou = 0.0
    n_batches = len(loader)
    last_report = time.time()
    with torch.set_grad_enabled(train):
        for step, (imgs, masks) in enumerate(loader):
            imgs, masks = imgs.to(device), masks.to(device)
            logits = model(imgs)
            loss   = seg_loss(logits, masks)
            if train and optimizer is not None:
                optimizer.zero_grad()
                loss.backward()
                optimizer.step()
            total_loss += loss.item() * imgs.size(0)
            total_iou  += iou_score(logits, masks) * imgs.size(0)
            # pause check (file-based signalling from the UI)
            if train and pause_path and pause_path.exists():
                print('PAUSED', flush=True)
                while pause_path.exists():
                    time.sleep(0.5)
                last_report = time.time()
                print('RESUMED', flush=True)
            now = time.time()
            if train and progress_cb and (now - last_report) >= report_every_sec:
                progress_cb(step + 1, n_batches, loss.item())
                last_report = now
    n = len(loader.dataset)  # type: ignore[arg-type]
    return total_loss / n, total_iou / n


def cache_datasets(train_ds, val_ds, folder: Path, workers: int) -> bool:
    """Decodes what training will read once, if the disk has room for it (see SegDataset.cache)."""
    parts: dict[int, list] = {}
    for d in (train_ds, val_ds):
        parent, indices = (d.parent, d.indices) if isinstance(d, _SubsetDataset) else (d, None)
        entry = parts.setdefault(id(parent), [parent, set()])
        if entry[1] is not None:
            entry[1] = None if indices is None else entry[1] | set(indices)
    count = sum(len(p.pairs) if i is None else len(i) for p, i in parts.values())
    size = next(iter(parts.values()))[0].size
    need = decoded_bytes(count, size)
    if folder.exists():  # left by a run that was ended before it could delete them (a restart)
        shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(folder).free
    if free < need * 1.1 + (1 << 30):
        print(f"Not decoding the images once: it needs {need / 2**30:.1f} GB and {free / 2**30:.1f} GB is free; "
              f"reading them from the files instead", flush=True)
        return False
    print(f"Decoding {count} images once, at {size[0]}x{size[1]} px ({need / 2**30:.1f} GB in {folder}, deleted after training) …", flush=True)
    for n, (parent, indices) in enumerate(parts.values()):
        parent.cache(folder, None if indices is None else list(indices), workers, f'set{n}')
    return True


def train(args: argparse.Namespace) -> None:
    folder = Path(args.cache_dir) if args.cache_dir else Path(args.out) / '.decoded'
    try:
        _train(args, folder)
    finally:
        # The decoded images are only for this training: gone however it ends (main.cjs deletes them too,
        # for a training stopped by ending the process)
        if args.cache and folder.exists():
            gc.collect()
            shutil.rmtree(folder, ignore_errors=True)
            print("Deleted the decoded images" if not folder.exists() else f"Couldn't delete the decoded images in {folder}", flush=True)


def _train(args: argparse.Namespace, cache_folder: Path) -> None:
    seed_everything(args.seed)
    if args.device == 'cuda':
        device = torch.device('cuda')
    elif args.device == 'cpu':
        device = torch.device('cpu')
    else:
        device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    print(f"Device: {device}")

    data_root = Path(args.data)
    out_dir   = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    # ── datasets & loaders ────────────────────────────────────────────────
    print("Loading dataset …")
    train_ds, val_ds = build_datasets(data_root, input_size(args), args.val_fraction, args.seed,
                                       max_samples=args.max_samples)
    print(f"  train: {len(train_ds)}  val: {len(val_ds)}")

    n_workers = args.workers if args.workers > 0 else (4 if device.type == 'cuda' else 0)
    print(f"  loader workers: {n_workers or 'none (this process)'}")
    if args.cache:
        cache_datasets(train_ds, val_ds, cache_folder, max(n_workers, 1))
    train_loader = DataLoader(
        train_ds, batch_size=args.batch, shuffle=True,
        num_workers=n_workers, pin_memory=(device.type == 'cuda'),
        persistent_workers=(n_workers > 0),
    )
    val_loader = DataLoader(
        val_ds, batch_size=args.batch, shuffle=False,
        num_workers=n_workers, pin_memory=(device.type == 'cuda'),
        persistent_workers=(n_workers > 0),
    )

    # ── model ─────────────────────────────────────────────────────────────
    model = UNet(in_ch=3, base=args.base).to(device)
    n_params = sum(p.numel() for p in model.parameters())
    print(f"  parameters: {n_params:,}")

    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr, weight_decay=1e-5)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs, eta_min=args.lr * 0.01)

    # ── resume from checkpoint ────────────────────────────────────────────────
    best_iou   = -1.0
    best_epoch = 0
    history: list[dict] = []
    start_epoch = 1
    pause_path  = out_dir / 'pause.flag'
    pause_path.unlink(missing_ok=True)  # clear any stale pause flag on (re)start

    if args.resume:
        last_pt   = out_dir / 'last.pt'
        hist_json = out_dir / 'history.json'
        if last_pt.exists():
            try:
                ckpt = torch.load(last_pt, map_location=device, weights_only=True)
                model.load_state_dict(ckpt['state_dict'])
                start_epoch = ckpt['epoch'] + 1
                best_iou    = ckpt.get('val_iou', -1.0)
                best_epoch  = ckpt['epoch']
                print(f'Resuming from epoch {ckpt["epoch"]} / {args.epochs}  (val IoU: {best_iou:.4f})')
            except Exception as e:
                print(f'[WARN] Could not load checkpoint, starting fresh: {e}')
                start_epoch = 1
        if hist_json.exists():
            try:
                with open(hist_json) as f:
                    history = json.load(f)
                for entry in history:
                    entry['totalEpochs'] = args.epochs
                    print(f'PROGRESS:{json.dumps(entry)}', flush=True)
            except Exception as e:
                print(f'[WARN] Could not load history: {e}')

    if start_epoch > args.epochs:
        print(f'Already completed {args.epochs} epochs — nothing to do.')
        return

    # ── training loop ─────────────────────────────────────────────────────────
    print(f"\n{'Epoch':>6}  {'TrainLoss':>10}  {'TrainIoU':>9}  {'ValLoss':>8}  {'ValIoU':>7}  {'LR':>9}  {'Time':>6}")
    print('-' * 72)

    for epoch in range(start_epoch, args.epochs + 1):
        t0 = time.time()
        tr_loss, tr_iou = run_epoch(model, train_loader, optimizer, device, train=True,
                                    pause_path=pause_path,
                                    progress_cb=lambda s, t, l, e=epoch: print(
                                        f'BATCH:{json.dumps({"epoch": e, "step": s, "total": t, "loss": round(l, 4)})}',
                                        flush=True))
        va_loss, va_iou = run_epoch(model, val_loader, None, device, train=False)
        scheduler.step()

        lr  = scheduler.get_last_lr()[0]
        sec = time.time() - t0
        print(f"{epoch:>6}  {tr_loss:>10.4f}  {tr_iou:>9.4f}  {va_loss:>8.4f}  {va_iou:>7.4f}  {lr:>9.2e}  {sec:>5.1f}s", flush=True)

        prog = {
            'epoch': epoch, 'totalEpochs': args.epochs,
            'trainLoss': round(tr_loss, 4), 'trainIou': round(tr_iou, 4),
            'valLoss': round(va_loss, 4), 'valIou': round(va_iou, 4),
            'lr': lr, 'sec': round(sec, 1),
        }
        print(f'PROGRESS:{json.dumps(prog)}', flush=True)
        history.append(prog)

        if va_iou > best_iou:
            best_iou   = va_iou
            best_epoch = epoch
            torch.save({'epoch': epoch, 'state_dict': model.state_dict(),
                        'val_iou': va_iou, 'args': vars(args)},
                       out_dir / 'best.pt')

        # Save last.pt + history after every epoch so training can always be resumed
        torch.save({'epoch': epoch, 'state_dict': model.state_dict(),
                    'val_iou': va_iou, 'args': vars(args)},
                   out_dir / 'last.pt')
        with open(out_dir / 'history.json', 'w') as f:
            json.dump(history, f, indent=2)

    print(f"\nBest val IoU: {best_iou:.4f}  (epoch {best_epoch})")

    # ── ONNX export ───────────────────────────────────────────────────────
    if args.export_onnx:
        ckpt = torch.load(out_dir / 'best.pt', map_location='cpu', weights_only=True)
        model.load_state_dict(ckpt['state_dict'])
        model.eval().cpu()
        width, height = input_size(args)
        dummy = torch.zeros(1, 3, height, width)  # the model's input: [N, 3, H, W]
        onnx_path = (out_dir / 'best.onnx').resolve()
        onnx_path.unlink(missing_ok=True)
        Path(str(onnx_path) + '.data').unlink(missing_ok=True)
        torch.onnx.export(
            model, dummy, str(onnx_path),
            input_names=['image'], output_names=['logits'],
            dynamic_axes={'image': {0: 'batch'}, 'logits': {0: 'batch'}},
            opset_version=17,
            dynamo=False,
        )
        print(f"Exported ONNX → {onnx_path}")


def input_size(args: argparse.Namespace) -> tuple[int, int]:
    """The model's input (width, height): --width and --height, each else --img-size."""
    return (args.width or args.img_size, args.height or args.img_size)


# ── inference helper ──────────────────────────────────────────────────────────

@torch.no_grad()
def predict(model: UNet, img_path: Path, img_size: int | tuple[int, int], device: torch.device) -> np.ndarray:
    """Return a binary mask (H×W uint8, values 0/255) for a single image."""
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    std  = np.array([0.229, 0.224, 0.225], dtype=np.float32)
    img  = np.array(Image.open(img_path).convert('RGB'), dtype=np.float32) / 255.0
    orig_h, orig_w = img.shape[:2]
    img  = _resize(img, img_size, is_mask=False)
    img  = (img - mean) / std
    x    = torch.from_numpy(img.transpose(2, 0, 1)).unsqueeze(0).to(device)
    logits = model(x)
    prob  = torch.sigmoid(logits)[0, 0].cpu().numpy()
    # The padding off, then back to original resolution
    w, h = _size(img_size)
    scale = min(w / orig_w, h / orig_h)
    fw, fh = max(1, min(w, round(orig_w * scale))), max(1, min(h, round(orig_h * scale)))
    x0, y0 = (w - fw) // 2, (h - fh) // 2
    prob  = np.array(Image.fromarray(prob[y0:y0 + fh, x0:x0 + fw]).resize((orig_w, orig_h), Image.BILINEAR))
    return ((prob > 0.5) * 255).astype(np.uint8)


# ── CLI ───────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description='Train a UNet binary segmentation model')
    parser.add_argument('--data',         required=True,       help='Dataset root directory')
    parser.add_argument('--out',          default='runs/unet', help='Output directory for checkpoints')
    parser.add_argument('--epochs',       type=int,   default=50,   help='Number of training epochs')
    parser.add_argument('--batch',        type=int,   default=4,    help='Batch size')
    parser.add_argument('--lr',           type=float, default=1e-3, help='Initial learning rate')
    parser.add_argument('--img-size',     type=int,   default=512,  help='Input image size (square), unless --width and --height say otherwise')
    parser.add_argument('--width',        type=int,   default=0,    help='Input width (0 = --img-size); images are fitted in keeping their proportions')
    parser.add_argument('--height',       type=int,   default=0,    help='Input height (0 = --img-size)')
    parser.add_argument('--base',         type=int,   default=32,   help='UNet base channel count (32 = lighter, 64 = standard)')
    parser.add_argument('--val-fraction', type=float, default=0.1,  help='Fraction for validation when no val split exists')
    parser.add_argument('--workers',      type=int,   default=0,    help='DataLoader worker processes (0 = 4 on a GPU, none on the CPU)')
    parser.add_argument('--cache',        action='store_true',      help='Decode the images once before training (raw files, deleted afterwards)')
    parser.add_argument('--cache-dir',    default='',               help='Where the decoded images go (default: <out>/.decoded)')
    parser.add_argument('--seed',         type=int,   default=0)
    parser.add_argument('--max-samples',  type=int,   default=0,    help='Cap dataset size for a quick smoke test (0 = use all)')
    parser.add_argument('--resume',       action='store_true',      help='Resume from last.pt checkpoint in --out directory')
    parser.add_argument('--export-onnx',  action='store_true',      help='Export best model to ONNX after training')
    parser.add_argument('--device',       default='auto',           help='Training device: auto | cuda | cpu')
    parser.add_argument('--export-only',  action='store_true',      help='Skip training; just export --out/best.pt to ONNX')
    args = parser.parse_args()

    # Export-only mode: no dataset needed
    if args.export_only:
        ckpt_path = Path(args.out) / 'best.pt'
        if not ckpt_path.exists():
            sys.exit(f"Error: checkpoint not found: {ckpt_path}")
        ckpt = torch.load(ckpt_path, map_location='cpu', weights_only=True)
        model = UNet(base=ckpt.get('args', {}).get('base', 32))
        model.load_state_dict(ckpt['state_dict'])
        model.eval().cpu()
        width, height = input_size(args)
        dummy = torch.zeros(1, 3, height, width)
        onnx_path = (Path(args.out) / 'best.onnx').resolve()
        # Remove any partial export from a previous attempt
        onnx_path.unlink(missing_ok=True)
        Path(str(onnx_path) + '.data').unlink(missing_ok=True)
        torch.onnx.export(
            model, dummy, str(onnx_path),
            input_names=['image'], output_names=['logits'],
            dynamic_axes={'image': {0: 'batch'}, 'logits': {0: 'batch'}},
            opset_version=17,
            dynamo=False,
        )
        print(f"EXPORT_OK:{onnx_path}")
        return

    # Validate dataset
    data_root = Path(args.data)
    if not data_root.is_dir():
        sys.exit(f"Error: dataset directory not found: {data_root}")
    has_flat  = (data_root / 'images').is_dir() and (data_root / 'masks').is_dir()
    has_split = (data_root / 'train').is_dir()  and (data_root / 'val').is_dir()
    if not has_flat and not has_split:
        sys.exit(
            f"Error: expected either images/masks/ subdirs or train/val/ subdirs in {data_root}"
        )

    train(args)


if __name__ == '__main__':
    main()
