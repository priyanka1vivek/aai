"use strict";
const $ = (id) => document.getElementById(id),
  esc = (v) =>
    String(v ?? "—").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
const pct = (v) => (v == null ? "—" : `${(v * 100).toFixed(2)}%`),
  num = (v) => (v == null ? "—" : Number(v).toLocaleString());
const state = {
  policy: null,
  models: [],
  features: [],
  samples: {},
  sampleIndices: {},
  masks: [],
  mask: Array(41).fill(0),
  job: null,
  searchJob: null,
  jobKind: "search",
  jobActive: false,
  poll: null,
  benchmark: null,
  refreshing: false,
  challenge: null,
  score: { correct: 0, total: 0 },
  replay: {
    running: false,
    busy: false,
    buffer: [],
    next: 0,
    total: 0,
    attacks: 0,
    correct: 0,
    timer: null,
    epoch: 0,
  },
};
async function api(url, body) {
  const opts =
    body === undefined
      ? {}
      : {
          method: "POST",
          ...(body instanceof FormData
            ? { body }
            : {
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
              }),
        };
  const r = await fetch(url, opts);
  let data;
  try {
    data = await r.json();
  } catch {
    throw Error(
      `Backend returned ${r.status} without JSON. Check the server logs and saved model artifacts.`,
    );
  }
  if (!r.ok) {
    const e = Error(data.error || `Request failed (${r.status})`);
    e.status = r.status;
    throw e;
  }
  return data;
}
function errorAt(id, e) {
  $(id).innerHTML =
    `<div class="notice error" role="alert">${esc(e.message || e)}</div>`;
}
async function action(button, target, fn) {
  const text = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = "Working…";
  }
  if (target) $(target).textContent = "Loading…";
  try {
    await fn();
  } catch (e) {
    if (target) errorAt(target, e);
    else {
      errorAt("global-error", e);
      $("global-error").hidden = false;
    }
  } finally {
    if (button) {
      button.textContent = text;
      button.disabled =
        button.hasAttribute("data-detector") && !state.policy?.available;
    }
  }
}
function detector() {
  if (!state.policy?.available)
    throw Error(
      "No runnable detector is available. Run python bootstrap_demo.py, then refresh this page, or restore the historical model artifacts.",
    );
  return state.policy.model_id;
}
function renderDetectorStatus() {
  const p = state.policy;
  const demo = p?.provenance === "locally_retrained_demo";
  $("detector-eyebrow").textContent = demo ? "LOCALLY RETRAINED DETECTOR" : "CALIBRATED DETECTOR";
  $("detector-title").textContent = "Test a saved detector on a connection.";
  $("evidence-title").textContent = demo
    ? "Newly retrained detector · measured separately"
    : "Historical calibrated detector";
  $("threshold-note").textContent = `Exploratory test-set curve for the selected model. Its saved operating point is ${p?.attack_threshold ?? "—"}. Do not tune on this test set.`;
  $("backend-status").textContent = p?.available
    ? (demo ? "Retrained demonstration detector ready" : "Historical detector ready")
    : "Saved detector unavailable";
  $("detector-error").hidden = !!p?.available;
  if (!p?.available) errorAt("detector-error", "Historical model files are absent. Run python bootstrap_demo.py to train a separate detector from the committed data, then refresh. Recorded evaluation reports remain viewable.");
  $("historical-note").textContent = p?.historical_available
    ? "Original calibrated model artifact available in this checkout."
    : "Recorded evaluation only · original model artifact unavailable in the published repository.";
  $("historical-metrics").innerHTML = p?.historical_expected_test_metrics || p?.expected_test_metrics
    ? metricCards(p.historical_expected_test_metrics || p.expected_test_metrics, p.historical_validation_calibration?.feature_count ?? p.validation_calibration?.feature_count ?? 11)
    : "Historical evaluation metadata unavailable.";
  const historical = p?.historical_expected_test_metrics || p?.expected_test_metrics;
  const active = currentModel()?.test_metrics;
  const reproduced = !!(demo && historical && active &&
    ["accuracy", "recall", "f1", "false_alarm_rate"].every(key =>
      Number.isFinite(active[key]) && Math.abs(active[key] - historical[key]) < 1e-10));
  $("historical-card").hidden = reproduced || !!p?.historical_available;
}
function currentModel() {
  return state.models.find((m) => m.model_id === state.policy?.model_id);
}
function table(headers, rows) {
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function chips(items) {
  return `<div class="chips">${(items || []).map((v) => `<span class="chip">${esc(v)}</span>`).join("")}</div>`;
}
function metricCards(m, count) {
  return [
    ["Accuracy", pct(m.accuracy)],
    ["Attack recall", pct(m.recall)],
    ["F1", pct(m.f1)],
    ["Selected inputs", `${count} of 41`],
  ]
    .map(
      ([k, v]) =>
        `<div class="metric"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`,
    )
    .join("");
}
function warnings(values) {
  return (values || []).length
    ? `<div class="notice">${values.map(esc).join("<br>")}</div>`
    : "";
}
const quickSignalInfo = {
  service: ["Service", "Network service used by the connection"],
  src_bytes: ["Bytes sent", "Bytes sent from source to destination"],
  duration: ["Duration (seconds)", "How long the connection lasted"],
  logged_in: ["Logged in", "0 = no · 1 = yes"],
  srv_serror_rate: ["Service error rate", "Share of recent same-service connections with errors"],
  dst_host_diff_srv_rate: ["Different-service rate", "Share of recent destination-host connections using other services"],
};
function fields(target, connection) {
  const used = new Set(currentModel()?.selected_features || []);
  const quick = target === "manual" ? new Set(Object.keys(quickSignalInfo)) : new Set();
  const html = (name) => {
    const value = connection[name], numeric = typeof value === "number";
    const max = name.endsWith("_rate") ||
      ["land", "logged_in", "root_shell", "is_host_login", "is_guest_login"].includes(name) ? 1 : null;
    const info = quickSignalInfo[name];
    const title = target === "manual" && info ? info[0] : name;
    const hint = target === "manual" && info ? `<small>${esc(info[1])}</small>` : "";
    return `<label class="${used.has(name) ? "used" : ""}">${esc(title)}${used.has(name) ? " • used" : ""}${hint}<input name="${esc(name)}" value="${esc(value)}" ${numeric ? `type="number" min="0" step="any" ${max !== null ? `max="${max}"` : ""}` : 'type="text"'} required></label>`;
  };
  if (target === "manual") {
    $("manual-fields").innerHTML = state.features.filter(name => quick.has(name)).map(html).join("");
    $("manual-extra-fields").innerHTML = state.features.filter(name => !quick.has(name)).map(html).join("");
  } else {
    $(target + "-fields").innerHTML = state.features.map(html).join("");
  }
}
function readFields(target) {
  const out = {};
  const containers = target === "manual" ? [$("manual-fields"), $("manual-extra-fields")] : [$(target + "-fields")];
  containers.forEach(container => container.querySelectorAll("input").forEach(i => {
    if (!i.reportValidity()) throw Error(`Invalid value for ${i.name}.`);
    out[i.name] = i.type === "number" ? Number(i.value) : i.value;
    if (i.type === "number" && !Number.isFinite(out[i.name])) throw Error(`${i.name} must be finite.`);
  }));
  return out;
}
function detectionResult(response, changed) {
  const prediction = response.predictions.at(-1);
  const previous = changed.length ? response.predictions[0] : null;
  const label = prediction.label === "attack" ? "Attack flagged" : "Normal traffic";
  const ignored = changed.filter(name => !(response.selected_features || []).includes(name));
  return `${warnings(response.warnings)}<div class="decision ${prediction.label}"><strong>${esc(label)}</strong><span>Attack score: ${pct(prediction.attack_score)}</span></div>
    <div class="score-track" role="img" aria-label="Attack score ${pct(prediction.attack_score)}"><i style="width:${Math.max(1, prediction.attack_score * 100)}%"></i></div>
    <p class="note">Decision threshold ${esc(response.threshold)}.</p>
    ${previous ? `<div class="comparison"><strong>What changed?</strong><p>Original: ${esc(previous.label)} (${pct(previous.attack_score)}) → Edited: ${esc(prediction.label)} (${pct(prediction.attack_score)}).</p><p>${changed.length} field${changed.length === 1 ? "" : "s"} changed.${ignored.length ? ` ${ignored.length} changed field${ignored.length === 1 ? " is" : "s are"} not used by this model.` : ""}</p></div>` : '<p class="note">Change a signal on the left and run again to compare its effect.</p>'}`;
}
async function sample(target, label) {
  const key = `${target}:${label}`,
    index = state.sampleIndices[key] ?? 0;
  const r = await api(`/api/sample?label=${label}&index=${index}`);
  state.samples[target] = r.connection;
  state.sampleIndices[key] = r.next_index ?? 0;
  fields(target, r.connection);
  if (target === "manual") {
    $("sample-status").textContent = `Recorded ${r.actual_label} example selected · test row ${r.test_row}. You can adjust the signals below.`;
    $("manual-output").textContent = "Ready. Run detection to see the model decision.";
  } else if ($(target + "-output")) {
    $(target + "-output").textContent =
      `Real ${r.actual_label} sample · test row ${r.test_row}`;
  }
}
function chart(id, rows, series, xKey, title) {
  const valid = rows.filter(
    (r) =>
      Number.isFinite(r[xKey]) && series.some((s) => Number.isFinite(r[s.key])),
  );
  if (!valid.length) {
    $(id).innerHTML = '<p class="note">No measured trace available yet.</p>';
    return;
  }
  const all = valid.flatMap((r) =>
      series.map((s) => r[s.key]).filter(Number.isFinite),
    ),
    lo = Math.min(...all, 0),
    hi = Math.max(...all, 0.01),
    xmin = valid[0][xKey],
    xmax = valid.at(-1)[xKey],
    x = (v) => 48 + ((v - xmin) / (xmax - xmin || 1)) * 550,
    y = (v) => 180 - ((v - lo) / (hi - lo || 1)) * 140;
  $(id).innerHTML =
    `<p class="chart-caption">${esc(title)} · ${series.map((s) => `<span style="color:${s.color}">${esc(s.name)}</span>`).join(" / ")}</p><svg viewBox="0 0 640 220" role="img" aria-label="${esc(title)}"><path d="M48 35V180H600" fill="none" stroke="#cddcda"/><text x="3" y="42" font-size="11" fill="#617479">${hi.toFixed(3)}</text><text x="3" y="184" font-size="11" fill="#617479">${lo.toFixed(3)}</text>${series
      .map(
        (s) =>
          `<polyline fill="none" stroke="${s.color}" stroke-width="2.5" points="${valid
            .filter((r) => Number.isFinite(r[s.key]))
            .map((r) => `${x(r[xKey])},${y(r[s.key])}`)
            .join(" ")}"/>${valid
            .filter((r) => Number.isFinite(r[s.key]))
            .map(
              (r) =>
                `<circle cx="${x(r[xKey])}" cy="${y(r[s.key])}" r="3" fill="${s.color}"><title>${esc(`${xKey} ${r[xKey]}: ${s.name} ${r[s.key]}`)}</title></circle>`,
            )
            .join("")}`,
      )
      .join(
        "",
      )}<text x="48" y="202" font-size="12" fill="#617479">${esc(xmin)}</text><text x="575" y="202" font-size="12" fill="#617479">${esc(xmax)}</text><text x="280" y="215" font-size="11" fill="#617479">${esc(xKey)}</text></svg>`;
}
function renderSaved() {
  const model = currentModel(),
    metrics = model?.test_metrics;
  if (metrics) {
    $("evidence-metrics").innerHTML = metricCards(metrics, model.feature_count);
  } else {
    $("evidence-metrics").textContent = "No measured evaluation report is available for the configured model.";
    $("attack-breakdown").textContent = "No attack-type evaluation report available.";
  }
  $("selected-count").textContent = model ? `${model.feature_count} selected inputs` : "Selected subset";
  $("active-features").innerHTML = model ? chips(model.selected_features) : "No runnable model selected.";
  if (model) {
    const cm = model.test_metrics.confusion_matrix;
    $("detector-evidence").innerHTML =
      `<h4>Confusion matrix · actual rows / predicted columns</h4>${table(
        ["Actual / predicted", "Normal", "Attack"],
        [
          ["Normal", cm[0][0], cm[0][1]],
          ["Attack", cm[1][0], cm[1][1]],
        ],
      )}<h4>Selected features</h4>${chips(model.selected_features)}<p class="note">${esc(model.evaluation_note || state.policy.evaluation_note)}</p>`;
    const rows = model.security_breakdown?.attack_types || [];
    $("attack-breakdown").innerHTML = table(
      [
        "Attack type",
        "Support",
        "Detected",
        "Missed",
        "Recall",
        "Present in training",
      ],
      rows.map((r) => [
        r.attack_type,
        r.connections,
        r.detected,
        r.missed,
        pct(r.recall),
        r.present_in_training ? "Yes" : "No",
      ]),
    );
  } else {
    $("detector-evidence").textContent = "Saved detector metadata unavailable.";
  }

}
function renderBenchmark() {
  const b = state.benchmark;
  if (!b) {
    $("overview-summary").textContent = "The recorded comparison is unavailable. Check that the original experiment report is present.";
    $("overview-features").textContent = "";
    $("frequency-chart").textContent = "Recorded feature frequencies are unavailable.";
    return;
  }
  renderFrequency();
  renderOverview();
}
function renderOverview() {
  const b = state.benchmark;
  if (!b) return;
  const method = $("overview-method").value;
  const current = b.summaries.find(s => s.algorithm === method);
  const full = b.summaries.find(s => s.algorithm === "full");
  if (!current || !full) {
    $("overview-summary").textContent = "The saved comparison is incomplete.";
    return;
  }
  const name = {ga: "Genetic Algorithm", pso: "Particle Swarm Optimization", full: "All features", chi_square: "Chi-square"}[method];
  const descriptions = {
    ga: "Evolutionary search mutates and recombines feature subsets, then keeps candidates with stronger validation fitness.",
    pso: "Binary particles update their feature choices using their own best subset and the swarm's best subset.",
    full: "Reference classifier with every original feature. There is no selection step.",
    chi_square: "A filter baseline ranks individual features by their association with the training labels.",
  };
  $("overview-summary").innerHTML = `<div class="map-intro"><div><span class="eyebrow">${esc(name)}</span><h4>${method === "ga" || method === "pso" ? "Search for a useful subset" : "Comparison baseline"}</h4><p>${esc(descriptions[method])}</p></div><span class="map-legend"><i></i> ${method === "ga" || method === "pso" ? "Brighter = selected in more runs" : "Highlighted = included"}</span></div>`;
  const frequency = current.feature_selection_frequency || [];
  $("overview-features").innerHTML = `<div class="feature-map" role="list" aria-label="Feature selection frequency for ${esc(name)}">${frequency.map((item, index) => `<div class="feature-tile ${item.frequency ? "active" : ""}" role="listitem" style="--frequency:${Math.max(0, Math.min(1, Number(item.frequency) || 0))}" title="${esc(item.feature)} · ${method === "ga" || method === "pso" ? `${Math.round(item.frequency * 5)} of 5 runs` : item.frequency ? "Included" : "Excluded"}"><span>${String(index + 1).padStart(2, "0")}</span><strong>${esc(item.feature)}</strong></div>`).join("")}</div>`;
}
function renderFrequency() {
  const summary = state.benchmark?.summaries.find(
    (s) => s.algorithm === $("frequency-method").value,
  );
  $("frequency-chart").innerHTML = (summary?.feature_selection_frequency || [])
    .map(
      (r) =>
        `<div class="bar-row"><span>${esc(r.feature)}</span><div class="bar"><i style="width:${r.frequency * 100}%"></i></div><span>${pct(r.frequency)}</span></div>`,
    )
    .join("");
}
async function reloadSaved() {
  const settled = await Promise.allSettled([
    api("/api/models"),
    api("/api/results"),
  ]);
  if (settled[0].status === "fulfilled") {
    state.models = settled[0].value.models;
    renderSaved();
  } else {
  }
  if (settled[1].status === "fulfilled") {
    state.benchmark = settled[1].value.results.find(
      (r) => r.result_id === "experiment_31e9b36582044da995b33f1b20eb6c92",
    )?.result;
    renderBenchmark();
  } else {
    errorAt("frequency-chart", settled[1].reason);
    $("overview-summary").textContent = "The recorded study could not be loaded. Check the backend and refresh.";
  }
}
async function refreshDetector(full = false) {
  if (state.refreshing) return;
  state.refreshing = true;
  $("refresh-results").disabled = true;
  $("refresh-status").textContent = "Checking backend evaluation reports…";
  try {
    const [policy, inventory] = await Promise.all([api("/api/default-detector"), api("/api/models")]);
    const changed = state.policy?.model_id !== policy.model_id;
    const thresholdChanged = state.policy?.attack_threshold !== policy.attack_threshold;
    state.policy = policy;
    state.models = inventory.models;
    if (changed || thresholdChanged) $("threshold").value = policy.attack_threshold;
    if ($("saved-threshold")) $("saved-threshold").textContent = policy.attack_threshold;
    if (changed) {
      pauseReplay();
      $("replay-reset").click();
      state.challenge = null;
      $("guess-normal").disabled = $("guess-attack").disabled = true;
      $("challenge-values").innerHTML = "";
      $("challenge-output").textContent = "Detector changed. Start a new challenge.";
      for (const target of ["manual", "whatif"]) $(target + "-output").textContent = "Detector updated. Submit again for a new prediction.";
      $("threshold-output").innerHTML = "";
    }
    if (!policy.available && state.replay.running) pauseReplay();
    document.querySelectorAll("[data-detector]").forEach(b => {
      b.disabled = !policy.available || (b.id === "replay-start" && state.replay.running);
    });
    const used = new Set(currentModel()?.selected_features || []);
    for (const target of ["manual", "whatif"]) (target === "manual"
      ? [$("manual-fields"), $("manual-extra-fields")]
      : [$("whatif-fields")]).forEach(container => container.querySelectorAll("input").forEach(input => {
      input.parentElement.classList.toggle("used", used.has(input.name));
      if (target !== "manual") input.parentElement.firstChild.textContent = input.name + (used.has(input.name) ? " • used" : "");
    }));
    renderDetectorStatus();
    renderSaved();
    if (full) await reloadSaved();
    $("refresh-status").textContent = `Backend reports checked at ${new Date().toLocaleTimeString()} · automatic check every 30 seconds.`;
  } catch (e) {
    $("refresh-status").textContent = `Refresh failed: ${e.message}. Displayed reports may be stale.`;
  } finally {
    state.refreshing = false;
    $("refresh-results").disabled = false;
  }
}
function buildControls() {
  const controls = [
    ["population", "Population / particles", 12, 4, 100, 1],
    ["iterations", "Iterations", 10, 1, 100, 1],
    ["seed", "Random seed", 1, 0, 2147483647, 1],
    ["min_features", "Minimum features", 5, 1, 41, 1],
    ["max_features", "Maximum features", 25, 1, 41, 1],
    ["min_attack_recall", "Minimum attack recall (0–1)", 0.95, 0, 1, 0.01],
    ["max_false_alarm_rate", "Maximum false alarms (0–1)", 0.05, 0, 1, 0.01],
    ["train_rows", "Search training rows", 5000, 200, 100778, 1],
    ["validation_rows", "Validation rows", 2000, 100, 25195, 1],
    ["patience", "Patience (0 = disabled)", 5, 0, 100, 1],
  ];
  const html = (items) =>
    items
      .map(
        ([name, label, value, min, max, step]) =>
          `<label>${label}<input name="${name}" type="number" value="${value}" min="${min}" max="${max}" step="${step}" required></label>`,
      )
      .join("");
  $("quick-controls").innerHTML = html(controls.slice(0, 3));
  $("search-controls").innerHTML = html(controls.slice(3));
  $("ga-controls").innerHTML = html([
    ["mutation_rate", "Mutation rate", 0.02439, 0, 1, 0.00001],
    ["crossover_rate", "Crossover rate", 0.8, 0, 1, 0.01],
  ]);
  $("pso-controls").innerHTML = html([
    ["inertia", "Inertia", 0.7, 0, 1, 0.01],
    ["cognitive", "Cognitive coefficient", 1.5, 0, 4, 0.1],
    ["social", "Social coefficient", 1.5, 0, 4, 0.1],
  ]);
}
function renderMask() {
  $("feature-grid").innerHTML = state.features
    .map(
      (name, i) =>
        `<button type="button" data-feature="${i}" aria-pressed="${!!state.mask[i]}">${String(i + 1).padStart(2, "0")} ${esc(name)}</button>`,
    )
    .join("");
  $("mask-count").textContent = `${state.mask.reduce((a, b) => a + b, 0)} / 41`;
  $("mask-list").innerHTML = state.masks
    .map(
      (mask, i) =>
        `<div class="actions"><code>${mask.join("")}</code><button type="button" data-remove-mask="${i}">Remove</button></div>`,
    )
    .join("");
}
function config() {
  const out = {};
  for (const id of [
    "quick-controls",
    "search-controls",
    $("algorithm").value === "ga" ? "ga-controls" : "pso-controls",
  ])
    $(id)
      .querySelectorAll("input")
      .forEach((i) => {
        if (!i.reportValidity()) throw Error(`Invalid ${i.name}`);
        out[i.name] = Number(i.value);
      });
  if (out.min_features > out.max_features)
    throw Error("Minimum features must not exceed maximum.");
  if (state.masks.length > out.population)
    throw Error("Initial masks exceed population size.");
  for (const mask of state.masks) {
    const n = mask.reduce((a, b) => a + b, 0);
    if (n < out.min_features || n > out.max_features)
      throw Error("Initial mask violates feature-count bounds.");
  }
  return out;
}
function busyJob(busy) {
  state.jobActive = busy;
  $("run-search").disabled = busy;
  $("cancel-job").disabled = !busy;
  $("finalize-job").disabled = busy;
}
function watchJob(id, kind) {
  state.job = id;
  state.jobKind = kind;
  try {
    sessionStorage.setItem(
      "sentinel-job",
      JSON.stringify({ id, kind, searchJob: state.searchJob }),
    );
  } catch {}
  busyJob(true);
  $("finalize-job").hidden = true;
  clearTimeout(state.poll);
  pollJob();
}
async function pollJob() {
  state.poll = null;
  let again = false;
  try {
    const r = await api(`/api/status/${state.job}`);
    $("search-error").innerHTML = "";
    $("job-state").textContent =
      `${state.jobKind === "search" ? "Search" : "Final training"} · ${r.status} · ${r.progress?.stage || ""} ${r.progress?.latest ? `· iteration ${r.progress.latest.iteration}` : ""}`;
    const history = r.history?.length ? r.history : r.result?.history || [];
    if (state.jobKind === "search") {
      chart(
        "fitness-chart",
        history,
        [
          {
            key: "best_fitness",
            name: "Best fitness (lower is better)",
            color: "#087c72",
          },
          { key: "mean_fitness", name: "Mean fitness", color: "#819793" },
        ],
        "iteration",
        "Validation fitness",
      );
      chart(
        "validation-chart",
        history,
        [
          { key: "validation_accuracy", name: "Accuracy", color: "#087c72" },
          { key: "attack_recall", name: "Attack recall", color: "#3766b7" },
          { key: "false_alarm_rate", name: "False alarms", color: "#b83f43" },
        ],
        "iteration",
        "Validation ratios",
      );
      const latest = r.progress?.latest || history.at(-1),
        m = r.result?.validation_metrics;
      if (m || latest) {
        $("job-metrics").innerHTML = metricCards(
          m || {
            accuracy: latest.validation_accuracy,
            recall: latest.attack_recall,
            f1: latest.validation_f1,
            false_alarm_rate: latest.false_alarm_rate,
          },
          r.result?.feature_count ?? latest.feature_count,
        );
        $("selected-search").innerHTML =
          `<h4>${r.status === "completed" ? "Final search subset" : "Current best subset"}</h4>${chips(r.result?.selected_features || state.features.filter((_, i) => latest?.best_mask[i]))}<p class="note">Constraint feasibility: ${esc(m?.security_feasible ?? latest?.security_feasible)} · Validation metrics, not test results.</p>`;
      }
    }
    if (["queued", "running"].includes(r.status)) {
      again = true;
    } else {
      busyJob(false);
      try {
        sessionStorage.removeItem("sentinel-job");
      } catch {}
      if (r.status === "completed" && state.jobKind === "search") {
        state.searchJob = state.job;
        $("finalize-job").hidden = false;
      }
      if (r.status === "completed" && state.jobKind === "finalize") {
        const records = r.result?.records || [];
        $("final-output").innerHTML =
          "<h4>Final trained model · test evaluation</h4>" +
          table(
            ["Model", "Accuracy", "Recall", "F1", "False alarms"],
            records.map((m) => [
              m.model_id,
              pct(m.test_metrics.accuracy),
              pct(m.test_metrics.recall),
              pct(m.test_metrics.f1),
              pct(m.test_metrics.false_alarm_rate),
            ]),
          );
        await reloadSaved();
      }
      if (r.error) errorAt("search-error", r.error);
    }
  } catch (e) {
    errorAt("search-error", e);
    if (e.status === 404) {
      $("job-state").textContent =
        "Job unavailable. Server restarts clear active jobs; saved reports remain available.";
      state.job = null;
      busyJob(false);
      try {
        sessionStorage.removeItem("sentinel-job");
      } catch {}
    } else {
      $("job-state").textContent =
        "Status unavailable. Retrying in one second; cancel is still available.";
      again = true;
    }
  }
  if (again) state.poll = setTimeout(pollJob, 1000);
}
function pauseReplay() {
  const r = state.replay;
  r.running = false;
  clearTimeout(r.timer);
  $("replay-pause").disabled = true;
  $("replay-start").disabled = !state.policy?.available;
  $("replay-start").textContent = "Resume";
}
async function replayStep() {
  const r = state.replay;
  if (!r.running || r.busy) return;
  const epoch = r.epoch;
  try {
    if (!r.buffer.length) {
      if (r.next === null) {
        pauseReplay();
        $("replay-start").disabled = true;
        $("replay-error").textContent = "End of recorded test traffic.";
        return;
      }
      r.busy = true;
      const response = await api("/api/replay", {
        model_id: detector(),
        start: r.next,
        count: 20,
      });
      if (epoch !== r.epoch) return;
      r.buffer = response.predictions;
      r.next = response.next_start;
      $("replay-error").innerHTML = warnings(response.warnings);
      r.busy = false;
    }
    if (!r.running) return;
    const p = r.buffer.shift();
    r.total++;
    if (p.label === "attack") r.attacks++;
    if (p.correct) r.correct++;
    $("replay-count").textContent =
      `${r.total} connections · ${r.attacks} attacks · ${r.correct} correct`;
    $("replay-output").insertAdjacentHTML(
      "afterbegin",
      `<div class="notice"><b class="${esc(p.label)}">${esc(p.label.toUpperCase())}</b> · row ${p.test_row} · attack score ${pct(p.attack_score)}<br><small>True label: ${esc(p.actual_label)} · ${p.correct ? "Correct" : "Mismatch"}</small></div>`,
    );
    while ($("replay-output").children.length > 40)
      $("replay-output").lastElementChild.remove();
  } catch (e) {
    errorAt("replay-error", e);
    pauseReplay();
  } finally {
    if (epoch === r.epoch) {
      r.busy = false;
      if (r.running)
        r.timer = setTimeout(replayStep, Number($("replay-speed").value));
    }
  }
}
function bind() {
  $("overview-method").onchange = renderOverview;
  $("overview-run").onclick = () => $("tab-optimization").click();
  $("overview-evidence").onclick = () => $("tab-evidence").click();
  $("overview-demo").onclick = () => $("tab-detection").click();
  $("see-search").onclick = () => $("tab-optimization").click();
  $("refresh-results").onclick = () => refreshDetector(true);
  document.querySelectorAll("[data-tab]").forEach((b, index) => {
    b.onkeydown = (e) => {
      const tabs = [...document.querySelectorAll("[data-tab]")];
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        const next =
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? tabs.length - 1
              : (index + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) %
                tabs.length;
        tabs[next].focus();
        tabs[next].click();
      }
    };
    b.onclick = () => {
      document.querySelectorAll("[data-tab]").forEach((t) => {
        const selected = t === b;
        t.setAttribute("aria-selected", selected);
        $(t.dataset.tab).hidden = !selected;
      });
      if (b.dataset.tab === "evidence") refreshDetector(true);
    };
  });
  document
    .querySelectorAll("[data-sample]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          action(b, b.dataset.target + "-output", () =>
            sample(b.dataset.target, b.dataset.sample),
          )),
    );
  $("manual-form").onsubmit = (e) => {
    e.preventDefault();
    action(e.submitter, "manual-output", async () => {
      if (!$("threshold").reportValidity())
        throw Error("Threshold must be 0.001–0.999.");
      const edited = readFields("manual");
      const original = state.samples.manual;
      if (!original) throw Error("Choose a recorded connection first.");
      const changed = Object.keys(edited).filter(name => edited[name] !== original[name]);
      const response = await api("/api/classify", {
        model_id: detector(),
        connections: changed.length ? [original, edited] : [edited],
        threshold: Number($("threshold").value),
      });
      $("manual-output").innerHTML = detectionResult(response, changed);
    });
  };
  $("replay-start").onclick = () => {
    state.replay.running = true;
    $("replay-start").disabled = true;
    $("replay-pause").disabled = false;
    replayStep();
  };
  $("replay-pause").onclick = pauseReplay;
  $("replay-reset").onclick = () => {
    pauseReplay();
    Object.assign(state.replay, {
      next: 0,
      buffer: [],
      total: 0,
      attacks: 0,
      correct: 0,
      busy: false,
      epoch: state.replay.epoch + 1,
    });
    $("replay-start").textContent = "Start";
    $("replay-output").innerHTML = "";
    $("replay-error").innerHTML = "";
    $("replay-count").textContent = "0 connections · 0 attacks · 0 correct";
  };
  $("algorithm").onchange = () => {
    const ga = $("algorithm").value === "ga";
    $("ga-controls").hidden = !ga;
    $("pso-controls").hidden = ga;
  };
  $("feature-grid").onclick = (e) => {
    const b = e.target.closest("[data-feature]");
    if (b) {
      const i = Number(b.dataset.feature);
      state.mask[i] = 1 - state.mask[i];
      renderMask();
    }
  };
  $("clear-mask").onclick = () => {
    state.mask.fill(0);
    renderMask();
  };
  $("add-mask").onclick = () => {
    try {
      const c = config(),
        n = state.mask.reduce((a, b) => a + b, 0);
      if (n < c.min_features || n > c.max_features)
        throw Error(
          `Mask must select ${c.min_features}–${c.max_features} inputs.`,
        );
      if (state.masks.length >= c.population)
        throw Error("Population is already filled.");
      state.masks.push([...state.mask]);
      renderMask();
      $("search-error").innerHTML = "";
    } catch (e) {
      errorAt("search-error", e);
    }
  };
  $("mask-list").onclick = (e) => {
    const b = e.target.closest("[data-remove-mask]");
    if (b) {
      state.masks.splice(Number(b.dataset.removeMask), 1);
      renderMask();
    }
  };
  $("search-form").onsubmit = (e) => {
    e.preventDefault();
    action(e.submitter, "search-error", async () => {
      const r = await api("/api/run", {
        kind: "search",
        algorithm: $("algorithm").value,
        config: config(),
        initial_masks: state.masks,
      });
      $("search-error").innerHTML = "";
      $("final-output").innerHTML = "";
      state.searchJob = null;
      watchJob(r.job_id, "search");
    }).finally(() => busyJob(state.jobActive));
  };
  $("cancel-job").onclick = (e) =>
    action(e.target, "search-error", async () => {
      $("search-error").textContent = (
        await api(`/api/cancel/${state.job}`, {})
      ).cancellation_requested
        ? "Cancellation requested; waiting for the backend."
        : "Cancellation response received.";
    });
  $("finalize-job").onclick = (e) =>
    action(e.target, "search-error", async () => {
      const r = await api(`/api/finalize/${state.searchJob}`, {});
      $("search-error").innerHTML = "";
      watchJob(r.job_id, "finalize");
    });
  for (const mode of ["whatif", "challenge"])
    $("mode-" + mode).onclick = () => {
      for (const m of ["whatif", "challenge"]) {
        $(m + "-panel").hidden = m !== mode;
        $("mode-" + m).setAttribute("aria-pressed", m === mode);
      }
    };
  $("whatif-form").onsubmit = (e) => {
    e.preventDefault();
    action(e.submitter, "whatif-output", async () => {
      const base = state.samples.whatif;
      if (!base) throw Error("Load a real example first.");
      const edited = readFields("whatif"),
        changes = Object.fromEntries(
          Object.entries(edited).filter(([k, v]) => v !== base[k]),
        );
      const r = await api("/api/what-if", {
        model_ids: [detector()],
        connection: base,
        changes,
      });
      $("whatif-output").innerHTML =
        r.comparisons
          .map(
            (c) =>
              table(
                ["Scenario", "Prediction", "Attack score"],
                [
                  ["Original", c.original.label, pct(c.original.attack_score)],
                  [
                    "Synthetic modified",
                    c.modified.label,
                    pct(c.modified.attack_score),
                  ],
                ],
              ) +
              `<p>Score change: ${pct(c.attack_score_change)} · Label changed: ${esc(c.label_changed)}</p><h4>Changed inputs the model uses</h4>${c.used_changed_features.length ? chips(c.used_changed_features) : "<p>None</p>"}<h4>Changed inputs ignored by the model</h4>${c.ignored_changed_features.length ? chips(c.ignored_changed_features) : "<p>None</p>"}${warnings(c.warnings)}`,
          )
          .join("") + `<p class="note">${esc(r.note)}</p>`;
    });
  };
  $("new-challenge").onclick = (e) =>
    action(e.target, "challenge-output", async () => {
      state.challenge = null;
      $("guess-normal").disabled = $("guess-attack").disabled = true;
      $("challenge-values").innerHTML = "";
      const r = await api("/api/challenge", { model_id: detector() });
      state.challenge = r.challenge_id;
      $("challenge-values").innerHTML = table(
        ["Selected input", "Value"],
        (currentModel()?.selected_features || []).map((f) => [
          f,
          r.connection[f],
        ]),
      );
      $("challenge-output").textContent = r.instruction;
      $("guess-normal").disabled = $("guess-attack").disabled = false;
    });
  for (const guess of ["normal", "attack"])
    $("guess-" + guess).onclick = (e) => {
      const id = state.challenge;
      $("new-challenge").disabled = true;
      $("guess-normal").disabled = $("guess-attack").disabled = true;
      action(e.target, "challenge-output", async () => {
        if (!id) throw Error("Start a new challenge.");
        const r = await api(`/api/challenge/${id}/answer`, { answer: guess });
        state.challenge = null;
        state.score.total++;
        if (r.correct) state.score.correct++;
        $("challenge-score").textContent =
          `Your score: ${state.score.correct} / ${state.score.total}`;
        $("challenge-output").innerHTML =
          `<div class="notice ${r.correct ? "" : "error"}">${r.correct ? "Correct guess" : "Incorrect guess"} · ${esc(r.outcome)}</div>${table(["True label", "Attack type", "Your guess", "Model answer", "Model attack score"], [[r.actual_label, r.attack_type, r.your_answer, r.machine.label, pct(r.machine.attack_score)]])}<p class="note">${esc(r.note)}</p>`;
      }).finally(() => {
        $("new-challenge").disabled = !state.policy?.available;
        $("guess-normal").disabled = $("guess-attack").disabled =
          !state.challenge;
      });
    };
  $("export-csv").onclick = async (e) => {
    e.preventDefault();
    const link = e.currentTarget,
      text = link.textContent;
    link.textContent = "Exporting…";
    try {
      const response = await fetch("/api/export");
      if (!response.ok) {
        let message = `Export failed (${response.status})`;
        try {
          message = (await response.json()).error || message;
        } catch {}
        throw Error(message);
      }
      const url = URL.createObjectURL(await response.blob()),
        download = document.createElement("a");
      download.href = url;
      download.download = "nids_comparison.csv";
      download.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      errorAt("global-error", err);
      $("global-error").hidden = false;
    } finally {
      link.textContent = text;
    }
  };
  $("frequency-method").onchange = renderFrequency;
  $("load-thresholds").onclick = (e) =>
    action(e.target, "threshold-output", async () => {
      const r = await api(`/api/thresholds/${detector()}`);
      $("threshold-output").innerHTML =
        '<div id="threshold-chart"></div>' +
        table(
          ["Threshold", "Accuracy", "Attack recall", "False-alarm rate"],
          r.rows.map((row) => [
            row.threshold.toFixed(3),
            pct(row.accuracy),
            pct(row.recall),
            pct(row.false_alarm_rate),
          ]),
        ) +
        `<p class="note">${esc(r.note)}</p>`;
      chart(
        "threshold-chart",
        r.rows,
        [
          { key: "recall", name: "Attack recall", color: "#087c72" },
          { key: "false_alarm_rate", name: "False alarms", color: "#b83f43" },
        ],
        "threshold",
        "Test-set threshold tradeoffs",
      );
    });
}
async function bootstrap() {
  buildControls();
  bind();
  document
    .querySelectorAll("[data-detector]")
    .forEach((b) => (b.disabled = true));
  const results = await Promise.allSettled([
    api("/api/default-detector"),
    api("/api/dataset"),
    reloadSaved(),
  ]);
  if (results[0].status === "fulfilled") {
    state.policy = results[0].value;
    $("threshold").value = state.policy.attack_threshold ?? 0.01;
    renderDetectorStatus();
  } else {
    errorAt("global-error", results[0].reason);
    $("global-error").hidden = false;
    $("backend-status").textContent = "Backend error";
  }
  if (results[1].status === "fulfilled") {
    state.features = results[1].value.feature_names;
    renderMask();
    await Promise.allSettled(
      ["manual", "whatif"].map(async (target) => {
        try {
          await sample(target, "normal");
        } catch (e) {
          errorAt(target + "-fields", e);
        }
      }),
    );
  } else {
    errorAt("manual-fields", results[1].reason);
    errorAt("search-error", results[1].reason);
    $("run-search").disabled = true;
  }
  renderSaved();
  if ($("saved-threshold") && state.policy) $("saved-threshold").textContent = state.policy.attack_threshold;
  setInterval(() => { if (!document.hidden) refreshDetector(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshDetector(); });
  document
    .querySelectorAll("[data-detector]")
    .forEach((b) => (b.disabled = !state.policy?.available));
  try {
    const saved = JSON.parse(sessionStorage.getItem("sentinel-job") || "null");
    if (saved) {
      state.searchJob = saved.searchJob;
      watchJob(saved.id, saved.kind);
    }
  } catch {}
}
bootstrap().catch((e) => {
  errorAt("global-error", e);
  $("global-error").hidden = false;
});
