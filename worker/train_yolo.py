"""Trains a YOLO object detector (Ultralytics) on a YOLO dataset, such as a collection graph's Format Dataset output,
reporting as train_unet.py does so the Train tab can show it: BATCH: lines during an epoch, PROGRESS: lines after
each, with precision, recall and mAP instead of IoU. Pauses while <out>/pause.flag exists, resumes from
<out>/weights/last.pt, and writes <out>/history.json. The weights it starts from are downloaded once into --weights-dir.
Afterwards it exports the best weights to <out>/best.onnx (EXPORT_OK:<path>), which FireFly's runtime runs as a
detector; --export-only does just that for a finished training.
"""
import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

MODELS = ('yolo11n', 'yolo11s', 'yolo11m', 'yolo11l', 'yolo11x')


def data_yaml(path):
    """The dataset's data.yaml: given itself or the folder holding it."""
    p = Path(path)
    if p.is_dir():
        p = p / 'data.yaml'
    if not p.exists():
        raise SystemExit(f'No data.yaml in {path}: choose a YOLO dataset folder (a Dataset Output with Format Dataset writes one)')
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', help='YOLO dataset folder (with data.yaml) or the data.yaml itself')
    ap.add_argument('--out', required=True, help='Where this training goes: weights/, results and history.json')
    ap.add_argument('--model', default='yolo11n', choices=MODELS, help='Which pretrained YOLO to start from')
    ap.add_argument('--weights-dir', required=True, help='Where the pretrained weights are kept (downloaded once)')
    ap.add_argument('--epochs', type=int, default=100)
    ap.add_argument('--batch', type=int, default=16)
    ap.add_argument('--imgsz', type=int, default=800, help='Training image size (the longer side), a multiple of 32')
    ap.add_argument('--device', default='auto', help='cuda, cpu or auto')
    ap.add_argument('--workers', type=int, default=0, help='0 = 4 with a GPU, none on the CPU')
    ap.add_argument('--resume', action='store_true')
    ap.add_argument('--export-only', action='store_true', help='Export <out>/weights/best.pt to <out>/best.onnx and stop')
    args = ap.parse_args()

    out = Path(args.out).resolve()
    # Ultralytics keeps a settings file whose folders (for the weights it downloads, such as the small model it checks
    # mixed precision with) default to where it's first imported, and fixes them on import. So it gets FireFly's own
    # settings and is imported from the weights folder: nothing of it lands where FireFly was started, or in the
    # user's own Ultralytics settings.
    weights_dir = Path(args.weights_dir).resolve()
    (weights_dir / 'config').mkdir(parents=True, exist_ok=True)  # it must exist, or Ultralytics falls back to its own
    os.environ['YOLO_CONFIG_DIR'] = str(weights_dir / 'config')
    os.environ['YOLO_AUTOINSTALL'] = 'False'  # never pip-install what it thinks it's missing: fail and say so instead
    os.chdir(weights_dir)

    import torch
    import ultralytics.utils
    from ultralytics import YOLO
    from ultralytics.utils import SETTINGS

    # FireFly's own settings, so this persists; WEIGHTS_DIR was worked out on import, before the first run set it
    if Path(SETTINGS['weights_dir']) != weights_dir:
        SETTINGS.update(weights_dir=str(weights_dir), runs_dir=str(weights_dir / 'runs'), datasets_dir=str(weights_dir / 'datasets'))
    ultralytics.utils.WEIGHTS_DIR = weights_dir

    if args.export_only:
        return export(YOLO, out, args.imgsz)
    if not args.data:
        raise SystemExit('Choose the dataset (--data)')
    data = data_yaml(args.data).resolve()
    out.mkdir(parents=True, exist_ok=True)
    pause = out / 'pause.flag'
    pause.unlink(missing_ok=True)  # a stale pause from an earlier run
    cuda = torch.cuda.is_available() and args.device != 'cpu'
    device = 0 if cuda else 'cpu'
    workers = args.workers or (4 if cuda else 0)
    imgsz = max(32, round(args.imgsz / 32) * 32)
    last = out / 'weights' / 'last.pt'
    history_path = out / 'history.json'
    history = []

    if args.resume and last.exists():
        model = YOLO(str(last))
        if history_path.exists():
            history = json.loads(history_path.read_text())
            for entry in history:  # the epochs done so far, for the tab's chart
                print(f'PROGRESS:{json.dumps(entry)}', flush=True)
        print(f'Resuming from {last}', flush=True)
    else:
        weights = weights_dir / f'{args.model}.pt'
        if not weights.exists():
            print(f'Downloading {args.model}.pt (the pretrained weights, once) into {weights.parent}…', flush=True)
        model = YOLO(str(weights))  # Ultralytics downloads a known model's weights to this path if they're missing

    state = {'step': 0, 'started': time.time()}

    def total(losses):
        """A trainer's running losses (box, class, distribution) added up: a tensor or, in newer versions, a dict."""
        if losses is None:
            return 0.0
        if isinstance(losses, dict):
            return sum(float(v) for v in losses.values())
        return float(losses.sum()) if hasattr(losses, 'sum') else float(losses)

    def on_epoch_start(trainer):
        state['step'], state['started'] = 0, time.time()

    def on_batch_end(trainer):
        state['step'] += 1
        loss = total(getattr(trainer, 'tloss', None))
        # On a line of its own: the progress bar redraws its line without ending it
        print(f'\nBATCH:{json.dumps({"epoch": trainer.epoch + 1, "step": state["step"], "total": len(trainer.train_loader), "loss": round(loss, 4)})}', flush=True)
        while pause.exists():  # the tab's Pause: wait here until it's lifted
            time.sleep(0.5)

    def on_epoch_end(trainer):
        if trainer.epoch + 1 > trainer.epochs:
            return  # the final check of the best weights, after the last epoch: not an epoch of its own
        m = trainer.metrics or {}
        entry = {
            'kind': 'yolo', 'epoch': trainer.epoch + 1, 'totalEpochs': trainer.epochs,
            'trainLoss': round(total(getattr(trainer, 'tloss', None)), 4),
            'valLoss': round(sum(float(m.get(k, 0)) for k in ('val/box_loss', 'val/cls_loss', 'val/dfl_loss')), 4),
            'precision': round(float(m.get('metrics/precision(B)', 0)), 4),
            'recall': round(float(m.get('metrics/recall(B)', 0)), 4),
            'map50': round(float(m.get('metrics/mAP50(B)', 0)), 4),
            'map': round(float(m.get('metrics/mAP50-95(B)', 0)), 4),
            'lr': float(next(iter(trainer.lr.values()), 0)) if getattr(trainer, 'lr', None) else 0.0,
            'sec': round(time.time() - state['started'], 1),
        }
        print(f'PROGRESS:{json.dumps(entry)}', flush=True)
        history.append(entry)
        history_path.write_text(json.dumps(history, indent=2))

    model.add_callback('on_train_epoch_start', on_epoch_start)
    model.add_callback('on_train_batch_end', on_batch_end)
    model.add_callback('on_fit_epoch_end', on_epoch_end)

    print(f'Training {args.model} on {data} at {imgsz} px, {"GPU" if cuda else "CPU"}, '
          f'{args.epochs} epochs, batch {args.batch}, {workers} workers', flush=True)
    if args.resume and last.exists():
        model.train(resume=True, device=device, workers=workers)
    else:
        # project/name put everything straight into --out (weights/best.pt, last.pt, results.csv, plots)
        model.train(data=str(data), epochs=args.epochs, batch=args.batch, imgsz=imgsz, device=device,
                    workers=workers, project=str(out.parent), name=out.name, exist_ok=True, plots=True, verbose=False)
    best = out / 'weights' / 'best.pt'
    if best.exists():
        print(f'BEST:{best}', flush=True)
        export(YOLO, out, imgsz)
    print('Done.', flush=True)


def export(YOLO, out, imgsz):
    """The best weights as <out>/best.onnx: a fixed-size image input ([1, 3, imgsz, imgsz], RGB 0..1) and the raw
    [1, 4 + classes, anchors] output, decoded and NMS'd by the runtime; class names go in its metadata."""
    best = out / 'weights' / 'best.pt'
    if not best.exists():
        raise SystemExit(f'No trained weights at {best}')
    trained = out / 'args.yaml'  # the size it was trained at, unless told otherwise
    if trained.exists():
        for line in trained.read_text(encoding='utf-8').splitlines():
            if line.startswith('imgsz:') and line.split(':', 1)[1].strip().isdigit():
                imgsz = int(line.split(':', 1)[1])
    print(f'Exporting {best} to ONNX at {imgsz} px…', flush=True)
    made = Path(YOLO(str(best)).export(format='onnx', imgsz=imgsz, opset=17, simplify=False, dynamic=False, half=False, device='cpu'))
    target = out / 'best.onnx'
    if made.resolve() != target:
        shutil.move(str(made), target)
    print(f'EXPORT_OK:{target}', flush=True)


if __name__ == '__main__':
    sys.exit(main())
