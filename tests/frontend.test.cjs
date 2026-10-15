const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const markup = fs.readFileSync('templates/index.html', 'utf8');
const script = fs.readFileSync('static/app.js', 'utf8');
const report = JSON.parse(fs.readFileSync('results/experiment_31e9b36582044da995b33f1b20eb6c92.json', 'utf8'));
const nodes = new Map();
const element = id => {
  if (!nodes.has(id)) nodes.set(id, {
    value: '', innerHTML: '', textContent: '',
    querySelectorAll(selector) {
      if (selector !== 'input') return [];
      return [...this.innerHTML.matchAll(/<input name="([^"]+)"[^>]*value="([^"]+)"/g)]
        .map(([, name, value]) => ({ name, value, reportValidity: () => true }));
    },
  });
  return nodes.get(id);
};
const context = vm.createContext({ document: { getElementById: element }, console });
vm.runInContext(script.split('\nbootstrap().catch')[0], context);

test('navigation panels, primary controls and optional tools are present', () => {
  for (const id of ['overview', 'optimization', 'detection', 'evidence', 'overview-method', 'quick-controls', 'manual-form', 'whatif-panel', 'challenge-panel']) {
    assert.match(markup, new RegExp(`id="${id}"`));
  }
  for (const id of ['overview', 'optimization', 'detection', 'evidence']) {
    assert.match(markup, new RegExp(`data-tab="${id}"`));
  }
  assert.match(markup, /id="overview"[^>]*aria-labelledby="tab-overview"/);
  assert.ok(markup.indexOf('id="overview"') < markup.indexOf('class="intro"'));
  assert.ok(markup.indexOf('class="intro"') < markup.indexOf('id="detection"'));
  assert.doesNotMatch(markup, /id="csv-form"/);
  assert.doesNotMatch(markup, /Original five-seed benchmark/);
  assert.doesNotMatch(markup, /id="benchmark"/);
  assert.match(markup, /results\/experiment_31e9b36582044da995b33f1b20eb6c92\.json/);
});

test('overview uses recorded feature frequencies without promoting evaluation scores', () => {
  context.report = report;
  vm.runInContext('state.benchmark = report', context);
  for (const method of ['ga', 'pso', 'full', 'chi_square']) {
    element('overview-method').value = method;
    vm.runInContext('renderOverview()', context);
    const row = report.summaries.find(s => s.algorithm === method);
    assert.equal((element('overview-features').innerHTML.match(/class="feature-tile /g) || []).length, 41);
    assert.ok(element('overview-features').innerHTML.includes(row.feature_selection_frequency[0].feature));
    assert.ok(!element('overview-summary').innerHTML.includes(`${(row.metrics.accuracy.mean * 100).toFixed(2)}%`));
  }
});

test('quick search controls and advanced controls produce a complete search configuration', () => {
  vm.runInContext('buildControls()', context);
  element('algorithm').value = 'ga';
  const ga = vm.runInContext('config()', context);
  assert.equal(ga.population, 12);
  assert.equal(ga.iterations, 10);
  assert.equal(ga.train_rows, 5000);
  assert.equal(ga.mutation_rate, 0.02439);
  element('algorithm').value = 'pso';
  const pso = vm.runInContext('config()', context);
  assert.equal(pso.population, 12);
  assert.equal(pso.inertia, 0.7);
});

test('matching retrained and historical scores display once with provenance', () => {
  context.demoPolicy = {
    available: true,
    model_id: 'local-demo',
    historical_available: false,
    provenance: 'locally_retrained_demo',
    attack_threshold: 0.01,
    historical_expected_test_metrics: {
      accuracy: 0.9247249822569198, recall: 0.9451414322449934,
      false_alarm_rate: 0.10225517454433117, f1: 0.9346176073974186,
    },
    historical_validation_calibration: { feature_count: 11 },
  };
  context.localModels = [{model_id: 'local-demo', test_metrics: {...context.demoPolicy.historical_expected_test_metrics}}];
  vm.runInContext('state.models = localModels; state.policy = demoPolicy; renderDetectorStatus()', context);
  assert.match(element('historical-note').textContent, /artifact unavailable/);
  assert.match(element('historical-metrics').innerHTML, /92\.47%/);
  assert.match(element('historical-metrics').innerHTML, /10\.23%/);
  assert.match(element('evidence-title').textContent, /retrained/);
  assert.equal(element('historical-card').hidden, true);
  assert.equal(element('matching-report-note').hidden, false);
  assert.match(element('matching-report-note').textContent, /separate saved model/);
  context.differentModels = [{model_id: 'local-demo', test_metrics: {...context.demoPolicy.historical_expected_test_metrics, accuracy: 0.8}}];
  vm.runInContext('state.models = differentModels; renderDetectorStatus()', context);
  assert.equal(element('historical-card').hidden, false);
  assert.equal(element('matching-report-note').hidden, true);
});
