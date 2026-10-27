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
  rows.replaceChildren = () => { rows.rows = []; };
  rows.insertRow = () => {
    const row = {
      cells: [], scrollIntoView() {},
      insertCell() { const cell = { textContent: '' }; this.cells.push(cell); return cell; },
    };
    rows.rows.push(row);
    return row;
  };
  const headers = [...html.matchAll(/<th>(.*?)<\/th>/g)].map((match) => ({ textContent: match[1] }));
  let copied, download;
  const context = vm.createContext({
    document: {
      querySelector: get,
      querySelectorAll: (selector) => selector === 'thead th' ? headers : [],
      createElement: () => ({ click() { download.name = this.download; download.url = this.href; } }),
    },
    Blob,
    URL: { createObjectURL(blob) { download = { blob }; return 'blob:csv'; }, revokeObjectURL() {} },
    window: { confirm: () => true },
    localStorage: { getItem: (key) => key === 'travelDirection' ? direction : null, setItem() {} },
    navigator: { clipboard: { async writeText(value) { copied = value; } } },
    console, setTimeout() {},
  });
  vm.runInContext(source, context);
  return { get, rows, context, copied: () => copied, download: () => download };
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
  assert.equal(cells.length, 16);
  vm.runInContext("selectDirection('both', false)", p.context);
  assert.equal(p.get('#vertical').disabled, true);
  assert.equal(p.get('#vertical').checked, false);
  assert.equal(p.get('#velocity').textContent, '10.000');
  assert.equal(cells[1].textContent, '3.000');
  p.get('#save-points').checked = false;
  p.get('#save').click();
  assert.equal(p.rows.rows[1].cells[3].textContent, 'No');
  assert.ok(p.rows.rows[1].cells.slice(4, 15).every((cell) => cell.textContent === ''));
  await p.get('#copy').click();
  assert.match(p.copied(), /Notes\tVertical\tSpacing \(mm\)/);
  assert.match(p.copied(), /3\.000\t\tYes\t50\t/);
  const both = page('both');
  assert.equal(both.get('#vertical').disabled, true);
});

test('full and partial up/down recordings flow through fit, plot and export', async () => {
  const records = [];
  for (const direction of [1, -1]) {
    for (let count = 2; count <= 5; count++) {
      const speed = Math.sqrt(2 * 9.80665 * (count - 0.5) * 0.05);
      const up = [], down = [];
      for (let i = 0; i < count; i++) {
        const root = Math.sqrt(speed ** 2 - 2 * 9.80665 * i * 0.05);
        const tick = (time) => (4294966295 + Math.round(time * 80000000)) >>> 0;
        up.push(tick((speed - root) / 9.80665));
        down.unshift(tick((speed + root) / 9.80665));
      }
      records.push(`TRAJECTORY expected_mps=${speed} direction=${direction} spacing_mm=50 up=${up} down=${down}`);
    }
  }
  for (const record of records) {
    const p = page(record.includes('direction=-1') ? '51' : '15');
    p.get('#vertical').checked = true;
    p.get('#vertical').change();
    assert.equal(p.get('#up-down').disabled, false);
    p.get('#up-down').checked = true;
    p.get('#up-down').change();
    vm.runInContext(`handleLine(${JSON.stringify(record)})`, p.context);
    const reading = vm.runInContext('currentReading', p.context);
    const expected = Number(record.match(/expected_mps=(\S+)/)[1]);
    assert.ok(Math.abs(reading.velocity - expected) < 1e-6, `${record}: ${reading.velocity}`);
    assert.equal(reading.times.length, reading.positions.length);
    const plot = p.get('#plot').innerHTML;
    assert.equal([...plot.matchAll(/class="plot-point"/g)].length, reading.times.length);
    assert.doesNotMatch(plot, /NaN|Infinity/);
    const first = record.includes('direction=-1') ? 5 : 1;
    assert.match(plot, new RegExp(`Sensor ${first}: 0 ms, 0 mm`));
    p.get('#save').click();
    const cells = p.rows.rows[0].cells;
    assert.equal(cells[3].textContent, 'Up & down');
    assert.equal(cells.slice(5, 15).filter((cell) => cell.textContent !== '').length, reading.times.length);
    await p.get('#copy').click();
    assert.match(p.copied(), /Return 1 \(ms\)/);
    vm.runInContext("selectDirection('both', false)", p.context);
    assert.equal(p.get('#up-down').disabled, true);
    assert.equal(p.get('#up-down').checked, false);
    assert.equal(p.get('#velocity').textContent, expected.toFixed(3));
  }
});

test('up/down fit estimates time offset and uses every timestamp', () => {
  const p = page();
  const positions = [0, 50, 100, 100, 50, 0];
  const descending = [false, false, false, true, true, true];
  const speed = 1.5;
  const times = positions.map((height, i) => {
    const root = Math.sqrt(speed ** 2 - 2 * 9.80665 * height / 1000);
    return 7 + 1000 * (speed + (descending[i] ? root : -root)) / 9.80665;
  });
  const fit = (values) => vm.runInContext(`fitVertical(${JSON.stringify(values)}, ${JSON.stringify(positions)}, ${JSON.stringify(descending)})`, p.context);
  const exact = fit(times);
  assert.ok(Math.abs(exact.velocity - speed) < 1e-8);
  assert.ok(Math.abs(exact.start - 0.007) < 1e-8);
  for (let i = 0; i < times.length; i++) {
    const noisy = [...times]; noisy[i] += 0.01;
    assert.ok(Math.abs(fit(noisy).velocity - speed) > 1e-7);
  }
});


test('first crossing UTC uses receipt minus passage duration and survives delayed saving', async () => {
  const received = 1793123456789;
  for (const direction of [1, -1]) {
    for (const upDown of [false, true]) {
      const p = page(direction > 0 ? '15' : '51');
      vm.runInContext(`Date.now = () => ${received}`, p.context);
      if (upDown) {
        // 100 ms round trip crossing the uint32 timer rollover.
        vm.runInContext(`handleLine('TRAJECTORY direction=${direction} spacing_mm=50 up=4294967000,1999704 down=5999704,7999704')`, p.context);
      } else {
        trial(p, direction, 3);
      }
      const reading = vm.runInContext('currentReading', p.context);
      const expected = new Date(received - Math.max(...reading.times)).toISOString();
      assert.equal(reading.firstCrossing, expected);
      if (upDown) assert.equal(expected, new Date(received - 100).toISOString());
      vm.runInContext(`Date.now = () => ${received + 60000}; updateReading()`, p.context);
      p.get('#save-points').checked = false;
      p.get('#save').click();
      assert.equal(p.rows.rows[0].cells.at(-1).textContent, expected);
      await p.get('#copy').click();
      assert.match(p.copied(), /First crossing \(UTC\)/);
      assert.ok(p.copied().endsWith(expected));
    }
  }
});


test('CSV download includes edited notes, quotes, newlines, empty cells and first crossing UTC', async () => {
  const p = page('15');
  vm.runInContext(`Date.now = () => 1700000000200;
    handleLine('VELOCITY direction=1 mps=1 ticks=0,4000000,8000000,12000000,16000000 spacing_mm=50')`, p.context);
  p.get('#save').click();
  assert.equal(p.get('#export').disabled, false);
  p.rows.rows[0].cells[2].textContent = 'sensor, "α"\nsecond line';
  p.get('#export').click();
  const download = p.download();
  assert.equal(download.name, 'beamvel.csv');
  assert.equal(download.url, 'blob:csv');
  assert.equal(download.blob.type, 'text/csv;charset=utf-8');
  const csv = await download.blob.text();
  assert.equal(csv,
    '"#","Velocity","Notes","Vertical","Spacing (mm)","Sensor 1 (ms)","Sensor 2 (ms)","Sensor 3 (ms)","Sensor 4 (ms)","Sensor 5 (ms)","Return 1 (ms)","Return 2 (ms)","Return 3 (ms)","Return 4 (ms)","Return 5 (ms)","First crossing (UTC)"\r\n'
    + '"1","1.000","sensor, ""α""\nsecond line","No","50","0","50","100","150","200","","","","","","2023-11-14T22:13:20.000Z"\r\n');
  p.get('#clear').click();
  assert.equal(p.rows.rows.length, 0);
  assert.equal(p.get('#export').disabled, true);
});
