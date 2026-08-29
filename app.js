"use strict";

const SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb";
const CHARACTERISTIC_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb";
const TARGET_DEVICE_NAME = "JDY-31-SPP";
const REMEMBERED_DEVICE_KEY = "smart-car-jdy31-device-id";

const byId = (id) => document.getElementById(id);
const ui = {
  connectionPill: byId("connectionPill"), connectionText: byId("connectionText"),
  connectButton: byId("connectButton"), disconnectButton: byId("disconnectButton"),
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
  ui.disconnectButton.disabled = !connected;
  document.querySelectorAll(".control").forEach((button) => { button.disabled = !connected; });
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

async function connectBluetooth() {
  if (!navigator.bluetooth) {
    setMessage("浏览器不支持 Web Bluetooth；iPhone 请使用 Bluefy。", true);
    addLog("当前浏览器没有 Web Bluetooth API", "error");
    return;
  }

  try {
    bluetoothDevice = await selectTargetDevice();
    bluetoothDevice.addEventListener("gattserverdisconnected", handleDisconnected);

    setMessage(`正在连接 ${bluetoothDevice.name || "蓝牙设备"}…`);
    const server = await bluetoothDevice.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    uartCharacteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);

    if (uartCharacteristic.properties.notify || uartCharacteristic.properties.indicate) {
      await uartCharacteristic.startNotifications();
      uartCharacteristic.addEventListener("characteristicvaluechanged", handleNotification);
    } else {
      addLog("FFE1 不支持通知，只能发送命令", "error");
    }

    ui.deviceName.textContent = bluetoothDevice.name || "未命名设备";
    setConnected(true);
    setMessage("连接成功，可发送 F / B / S / 0～9");
    addLog(`已连接 ${bluetoothDevice.name || "未命名设备"}`);
  } catch (error) {
    if (error.name === "NotFoundError") {
      setMessage("已取消设备选择");
      return;
    }
    uartCharacteristic = null;
    setConnected(false);
    setMessage(`连接失败：${error.message}`, true);
    addLog(error.message, "error");
  }
}

async function selectTargetDevice() {
  const rememberedId = localStorage.getItem(REMEMBERED_DEVICE_KEY);

  /* 浏览器不允许网页使用MAC地址，改用浏览器分配的设备ID记住已授权模块。 */
  if (rememberedId && typeof navigator.bluetooth.getDevices === "function") {
    const permittedDevices = await navigator.bluetooth.getDevices();
    const rememberedDevice = permittedDevices.find((device) =>
      device.id === rememberedId && device.name === TARGET_DEVICE_NAME
    );
    if (rememberedDevice) {
      setMessage(`正在重新连接已授权的 ${TARGET_DEVICE_NAME}…`);
      addLog(`使用已记住设备 ${TARGET_DEVICE_NAME}`);
      return rememberedDevice;
    }
  }

  setMessage(`只搜索 ${TARGET_DEVICE_NAME}…`);
  const selectedDevice = await navigator.bluetooth.requestDevice({
    filters: [{ name: TARGET_DEVICE_NAME }],
    optionalServices: [SERVICE_UUID]
  });

  /* 某些第三方浏览器可能忽略过滤器，因此连接前再次严格校验名称。 */
  if (selectedDevice.name !== TARGET_DEVICE_NAME) {
    throw new Error(`拒绝连接 ${selectedDevice.name || "未命名设备"}，只允许 ${TARGET_DEVICE_NAME}`);
  }

  localStorage.setItem(REMEMBERED_DEVICE_KEY, selectedDevice.id);
  return selectedDevice;
}

function disconnectBluetooth() {
  if (bluetoothDevice?.gatt?.connected) bluetoothDevice.gatt.disconnect();
  else handleDisconnected();
}

function handleDisconnected() {
  uartCharacteristic = null;
  receiveBuffer = "";
  clearTimeout(streamTimer);
  setConnected(false);
  ui.streamState.textContent = "等待数据";
  ui.streamState.classList.remove("live");
  setMessage("蓝牙已断开");
  addLog("蓝牙已断开", "error");
}

async function sendCommand(command) {
  if (!uartCharacteristic || !bluetoothDevice?.gatt?.connected) {
    setMessage("请先连接 JDY-31", true);
    return false;
  }

  try {
    const payload = encoder.encode(command);
    if (uartCharacteristic.properties.writeWithoutResponse && uartCharacteristic.writeValueWithoutResponse) {
      await uartCharacteristic.writeValueWithoutResponse(payload);
    } else if (uartCharacteristic.properties.write && uartCharacteristic.writeValueWithResponse) {
      await uartCharacteristic.writeValueWithResponse(payload);
    } else if (uartCharacteristic.writeValue) {
      await uartCharacteristic.writeValue(payload);
    } else {
      throw new Error("FFE1 不支持写入");
    }
    addLog(command, "tx");
    setMessage(`命令 ${command} 已发送`);
    return true;
  } catch (error) {
    setMessage(`发送失败：${error.message}`, true);
    addLog(error.message, "error");
    return false;
  }
}

function handleNotification(event) {
  receiveBuffer += decoder.decode(event.target.value, { stream: true }).replace(/\r/g, "");
  const lines = receiveBuffer.split("\n");
  receiveBuffer = lines.pop() || "";
  lines.map((line) => line.trim()).filter(Boolean).forEach(processLine);
  if (receiveBuffer.length > 512) {
    processLine(receiveBuffer.trim());
    receiveBuffer = "";
  }
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

ui.connectButton.addEventListener("click", connectBluetooth);
ui.disconnectButton.addEventListener("click", disconnectBluetooth);

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

setConnected(false);
setDriveState("S");
setSpeed("6");
