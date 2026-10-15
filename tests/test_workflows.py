"""Real Flask routes with the reproducibly trained local detector."""
import csv
import io
import json
import tempfile
import time
import unittest
from pathlib import Path

from app import app, service
from bootstrap_demo import build


class Workflows(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model_id = build()
        cls.client = app.test_client()

    def request_ok(self, method, path, **kwargs):
        response = self.client.open(path, method=method, **kwargs)
        self.assertLess(response.status_code, 300, response.get_data(as_text=True)[:500])
        return response.get_json()

    def test_missing_historical_artifact_and_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            (temp / 'models').mkdir()
            (temp / 'results').mkdir()
            (temp / 'detector_policy.json').write_text((service.root / 'detector_policy.json').read_text())
            original = service.root
            try:
                service.root = temp
                policy = self.request_ok('GET', '/api/default-detector')
                self.assertFalse(policy['available'])
                self.assertEqual(policy['historical_model_id'], policy['model_id'])
                self.assertEqual(self.client.post('/api/classify', json={'model_id':policy['model_id'], 'connection':{}}).status_code, 404)
            finally:
                service.root = original
        policy = self.request_ok('GET', '/api/default-detector')
        self.assertTrue(policy['available'])
        self.assertFalse(policy['historical_available'])
        self.assertEqual(policy['provenance'], 'locally_retrained_demo')
        self.assertNotEqual(policy['model_id'], policy['historical_model_id'])
        self.assertEqual(policy['model_id'], self.model_id)
        models = self.request_ok('GET', '/api/models')['models']
        self.assertTrue(next(m for m in models if m['model_id']==self.model_id)['available'])
        self.assertFalse(next(m for m in models if m['model_id']==policy['historical_model_id'])['available'])

    def test_detection_csv_what_if_replay_challenge_and_evidence(self):
        self.assertIn(b'/static/app.js', self.client.get('/').data)
        with self.client.get('/static/app.js') as script:
            self.assertEqual(script.status_code, 200)
        self.assertEqual(len(self.request_ok('GET','/api/dataset')['feature_names']), 41)
        sample = self.request_ok('GET', '/api/sample?label=normal&index=0')
        connection = sample['connection']
        predicted = self.request_ok('POST', '/api/classify', json={'model_id':self.model_id,'connection':connection})
        self.assertEqual(len(predicted['predictions']), 1)
        self.assertEqual(predicted['threshold'], 0.01)
        self.assertEqual(self.client.post('/api/classify',json={'model_id':self.model_id,'connection':{}}).status_code,400)
        stream = io.StringIO()
        writer = csv.DictWriter(stream, fieldnames=list(connection))
        writer.writeheader();writer.writerow(connection)
        csv_response = self.client.post('/api/classify-csv', data={'model_id':self.model_id,'file':(io.BytesIO(stream.getvalue().encode()),'connections.csv')})
        self.assertEqual(csv_response.status_code, 200, csv_response.get_data(as_text=True))
        self.assertEqual(csv_response.get_json()['predictions'][0]['label'], predicted['predictions'][0]['label'])
        changed = self.request_ok('POST','/api/what-if',json={'model_ids':[self.model_id], 'connection':connection,'changes':{'src_bytes':float(connection['src_bytes'])+1}})
        self.assertIn('src_bytes',changed['comparisons'][0]['used_changed_features'])
        replay = self.request_ok('POST','/api/replay',json={'model_id':self.model_id,'start':0,'count':2})
        self.assertEqual(len(replay['predictions']),2)
        challenge = self.request_ok('POST','/api/challenge',json={'model_id':self.model_id})
        self.assertNotIn('actual_label',challenge)
        self.assertNotIn('machine',challenge)
        answer = self.request_ok('POST',f"/api/challenge/{challenge['challenge_id']}/answer",json={'answer':'attack'})
        self.assertIn(answer['actual_label'],('normal','attack'))
        self.assertEqual(self.client.post(f"/api/challenge/{challenge['challenge_id']}/answer",json={'answer':'normal'}).status_code,400)
        curve = self.request_ok('GET',f'/api/thresholds/{self.model_id}')
        self.assertEqual(curve['evaluation_set'],'KDDTest+')
        self.assertTrue(any(row['threshold']==0.01 for row in curve['rows']))
        self.assertIn('experiment_31e9b36582044da995b33f1b20eb6c92', [r['result_id'] for r in self.request_ok('GET','/api/results')['results']])
        self.assertIn('false_alarm_rate',self.client.get('/api/export').get_data(as_text=True))

    def test_small_optimization_and_finalization(self):
        result = self.request_ok('POST','/api/run',json={'kind':'search','algorithm':'ga','config':{'population':4,'iterations':1,'train_rows':200,'validation_rows':100,'trees':5,'final_trees':5}})
        self.assertEqual(result['status'],'queued')
        def finished(identifier):
            for _ in range(120):
                state=self.request_ok('GET',f'/api/status/{identifier}')
                if state['status'] not in ('queued','running'):
                    self.assertEqual(state['status'],'completed',state.get('error'))
                    return state
                time.sleep(.2)
            self.fail('Background job did not finish within 24 seconds')
        search=finished(result['job_id'])
        self.assertIn('validation_metrics',search['result'])
        final=self.request_ok('POST',f"/api/finalize/{result['job_id']}")
        finalized=finished(final['job_id'])
        identifier=finalized['result']['records'][0]['model_id']
        self.assertEqual(len(self.request_ok('POST','/api/classify',json={'model_id':identifier,'connection':self.request_ok('GET','/api/sample?index=0')['connection']})['predictions']),1)


if __name__ == '__main__':
    unittest.main()
