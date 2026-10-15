# Final additional detector: PSO seed 3 with validation calibration

Test benchmark: **92.47% accuracy, 94.51% attack recall, 93.46% F1**.
False-alarm rate is **10.23%**: 993 normal rows are flagged; 704 attacks are missed.
It needs **11 original features**. Do not describe it as a proven optimum or a
deployment-ready system, and do not hide the false-alarm rate.

The frozen mask comes from the existing PSO seed 3 result. A local calibration
refitted all ten frozen GA/PSO masks on the training split using 150 RF trees.
For each mask, it evaluated a fixed threshold grid on the validation split.
The preset rule maximized attack-type macro recall, then overall attack recall,
then specificity, subject to validation FAR <=2% and recall >=98%. This selected
PSO seed 3 at **0.01**, with validation attack recall/macro recall 100% and FAR
1.685%. Selection evidence is in `REDUCED_CALIBRATION_EVIDENCE.json`.

The final RF refit on all KDDTrain+ exactly reproduced every original PSO seed 3
test metric at its old threshold 0.15. Therefore your already saved RF can be
reused: only the operating threshold changes. This is calibration, not a new
forest architecture. The original masks were optimized on the same validation
split, and prior test results informed the decision to investigate calibration.
This is an exploratory benchmark revision, not nested validation or a new
independent held-out assessment. The new test recall/FAR do not satisfy the old
98%/2% security gates; metadata records that failure explicitly.

## Activate only with the original local artifacts

```powershell
git pull --ff-only origin main
.\venv\Scripts\python.exe activate_detector.py
.\venv\Scripts\python.exe app.py
```

The original source `.joblib`, matching `.predictions.npz`, and prepared data are
not committed. A fresh checkout cannot run this command. Use `bootstrap_demo.py`
for a distinctly labeled local retraining, or restore your trusted original
files from your laptop.

The activation command reads the original PSO seed 3 prediction cache, verifies
all expected metrics, checks native saved-model predictions against the cache,
then saves a new `pso_calibrated` model with default threshold 0.01. It never
fits RFs or repeats GA/PSO. Original model files and experiment results stay
unchanged. It prints the exact model ID for Person 2.

`/api/models` lists it and all existing detection, CSV, replay, what-if and
challenge APIs accept its model ID. Person 2 should read `detector_policy.json`
for the default selection, initialize the threshold control to 0.01, and allow
0.001–0.999. Threshold curves now include low operating points. Display scores
as uncalibrated attack estimates, not certainty.

Keep the original five-seed, common-threshold comparison in Security Evaluation.
Display this additional calibrated detector in a separate row with its selection
rule and full metrics. Do not replace the original PSO average with 92.47%.
The default fitness objective and GA/PSO implementations remain intact.

## Reproduce calibration if desired later

`calibrate_reduced.py --report results/experiment_31e9b36582044da995b33f1b20eb6c92.json`
performs ten validation RF fits plus one final fit. It is not required now.

Frontend bootstrap: `GET /api/default-detector` returns the configured model ID, threshold, selection evidence and an `available` flag. After activation, `available=true`. Use that ID in classification requests.
