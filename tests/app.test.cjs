const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

function page(direction = '51') {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: '50', checked: id === '#save-points', textContent: '',
      classList: { toggle() {} },
      addEventListener(event, handler) { this[event] = handler; },
      setAttribute(name, value) { this[name] = value; },
    });
    return elements.get(id);
  };
  const rows = get('#trial-rows');
  rows.rows = [];
  rows.insertRow = () => {
    const row = {
      cells: [], scrollIntoView() {},
      insertCell() { const cell = { textContent: '' }; this.cells.push(cell); return cell; },
    };
    rows.rows.push(row);
    return row;
  };
  const headers = [...html.matchAll(/<th>(.*?)<\/th>/g)].map((match) => ({ textContent: match[1] }));
  let copied;
  const context = vm.createContext({
    document: { querySelector: get, querySelectorAll: (selector) => selector === 'thead th' ? headers : [] },
    localStorage: { getItem: (key) => key === 'travelDirection' ? direction : null, setItem() {} },
    navigator: { clipboard: { async writeText(value) { copied = value; } } },
    console, setTimeout() {},
  });
  vm.runInContext(source, context);
  return { get, rows, context, copied: () => copied };
}

function trial(page, direction, speed, spacing = 50) {
  const times = Array.from({ length: 5 }, (_, i) => {
    const height = i * spacing / 1000;
    return 2 * height / (speed + Math.sqrt(speed ** 2 - 2 * 9.80665 * height));
  });
  // Exercise uint32 rollover, using the actual 80 MHz capture resolution.
  const ticks = times.map((time) => (4294900000 + Math.round(time * 80000000)) >>> 0);
  if (direction === -1) ticks.reverse();
  vm.runInContext(`handleLine('VELOCITY direction=${direction} mps=${direction * 10} ticks=${ticks.join(',')} spacing_mm=${spacing}')`, page.context);
}

test('vertical fit recovers first-sensor speed in either direction, including near the apex', () => {
  for (const direction of [1, -1]) {
    for (const speed of [2, 3, 20, 100, 1000]) {
      const p = page(direction === 1 ? '15' : '51');
      p.get('#vertical').checked = true;
      trial(p, direction, speed);
      const fitted = vm.runInContext('currentReading.velocity', p.context);
      assert.ok(Math.abs(fitted - speed) < Math.max(0.0001, speed * 0.0001), `${speed}: ${fitted}`);
      assert.match(p.get('#plot').innerHTML, /<path class="plot-fit"/);
      assert.match(p.get('#plot')['aria-label'], /first-sensor velocity/);
      assert.match(p.get('#plot').innerHTML, new RegExp(`Sensor ${direction === 1 ? 1 : 5}: 0 ms, 0 mm`));
      assert.doesNotMatch(p.get('#plot').innerHTML, /NaN|Infinity/);
    }
  }
});

test('fit uses all timestamps and estimates the first crossing time', () => {
  const p = page();
  const positions = [0, 50, 100, 150, 200];
  const times = positions.map((x) => 1000 * 2 * (x / 1000) / (3 + Math.sqrt(9 - 2 * 9.80665 * x / 1000)));
  const fit = (values) => vm.runInContext(`fitVertical(${JSON.stringify(values)}, ${JSON.stringify(positions)})`, p.context);
  const exact = fit(times);
  assert.ok(Math.abs(exact.velocity - 3) < 1e-10);
  const shifted = fit(times.map((t) => t + 7));
  assert.ok(Math.abs(shifted.velocity - 3) < 1e-10);
  assert.ok(Math.abs(shifted.start - 0.007) < 1e-10);
  for (let i = 0; i < 5; i++) {
    const noisy = [...times]; noisy[i] += 0.01;
    assert.ok(Math.abs(fit(noisy).velocity - 3) > 1e-7);
  }
});

test('mode changes recalculate the reading, Both disables vertical, saved modes remain unchanged', async () => {
  const p = page();
  trial(p, -1, 3);
  assert.equal(p.get('#velocity').textContent, '10.000');
  p.get('#vertical').checked = true;
  p.get('#vertical').change();
  assert.equal(p.get('#velocity').textContent, '3.000');
  p.get('#save').click();
  const cells = p.rows.rows[0].cells;
  assert.equal(cells[2].className, 'notes');
  assert.equal(cells[3].textContent, 'Yes');
  assert.equal(cells[4].textContent, '50');
  assert.equal(cells.length, 10);
  vm.runInContext("selectDirection('both', false)", p.context);
  assert.equal(p.get('#vertical').disabled, true);
  assert.equal(p.get('#vertical').checked, false);
  assert.equal(p.get('#velocity').textContent, '10.000');
  assert.equal(cells[1].textContent, '3.000');
  p.get('#save-points').checked = false;
  p.get('#save').click();
  assert.equal(p.rows.rows[1].cells[3].textContent, 'No');
  assert.ok(p.rows.rows[1].cells.slice(4).every((cell) => cell.textContent === ''));
  await p.get('#copy').click();
  assert.match(p.copied(), /Notes\tVertical\tSpacing \(mm\)/);
  assert.match(p.copied(), /3\.000\t\tYes\t50\t/);
  const both = page('both');
  assert.equal(both.get('#vertical').disabled, true);
});
