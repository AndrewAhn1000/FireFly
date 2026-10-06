"""Dataset sanity checker — run before training to verify image/mask pairs.

Usage
-----
  python worker/check_dataset.py --data path/to/dataset [--n 8] [--out check.png]

Outputs
-------
  - Console stats: pair count, mask coverage distribution, size mismatches
  - check.png: grid showing N random pairs as  image | mask overlay
"""

import argparse
import json
import random
import sys
from pathlib import Path

try:
    import numpy as np
    _NP_OK = True
except ImportError:
    _NP_OK = False

try:
    from PIL import Image, ImageDraw
    _PIL_OK = True
except ImportError:
    _PIL_OK = False


def mask_coverage(mask_arr: np.ndarray) -> float:
    """Fraction of foreground pixels (0–1)."""
    return float((mask_arr > 0).mean())


def make_cells(img: Image.Image, mask: Image.Image,
               cell_w: int, cell_h: int) -> tuple:
    """Return (img_cell, mask_cell, zoom_cell) for one pair."""
    img_rgb  = img.convert('RGB')
    mask_l   = mask.convert('L')
    mask_arr = np.array(mask_l)
    fg       = mask_arr > 0

    img_cell  = img_rgb.resize((cell_w, cell_h), Image.BILINEAR)

    # pure mask: foreground = bright green, background = dark
    vis = np.zeros((mask_arr.shape[0], mask_arr.shape[1], 3), dtype=np.uint8)
    vis[fg]  = (80, 230, 80)
    vis[~fg] = (20, 20, 20)
    mask_cell = Image.fromarray(vis).resize((cell_w, cell_h), Image.NEAREST)

    # zoom cell: crop to bounding box of foreground (or centre if empty)
    if fg.any():
        rows = np.where(fg.any(axis=1))[0]
        cols = np.where(fg.any(axis=0))[0]
        r0, r1 = int(rows[0]),  int(rows[-1])
        c0, c1 = int(cols[0]),  int(cols[-1])
        pad = max(12, int(max(r1 - r0, c1 - c0) * 0.5))
        r0 = max(0, r0 - pad);  r1 = min(mask_arr.shape[0] - 1, r1 + pad)
        c0 = max(0, c0 - pad);  c1 = min(mask_arr.shape[1] - 1, c1 + pad)
        crop_img  = img_rgb.crop((c0, r0, c1 + 1, r1 + 1))
        crop_vis  = Image.fromarray(vis).crop((c0, r0, c1 + 1, r1 + 1))
        # blend: image darkened + bright mask on top
        ci = np.array(crop_img.resize((cell_w, cell_h), Image.BILINEAR)).astype(np.float32)
        cm = np.array(crop_vis.resize((cell_w, cell_h), Image.NEAREST)).astype(np.float32)
        blended = np.clip(ci * 0.45 + cm * 0.55, 0, 255).astype(np.uint8)
        zoom_cell = Image.fromarray(blended)
    else:
        zoom_cell = Image.new('RGB', (cell_w, cell_h), (40, 20, 20))  # empty = dark red hint

    return img_cell, mask_cell, zoom_cell


# ── main ──────────────────────────────────────────────────────────────────────

def _emit_fail(msg: str) -> None:
    result = {'pairs': 0, 'sampledCount': 0, 'coverageMean': 0.0, 'coverageMin': 0.0,
              'coverageMax': 0.0, 'emptyMasks': 0, 'emptyPct': 0.0, 'sizeMismatches': 0,
              'warnings': [msg], 'pass': False}
    print(f'CHECK_RESULT:{json.dumps(result)}', flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True, help='Dataset root folder')
    ap.add_argument('--n',    type=int, default=8, help='Number of pairs to visualise (default 8)')
    ap.add_argument('--out',  default='dataset_check.png', help='Output grid image path')
    ap.add_argument('--seed', type=int, default=42)
    args = ap.parse_args()

    data_root = Path(args.data)
    if not data_root.is_dir():
        _emit_fail(f'Path not found: {data_root}')
        return

    print(f"Scanning {data_root} …")

    # locate image/mask dirs without hard-exit
    img_dirs, mask_dirs = [], []
    if (data_root / 'images').is_dir() and (data_root / 'masks').is_dir():
        img_dirs.append(data_root / 'images')
        mask_dirs.append(data_root / 'masks')
    for split in ('train', 'val'):
        si, sm = data_root / split / 'images', data_root / split / 'masks'
        if si.is_dir() and sm.is_dir():
            img_dirs.append(si); mask_dirs.append(sm)
    if not img_dirs:
        _emit_fail(f'No images/ or train/val/ folders found under {data_root}')
        return

    pairs = []
    for img_dir, mask_dir in zip(img_dirs, mask_dirs):
        mask_stems = {p.stem: p for p in mask_dir.iterdir()
                      if p.suffix.lower() in ('.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff')}
        for img_path in sorted(img_dir.iterdir()):
            if img_path.suffix.lower() not in ('.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff'):
                continue
            if img_path.stem in mask_stems:
                pairs.append((img_path, mask_stems[img_path.stem]))

    if not pairs:
        _emit_fail('No matched image/mask pairs found — ensure filenames match between images/ and masks/')
        return

    print(f"  Found {len(pairs)} pairs")

    # ── stats ─────────────────────────────────────────────────────────────────
    random.seed(args.seed)
    sample = random.sample(pairs, min(200, len(pairs)))

    coverages   = []
    empty_masks = 0
    full_masks  = 0
    size_mismatches = 0

    if not _NP_OK or not _PIL_OK:
        missing = [p for p, ok in [('numpy', _NP_OK), ('Pillow', _PIL_OK)] if not ok]
        print(f"  [WARN] {', '.join(missing)} not installed — skipping pixel-level stats and grid")
    else:
        for img_p, mask_p in sample:
            try:
                img_arr  = np.array(Image.open(img_p))
                mask_arr = np.array(Image.open(mask_p).convert('L'))
            except Exception as e:
                print(f"  [WARN] Could not read {img_p.name}: {e}")
                continue

            if img_arr.shape[:2] != mask_arr.shape[:2]:
                size_mismatches += 1

            cov = mask_coverage(mask_arr)
            coverages.append(cov)
            if cov == 0.0:
                empty_masks += 1
            if cov > 0.98:
                full_masks += 1

    if coverages:
        print(f"\n  Mask coverage (foreground %) over {len(coverages)} random samples:")
        print(f"    min  {min(coverages)*100:.1f}%")
        print(f"    mean {sum(coverages)/len(coverages)*100:.1f}%")
        print(f"    max  {max(coverages)*100:.1f}%")
        print(f"    empty masks (0% fg) : {empty_masks}  ({empty_masks/len(coverages)*100:.1f}%)")
        print(f"    nearly-full (>98%)  : {full_masks}  ({full_masks/len(coverages)*100:.1f}%)")
        if size_mismatches:
            print(f"\n  [WARN] {size_mismatches} pairs have mismatched image/mask sizes!")
        else:
            print(f"    size match: OK")

    if empty_masks == len(coverages):
        print("\n  [ERROR] ALL sampled masks are empty — check your mask format.")
        print("          Masks should be grayscale PNGs where foreground pixels are non-zero.")
    elif empty_masks > len(coverages) * 0.5:
        print(f"\n  [WARN] More than half the masks are empty — data quality may be low.")

    # ── visual grid ───────────────────────────────────────────────────────────
    if _NP_OK and _PIL_OK:
        n = min(args.n, len(pairs))
        vis_pairs = random.sample(pairs, n)

        cell_w, cell_h = 192, 192
        pairs_per_row  = min(n, 3)           # 3 pairs across → 9 cells wide
        n_rows = (n + pairs_per_row - 1) // pairs_per_row
        gap    = 3
        # each pair = 3 cells wide
        grid_w = pairs_per_row * cell_w * 3 + (pairs_per_row - 1) * gap * 2
        grid_h = n_rows * cell_h + (n_rows - 1) * gap
        grid = Image.new('RGB', (grid_w, grid_h), (18, 18, 18))

        draw = ImageDraw.Draw(grid)

        for idx, (img_p, mask_p) in enumerate(vis_pairs):
            pr  = idx // pairs_per_row   # pair row
            pc  = idx % pairs_per_row    # pair column
            px  = pc * (cell_w * 3 + gap * 2)
            py  = pr * (cell_h + gap)
            try:
                img  = Image.open(img_p).convert('RGB')
                mask = Image.open(mask_p).convert('L')
                cov  = mask_coverage(np.array(mask))
                ic, mc, zc = make_cells(img, mask, cell_w, cell_h)
                grid.paste(ic, (px,              py))
                grid.paste(mc, (px + cell_w + gap,          py))
                grid.paste(zc, (px + (cell_w + gap) * 2,   py))
                try:
                    draw.text((px + cell_w * 2 + gap * 2 + 3, py + cell_h - 14),
                              f"{cov*100:.2f}%", fill=(255, 220, 50))
                except Exception:
                    pass
            except Exception as e:
                print(f"  [WARN] Could not render {img_p.name}: {e}")

        out_path = Path(args.out)
        grid.save(out_path)
        print(f"\n  Grid saved → {out_path.resolve()}")
    # (grid skipped if numpy/Pillow unavailable — already warned above)

    # ── structured result (parsed by Electron UI) ─────────────────────────────
    result: dict = {
        'pairs':          len(pairs),
        'sampledCount':   len(coverages),
        'coverageMean':   round(sum(coverages) / len(coverages), 4) if coverages else 0.0,
        'coverageMin':    round(min(coverages), 4) if coverages else 0.0,
        'coverageMax':    round(max(coverages), 4) if coverages else 0.0,
        'emptyMasks':     empty_masks,
        'emptyPct':       round(empty_masks / len(coverages) * 100, 1) if coverages else 0.0,
        'sizeMismatches': size_mismatches,
        'warnings':       [],
        'pass':           True,
    }

    if len(pairs) == 0:
        result['warnings'].append('No image/mask pairs found — check folder layout')
        result['pass'] = False
    elif coverages:
        if empty_masks == len(coverages):
            result['warnings'].append('All sampled masks are empty — masks should have non-zero pixels for foreground')
            result['pass'] = False
        elif empty_masks > len(coverages) * 0.5:
            result['warnings'].append(f'{empty_masks} of {len(coverages)} sampled masks are empty (>{int(empty_masks/len(coverages)*100)}%)')
            result['pass'] = False
        if size_mismatches:
            result['warnings'].append(f'{size_mismatches} pairs have mismatched image/mask sizes')

    print(f'CHECK_RESULT:{json.dumps(result)}', flush=True)

    # ── quick overfit hint ─────────────────────────────────────────────────────
    print(f"""
Quick overfit test (verifies the model can actually learn your data):
  python worker/train_unet.py --data {args.data} --max-samples 64 --epochs 10 --img-size 256 --base 16

  Expected: train IoU should climb from ~0% toward 50–80% over 10 epochs.
  If it stays near 0%, something is wrong with the mask format or data.
""")


if __name__ == '__main__':
    main()
