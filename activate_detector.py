"""Verify cached scores and save the calibrated operating point; no training."""
import json
import time
from pathlib import Path
import joblib
import numpy as np
from src.config import ROOT
from src.evaluate import classify, security_breakdown
from src.fitness import metrics
from src.storage import atomic_json


def activate(root=ROOT):
    policy=json.loads((root/'detector_policy.json').read_text())
    source=policy['source_model_id'];identifier=policy['model_id'];threshold=policy['attack_threshold']
    folder=root/'models'
    required=[folder/f'{source}.predictions.npz',folder/f'{source}.joblib',
              root/'results'/'prepared_data.joblib']
    missing=[str(path.relative_to(root)) for path in required if not path.is_file()]
    if missing:
        raise SystemExit('Original artifacts unavailable: '+', '.join(missing)+
                         '. Restore the matching files from your laptop, or run '
                         'python bootstrap_demo.py for a separately identified retrained detector.')
    with np.load(folder/f'{source}.predictions.npz') as cached:
        y=cached['y'].copy();scores=cached['attack_scores'].copy()
    predictions=(scores>=threshold).astype(np.int8)
    measured=metrics(y,predictions)
    for key,expected in policy['expected_test_metrics'].items():
        if not np.allclose(measured[key],expected,atol=1e-12,rtol=0):
            raise ValueError(f'{key} differs from the verified dataset/model. No model was saved.')
    saved=joblib.load(folder/f'{source}.joblib')
    saved.update(model_id=identifier,algorithm='pso_calibrated',attack_threshold=threshold)
    bundle=joblib.load(root/'results'/'prepared_data.joblib')
    if not np.array_equal(y,bundle['y_test']):raise ValueError('Prepared test rows differ from prediction cache.')
    records=bundle['raw_test'].iloc[:128].to_dict('records')
    response=classify(records,saved)
    if not np.allclose([r['attack_score'] for r in response['predictions']],scores[:128],atol=1e-12):
        raise ValueError('Cached scores disagree with saved classifier. No model was saved.')
    meta=json.loads((folder/f'{source}.json').read_text())
    meta.update(model_id=identifier,algorithm='pso_calibrated',source_model_id=source,
                source_experiment_id=policy['source_experiment_id'],attack_threshold=threshold,
                test_metrics=measured,security_breakdown=security_breakdown(bundle,predictions),
                validation_calibration=policy['validation_calibration'],
                evaluation_note=policy['evaluation_note'])
    meta['config']={**meta['config'],'attack_threshold':threshold}
    meta['test_security_constraints_met']=(
        measured['recall']>=meta['config'].get('min_attack_recall',0)
        if meta['config'].get('min_attack_recall') is not None else True) and (
        measured['false_alarm_rate']<=meta['config'].get('max_false_alarm_rate',1)
        if meta['config'].get('max_false_alarm_rate') is not None else True)
    # Re-measure prediction timing because the policy's threshold changed.
    batch=bundle['raw_test'].iloc[:1000].to_dict('records');times=[]
    for _ in range(3):
        started=time.perf_counter();classify(batch,saved);times.append(time.perf_counter()-started)
    meta['prediction_timing']={**meta['prediction_timing'],
        'pipeline_ms_per_connection':float(np.median(times)*1000/len(batch)),
        'note':'Amortized batch latency; includes input validation. Classifier timing inherited from unchanged RF.'}
    joblib.dump(saved,folder/f'{identifier}.joblib',compress=3)
    atomic_json(folder/f'{identifier}.json',meta)
    np.savez_compressed(folder/f'{identifier}.predictions.npz',y=y,attack_scores=scores,predictions=predictions)
    atomic_json(root/'results'/f'calibrated_detector_{identifier}.json',meta)
    print('VERIFIED CALIBRATED DETECTOR — no training')
    for key in ['accuracy','recall','f1','false_alarm_rate']:
        print(f'{key}: {measured[key]:.2%}')
    print('Features:',meta['feature_count'])
    print('Threshold:',threshold)
    print('Model ID:',identifier)
    print('Restart app.py. The new model uses 0.01 by default; no threshold override is required.')
    print(policy['evaluation_note'])
    return meta


if __name__=='__main__':
    activate()
