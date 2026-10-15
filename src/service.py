from concurrent.futures import ThreadPoolExecutor
from threading import Event,Lock
import copy
import json
import re
import uuid
import joblib
import numpy as np
from .config import ROOT,SearchConfig,parse_mask
from .fitness import FitnessEvaluator,Cancelled
from .ga import run_ga
from .pso import run_pso
from .baselines import run_baselines
from .evaluate import train_final,classify,threshold_sweep
from .runner import experiment
from .storage import atomic_json


class ModelUnavailable(Exception):
    pass


class ProjectService:
    def __init__(self,root=ROOT):
        self.root=root;self.jobs={};self.lock=Lock();self.worker=ThreadPoolExecutor(max_workers=1)
        self.bundle=None;self.loaded_models={};self.challenges={}

    def data(self):
        if self.bundle is None:
            path=self.root/'results'/'prepared_data.joblib'
            if not path.is_file():raise ValueError('Run python src/preprocess.py first.')
            self.bundle=joblib.load(path)
        return self.bundle

    def summary(self):
        path=self.root/'results'/'dataset_summary.json'
        if not path.is_file():raise ValueError('Run python src/preprocess.py first.')
        return json.loads(path.read_text())

    def start(self,payload):
        kind=payload.get('kind','search')
        if kind not in ['search','baselines','experiment','score']:
            raise ValueError('kind must be search, baselines, experiment or score.')
        cfg=SearchConfig.parse(payload.get('config'))
        name=payload.get('algorithm','ga')
        if kind=='search' and name not in ['ga','pso']:raise ValueError('algorithm must be ga or pso.')
        initial=payload.get('initial_masks')
        if initial is not None:
            if not isinstance(initial,list) or len(initial)>cfg.population:
                raise ValueError('initial_masks must be a list no longer than population.')
            for mask in initial:parse_mask(mask,cfg)
        if kind=='score':parse_mask(payload.get('mask'),cfg)
        seeds=payload.get('seeds',[1,2,3,4,5])
        if kind=='experiment':
            if not isinstance(seeds,list) or not 2<=len(seeds)<=10 or len(set(seeds))!=len(seeds):
                raise ValueError('Use 2 to 10 distinct seeds.')
            for seed in seeds:SearchConfig.parse({**cfg.to_dict(),'seed':seed})
        bundle=self.data()
        with self.lock:
            if any(j['status'] in ['queued','running'] for j in self.jobs.values()):
                raise ValueError('A job is already running. Wait or cancel it first.')
            identifier=uuid.uuid4().hex;cancel=Event()
            self.jobs[identifier]={'job_id':identifier,'status':'queued','kind':kind,
                                    'progress':{},'result':None,'error':None,'cancel':cancel}
        def update(values):
            with self.lock:
                self.jobs[identifier]['progress']=copy.deepcopy(values)
                if 'latest' in values:
                    self.jobs[identifier].setdefault('history',[]).append(copy.deepcopy(values['latest']))
        def work():
            with self.lock:self.jobs[identifier]['status']='running'
            try:
                evaluator=FitnessEvaluator(bundle,cfg,cancel)
                if kind=='search':
                    fn=run_ga if name=='ga' else run_pso
                    result=fn(evaluator,cfg,lambda row:update({'stage':'search','latest':row}),initial)
                    # Search tabs report validation evidence only. Final training is explicit.
                elif kind=='score':
                    mask=parse_mask(payload['mask'],cfg)
                    result={'mask':mask.tolist(),'validation_metrics':evaluator.evaluate(mask),
                            'selected_features':[n for n,b in zip(bundle['feature_names'],mask) if b]}
                elif kind=='baselines':result={'records':run_baselines(evaluator,cfg)}
                else:result=experiment(bundle,cfg,seeds,self.root,update,cancel)
                if cancel.is_set():raise Cancelled('Cancelled after current stage.')
                atomic_json(self.root/'results'/f'job_{identifier}.json',result)
                with self.lock:self.jobs[identifier].update(status='completed',result=result)
            except Cancelled as exc:
                with self.lock:self.jobs[identifier].update(status='cancelled',error=str(exc))
            except Exception as exc:
                with self.lock:self.jobs[identifier].update(status='failed',error=f'{type(exc).__name__}: {exc}')
        self.worker.submit(work)
        return {'job_id':identifier,'status':'queued'}

    def status(self,identifier):
        with self.lock:
            if identifier not in self.jobs:raise KeyError('Unknown job ID; jobs reset on server restart.')
            return copy.deepcopy({k:v for k,v in self.jobs[identifier].items() if k!='cancel'})

    def cancel(self,identifier):
        with self.lock:
            if identifier not in self.jobs:raise KeyError('Unknown job ID.')
            self.jobs[identifier]['cancel'].set()
        return {'job_id':identifier,'cancellation_requested':True,
                'note':'Stops between classifier fits/stages; the current fit is allowed to finish.'}

    def finalize(self,identifier):
        previous=self.status(identifier)
        if previous['status']!='completed' or previous['kind'] not in ['search','baselines']:
            raise ValueError('Finalize a completed search or baselines job.')
        records=previous['result'].get('records',[previous['result']])
        cfg=SearchConfig.parse(records[0]['config'])
        bundle=self.data()
        with self.lock:
            if any(j['status'] in ['queued','running'] for j in self.jobs.values()):
                raise ValueError('A job is already running.')
            job_id=uuid.uuid4().hex;cancel=Event()
            self.jobs[job_id]={'job_id':job_id,'status':'queued','kind':'finalize','progress':{},
                              'result':None,'error':None,'cancel':cancel}
        def work():
            with self.lock:self.jobs[job_id]['status']='running'
            try:
                output=[]
                for record in records:
                    if cancel.is_set():raise Cancelled('Finalization cancelled between models.')
                    with self.lock:self.jobs[job_id]['progress']={'stage':'final_training','algorithm':record['algorithm']}
                    result=train_final(bundle,copy.deepcopy(record),cfg,self.root);output.append(result)
                if cancel.is_set():raise Cancelled('Finalization cancelled after training.')
                result={'records':output}
                atomic_json(self.root/'results'/f'job_{job_id}.json',result)
                with self.lock:self.jobs[job_id].update(status='completed',result=result)
            except Cancelled as exc:
                with self.lock:self.jobs[job_id].update(status='cancelled',error=str(exc))
            except Exception as exc:
                with self.lock:self.jobs[job_id].update(status='failed',error=f'{type(exc).__name__}: {exc}')
        self.worker.submit(work)
        return {'job_id':job_id,'status':'queued'}

    def models(self):
        output=[]
        for path in sorted((self.root/'models').glob('*.json')):
            meta=json.loads(path.read_text())
            output.append({**meta, 'available':path.with_suffix('.joblib').is_file(),
                           'provenance':meta.get('provenance','historical_metadata')})
        return output

    def model(self,identifier):
        if not isinstance(identifier,str) or not re.fullmatch('[a-f0-9]{32}',identifier):
            raise ValueError('Invalid model ID.')
        path=self.root/'models'/f'{identifier}.joblib'
        if not path.is_file():raise KeyError('Model artifact unavailable. Run python bootstrap_demo.py for a separate demonstration detector, or restore the original model files.')
        if identifier not in self.loaded_models:
            try:
                self.loaded_models[identifier]=joblib.load(path)
            except Exception as exc:
                raise ModelUnavailable(f'Could not load saved model {identifier}; restore or retrain its artifact. ({type(exc).__name__})') from exc
        return self.loaded_models[identifier]

    def predict(self,payload):
        saved=self.model(payload.get('model_id'))
        records=payload.get('connections')
        if records is None:records=[payload.get('connection')]
        return classify(records,saved,payload.get('threshold'))

    def sample(self,label=None,index=0):
        bundle=self.data()
        if label not in [None,'normal','attack']:raise ValueError('label must be normal or attack.')
        indices=np.arange(len(bundle['y_test']))
        if label:indices=indices[bundle['y_test'][indices]==(1 if label=='attack' else 0)]
        if index<0 or index>=len(indices):raise ValueError('Sample index is out of range.')
        original=int(indices[index]);connection=bundle['raw_test'].iloc[original].to_dict()
        return {'index':index,'test_row':original,'connection':connection,
                'actual_label':'attack' if bundle['y_test'][original] else 'normal',
                'available_samples':len(indices),'next_index':index+1 if index+1<len(indices) else None}

    def replay(self,model_id,start=0,count=10):
        if start<0 or not 1<=count<=100:raise ValueError('start >= 0 and count in [1,100] required.')
        bundle=self.data();end=min(start+count,len(bundle['y_test']))
        if start>=end:raise ValueError('Replay has reached the end of the test file.')
        records=bundle['raw_test'].iloc[start:end].to_dict(orient='records')
        response=classify(records,self.model(model_id))
        for j,p in enumerate(response['predictions']):
            p.update(test_row=start+j,actual_label='attack' if bundle['y_test'][start+j] else 'normal')
            p['correct']=p['label']==p['actual_label']
        response.update(next_start=end if end<len(bundle['y_test']) else None)
        return response

    def results(self):
        output=[]
        for pattern in ['job_*.json','experiment_*.json']:
            for path in sorted((self.root/'results').glob(pattern)):
                output.append({'result_id':path.stem,'result':json.loads(path.read_text())})
        return output

    def threshold_curve(self,model_id):
        saved=self.model(model_id)
        cache=self.root/'models'/f'{model_id}.predictions.npz'
        if not cache.is_file():
            raise KeyError('Prediction cache unavailable for this model. Rebuild the detector or restore its matching cache.')
        return threshold_sweep(saved,self.root)

    def what_if(self,payload):
        connection=payload.get('connection')
        changes=payload.get('changes',{})
        identifiers=payload.get('model_ids')
        if not isinstance(connection,dict) or not isinstance(changes,dict):
            raise ValueError('connection and changes must be objects.')
        if not isinstance(identifiers,list) or not 1<=len(identifiers)<=4:
            raise ValueError('model_ids must contain 1 to 4 saved model IDs.')
        modified={**connection,**changes};comparisons=[]
        for identifier in identifiers:
            saved=self.model(identifier)
            prediction=classify([connection,modified],saved,payload.get('threshold'))
            a,b=prediction['predictions']
            comparisons.append({'model_id':identifier,'algorithm':saved['algorithm'],
                                 'original':a,'modified':b,'label_changed':a['label']!=b['label'],
                                 'attack_score_change':b['attack_score']-a['attack_score'],
                                 'used_changed_features':sorted(set(changes)&set(saved['selected_features'])),
                                 'ignored_changed_features':sorted(set(changes)-set(saved['selected_features'])),
                                 'warnings':prediction['warnings']})
        return {'comparisons':comparisons,'changes':changes,
                'note':'Synthetic feature perturbation, not a generated network attack. '
                       'Edited connection statistics may not correspond to physically consistent traffic.'}

    def new_challenge(self,model_id):
        bundle=self.data();index=int(np.random.default_rng().integers(len(bundle['y_test'])))
        connection=bundle['raw_test'].iloc[index].to_dict()
        machine=classify([connection],self.model(model_id))['predictions'][0]
        identifier=uuid.uuid4().hex
        challenge={'connection':connection,'actual_label':'attack' if bundle['y_test'][index] else 'normal',
                   'machine':machine,'test_row':index,'answered':False,
                   'attack_type':str(bundle['test_attack_types'][index])}
        with self.lock:
            if len(self.challenges)>=1000:self.challenges.pop(next(iter(self.challenges)))
            self.challenges[identifier]=challenge
        return {'challenge_id':identifier,'connection':connection,
                'instruction':'Predict normal or attack. Submit your answer to reveal the true label and model decision.'}

    def answer_challenge(self,identifier,answer):
        if answer not in ['normal','attack']:raise ValueError('answer must be normal or attack.')
        with self.lock:
            if identifier not in self.challenges:raise KeyError('Unknown or expired challenge ID.')
            challenge=self.challenges[identifier]
            if challenge['answered']:raise ValueError('Challenge was already answered.')
            challenge['answered']=True
            output=copy.deepcopy(challenge)
        actual=output['actual_label'];machine=output['machine']['label']
        outcome='correct_detection' if answer==actual else ('missed_attack' if actual=='attack' else 'false_alarm')
        return {'actual_label':actual,'your_answer':answer,'correct':answer==actual,
                'outcome':outcome,'machine':output['machine'],'machine_correct':machine==actual,
                'test_row':output['test_row'],
                'attack_type':output['attack_type'],
                'note':'Educational analyst exercise. One connection is not evidence of overall model quality.'}
