"""The executor stays free of any movement model (docs/movement-architecture.md): behavior.py imports no model or
controller module, reads the map's dynamics only to choose its controller, and names nothing after platforms, jumps,
ground or landings in its code (its comments may say what a controller's evidence was)."""
import ast
import re
import unittest
from pathlib import Path

SOURCE = (Path(__file__).parent / 'behavior.py').read_text(encoding='utf8')
WORDS = re.compile(r'jump|takeoff|landing|ground|slope|edge|crest|downhill|platform|ledge', re.I)


class ExecutorTests(unittest.TestCase):
    def test_it_imports_no_movement_model(self):
        tree = ast.parse(SOURCE)
        imported = {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
        imported |= {n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)}
        self.assertFalse(imported & {'platformer', 'platformer_control', 'calibration'}, imported)

    def test_it_reads_the_dynamics_only_to_choose_a_controller(self):
        tree = ast.parse(SOURCE)
        maprun = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'MapRun')
        allowed = {id(n) for f in maprun.body if isinstance(f, ast.FunctionDef) and f.name in ('__init__', 'control') for n in ast.walk(f)}
        uses = [n.lineno for n in ast.walk(tree) if isinstance(n, ast.Attribute) and n.attr == 'dynamics' and id(n) not in allowed]
        self.assertEqual(uses, [], 'MapRun.dynamics read outside choosing its controller')

    def test_its_code_names_no_platformer_terms(self):
        tree = ast.parse(SOURCE)
        names = set()
        for n in ast.walk(tree):
            if isinstance(n, ast.Name):
                names.add(n.id)
            elif isinstance(n, ast.Attribute):
                names.add(n.attr)
            elif isinstance(n, (ast.FunctionDef, ast.ClassDef)):
                names.add(n.name)
            elif isinstance(n, ast.arg):
                names.add(n.arg)
            elif isinstance(n, ast.Constant) and isinstance(n.value, str) and not n.value.startswith(('\n', ' ')) and len(n.value) < 40:
                names.add(n.value)  # keys and kinds, not messages or docstrings
        self.assertEqual(sorted(x for x in names if WORDS.search(x)), [])


if __name__ == '__main__':
    unittest.main()
