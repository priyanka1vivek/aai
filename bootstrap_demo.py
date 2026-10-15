"""Build a new, locally identified detector from the committed NSL-KDD data.

This does not recover or authenticate the previously evaluated PSO forest.
"""
import hashlib
import json
from pathlib import Path

import joblib

from src.config import ROOT, SearchConfig
from src.evaluate import train_final
from src.preprocess import FEATURE_NAMES, prepare_data
from src.storage import atomic_json

DATA_SHA256 = {
    'KDDTrain+.txt': '1b86d2f957b33082081bba410fe129b475efebcc13c9014c3f447c8271aadf95',
    'KDDTest+.txt': 'fa46b0935342616aa83b7c2578db355b6a7aaabbc492248172c7a1e8b7ab8f84',
}


def build(root=ROOT):
    root = Path(root)
    for name, expected in DATA_SHA256.items():
        path = root / 'data' / name
        if not path.is_file():
            raise FileNotFoundError(f'{path} is missing. Restore the committed NSL-KDD data files.')
        # Git may check text files out with CRLF on Windows. Hash the canonical LF bytes.
        digest = hashlib.sha256(path.read_bytes().replace(b'\r\n', b'\n')).hexdigest()
        if digest != expected:
            raise ValueError(f'{name} differs from the committed dataset (SHA-256 {digest}).')
    active = root / 'results' / 'active_detector.json'
    if active.is_file():
        record = json.loads(active.read_text())
        identifier = record['model_id']
        if record.get('recipe_version') == 1 and (root / 'models' / f'{identifier}.joblib').is_file():
            print(f'Existing local demonstration detector: {identifier}')
            return identifier
    prepare_data(root)
    bundle = joblib.load(root / 'results' / 'prepared_data.joblib')
    # Reuse the *feature names* of the published configuration, not its reported scores.
    published = json.loads((root / 'models' / 'b8c6bf4db26f44b2b557f99114f03999.json').read_text())
    selected = published['selected_features']
    cfg = SearchConfig.parse(published['config'])
    result = {'best_mask': [int(name in selected) for name in FEATURE_NAMES],
              'selected_features': selected, 'feature_count': len(selected),
              'algorithm': 'retrained_pso_mask', 'best_fitness': None}
    result = train_final(bundle, result, cfg, root)
    identifier = result['model_id']
    path = root / 'models' / f'{identifier}.json'
    meta = json.loads(path.read_text())
    meta['provenance'] = 'locally_retrained_demo'
    meta['evaluation_note'] = ('New Random Forest refit from the committed NSL-KDD data using the published '
                               '11-feature mask and recorded configuration. Its locally measured test metrics '
                               'are separate from the historical calibrated PSO model and do not authenticate its binary.')
    meta['dataset_sha256'] = DATA_SHA256
    atomic_json(path, meta)
    atomic_json(active, {'model_id': identifier, 'provenance': 'locally_retrained_demo', 'recipe_version': 1})
    print(f'New demonstration model: {identifier}')
    for key in ('accuracy', 'recall', 'false_alarm_rate'):
        print(f'{key}: {meta["test_metrics"][key]:.4%}')
    return identifier


if __name__ == '__main__':
    build()
