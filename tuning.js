"use strict";

window.SmartCarTuning = (() => {
  const byId = (id) => document.getElementById(id);
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const inputs = new Map(
    [...document.querySelectorAll(".param-input")].map((input) => [input.dataset.param, input])
  );
  const ui = {
    tabs: [...document.querySelectorAll(".module-tab")],
    controlModule: byId("controlModule"), sensorModule: byId("sensorModule"), tuningModule: byId("tuningModule"),
    modeButton: byId("tuningModeButton"), modeStatus: byId("tuningModeStatus"),
    readButton: byId("readParamsButton"), applyButton: byId("applyParamsButton"),
    defaultsButton: byId("restoreDefaultsButton"), message: byId("tuningMessage"),
    dirtyCount: byId("tuningDirtyCount")
  };

  const values = new Map();
  let connected = false;
  let modeActive = false;
  let reading = false;
  let busy = false;
  let api = null;
  const responseWaiters = new Set();

  function waitForResponse(predicate, timeoutMs = 1200) {
    let waiter;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        responseWaiters.delete(waiter);
        reject(new Error("等待单片机回复超时"));
      }, timeoutMs);
      waiter = {
        accept(line) {
          if (!predicate(line) && !/^ERR (?:TUNE|PARAM)/i.test(line)) return false;
          clearTimeout(timer);
          responseWaiters.delete(waiter);
          if (/^ERR /i.test(line)) reject(new Error(line));
          else resolve(line);
          return true;
        },
        cancel(error) {
          clearTimeout(timer);
          responseWaiters.delete(waiter);
          if (error) reject(error);
          else resolve("");
        }
      };
      responseWaiters.add(waiter);
    });
    return { promise, cancel: () => waiter?.cancel() };
  }

  function notifyResponseWaiters(line) {
    [...responseWaiters].forEach((waiter) => waiter.accept(line));
  }

  async function sendAndConfirm(command, predicate, retries = 1) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const waiter = waitForResponse(predicate);
      if (!(await api.sendCommand(command))) {
        waiter.cancel();
        throw new Error("蓝牙发送失败");
      }
      try {
        return await waiter.promise;
      } catch (error) {
        lastError = error;
        if (!/超时/.test(error.message) || attempt >= retries) throw error;
        ui.message.textContent = "回复超时，正在自动重试…";
        await delay(150);
      }
    }
    throw lastError;
  }

  function setBusy(value) {
    busy = value;
    setInputAvailability();
  }

  function showModule(name) {
    if (name !== "tuning" && modeActive) {
      api?.setMessage("请先退出参数调整模式", true);
      ui.message.textContent = "调参模式仍在运行，请先退出";
      return false;
    }
    ui.controlModule.hidden = name !== "control";
    ui.sensorModule.hidden = name !== "sensors";
    ui.tuningModule.hidden = name !== "tuning";
    ui.tabs.forEach((button) => button.classList.toggle("active", button.dataset.module === name));
    history.replaceState(null, "", `#${name}`);
    if (name === "sensors") requestAnimationFrame(() => window.SmartCarSensorCharts?.render());
    return true;
  }

  function setInputAvailability() {
    ui.modeButton.disabled = !connected || busy;
    document.querySelectorAll(".tuning-control").forEach((button) => { button.disabled = !connected || !modeActive || busy; });
    inputs.forEach((input) => { input.disabled = !connected || !modeActive || busy || input.readOnly; });
    ui.modeButton.textContent = modeActive ? "退出调参模式" : "进入调参模式";
    ui.modeStatus.textContent = modeActive ? "调参中" : "未进入";
    ui.modeStatus.className = `mode-badge ${modeActive ? "tracking" : "stopped"}`;
  }

  function updateDirtyCount() {
    let count = 0;
    inputs.forEach((input, key) => {
      const changed = modeActive && !input.readOnly && values.has(key) && Number(input.value) !== values.get(key);
      input.classList.toggle("changed", changed);
      if (changed) count += 1;
    });
    ui.dirtyCount.textContent = `${count} 项待应用`;
    return count;
  }

  function setConnected(value) {
    connected = value;
    if (!connected) {
      modeActive = false;
      reading = false;
      busy = false;
      responseWaiters.forEach((waiter) => waiter.cancel(new Error("蓝牙已断开")));
      ui.message.textContent = "连接蓝牙后可进入调参模式";
    }
    setInputAvailability();
    updateDirtyCount();
  }

  async function toggleMode() {
    if (!connected) return;
    const targetMode = modeActive ? "0" : "1";
    setBusy(true);
    ui.message.textContent = modeActive ? "正在退出调参模式…" : "正在停车并进入调参模式…";
    try {
      await sendAndConfirm(
        `@MODE ${targetMode}\n`,
        targetMode === "1"
          ? (line) => /^PARAM END$/i.test(line)
          : (line) => line.toUpperCase() === "TUNE MODE=0"
      );
    } catch (error) {
      ui.message.textContent = `切换失败：${error.message}`;
      api.setMessage(`调参模式切换失败：${error.message}`, true);
    } finally {
      setBusy(false);
    }
  }

  async function readParameters() {
    if (!modeActive) return;
    reading = true;
    setBusy(true);
    ui.message.textContent = "正在读取单片机参数…";
    try {
      await sendAndConfirm("@GET\n", (line) => /^PARAM END$/i.test(line));
    } catch (error) {
      reading = false;
      ui.message.textContent = `读取失败：${error.message}`;
      api.setMessage(`参数读取失败：${error.message}`, true);
    } finally {
      setBusy(false);
    }
  }

  async function applyParameters() {
    if (!modeActive) return;
    const changed = [];
    for (const [key, input] of inputs) {
      if (input.readOnly || !values.has(key) || Number(input.value) === values.get(key)) continue;
      if (!input.reportValidity()) return;
      changed.push([key, Number(input.value)]);
    }
    if (!changed.length) {
      ui.message.textContent = "参数没有变化";
      return;
    }

    setBusy(true);
    ui.message.textContent = `正在应用 ${changed.length} 项参数…`;
    try {
      for (const [key, value] of changed) {
        ui.message.textContent = `正在应用 ${key}…`;
        await sendAndConfirm(
          `@SET ${key} ${value}\n`,
          (line) => line.toUpperCase() === `OK PARAM ${key}=${value}`
        );
      }
      ui.message.textContent = "修改完成，正在回读校验…";
      await sendAndConfirm("@GET\n", (line) => /^PARAM END$/i.test(line));
    } catch (error) {
      ui.message.textContent = `应用失败：${error.message}`;
      api.setMessage(`参数应用失败：${error.message}`, true);
    } finally {
      setBusy(false);
    }
  }

  async function restoreDefaults() {
    if (!modeActive) return;
    setBusy(true);
    ui.message.textContent = "正在恢复代码默认值…";
    try {
      await sendAndConfirm("@DEFAULT\n", (line) => /^PARAM END$/i.test(line));
    } catch (error) {
      ui.message.textContent = `恢复失败：${error.message}`;
      api.setMessage(`恢复默认值失败：${error.message}`, true);
    } finally {
      setBusy(false);
    }
  }

  function processLine(line) {
    notifyResponseWaiters(line);
    let match = line.match(/^TUNE MODE=(0|1)$/i);
    if (match) {
      modeActive = match[1] === "1";
      setInputAvailability();
      ui.message.textContent = modeActive ? "调参模式已开启，电机保持停止" : "已退出调参模式，车辆仍保持停止";
      if (!modeActive) showModule("control");
      return true;
    }

    if (/^PARAM BEGIN$/i.test(line)) {
      reading = true;
      ui.message.textContent = "正在接收参数…";
      return true;
    }
    if (/^PARAM END$/i.test(line)) {
      reading = false;
      updateDirtyCount();
      ui.message.textContent = "参数已与单片机同步";
      setInputAvailability();
      return true;
    }

    match = line.match(/^PARAM ([A-Z0-9_]+)=(\d+) RW=(0|1)$/i);
    if (match) {
      const key = match[1].toUpperCase();
      const value = Number(match[2]);
      const input = inputs.get(key);
      values.set(key, value);
      if (input) {
        input.value = String(value);
        input.readOnly = match[3] === "0";
      }
      if (key === "SPEED") api?.onSpeed(value);
      if (!reading) updateDirtyCount();
      return true;
    }

    match = line.match(/^OK PARAM ([A-Z0-9_]+)=(\d+)$/i);
    if (match) {
      values.set(match[1].toUpperCase(), Number(match[2]));
      updateDirtyCount();
      ui.message.textContent = `${match[1]} 已应用`;
      return true;
    }
    match = line.match(/^OK ULTRA_EN=(0|1)$/i);
    if (match) {
      const value = Number(match[1]);
      values.set("ULTRA_EN", value);
      const input = inputs.get("ULTRA_EN");
      if (input) input.value = String(value);
      updateDirtyCount();
      ui.message.textContent = `超声波避障已${value ? "启用" : "关闭"}`;
      return true;
    }
    if (/^OK PARAM DEFAULTS$/i.test(line)) {
      ui.message.textContent = "已恢复代码默认值，正在重新读取…";
      return true;
    }
    if (/^ERR (?:TUNE|PARAM)/i.test(line)) {
      ui.message.textContent = line;
      api?.setMessage(line, true);
      setInputAvailability();
      return true;
    }
    return false;
  }

  function init(callbacks) {
    api = callbacks;
    ui.tabs.forEach((button) => button.addEventListener("click", () => showModule(button.dataset.module)));
    ui.modeButton.addEventListener("click", toggleMode);
    ui.readButton.addEventListener("click", readParameters);
    ui.applyButton.addEventListener("click", applyParameters);
    ui.defaultsButton.addEventListener("click", restoreDefaults);
    inputs.forEach((input) => input.addEventListener("input", updateDirtyCount));
    setInputAvailability();
    const initialModule = ["#control", "#sensors", "#tuning"].includes(location.hash) ? location.hash.slice(1) : "control";
    showModule(initialModule);
  }

  return { init, processLine, setConnected };
})();
