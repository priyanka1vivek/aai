# Four-tab frontend contract

All ratios/scores are numbers in [0,1] unless fitness is penalized for violated
security constraints (>1). Display ratios as percentages. Times use seconds
unless a field explicitly says ms. Masks are 41 original-input bits in the
order supplied by GET /api/dataset. Confusion matrices are
[[true_normal,false_alarm],[missed_attack,true_attack]].

## Feature Optimization tab

POST /api/run:

```json
{
  "kind":"search",
  "algorithm":"ga",
  "config":{
    "population":12,"iterations":10,"seed":1,
    "train_rows":5000,"validation_rows":2000,
    "mutation_rate":0.02439,"crossover_rate":0.8,
    "min_features":5,"max_features":25,
    "min_attack_recall":0.95,"max_false_alarm_rate":0.05,
    "patience":5
  },
  "initial_masks":[]
}
```

Switch algorithm to pso; use inertia/cognitive/social controls rather than GA
operators. initial_masks accepts up to population masks, each a 41-bit string
or array. Missing positions are generated randomly. Inputs that violate the
feature-count bounds are rejected; evolved candidates are repaired.

The request returns HTTP 202 and job_id. GET /api/status/JOB_ID returns status,
progress, history, result and error. Valid states: queued/running/completed/
failed/cancelled. history contains all snapshots; progress.latest is the most
recent snapshot. Iteration 0 is initialization, not a completed update.
progress.latest.candidates provides each current mask, fitness, accuracy and
feature count. PSO snapshots also include personal_best_fitness and mean velocity.
Once complete, result.history contains the full trace. Do not discard state
when temporarily switching tabs. Poll at ~1 second intervals, not in a tight loop.

POST /api/cancel/JOB_ID requests cooperative cancellation. POST
/api/finalize/JOB_ID freezes a completed search and starts final model training;
poll its new job ID to get result.records[0].model_id and test diagnostics.
Validation results belong in optimization; test metrics belong in evaluation.
The baseline job can likewise be finalized to train both baseline models.

To score a hand-picked chromosome without evolution, POST /api/run with
kind=score, mask=<41 bits>, config=<same scorer settings>. It returns validation
metrics and selected feature names. This is a job, not an instant calculation.

## Security Evaluation tab

POST /api/run with:

```json
{"kind":"baselines","config":{"chi_k":12,"train_rows":5000,"validation_rows":2000}}
```

Finalize that completed job to create both baseline models. result.records
includes grouped chi-square ranking. Show its heuristic selection rule.

For a complete controlled comparison, POST /api/run with:

```json
{"kind":"experiment","seeds":[1,2,3,4,5],"config":{"population":16,"iterations":15,"train_rows":10000,"validation_rows":5000}}
```

This automatically searches, finalizes and saves baselines and each GA/PSO run.
Status progress includes stage, algorithm, seed, completed_runs and latest trace.
The result includes records, summaries, statistics and experiment_id. Select
one experiment report for a fair table; never aggregate unrelated settings.
Use validation fitness to choose each method's representative saved model.

GET /api/models provides saved-model metadata including test_metrics,
security_breakdown, selected_features, feature_importances, prediction_timing,
test_security_constraints_met and configuration. Attack-type rows include count,
detected, missed, recall and present_in_training. Rare groups require support
counts in the display. Feature importances are global RF impurity importances,
not per-connection explanations or causal importance.

GET /api/results supplies completed search/finalization/experiment reports.
GET /api/thresholds/MODEL_ID gives test metrics over thresholds from .05 to .95.
Show attack recall and false alarms together. Mark this curve as exploratory;
formal threshold selection must use validation data.
GET /api/export downloads the saved-model comparison table as CSV.

## Traffic What-if tab

GET /api/sample?label=attack&index=0 loads a real attack example. label=normal
loads a normal example; omit label for any test row. index advances within the
filtered set. The response gives connection, actual_label, test_row and next_index.

POST /api/what-if:

```json
{
  "model_ids":["SAVED_MODEL_ID"],
  "connection":{"REPLACE":"use the full object returned by /api/sample"},
  "changes":{"src_bytes":5000,"duration":20,"serror_rate":0.8}
}
```

model_ids accepts 1-4 models. The response contains original and modified
prediction per model, score change, label_changed, used_changed_features and
ignored_changed_features. Optional threshold applies the same override to all
models. Without override, each uses its own recorded threshold.
Validate before submission and display backend errors. Numeric fields must be
finite/nonnegative; rate and binary fields have [0,1] limits. Edited combinations
can be physically inconsistent: label them synthetic sensitivity experiments.
Do not imply that an edited record has a verified true label.

## Detection & Analyst Challenge tab

POST /api/classify with model_id and connection=<input object>, or
connections=[<objects>] for a batch up to 5000. Optional threshold=.3 overrides
the saved threshold. Response predictions include label and attack_score.
Display warnings for unknown categories; never rename the score to confidence
or claim that a connection is certainly safe. All selected inputs are required;
unselected inputs may be omitted. Full-feature models require all 41 inputs.

POST /api/classify-csv as multipart form: file=<CSV>, model_id=<ID>, optionally
threshold=<number>. CSV needs a header row with original feature names; label
and difficulty columns are accepted but ignored as inputs. Missing values and
more than 5000 rows are rejected. Upload limit is 5 MiB. This route does not
accept the raw headerless 43-column NSL-KDD TXT file.

POST /api/replay:

```json
{"model_id":"SAVED_MODEL_ID","start":0,"count":10}
```

Returns predictions, true labels, correct flags and next_start. The frontend
buffers these rows and displays them on a timer, maintaining running counts.
Start/pause/speed are client controls; fetch the next batch when needed. Stop
when next_start is null. Call it test-data replay, not network packet capture.

POST /api/challenge with model_id=<ID> returns challenge_id and connection
without ground truth or model prediction. Show selected feature values and
two answer buttons: Normal / Attack. POST /api/challenge/CHALLENGE_ID/answer
with {"answer":"attack"} reveals true label, attack type, human correctness,
machine result and outcome. The backend accepts only the first answer. Store
the user's cumulative score in frontend state, and explain missed_attack vs
false_alarm. Do not expose /api/sample actual labels in the challenge UI.

## Integration and errors

Put the finished page in templates/index.html and static files in static/.
app.py automatically serves the page when it exists. Keep same-origin relative
URLs. Error responses have an error string; invalid inputs return 400, unknown
IDs 404. A running job blocks new search/finalization jobs; classifications
remain available. Never show random/demo values as completed real results.

Server restarts clear active jobs/challenges; saved model files and JSON results
persist. Reload completed records via /api/results and models via /api/models.


## Calibrated default detector

Read `detector_policy.json` for the additional default model ID. The user first
runs `activate_detector.py`, which verifies cached metrics and saves that model.
Choose it in `/api/models`, initialize the detection threshold to **0.01**, and
allow 0.001–0.999. Without a threshold override, this calibrated model defaults
to 0.01. Existing model defaults and original experiment files are unchanged.
The threshold curve endpoint includes 0.001, 0.005, 0.01 and 0.025 too.

Display its accuracy/recall/F1 AND false-alarm rate, with the exploratory
calibration note. Keep it separate from the original five-seed comparison.
Do not replace the PSO mean with this model's score, invent an optimization
history for calibration, or describe the attack score as calibrated certainty.
The inherited 98% recall / 2% FAR test constraints are not met; show the recorded
`test_security_constraints_met=false` rather than claiming they were achieved.

Frontend bootstrap: `GET /api/default-detector` returns the configured model ID, threshold, selection evidence and an `available` flag. After activation, `available=true`. Use that ID in classification requests.

## Fresh-checkout model state

`/api/default-detector` now includes `available`, `provenance`,
`historical_model_id`, and `historical_available`. Before local training it
returns the historical ID with `available=false`. After `bootstrap_demo.py`
it selects the newly retrained ID with `provenance=locally_retrained_demo`; it
never presents that ID as the original calibrated artifact. `/api/models`
includes per-model `available` and `provenance` fields. JSON-only historical
reports are evidence, not runnable classifiers.
