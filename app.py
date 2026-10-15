"""Local API server. Person 2 can add templates/static files without changing src/."""
import io
import csv
import json
from pathlib import Path
import pandas as pd
from flask import Flask,jsonify,request,render_template,Response
from src.service import ProjectService,ModelUnavailable

app=Flask(__name__)
app.config['MAX_CONTENT_LENGTH']=5*1024*1024
service=ProjectService()


@app.errorhandler(ValueError)
def invalid(error):return jsonify(error=str(error)),400


@app.errorhandler(ModelUnavailable)
def unavailable(error):return jsonify(error=str(error)),503


@app.errorhandler(KeyError)
def missing(error):return jsonify(error=str(error)),404


def body():
    data=request.get_json()
    if not isinstance(data,dict):raise ValueError('Send a JSON object.')
    return data


@app.get('/')
def home():
    if (Path(app.root_path)/'templates'/'index.html').is_file():
        return render_template('index.html')
    return '''<!doctype html><html><head><meta charset="utf-8"><title>NIDS Backend</title>
    <style>body{font:16px system-ui;max-width:900px;margin:40px auto;padding:20px;background:#f2f5fb;color:#14233e}
    textarea{width:100%;min-height:280px;font:14px monospace}input{width:100%;padding:12px;box-sizing:border-box}button{margin:12px 0;padding:12px 20px;background:#2360dc;color:white;border:0;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere}section{background:white;padding:24px;border-radius:12px}</style></head><body>
    <h1>NIDS backend is running</h1><p>GA/PSO optimization · Security evaluation · Traffic what-if · Detection and analyst challenge</p>
    <p>This is an API tester. Person 2 supplies the four-tab frontend in templates/index.html.</p><section>
    <label>Endpoint<input id="endpoint" value="/api/run"></label>
    <label>JSON request<textarea id="payload">{"kind":"search","algorithm":"ga","config":{"population":4,"iterations":2,"train_rows":1000,"validation_rows":500,"trees":10}}</textarea></label>
    <button onclick="send('POST')">POST request</button><button onclick="send('GET')">GET request</button><pre id="output"></pre>
    </section><script>async function send(method){try{let options={method};if(method==='POST'){options.headers={'Content-Type':'application/json'};options.body=JSON.stringify(JSON.parse(document.getElementById('payload').value))}let r=await fetch(document.getElementById('endpoint').value,options);document.getElementById('output').textContent=JSON.stringify(await r.json(),null,2)}catch(e){document.getElementById('output').textContent=e.message}}</script></body></html>'''


@app.get('/api/dataset')
def dataset():return jsonify(service.summary())


@app.get('/api/default-detector')
def default_detector():
    path=service.root/'detector_policy.json'
    if not path.is_file():raise KeyError('Default detector policy is unavailable.')
    policy=json.loads(path.read_text())
    historical_id=policy['model_id']
    historical_available=(service.root/'models'/f'{historical_id}.joblib').is_file()
    policy['historical_model_id']=historical_id
    policy['historical_available']=historical_available
    policy['available']=historical_available
    policy['provenance']='historically_evaluated'
    if not historical_available:
        active=service.root/'results'/'active_detector.json'
        if active.is_file():
            try:
                identifier=json.loads(active.read_text())['model_id']
                meta=json.loads((service.root/'models'/f'{identifier}.json').read_text())
                if meta.get('provenance')=='locally_retrained_demo' and (service.root/'models'/f'{identifier}.joblib').is_file():
                    policy['historical_expected_test_metrics']=policy.pop('expected_test_metrics')
                    policy['historical_validation_calibration']=policy.pop('validation_calibration')
                    policy.update(model_id=identifier,attack_threshold=meta['attack_threshold'],
                                  available=True,provenance='locally_retrained_demo',
                                  evaluation_note=meta['evaluation_note'])
            except (KeyError, ValueError, OSError):
                pass
    return jsonify(policy)


@app.post('/api/run')
def run():return jsonify(service.start(body())),202


@app.get('/api/status/<identifier>')
def status(identifier):return jsonify(service.status(identifier))


@app.post('/api/cancel/<identifier>')
def cancel(identifier):return jsonify(service.cancel(identifier))


@app.post('/api/finalize/<identifier>')
def finalize(identifier):return jsonify(service.finalize(identifier)),202


@app.get('/api/results')
def results():return jsonify(results=service.results())


@app.get('/api/models')
def models():return jsonify(models=service.models())


@app.get('/api/sample')
def sample():
    try:index=int(request.args.get('index','0'))
    except ValueError:raise ValueError('index must be an integer.')
    return jsonify(service.sample(request.args.get('label'),index))


@app.post('/api/classify')
def predict():return jsonify(service.predict(body()))


@app.post('/api/classify-csv')
def predict_csv():
    if 'file' not in request.files:raise ValueError('Upload a CSV under form field file.')
    uploaded=request.files['file']
    try:frame=pd.read_csv(uploaded,nrows=5001)
    except Exception:raise ValueError('Could not parse CSV. Use a header row with original NSL-KDD feature names.')
    if len(frame)>5000:raise ValueError('CSV upload is limited to 5000 connections.')
    if frame.isna().any().any():raise ValueError('CSV contains missing values.')
    connection_columns=[c for c in frame.columns if c not in ['label','difficulty']]
    payload={'model_id':request.form.get('model_id'),'connections':frame[connection_columns].to_dict('records')}
    if request.form.get('threshold') is not None:
        try:payload['threshold']=float(request.form['threshold'])
        except ValueError:raise ValueError('threshold must be numeric.')
    return jsonify(service.predict(payload))


@app.get('/api/thresholds/<model_id>')
def thresholds(model_id):return jsonify(service.threshold_curve(model_id))


@app.post('/api/what-if')
def what_if():return jsonify(service.what_if(body()))


@app.post('/api/replay')
def replay():
    data=body();start=data.get('start',0);count=data.get('count',10)
    if type(start) is not int or type(count) is not int:raise ValueError('start and count must be integers.')
    return jsonify(service.replay(data.get('model_id'),start,count))


@app.post('/api/challenge')
def challenge():return jsonify(service.new_challenge(body().get('model_id')))


@app.post('/api/challenge/<identifier>/answer')
def answer(identifier):return jsonify(service.answer_challenge(identifier,body().get('answer')))


@app.get('/api/export')
def export():
    stream=io.StringIO();writer=csv.writer(stream)
    writer.writerow(['model_id','method','features','accuracy','attack_recall','attack_f1',
                     'false_alarm_rate','missed_attacks','pipeline_ms_per_connection'])
    for model in service.models():
        m=model['test_metrics']
        writer.writerow([model['model_id'],model['algorithm'],model['feature_count'],m['accuracy'],
                         m['recall'],m['f1'],m['false_alarm_rate'],m['missed_attacks'],
                         model['prediction_timing']['pipeline_ms_per_connection']])
    return Response(stream.getvalue(),mimetype='text/csv',headers={'Content-Disposition':'attachment; filename=nids_comparison.csv'})


if __name__=='__main__':app.run(host='127.0.0.1',port=5000,debug=False,threaded=True)
