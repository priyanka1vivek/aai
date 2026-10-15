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
});

test('overview reads the recorded comparison and distinguishes run averages from examples', () => {
  context.report = report;
  vm.runInContext('state.benchmark = report', context);
  for (const method of ['ga', 'pso', 'full', 'chi_square']) {
    element('overview-method').value = method;
    vm.runInContext('renderOverview()', context);
    const row = report.summaries.find(s => s.algorithm === method);
    assert.ok(element('overview-summary').innerHTML.includes(`${(row.metrics.accuracy.mean * 100).toFixed(2)}%`));
    assert.ok(element('overview-summary').innerHTML.includes(`${(row.metrics.recall.mean * 100).toFixed(2)}%`));
    assert.ok(element('overview-summary').innerHTML.includes(`${(row.metrics.false_alarm_rate.mean * 100).toFixed(2)}%`));
    assert.ok(element('overview-features').innerHTML.includes('Saved baseline') || element('overview-features').innerHTML.includes('One saved run'));
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
