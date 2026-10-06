"""Checks a YOLO dataset (data.yaml, images/<split>/…, labels/<split>/….txt) for the Train tab: images and boxes per
split and class, and the problems that would spoil training; draws a grid of sample images with their boxes.
Prints CHECK_RESULT:{json} as check_dataset.py does.
"""
import argparse
import json
import random
import re
from collections import Counter
from pathlib import Path

from PIL import Image, ImageDraw

COLORS = ['#ff4d4d', '#3ddc84', '#4d9dff', '#ffb84d', '#c77dff', '#4dd8e6', '#ff7ab6', '#d4e157']
IMAGE = re.compile(r'\.(png|jpe?g|bmp)$', re.I)


def class_names(yaml):
    names = {}
    for line in yaml.read_text(encoding='utf-8').splitlines():
        m = re.match(r'^\s+(\d+):\s*(.+?)\s*$', line)
        if m:
            names[int(m[1])] = m[2]
    return [names.get(i, f'class {i}') for i in range(max(names) + 1)] if names else []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True, help='The dataset folder (with data.yaml) or data.yaml itself')
    ap.add_argument('--out', default='yolo_dataset_check.png', help='Where the sample grid is drawn')
    ap.add_argument('--n', type=int, default=8)
    args = ap.parse_args()

    root = Path(args.data)
    yaml = root if root.is_file() else root / 'data.yaml'
    root = yaml.parent
    warnings, fatal = [], []
    if not yaml.exists():
        result = {'kind': 'yolo', 'pass': False, 'pairs': 0, 'sampledCount': 0, 'coverageMean': 0, 'classes': [],
                  'warnings': [f'No data.yaml in {root}. Choose the folder a Dataset Output with Format Dataset writes into.']}
        print(f'CHECK_RESULT:{json.dumps(result)}', flush=True)
        return
    names = class_names(yaml)
    if not names:
        fatal.append('data.yaml names no classes')

    images, boxes, problems = Counter(), {}, []
    labelled = []
    for image in sorted((root / 'images').rglob('*')) if (root / 'images').exists() else []:
        if not IMAGE.search(image.name):
            continue
        split = image.relative_to(root / 'images').parts[0]
        images[split] += 1
        label = (root / 'labels' / image.relative_to(root / 'images')).with_suffix('.txt')
        if not label.exists():
            problems.append(f'{image.relative_to(root).as_posix()} has no label file')
            continue
        lines = []
        for line in label.read_text(encoding='utf-8').splitlines():
            parts = line.split()
            if not parts:
                continue
            try:
                c, x, y, w, h = int(parts[0]), *map(float, parts[1:5])
            except ValueError:
                problems.append(f'{label.relative_to(root).as_posix()}: "{line}" isn\'t class x y w h'); continue
            if len(parts) != 5 or not all(0 <= v <= 1 for v in (x, y, w, h)) or c < 0 or c >= max(1, len(names)):
                problems.append(f'{label.relative_to(root).as_posix()}: "{line}" is out of range'); continue
            boxes.setdefault(split, Counter())[c] += 1
            lines.append((c, x, y, w, h))
        labelled.append((image, lines))

    total = sum(images.values())
    if total == 0:
        fatal.append('No images under images/')
    if images and not images.get('train'):
        fatal.append('No training images (images/train)')
    if images and not images.get('val'):
        warnings.append('No validation images (images/val): the scores can\'t be measured')
    if problems:
        warnings.append(f'{len(problems)} label problem(s), e.g. {problems[0]}')
    every = Counter()
    for counts in boxes.values():
        every.update(counts)
    for c, name in enumerate(names):
        if every[c] == 0:
            warnings.append(f'No "{name}" boxes: the model can\'t learn that class')
        elif every[c] < 100:
            warnings.append(f'Only {every[c]} "{name}" boxes: expect that class to be weak (a few hundred or more helps)')

    # A grid of samples with their boxes, to see they sit on the right things
    random.seed(42)
    sample = random.sample(labelled, min(args.n, len(labelled)))
    if sample:
        tw, th, cols = 400, 300, 4
        rows = (len(sample) + cols - 1) // cols
        grid = Image.new('RGB', (tw * cols, th * rows), (20, 20, 20))
        for i, (image, lines) in enumerate(sample):
            with Image.open(image) as im:
                im = im.convert('RGB')
                W, H = im.size
                draw = ImageDraw.Draw(im)
                for c, x, y, w, h in lines:
                    draw.rectangle([(x - w / 2) * W, (y - h / 2) * H, (x + w / 2) * W, (y + h / 2) * H], outline=COLORS[c % len(COLORS)], width=3)
                im.thumbnail((tw, th))
                grid.paste(im, ((i % cols) * tw + (tw - im.width) // 2, (i // cols) * th + (th - im.height) // 2))
        grid.save(args.out)

    result = {
        'kind': 'yolo', 'pass': not fatal, 'pairs': total, 'sampledCount': 0, 'coverageMean': 0,
        'splits': {s: {'images': n, 'boxes': sum(boxes.get(s, Counter()).values())} for s, n in sorted(images.items())},
        'classes': [{'name': name, 'boxes': every[c], 'color': COLORS[c % len(COLORS)]} for c, name in enumerate(names)],
        'warnings': fatal + warnings,
    }
    print(f'CHECK_RESULT:{json.dumps(result)}', flush=True)


if __name__ == '__main__':
    main()
