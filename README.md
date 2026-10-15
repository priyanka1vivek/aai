# Sentinel · NSL-KDD intrusion detection lab

## Start from a fresh checkout

The repository includes the full `KDDTrain+.txt` and `KDDTest+.txt` data and the
historical JSON reports, but excludes generated `.joblib` and `.npz` files. The
published calibrated model ID `b8c6bf4db26f44b2b557f99114f03999` cannot be
loaded from a fresh checkout. Its **recorded** test results are 92.47% accuracy,
94.51% attack recall and **10.23% false-alarm rate** (993 false alarms; 704 missed
attacks). The reports remain visible even when no classifier is available.

Python 3.11, macOS/Linux:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python bootstrap_demo.py
python app.py
```

Windows PowerShell:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe bootstrap_demo.py
.\.venv\Scripts\python.exe app.py
```

Open http://127.0.0.1:5000. `bootstrap_demo.py` verifies SHA-256 of the two
committed dataset files, prepares the split, and trains a **new** Random Forest
using the published 11-feature mask, recorded training settings and threshold.
It saves a new local model ID, measured metadata and prediction cache, and
selects it in `results/active_detector.json`. Re-running it reuses the available
local demo model. The script never changes `detector_policy.json`, historical
model metadata, or experiment results. The UI labels the new detector as a local
retraining, while the historical model remains unavailable until its original
binary is restored. Matching test percentages do not prove binary identity or
turn the exploratory benchmark into an independent evaluation.

To verify the frontend and API flows, run `node --check static/app.js` and
`python -m unittest discover -s tests -v`. The tests cover missing-artifact
startup, real-data prediction, CSV upload, what-if, replay, challenge,
threshold evidence, historical reports, and a small search/finalization job.
GitHub Actions runs these checks on a clean checkout. Generated models and
caches stay untracked; each new checkout trains its own demo. Loading joblib
files from untrusted sources is unsafe, so restore only artifacts you trust.

If you have the **original** `models/99af1769fd4d4e0a831a0bd435890d60.joblib`
and matching `.predictions.npz` on your laptop, copy those plus
`results/prepared_data.joblib` into their named folders and run
`python activate_detector.py`. The script verifies cached scores and test rows
before writing the historical calibrated model. Do not rename a newly trained
model to the historical ID. When the historical file is present, it takes
priority over the local demo in `/api/default-detector`.

The UI uses Flask on localhost, and replay uses recorded test rows, not live
network packets. The benchmark is exploratory and historical; it is not a
modern deployment validation.

---

## Historical calibrated detector (original artifacts required)

A recall-focused training-validation calibration selected PSO seed 3 at threshold
0.01: **92.47% test accuracy, 94.51% attack recall, 93.46% F1**, with **10.23% false
alarms**, using 11 inputs. This is an exploratory benchmark revision after prior
test-set inspection, not a fresh independent assessment or a proven optimum.

Only if the original saved model and prediction cache are available locally, run
`.\venv\Scripts\python.exe activate_detector.py` to verify their scores and create
the calibrated model without training. It prints
its model ID. See `FINAL_DETECTOR.md` for the selection evidence, limitations and
frontend handoff. Keep the original five-seed results separate.

## Current status: read your existing results first

If you already completed the five-seed experiment, **do not start another training run**.
From this project folder in Windows PowerShell, run:

```powershell
.\venv\Scripts\python.exe report_results.py
```

This command reads every completed `results/experiment_*.json`, prints test
accuracy, attack recall, F1, false-alarm rate, sample standard deviations,
feature counts, and the validation-selected saved model for each method. It
uses no dataset, never loads a model and never trains. Configurations stay separate.
The currently committed experiment has a tiny verification budget; your laptop
may have the later five-seed report. Upload that **experiment JSON** to GitHub
or attach it in chat for review. Do not upload the virtual environment.

`run_improved.py` and its matching `src/` modules are now included. That command
**does train a new experiment**; adding the file does not improve existing models.
Only use it if you deliberately choose to spend that training budget. Its
validation-selected security settings do not guarantee better unseen-test results.
See `REVISION_STEPS.md` for the revised objective and limitations.

The VS Code source-control `U` means untracked, not an error. New files remain
local until committed and pushed. `.gitignore` prevents future generated binary,
cache, virtual-environment and dataset files from being added. Files already
committed are retained, and existing result/model files are not deleted.

# Person 1: complete NSL-KDD optimization and security backend

This folder supersedes the first-two-files starter. It contains the data,
algorithms, experiments, saved-model training, security diagnostics, prediction,
what-if and analyst-challenge backend. The polished frontend is integrated.
The root page serves the integrated four-section frontend.

## The four tabs

1. **Feature Optimization:** switch GA/Binary PSO; configure population,
   generations/iterations, seed and operators; supply starting chromosomes or
   particle positions; limit selected features; set validation attack-recall and
   false-alarm constraints; stop on fitness/accuracy, stagnation or a soft time
   budget. Show best/mean fitness, attack recall, false alarms, population
   diversity, candidates and selected features. Score a custom mask separately.
2. **Security Evaluation:** run full-feature and grouped chi-square baselines;
   run GA/PSO with 2-10 matched seeds; compare accuracy, attack precision/recall/F1,
   false alarms, missed attacks, feature counts and measured prediction time.
   Show confusion matrix, attack-type recall, seen/unseen-attack-type recall,
   aggregate feature importances, repeated-run variation and statistics. Explore
   the threshold tradeoff curve; export comparison CSV.
3. **Traffic What-if Lab:** load a real test connection; change duration, source
   bytes, destination bytes, counts/rates or categorical fields; compare original
   and modified predictions from up to four saved models. Show attack-score
   change, changed selected inputs and changed inputs ignored by reduced models.
   These are synthetic feature perturbations, not physically validated traffic
   or generated real attacks. Do not claim robustness from a few examples.
4. **Live Detection & Analyst Challenge:** classify a real example, custom input
   or CSV; choose model and threshold; replay held-out connections with start,
   pause and adjustable display rate; show labels, truth and running error counts.
   The challenge hides ground truth and model decision until the analyst guesses
   normal/attack, then explains correct detection, missed attack or false alarm.
   It is an educational task, not a measurement of overall model accuracy.

GA and PSO are search algorithms, not separate kinds of neural models. A bit
means whether an original NSL-KDD input is retained. Random Forest is trained on
each candidate subset and once more on a frozen final subset. No finite run
guarantees a global optimum or the smallest possible feature subset.

## 1. Get the data

Open https://github.com/jmnwong/NSL-KDD-Dataset -> Code -> Download ZIP.
Extract it, copy KDDTrain+.txt and KDDTest+.txt into data/. Use the full TXT files,
not the ARFF, 20Percent or Test-21 alternatives. Keep the filenames unchanged.
The mirror describes its provenance as a backup of the original UNB dataset.
NSL-KDD is a historical benchmark, not evidence of modern deployment coverage.

## 2. Install and preprocess

Open this folder in VS Code. Windows PowerShell:

    python -m venv venv
    .\venv\Scripts\python.exe -m pip install -r requirements.txt
    .\venv\Scripts\python.exe src/preprocess.py

macOS/Linux equivalent:

    python3 -m venv venv
    ./venv/bin/python -m pip install -r requirements.txt
    ./venv/bin/python src/preprocess.py

Expected: source training 125973; training split 100778; validation 25195;
test 22544; original inputs 41; encoded columns 121 with the fixed split.
Difficulty and attack type are never classifier inputs. Attack types are
retained separately solely for evaluation. Normal=0; any attack=1.

Encoding is fit only on the training split during search. Categorical inputs
are grouped one-hot columns. A 41-bit mask expands through feature_groups, so
feature counts always refer to original inputs. Unknown categories are handled
explicitly. Final models refit their encoding on all KDDTrain+ after selection.

## 3. Verify the whole backend with a small run

    .\venv\Scripts\python.exe smoke_check.py

This checks real-data GA/PSO execution, seed reproducibility, best-so-far
convergence, baselines, saved models, predictions, excluded-feature invariance,
what-if, thresholds, replay, hidden-label challenges, repeated runs and statistics.
It writes tiny-run demo models and results. Its settings are for verification,
not your final report. It may take several minutes depending on your computer.
Keep/report the configuration with each result. Do not combine configurations
as if they belonged to one controlled experiment.

## 4. Start the backend

    .\venv\Scripts\python.exe app.py

Open http://127.0.0.1:5000. The four-section frontend calls the same-origin Flask API. For scripted requests,
use the endpoints below.

First POST /api/run with:

```json
{
  "kind": "search",
  "algorithm": "ga",
  "config": {
    "population": 4,
    "iterations": 2,
    "train_rows": 1000,
    "validation_rows": 500,
    "trees": 10
  }
}
```

It returns job_id. GET /api/status/JOB_ID until status is completed or failed.
Completed search results include validation_metrics, best_mask, selected_features,
history, stop_reason and config. Snapshot iteration 0 is the initial population;
iterations=2 permits two updates after initialization. Therefore the maximum
candidate evaluation calls are population*(iterations+1), before caching.

To create a detection model from that frozen result, POST /api/finalize/JOB_ID.
Poll the returned new job ID. The completed finalization result contains model_id,
test_metrics, security_breakdown, feature_importances and prediction_timing.

Search itself does not read test labels or automatically produce test scores.
Only explicit finalization and repeated experiments do final test evaluation.

## 5. Run report experiments

    .\venv\Scripts\python.exe -m src.runner --seeds 1 2 3 4 5 --population 16 --iterations 15 --train-rows 10000 --validation-rows 5000

Start small, measure runtime, then choose the largest budget your deadline
allows. Ten seeds give more optimizer-variability evidence than five but cost
twice as much. Baselines use the same search sample and final RF settings.
Baselines are deterministic here and are evaluated once; their across-run
standard deviation is null, not a fabricated zero from repeated identical runs.

The report includes individual results, mean/sample std, paired GA-vs-PSO
Wilcoxon tests for fitness and test F1 (with a two-metric correction), and paired
stratified bootstrap intervals for validation-selected models against full inputs.
Seeds represent optimizer variability on a fixed split, not independent datasets.
Small counts have low power. Intervals assume exchangeable test rows within
each class; rare attack-type recalls can be unstable. Nonsignificance is valid.

## How security-aware selection works

The original objective is preserved when optional constraints are absent:

    base = accuracy_weight*(1-validation_accuracy)
           + (1-accuracy_weight)*(selected_original_features/41)

Lower is better. With optional min_attack_recall/max_false_alarm_rate, a feasible
candidate retains that score in [0,1]. An infeasible candidate gets
1 + summed_constraint_violations + base, so it ranks behind every feasible mask.
The UI must display security_feasible=false rather than claiming the targets
were achieved. Constraints are measured on validation data and may fail on test;
test_security_constraints_met reports that separately.

Feature-count limits are repaired inside the algorithms. The shared RF seed,
training/validation sampling and data split are fixed across GA/PSO seeds.
Fitness caching is local to one evaluator/configuration. Default mutation is
approximately 1/41 per bit, not one forced mutation per chromosome.

Chi-square provides a simple supervised ranking baseline rather than a third
metaheuristic. Numeric training inputs are min-max scaled to nonnegative values
for ranking only; categorical indicator scores are summed by original feature.
The top chi_k original inputs are retained. This grouped ranking is a heuristic;
its scores are not formal significance p-values and category counts/scaling can
affect ranking. The classifier itself uses the same encoding as other methods.

Attack-score threshold defaults to 0.5. Adjust it on validation data for a formal
chosen policy. The saved model records its threshold. A detection override and
test-set threshold curve are exploratory and must not be used to tune a threshold
and then claim an independent test estimate. RF scores are not calibrated certainty.

## Configuration fields

Field | Default | Meaning
--- | --- | ---
population | 16 | GA chromosomes / PSO particles (4-100)
iterations | 15 | Updates after initialization (1-100)
seed | 1 | Optimizer random seed
train_rows | 10000 | Fixed stratified search training sample
validation_rows | 5000 | Fixed stratified validation sample
trees | 40 | RF trees per candidate
max_depth | 16 | RF maximum depth, also used in final comparison
final_trees | 100 | RF trees for final saved models, same across methods
accuracy_weight | 0.9 | Accuracy vs original feature-count tradeoff
mutation_rate | 0.02439 | GA per-bit mutation probability
crossover_rate | 0.8 | GA one-point crossover probability
tournament_size | 3 | GA tournament size, <= population
inertia | 0.7 | PSO previous-velocity weight
cognitive | 1.5 | PSO personal-best attraction
social | 1.5 | PSO global-best attraction
velocity_limit | 4.0 | PSO velocity clipping
min_features / max_features | 1 / 41 | Search subset bounds
patience | 0 | Stop after this many unimproved updates; 0 disables
target_accuracy | null | Stop if best feasible mask achieves target validation accuracy
target_fitness | null | Stop if best feasible mask achieves target fitness
max_seconds | 0 | Soft elapsed-time stop checked between updates; 0 disables
chi_k | 12 | Original features retained by chi-square baseline
attack_threshold | 0.5 | Threshold used consistently during search/final evaluation
min_attack_recall | null | Optional minimum validation attack recall
max_false_alarm_rate | null | Optional maximum validation normal false-alarm rate

Stopping conditions use OR: the first reached ends the run. Time budget may be
exceeded by the current population evaluation. Cancellation waits for the current
RF fit/stage, never kills a classifier halfway through. In-flight job IDs/history
reset on server restart; completed JSON and models persist.

## Your files, in the order to study

File | Responsibility
--- | ---
src/preprocess.py | Load/validate, split, encode, group original inputs, save data
src/config.py | Validate settings, supplied masks and feature bounds
src/fitness.py | Cached RF evaluation, intrusion metrics and constraint penalties
src/search_common.py | Snapshots, stopping and shared result format
src/ga.py | Selection, elitism, crossover, mutation and repair
src/pso.py | Velocity, sigmoid, personal/global best and repair
src/baselines.py | Full-input and grouped chi-square masks
src/evaluate.py | Final training, timing, attack breakdown and classification
src/statistics.py | Paired seed tests and paired test-row bootstrap
src/runner.py | Controlled repeated experiments and report summaries
src/storage.py | Atomic result JSON writes
src/service.py | Background jobs, model loading, what-if, replay and challenge
app.py | Flask routes for Person 2 to call
smoke_check.py | Real-data integration verification

## Person 2 handoff

Give Person 2 this entire folder. The merged frontend lives in templates/index.html, static/app.js
and static/style.css. app.py serves it at the root URL. They can reuse the APIs as documented in FRONTEND_CONTRACT.md.
Run frontend and backend on the same localhost origin. No CORS changes are needed.
Poll status once per second; use the returned history rather than animating fake
convergence. Frontend timers control replay pace; /api/replay predicts batches.

Both people need the same Python dependency versions; requirements.txt pins the
six direct dependencies used for verification. Transfer trained joblib
files only from this project and use matching scikit-learn versions. Run this
development server locally; it is not a production/authenticated deployment.

## Honest presentation claims

- Best-found subset, not proven global optimum/minimum subset.
- Measured feature reduction and accuracy/recall tradeoff, not guaranteed improvement.
- Measured amortized batch inference latency; isolated one-row latency is different.
- Simulated replay of recorded connections, not raw packet capture.
- Detection of test attack labels absent from training, not general zero-day protection.
- Useful security-focused integration, not a claim of unprecedented research novelty.
- What-if edits inspect model sensitivity; they are not validated adversarial attacks.

## Dataset attribution

NSL-KDD, Canadian Institute for Cybersecurity / University of New Brunswick.
M. Tavallaee, E. Bagheri, W. Lu, and A. Ghorbani, "A Detailed Analysis of the
KDD CUP 99 Data Set," CISDA, 2009.
