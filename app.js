const BAUD_RATE = 2_000_000;
const ESPRESSIF_VENDOR_ID = 0x303a;

const connectButton = document.querySelector("#connect");
const connectionLabel = document.querySelector(".connection-label");
const distanceInput = document.querySelector("#distance");
const velocityOutput = document.querySelector("#velocity");
const saveButton = document.querySelector("#save");
const copyButton = document.querySelector("#copy");
const clearButton = document.querySelector("#clear");
const trialRows = document.querySelector("#trial-rows");
const sensors = [...document.querySelectorAll(".sensor")];
const segments = ["v12", "v23", "v34", "v45"].map((id) => document.getElementById(id));
const directionButtons = [...document.querySelectorAll(".direction-option")];

let port;
let reader;
let readTask;
let readBuffer = "";
let disconnecting = false;
let writeQueue = Promise.resolve();
let currentVelocity;
let trialCount = 0;

const savedDistance = localStorage.getItem("spacingMm");
if (savedDistance) distanceInput.value = savedDistance;

let selectedDirection = localStorage.getItem("travelDirection") ?? "both";
if (!["15", "51", "both"].includes(selectedDirection)) selectedDirection = "both";

function selectDirection(direction, transmit = true) {
  selectedDirection = direction;
  localStorage.setItem("travelDirection", direction);
  directionButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.direction === direction);
  });
  if (transmit) send(`direction ${direction}`);
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

function handleLine(line) {
  if (line.startsWith("TRIAL ")) {
    segments.forEach((output) => { output.textContent = "—"; });
    return;
  }
  const segment = line.match(/^SEGMENT pair=([1-4]) mps=([-+]?\d+(?:\.\d+)?)/);
  if (segment) {
    segments[Number(segment[1]) - 1].textContent = Number(segment[2]).toFixed(3);
    return;
  }
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

  const velocity = line.match(/^VELOCITY .* mps=([-+]?\d+(?:\.\d+)?) v12=(\S+) v23=(\S+) v34=(\S+) v45=(\S+)/);
  if (velocity) {
    if (!velocity.slice(1).every((value) => Number.isFinite(Number(value)))) return;
    currentVelocity = Number(velocity[1]).toFixed(3);
    velocityOutput.textContent = currentVelocity;
    segments.forEach((output, index) => {
      output.textContent = Number(velocity[index + 2]).toFixed(3);
    });
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
  row.scrollIntoView({ block: "nearest" });
  clearButton.disabled = false;
});
copyButton.addEventListener("click", async () => {
  const lines = [["#", "Velocity", "Notes"]];
  for (const row of trialRows.rows) {
    lines.push([...row.cells].map((cell) => cell.textContent.trim().replace(/\s+/g, " ")));
  }
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
});

if ("serial" in navigator) {
navigator.serial.addEventListener("disconnect", () => disconnect().catch(console.error));
  scanPorts().catch(console.error);
} else {
  connectButton.disabled = true;
  connectionLabel.textContent = "Chrome required";
}
