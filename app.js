const BAUD_RATE = 2_000_000;
const GRAVITY = 9.80665;
const ESPRESSIF_VENDOR_ID = 0x303a;

const connectButton = document.querySelector("#connect");
const connectionLabel = document.querySelector(".connection-label");
const distanceInput = document.querySelector("#distance");
const verticalInput = document.querySelector("#vertical");
const upDownInput = document.querySelector("#up-down");
const velocityOutput = document.querySelector("#velocity");
const saveButton = document.querySelector("#save");
const copyButton = document.querySelector("#copy");
const exportButton = document.querySelector("#export");
const clearButton = document.querySelector("#clear");
const savePoints = document.querySelector("#save-points");
const trialRows = document.querySelector("#trial-rows");
const sensors = [...document.querySelectorAll(".sensor")];
const plot = document.querySelector("#plot");
const directionButtons = [...document.querySelectorAll(".direction-option")];

let port;
let reader;
let readTask;
let readBuffer = "";
let disconnecting = false;
let writeQueue = Promise.resolve();
let currentVelocity;
let currentReading;
let trialCount = 0;

const savedDistance = localStorage.getItem("spacingMm");
if (savedDistance) distanceInput.value = savedDistance;

verticalInput.checked = localStorage.getItem("vertical") === "true";

upDownInput.checked = localStorage.getItem("upDown") === "true";

let selectedDirection = localStorage.getItem("travelDirection") ?? "both";
if (!["15", "51", "both"].includes(selectedDirection)) selectedDirection = "both";

function selectDirection(direction, transmit = true) {
  selectedDirection = direction;
  localStorage.setItem("travelDirection", direction);
  directionButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.direction === direction);
  });
  verticalInput.disabled = direction === "both";
  if (verticalInput.disabled) verticalInput.checked = false;
  updateModes();
  updateReading();
  if (transmit) {
    send(`direction ${direction}`);
    send(`updown ${Number(upDownInput.checked)}`);
  }
}

function updateModes() {
  upDownInput.disabled = !verticalInput.checked || verticalInput.disabled;
  if (upDownInput.disabled) upDownInput.checked = false;
}

selectDirection(selectedDirection, false);

function setConnected(connected) {
  connectButton.classList.toggle("connected", connected);
  connectionLabel.textContent = connected ? "Disconnect" : "Connect";
}

function setSensor(index, isUnblocked) {
  const sensor = sensors[index];
  sensor.classList.toggle("unblocked", isUnblocked);
  sensor.classList.toggle("blocked", !isUnblocked);
  sensor.querySelector("strong").textContent = isUnblocked ? "Unblocked" : "Blocked";
}

// Fit arrival times, including the first timestamp's uncertainty. Positions are meters.
function fitVertical(times, positions, descending = []) {
  const seconds = times.map((time) => time / 1000);
  const heights = positions.map((position) => position / 1000);
  const arrival = (inverseSpeed, height, down) => {
    const root = Math.sqrt(Math.max(0, 1 - 2 * GRAVITY * height * inverseSpeed ** 2));
    return down ? (1 + root) / (GRAVITY * inverseSpeed)
      : 2 * height * inverseSpeed / (1 + root);
  };
  function evaluate(inverseSpeed) {
    const offsets = seconds.map((time, i) => time - arrival(inverseSpeed, heights[i], descending[i]));
    const start = offsets.reduce((sum, value) => sum + value, 0) / times.length;
    const error = offsets.reduce((sum, value) => sum + (value - start) ** 2, 0);
    return { start, error };
  }
  // Reciprocal speed gives a finite search interval, from infinite speed to
  // just enough speed to reach the highest sensor on the upward passage.
  let low = 0, high = 1 / Math.sqrt(2 * GRAVITY * Math.max(...heights));
  for (let i = 0; i < 100; i++) {
    const a = low + (high - low) / 3;
    const b = high - (high - low) / 3;
    if (evaluate(a).error < evaluate(b).error) high = b;
    else low = a;
  }
  const inverseSpeed = (low + high) / 2;
  return { velocity: 1 / inverseSpeed, start: evaluate(inverseSpeed).start };
}

function updateReading() {
  if (!currentReading) return;
  currentReading.vertical = currentReading.upDown || (verticalInput.checked && selectedDirection !== "both");
  if (currentReading.vertical) {
    Object.assign(currentReading, fitVertical(currentReading.times, currentReading.positions, currentReading.descending));
  } else {
    currentReading.velocity = currentReading.baseVelocity;
  }
  currentVelocity = currentReading.velocity.toFixed(3);
  velocityOutput.textContent = currentVelocity;
  drawPlot(currentReading);
}

function drawPlot(reading) {
  const left = 56, right = 620, top = 30, bottom = 178;
  const spacing = reading?.spacing ?? Number(distanceInput.value);
  const times = reading?.times;
  const duration = times ? Math.max(...times) : 1;
  const x = (time) => left + time / duration * (right - left);
  const height = reading?.upDown
    ? Math.max(4 * spacing, 1000 * reading.velocity ** 2 / (2 * GRAVITY)) : 4 * spacing;
  const y = (position) => bottom - position / height * (bottom - top);
  const label = (value) => Number(value.toPrecision(3)).toString();
  let drawing = `<defs><clipPath id="plot-area"><rect x="${left}" y="${top - 8}" width="${right - left}" height="${bottom - top + 16}"/></clipPath></defs>`;
  drawing += `<text class="plot-label" x="${left}" y="12">Position (mm)</text>`;
  for (let i = 0; i < 5; i++) {
    const position = i * spacing;
    drawing += `<line class="plot-grid" x1="${left}" y1="${y(position)}" x2="${right}" y2="${y(position)}"/>`;
    drawing += `<text class="plot-label" x="${left - 10}" y="${y(position) + 4}" text-anchor="end">${label(position)}</text>`;
  }
  if (reading) {
    for (const time of [0, duration / 2, duration]) {
      drawing += `<text class="plot-label" x="${x(time)}" y="198" text-anchor="middle">${label(time)}</text>`;
    }
    // The inverse time-on-position fit passes through the measurement centroid.
    const meanTime = times.reduce((sum, value) => sum + value, 0) / times.length;
    const fittedPosition = (time) => {
      if (!reading.vertical) return 2 * spacing + reading.velocity * (time - meanTime);
      const elapsed = time / 1000 - reading.start;
      return 1000 * (reading.velocity * elapsed - GRAVITY * elapsed ** 2 / 2);
    };
    // A quadratic Bézier represents the constant-gravity trajectory exactly.
    const start = fittedPosition(0), end = fittedPosition(duration);
    const control = 2 * fittedPosition(duration / 2) - (start + end) / 2;
    drawing += `<path class="plot-fit" clip-path="url(#plot-area)" d="M ${left} ${y(start)} Q ${(left + right) / 2} ${y(control)} ${right} ${y(end)}"/>`;
    times.forEach((time, i) => {
      const sensor = reading.sensors[i];
      const position = reading.positions[i];
      const px = x(time), py = y(position);
      drawing += `<circle class="plot-point" cx="${px}" cy="${py}" r="4.5"><title>Sensor ${sensor + 1}: ${label(time)} ms, ${label(position)} mm</title></circle>`;
      drawing += `<text class="plot-number" x="${px + (px > right - 20 ? -8 : 8)}" y="${py - 8}" text-anchor="${px > right - 20 ? "end" : "start"}">${sensor + 1}</text>`;
    });
  }
  drawing += `<text class="plot-label" x="${(left + right) / 2}" y="218" text-anchor="middle">Time (ms)</text>`;
  plot.innerHTML = drawing;
  plot.setAttribute("aria-label", reading
    ? `Position versus time: ${times.length} sensor measurements; ${reading.vertical ? "gravity fit; first-sensor velocity" : "constant velocity fit; velocity"} ${reading.velocity.toFixed(3)} meters per second`
    : "Position versus time; waiting for a complete trial");
}

drawPlot();

function handleLine(line) {
  const state = line.match(/^STATE sensor=([1-5]) blocked=([01])/);
  if (state) {
    setSensor(Number(state[1]) - 1, state[2] === "0");
    return;
  }

  const status = line.match(/^STATUS blocked=([01]{5})/);
  if (status) {
    [...status[1]].forEach((blocked, index) => setSensor(index, blocked === "0"));
    return;
  }

  if (line.startsWith("TRAJECTORY ")) {
    const fields = Object.fromEntries(line.split(" ").slice(1).map((field) => field.split("=")));
    const up = fields.up?.split(",").map(Number);
    const down = fields.down?.split(",").map(Number);
    const spacing = Number(fields.spacing_mm);
    const direction = Number(fields.direction);
    if (!up || !down || up.length < 2 || up.length > 5 || down.length !== up.length
        || !Number.isFinite(spacing) || spacing <= 0 || ![1, -1].includes(direction)) return;
    const ticks = [...up, ...down];
    if (!ticks.every((tick) => Number.isInteger(tick) && tick >= 0 && tick <= 0xffffffff)) return;
    const times = ticks.map((tick) => ((tick - ticks[0]) >>> 0) / 80000);
    if (times.at(-1) > 5000 || times.some((time, i) => i > 0 && time <= times[i - 1])) return;
    const steps = up.map((_, i) => i);
    steps.push(...[...steps].reverse());
    const positions = steps.map((step) => step * spacing);
    const sensors = steps.map((step) => direction > 0 ? step : 4 - step);
    const descending = times.map((_, i) => i >= up.length);
    // Backdate receipt by the hardware-measured passage duration.
    const firstCrossing = new Date(Date.now() - Math.max(...times)).toISOString();
    currentReading = { times, positions, sensors, descending, spacing, upDown: true, firstCrossing };
    updateReading();
    saveButton.disabled = false;
    return;
  }

  if (line.startsWith("VELOCITY ")) {
    const fields = Object.fromEntries(line.split(" ").slice(1).map((field) => field.split("=")));
    const ticks = fields.ticks?.split(",").map(Number);
    const spacing = Number(fields.spacing_mm);
    const velocity = Math.abs(Number(fields.mps));
    const direction = Number(fields.direction);
    if (!ticks || ticks.length !== 5 || !ticks.every((tick) => Number.isInteger(tick) && tick >= 0 && tick <= 0xffffffff)
        || !Number.isFinite(velocity) || !Number.isFinite(spacing) || spacing <= 0
        || ![1, -1].includes(direction)) return;
    const first = ticks[direction > 0 ? 0 : 4];
    const times = ticks.map((tick) => ((tick - first) >>> 0) / 80000);
    const ordered = direction > 0 ? times : [...times].reverse();
    if (ordered[4] > 5000 || ordered.some((time, i) => i > 0 && time <= ordered[i - 1])) return;
    const positions = times.map((_, sensor) => (direction > 0 ? sensor : 4 - sensor) * spacing);
    const firstCrossing = new Date(Date.now() - Math.max(...times)).toISOString();
    currentReading = { times, positions, sensors: [0, 1, 2, 3, 4], spacing, baseVelocity: velocity, firstCrossing };
    updateReading();
    saveButton.disabled = false;
  }
}

async function readSerial() {
  const decoder = new TextDecoder();
  const activePort = port;
  while (!disconnecting && activePort === port && activePort?.readable) {
    reader = port.readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        readBuffer += decoder.decode(value, { stream: true });
        const lines = readBuffer.split(/\r?\n/);
        readBuffer = lines.pop();
        lines.forEach(handleLine);
      }
    } catch (error) {
      if (error.name !== "NetworkError") console.error(error);
    } finally {
      reader.releaseLock();
      reader = undefined;
    }
  }
}

function send(command) {
  if (!port?.writable) return Promise.resolve();
  writeQueue = writeQueue.then(async () => {
    const writer = port.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(`${command}\n`));
    } finally {
      writer.releaseLock();
    }
  }).catch(console.error);
  return writeQueue;
}

async function connect(selectedPort) {
  port = selectedPort;
  readBuffer = "";
  try {
    await port.open({ baudRate: BAUD_RATE });
  } catch (error) {
    port = undefined;
    throw error;
  }
  setConnected(true);
  await send(`distance ${distanceInput.value}`);
  await send(`direction ${selectedDirection}`);
  await send(`updown ${Number(upDownInput.checked)}`);
  await send("status");
  readTask = readSerial().finally(() => {
    if (!disconnecting) setConnected(false);
  });
}

async function disconnect() {
  if (disconnecting) return;
  disconnecting = true;
  const activePort = port;
  try {
    if (reader) await reader.cancel();
    if (readTask) await readTask;
    await writeQueue;
    if (activePort) await activePort.close();
  } catch (error) {
    if (error.name !== "NetworkError") console.error(error);
  } finally {
    port = undefined;
    reader = undefined;
    readTask = undefined;
    disconnecting = false;
    setConnected(false);
  }
}

async function choosePort() {
  if (port) {
    connectButton.disabled = true;
    connectionLabel.textContent = "Disconnecting";
    try {
      await disconnect();
    } finally {
      connectButton.disabled = false;
    }
    return;
  }
  connectButton.disabled = true;
  connectionLabel.textContent = "Connecting";
  try {
    const selected = await navigator.serial.requestPort({
      filters: [{ usbVendorId: ESPRESSIF_VENDOR_ID }],
    });
    await connect(selected);
  } catch (error) {
    if (error.name === "NotFoundError") {
      connectionLabel.textContent = "Connect";
    } else {
      connectionLabel.textContent = "Port unavailable";
      console.error(error);
      setTimeout(() => {
        if (!port) connectionLabel.textContent = "Connect";
      }, 1800);
    }
  } finally {
    connectButton.disabled = false;
  }
}

async function scanPorts() {
  const ports = await navigator.serial.getPorts();
  const selected = ports.find((item) => item.getInfo().usbVendorId === ESPRESSIF_VENDOR_ID) ?? ports[0];
  if (!selected) return;
  try {
    await connect(selected);
  } catch (error) {
    connectionLabel.textContent = "Connect";
    console.error(error);
  }
}

function updateDistance() {
  const distance = Number(distanceInput.value);
  if (!(distance > 0)) return;
  localStorage.setItem("spacingMm", String(distance));
  send(`distance ${distance}`);
}

verticalInput.addEventListener("change", () => {
  localStorage.setItem("vertical", String(verticalInput.checked));
  updateModes();
  send(`updown ${Number(upDownInput.checked)}`);
  updateReading();
});
upDownInput.addEventListener("change", () => {
  localStorage.setItem("upDown", String(upDownInput.checked));
  send(`updown ${Number(upDownInput.checked)}`);
});
connectButton.addEventListener("click", choosePort);
distanceInput.addEventListener("change", updateDistance);
distanceInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    updateDistance();
    distanceInput.blur();
  }
});
directionButtons.forEach((button) => {
  button.addEventListener("click", () => selectDirection(button.dataset.direction));
});
saveButton.addEventListener("click", () => {
  if (currentVelocity === undefined) return;
  saveButton.disabled = true;
  const row = trialRows.insertRow();
  row.insertCell().textContent = String(++trialCount);
  const velocity = row.insertCell();
  velocity.contentEditable = "true";
  velocity.spellcheck = false;
  velocity.textContent = currentVelocity;
  const notes = row.insertCell();
  notes.className = "notes";
  notes.contentEditable = "true";
  notes.spellcheck = false;
  row.insertCell().textContent = currentReading.upDown ? "Up & down" : currentReading.vertical ? "Yes" : "No";
  row.insertCell().textContent = savePoints.checked ? String(currentReading.spacing) : "";
  for (const down of [false, true]) {
    for (let sensor = 0; sensor < 5; sensor++) {
      const i = currentReading.sensors.findIndex((value, index) => value === sensor
        && Boolean(currentReading.descending?.[index]) === down);
      row.insertCell().textContent = savePoints.checked && i >= 0 ? String(currentReading.times[i]) : "";
    }
  }
  row.insertCell().textContent = currentReading.firstCrossing;
  row.scrollIntoView({ block: "nearest" });
  clearButton.disabled = false;
  exportButton.disabled = false;
});

function tableData() {
  return [
    [...document.querySelectorAll("thead th")].map((cell) => cell.textContent.trim()),
    ...[...trialRows.rows].map((row) => [...row.cells].map((cell) => cell.textContent.trim())),
  ];
}

exportButton.addEventListener("click", () => {
  const csv = tableData().map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(",")).join("\r\n") + "\r\n";
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "beamvel.csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});

copyButton.addEventListener("click", async () => {
  const lines = tableData().map((row) => row.map((value) => value.replace(/\s+/g, " ")));
  try {
    await navigator.clipboard.writeText(lines.map((line) => line.join("\t")).join("\n"));
    copyButton.textContent = "Copied";
  } catch (error) {
    copyButton.textContent = "Failed";
    console.error(error);
  }
  setTimeout(() => {
    copyButton.textContent = "Copy";
  }, 1200);
});
clearButton.addEventListener("click", () => {
  if (!window.confirm("Are you sure you want to clear table?")) return;
  trialRows.replaceChildren();
  trialCount = 0;
  clearButton.disabled = true;
  exportButton.disabled = true;
});

if ("serial" in navigator) {
navigator.serial.addEventListener("disconnect", () => disconnect().catch(console.error));
  scanPorts().catch(console.error);
} else {
  connectButton.disabled = true;
  connectionLabel.textContent = "Chrome required";
}
