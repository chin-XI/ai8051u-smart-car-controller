"use strict";

const SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb";
const CHARACTERISTIC_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb";
const SPP_UUID = "00001101-0000-1000-8000-00805f9b34fb";
const REMEMBERED_BLE_DEVICE_KEY = "smart-car-jdy31-device-id";
const BLE_PREFIX_KEY = "smart-car-ble-prefix";

const byId = (id) => document.getElementById(id);
const ui = {
  connectionPill: byId("connectionPill"), connectionText: byId("connectionText"),
  connectButton: byId("connectButton"), disconnectButton: byId("disconnectButton"),
  connectionType: byId("connectionType"), deviceNameFilter: byId("deviceNameFilter"),
  deviceName: byId("deviceName"), message: byId("message"), driveState: byId("driveState"),
  speedValue: byId("speedValue"), gearGrid: byId("gearGrid"), streamState: byId("streamState"),
  l1Value: byId("l1Value"), l2Value: byId("l2Value"), r1Value: byId("r1Value"), r2Value: byId("r2Value"),
  l1Bar: byId("l1Bar"), l2Bar: byId("l2Bar"), r1Bar: byId("r1Bar"), r2Bar: byId("r2Bar"),
  sumValue: byId("sumValue"), errorValue: byId("errorValue"), errorNeedle: byId("errorNeedle"),
  crossCard: byId("crossCard"), crossValue: byId("crossValue"), crossText: byId("crossText"),
  logWindow: byId("logWindow"), clearLogButton: byId("clearLogButton"),
  packetCount: byId("packetCount"), lastReceive: byId("lastReceive")
};

let bluetoothDevice = null;
let uartCharacteristic = null;
let serialPort = null;
let serialReader = null;
let serialWriter = null;
let serialReadTask = null;
let lastGrantedSerialPort = null;
let lastGrantedBleDevice = null;
let activeTransport = null;
let intentionalDisconnect = false;
let receiveBuffer = "";
let packetCount = 0;
let streamTimer = null;
let lastTelemetryLog = 0;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

function setMessage(text, isError = false) {
  ui.message.textContent = text;
  ui.message.classList.toggle("error", isError);
}

function setConnected(connected) {
  ui.connectionPill.classList.toggle("connected", connected);
  ui.connectionText.textContent = connected ? "已连接" : "未连接";
  ui.connectButton.disabled = connected;
  ui.connectionType.disabled = connected;
  ui.deviceNameFilter.disabled = connected;
  document.querySelectorAll(".control").forEach((button) => { button.disabled = !connected; });
  updateConnectionControls();
  window.SmartCarTuning?.setConnected(connected);
  window.SmartCarSensorCharts?.setConnected(connected);
}

function selectedConnectionType() {
  return ui.connectionType.value;
}

function selectedLastDevice() {
  return selectedConnectionType() === "serial" ? lastGrantedSerialPort : lastGrantedBleDevice;
}

function lastDeviceLabel() {
  if (selectedConnectionType() === "serial") return lastGrantedSerialPort ? "上次：已授权的 JDY-31 SPP" : "--";
  return lastGrantedBleDevice ? `上次：${lastGrantedBleDevice.name || "未命名 BLE 设备"}` : "--";
}

function updateConnectionControls() {
  const connected = Boolean(serialPort || bluetoothDevice?.gatt?.connected);
  const serialSelected = selectedConnectionType() === "serial";
  ui.deviceNameFilter.hidden = serialSelected;
  ui.connectButton.textContent = serialSelected ? "连接 SPP" : "搜索 BLE";
  ui.disconnectButton.disabled = !connected && !selectedLastDevice();
  ui.disconnectButton.textContent = connected ? "断开" : "上次设备";
  if (!connected) ui.deviceName.textContent = lastDeviceLabel();
}

function setDriveState(state) {
  const states = {
    F: ["循迹中", "tracking"],
    B: ["倒车中", "reversing"],
    S: ["已停车", "stopped"]
  };
  const selected = states[state] || states.S;
  ui.driveState.textContent = selected[0];
  ui.driveState.className = `mode-badge ${selected[1]}`;
}

function setSpeed(command) {
  const percent = command === "0" ? 100 : Number(command) * 10;
  ui.speedValue.textContent = `${percent}%`;
  ui.gearGrid.querySelectorAll(".gear").forEach((button) => {
    button.classList.toggle("selected", button.dataset.command === command);
  });
}

function addLog(text, kind = "rx") {
  const placeholder = ui.logWindow.querySelector(".muted");
  if (placeholder) placeholder.remove();
  const row = document.createElement("p");
  row.className = kind;
  row.textContent = `${kind === "tx" ? "TX" : kind === "error" ? "ERR" : "RX"} › ${text}`;
  ui.logWindow.appendChild(row);
  while (ui.logWindow.children.length > 80) ui.logWindow.firstElementChild.remove();
  ui.logWindow.scrollTop = ui.logWindow.scrollHeight;
}

function receiveBytes(value) {
  receiveBuffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
  const lines = receiveBuffer.split("\n");
  receiveBuffer = lines.pop() || "";
  lines.map((line) => line.trim()).filter(Boolean).forEach(processLine);
  if (receiveBuffer.length > 512) {
    processLine(receiveBuffer.trim());
    receiveBuffer = "";
  }
}

async function readSerialPort(port) {
  const reader = port.readable.getReader();
  serialReader = reader;
  try {
    while (serialPort === port) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) receiveBytes(value);
    }
  } catch (error) {
    if (serialPort === port && !intentionalDisconnect) addLog(`串口读取失败：${error.message}`, "error");
  } finally {
    try { reader.releaseLock(); } catch (_) { /* 已释放 */ }
    if (serialReader === reader) serialReader = null;
    if (serialPort === port) {
      serialPort = null;
      if (serialWriter) {
        try { serialWriter.releaseLock(); } catch (_) { /* 已释放 */ }
      }
      serialWriter = null;
      activeTransport = null;
      handleDisconnected();
    }
  }
}

async function connectSerialPort(port) {
  setMessage("正在连接 JDY-31 串口…");
  await port.open({ baudRate: 57600, bufferSize: 1024 });
  serialPort = port;
  serialWriter = port.writable.getWriter();
  serialReadTask = readSerialPort(port);
  lastGrantedSerialPort = port;
  activeTransport = "serial";
  intentionalDisconnect = false;
  ui.deviceName.textContent = "JDY-31 · SPP";
  setConnected(true);
  setMessage("SPP 串口蓝牙连接成功，可发送 F / B / S / 0～9");
  addLog("已连接 JDY-31 SPP");
}

async function connectSerial() {
  if (!navigator.serial) {
    setMessage("当前浏览器不支持网页串口；Android 请使用支持蓝牙 SPP Web Serial 的新版 Chrome。", true);
    addLog("当前浏览器没有 Web Serial API", "error");
    return;
  }
  try {
    setMessage("请选择已在系统蓝牙中配对的 JDY-31…");
    const selectedPort = await navigator.serial.requestPort({ filters: [{ bluetoothServiceClassId: SPP_UUID }] });
    await connectSerialPort(selectedPort);
  } catch (error) {
    if (error.name === "NotFoundError") {
      setMessage("未选择设备；请先在系统蓝牙中配对 JDY-31");
      return;
    }
    serialPort = null;
    serialWriter = null;
    activeTransport = null;
    setConnected(false);
    setMessage(`串口连接失败：${error.message}`, true);
    addLog(error.message, "error");
  }
}

async function connectBleDevice(device) {
  bluetoothDevice = device;
  bluetoothDevice.addEventListener("gattserverdisconnected", handleDisconnected);
  setMessage(`正在连接 ${device.name || "BLE 设备"}…`);
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE_UUID);
  uartCharacteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);
  if (uartCharacteristic.properties.notify || uartCharacteristic.properties.indicate) {
    await uartCharacteristic.startNotifications();
    uartCharacteristic.addEventListener("characteristicvaluechanged", handleNotification);
  }
  lastGrantedBleDevice = device;
  activeTransport = "ble";
  intentionalDisconnect = false;
  localStorage.setItem(REMEMBERED_BLE_DEVICE_KEY, device.id);
  ui.deviceName.textContent = device.name || "未命名设备";
  setConnected(true);
  setMessage("BLE 连接成功，可发送 F / B / S / 0～9");
  addLog(`已连接 ${device.name || "未命名 BLE 设备"}`);
}

async function connectBluetooth() {
  if (!navigator.bluetooth) {
    setMessage("浏览器不支持 Web Bluetooth；iPhone 请使用 Bluefy。", true);
    return;
  }
  try {
    const namePrefix = ui.deviceNameFilter.value.trim();
    const requestOptions = { optionalServices: [SERVICE_UUID] };
    if (namePrefix) requestOptions.filters = [{ namePrefix }];
    else requestOptions.acceptAllDevices = true;
    localStorage.setItem(BLE_PREFIX_KEY, namePrefix);
    setMessage(namePrefix ? `只显示名称以 ${namePrefix} 开头的 BLE 设备…` : "显示附近全部 BLE 设备…");
    const selectedDevice = await navigator.bluetooth.requestDevice(requestOptions);
    await connectBleDevice(selectedDevice);
  } catch (error) {
    if (error.name === "NotFoundError") {
      setMessage("未选择设备；可修改前缀或留空重试");
      return;
    }
    uartCharacteristic = null;
    setConnected(false);
    setMessage(`连接失败：${error.message}`, true);
    addLog(error.message, "error");
  }
}

function connectSelectedDevice() {
  return selectedConnectionType() === "serial" ? connectSerial() : connectBluetooth();
}

async function connectLastDevice() {
  const device = selectedLastDevice();
  if (!device) return;
  try {
    if (selectedConnectionType() === "serial") {
      setMessage("正在连接上次授权的 SPP 设备…");
      await connectSerialPort(device);
    } else {
      await connectBleDevice(device);
    }
  } catch (error) {
    serialPort = null;
    serialWriter = null;
    uartCharacteristic = null;
    activeTransport = null;
    setConnected(false);
    setMessage(`上次设备连接失败：${error.message}`, true);
    addLog(error.message, "error");
  }
}

async function disconnectCurrentDevice() {
  if (!serialPort && !bluetoothDevice?.gatt?.connected) return;
  intentionalDisconnect = true;
  await sendCommand("S");
  if (activeTransport === "serial") {
    const port = serialPort;
    serialPort = null;
    try { await serialReader?.cancel(); } catch (_) { /* 已停止读取 */ }
    try { await serialReadTask; } catch (_) { /* 已退出 */ }
    if (serialWriter) {
      try { serialWriter.releaseLock(); } catch (_) { /* 已释放 */ }
    }
    serialWriter = null;
    serialReadTask = null;
    activeTransport = null;
    try { await port?.close(); } catch (_) { /* 已关闭 */ }
    handleDisconnected();
    return;
  }
  bluetoothDevice?.gatt?.disconnect();
}

function handleDisconnected() {
  const planned = intentionalDisconnect;
  intentionalDisconnect = false;
  uartCharacteristic = null;
  bluetoothDevice = null;
  activeTransport = null;
  receiveBuffer = "";
  clearTimeout(streamTimer);
  setConnected(false);
  ui.deviceName.textContent = lastDeviceLabel();
  ui.streamState.textContent = "等待数据";
  ui.streamState.classList.remove("live");
  setMessage(planned ? "已停车并断开" : "蓝牙意外断开", !planned);
  addLog(planned ? "蓝牙已断开" : "蓝牙意外断开", planned ? "rx" : "error");
}

async function sendCommand(command) {
  const connected = activeTransport === "serial" ? Boolean(serialWriter) : Boolean(uartCharacteristic && bluetoothDevice?.gatt?.connected);
  if (!connected) {
    setMessage("请先连接 JDY-31", true);
    return false;
  }
  try {
    const payload = encoder.encode(command);
    if (activeTransport === "serial" && serialWriter) {
      await serialWriter.write(payload);
    } else if (uartCharacteristic.properties.writeWithoutResponse && uartCharacteristic.writeValueWithoutResponse) {
      await uartCharacteristic.writeValueWithoutResponse(payload);
    } else if (uartCharacteristic.properties.write && uartCharacteristic.writeValueWithResponse) {
      await uartCharacteristic.writeValueWithResponse(payload);
    } else if (uartCharacteristic.writeValue) {
      await uartCharacteristic.writeValue(payload);
    } else {
      throw new Error("当前连接不支持写入");
    }
    const commandLabel = command.trim();
    addLog(commandLabel, "tx");
    setMessage(`命令 ${commandLabel} 已发送`);
    return true;
  } catch (error) {
    setMessage(`发送失败：${error.message}`, true);
    addLog(error.message, "error");
    return false;
  }
}

function handleNotification(event) {
  receiveBytes(event.target.value);
}

function numberFrom(line, key) {
  const match = line.match(new RegExp(`(?:^|\\s)${key}\\s*=\\s*(-?\\d+)`, "i"));
  return match ? Number(match[1]) : null;
}

function processLine(line) {
  if (!line) return;
  packetCount += 1;
  ui.packetCount.textContent = String(packetCount);
  ui.lastReceive.textContent = new Date().toLocaleTimeString([], { hour12: false });

  if (window.SmartCarTuning?.processLine(line)) {
    addLog(line, /^ERR\b/i.test(line) ? "error" : "rx");
    return;
  }

  const l1 = numberFrom(line, "L1");
  const l2 = numberFrom(line, "L2");
  const r1 = numberFrom(line, "R1");
  const r2 = numberFrom(line, "R2");
  const sum = numberFrom(line, "SUM");
  const error = numberFrom(line, "ERROR");
  const cross = numberFrom(line, "CROSS");
  const telemetry = [l1, l2, r1, r2, sum, error, cross].every((value) => value !== null);

  if (telemetry) {
    updateTelemetry({ l1, l2, r1, r2, sum, error, cross });
    window.SmartCarSensorCharts?.push({ l1, l2, r1, r2, cross });
    const now = Date.now();
    if (now - lastTelemetryLog >= 250) {
      addLog(line);
      lastTelemetryLog = now;
    }
  } else {
    addLog(line);
  }

  const speed = numberFrom(line, "SPEED");
  if (speed !== null) setSpeed(speed >= 100 ? "0" : String(Math.round(speed / 10)));
  if (/PID\s+FORWARD/i.test(line)) setDriveState("F");
  if (/BACKWARD/i.test(line)) setDriveState("B");
  if (/\bSTOP\b/i.test(line)) setDriveState("S");
}

function updateTelemetry(data) {
  const sensors = [
    [ui.l1Value, ui.l1Bar, data.l1], [ui.l2Value, ui.l2Bar, data.l2],
    [ui.r1Value, ui.r1Bar, data.r1], [ui.r2Value, ui.r2Bar, data.r2]
  ];
  sensors.forEach(([valueElement, barElement, value]) => {
    valueElement.textContent = String(value);
    barElement.style.width = `${Math.max(0, Math.min(100, value / 4095 * 100))}%`;
  });

  ui.sumValue.textContent = String(data.sum);
  ui.errorValue.textContent = String(data.error);
  const errorPosition = 50 + Math.max(-1, Math.min(1, data.error / 6000)) * 50;
  ui.errorNeedle.style.left = `${errorPosition}%`;

  const detected = data.cross === 1;
  ui.crossCard.className = `metric cross ${detected ? "detected" : "normal"}`;
  ui.crossValue.textContent = `CROSS=${detected ? 1 : 0}`;
  ui.crossText.textContent = detected ? "检测到十字路口" : "普通路段";

  ui.streamState.textContent = "数据流正常";
  ui.streamState.classList.add("live");
  clearTimeout(streamTimer);
  streamTimer = setTimeout(() => {
    ui.streamState.textContent = "数据暂停";
    ui.streamState.classList.remove("live");
  }, 1500);
}

ui.connectButton.addEventListener("click", connectSelectedDevice);
ui.disconnectButton.addEventListener("click", () => serialPort || bluetoothDevice?.gatt?.connected ? disconnectCurrentDevice() : connectLastDevice());
ui.connectionType.addEventListener("change", () => {
  updateConnectionControls();
  if (selectedConnectionType() === "serial") {
    setMessage(navigator.serial ? "先在手机系统蓝牙中配对 JDY-31，再点连接" : "当前浏览器不支持网页串口", !navigator.serial);
  } else {
    setMessage("可按 BLE 设备名前缀筛选");
  }
});

document.querySelectorAll(".drive-button").forEach((button) => {
  button.addEventListener("click", async () => {
    if (await sendCommand(button.dataset.command)) setDriveState(button.dataset.command);
  });
});

ui.gearGrid.querySelectorAll(".gear").forEach((button) => {
  button.addEventListener("click", async () => {
    if (await sendCommand(button.dataset.command)) setSpeed(button.dataset.command);
  });
});

ui.clearLogButton.addEventListener("click", () => {
  ui.logWindow.innerHTML = '<p class="muted">日志已清空</p>';
});

async function loadGrantedDevices() {
  if (navigator.serial?.getPorts) {
    try {
      const ports = await navigator.serial.getPorts();
      const sppPorts = ports.filter((port) => port.getInfo().bluetoothServiceClassId);
      if (sppPorts.length === 1) lastGrantedSerialPort = sppPorts[0];
    } catch (_) { /* 使用手动连接 */ }
  }
  if (navigator.bluetooth?.getDevices) {
    try {
      const devices = await navigator.bluetooth.getDevices();
      const rememberedId = localStorage.getItem(REMEMBERED_BLE_DEVICE_KEY);
      lastGrantedBleDevice = devices.find((device) => device.id === rememberedId) || (devices.length === 1 ? devices[0] : null);
    } catch (_) { /* 使用手动连接 */ }
  }
  updateConnectionControls();
  if (selectedLastDevice()) setMessage("可直接连接上次设备，或重新选择");
}

ui.deviceNameFilter.value = localStorage.getItem(BLE_PREFIX_KEY) ?? "JDY";
window.SmartCarSensorCharts?.init();
window.SmartCarTuning?.init({ sendCommand, setMessage, onSpeed: (value) => setSpeed(value >= 100 ? "0" : String(Math.round(value / 10))) });
setConnected(false);
loadGrantedDevices();
setDriveState("S");
setSpeed("6");
