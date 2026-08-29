"use strict";

window.SmartCarSensorCharts = (() => {
  const byId = (id) => document.getElementById(id);
  const ui = {
    sensorCanvas: byId("sensorWaveform"), sideCanvas: byId("sideSumWaveform"),
    historyLength: byId("chartHistoryLength"), pauseButton: byId("pauseChartsButton"),
    clearButton: byId("clearChartsButton"), exportButton: byId("exportChartsButton"),
    sampleCount: byId("chartSampleCount"), streamState: byId("chartStreamState"),
    l1: byId("chartL1Value"), l2: byId("chartL2Value"),
    r1: byId("chartR1Value"), r2: byId("chartR2Value"),
    left: byId("chartLeftValue"), right: byId("chartRightValue")
  };

  const samples = [];
  let paused = false;
  let connected = false;
  let initialized = false;
  let resizeTimer = null;
  let lastCross = null;

  const fourSeries = [
    { key: "l1", color: "#42d7ee" }, { key: "l2", color: "#258cff" },
    { key: "r1", color: "#ffbd4a" }, { key: "r2", color: "#ff5365" }
  ];
  const sideSeries = [
    { key: "left", color: "#38dc82" }, { key: "right", color: "#b57cff" }
  ];
  const crossEvents = {
    enter: { color: "#38dc82", label: "进入" },
    exit: { color: "#ff5365", label: "退出" }
  };

  function maxPoints() { return Number(ui.historyLength.value) || 200; }

  function prepareCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return null;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(rect.width * ratio);
    const height = Math.round(rect.height * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { context, width: rect.width, height: rect.height };
  }

  function drawCrossMarkers(ctx, plot, plotWidth) {
    samples.forEach((sample, index) => {
      const event = crossEvents[sample.crossEvent];
      if (!event) return;
      const x = plot.left + plotWidth * index / Math.max(1, samples.length - 1);

      ctx.save();
      ctx.strokeStyle = event.color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(x, plot.top);
      ctx.lineTo(x, plot.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = event.color;
      ctx.font = "700 10px ui-monospace, SFMono-Regular, Consolas, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(event.label, Math.max(plot.left + 12, Math.min(plot.right - 12, x)),
        plot.top + (sample.crossEvent === "enter" ? 2 : 15));
      ctx.restore();
    });
  }

  function drawChart(canvas, series, maximum) {
    const prepared = prepareCanvas(canvas);
    if (!prepared) return;
    const { context: ctx, width, height } = prepared;
    const plot = { left: 48, right: width - 12, top: 14, bottom: height - 28 };
    const plotWidth = Math.max(1, plot.right - plot.left);
    const plotHeight = Math.max(1, plot.bottom - plot.top);

    ctx.clearRect(0, 0, width, height);
    ctx.font = "11px ui-monospace, SFMono-Regular, Consolas, monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let step = 0; step <= 4; step += 1) {
      const y = plot.bottom - plotHeight * step / 4;
      ctx.strokeStyle = step === 0 ? "#35546d" : "rgba(88,128,158,.22)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plot.left, y);
      ctx.lineTo(plot.right, y);
      ctx.stroke();
      ctx.fillStyle = "#7890a4";
      ctx.fillText(String(Math.round(maximum * step / 4)), plot.left - 7, y);
    }

    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#60788d";
    ctx.fillText("较早", plot.left, plot.bottom + 8);
    ctx.textAlign = "right";
    ctx.fillText("当前", plot.right, plot.bottom + 8);

    if (samples.length < 2) {
      ctx.fillStyle = "#6f879b";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(connected ? "等待传感器数据" : "连接蓝牙后开始绘图", plot.left + plotWidth / 2, plot.top + plotHeight / 2);
      return;
    }

    series.forEach(({ key, color }) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      samples.forEach((sample, index) => {
        const x = plot.left + plotWidth * index / Math.max(1, samples.length - 1);
        const y = plot.bottom - Math.max(0, Math.min(maximum, sample[key])) / maximum * plotHeight;
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
    drawCrossMarkers(ctx, plot, plotWidth);
  }

  function render() {
    drawChart(ui.sensorCanvas, fourSeries, 4000);
    drawChart(ui.sideCanvas, sideSeries, 7000);
  }

  function updateLatest(sample) {
    ui.l1.textContent = sample.l1; ui.l2.textContent = sample.l2;
    ui.r1.textContent = sample.r1; ui.r2.textContent = sample.r2;
    ui.left.textContent = sample.left; ui.right.textContent = sample.right;
    ui.sampleCount.textContent = String(samples.length);
  }

  function push(data) {
    if (paused) return;
    const cross = Number(data.cross) === 1 ? 1 : 0;
    let crossEvent = null;
    if (lastCross === null) {
      if (cross === 1) crossEvent = "enter";
    } else if (cross !== lastCross) {
      crossEvent = cross === 1 ? "enter" : "exit";
    }
    lastCross = cross;
    const sample = {
      time: Date.now(), l1: data.l1, l2: data.l2, r1: data.r1, r2: data.r2,
      left: data.l1 + data.l2, right: data.r1 + data.r2, cross, crossEvent
    };
    samples.push(sample);
    if (samples.length > maxPoints()) samples.splice(0, samples.length - maxPoints());
    updateLatest(sample);
    ui.streamState.textContent = "正在记录";
    ui.streamState.classList.add("live");
    render();
  }

  function clear() {
    samples.length = 0;
    lastCross = null;
    ui.sampleCount.textContent = "0";
    [ui.l1, ui.l2, ui.r1, ui.r2, ui.left, ui.right].forEach((element) => { element.textContent = "--"; });
    render();
  }

  function togglePause() {
    paused = !paused;
    ui.pauseButton.textContent = paused ? "继续波形" : "暂停波形";
    ui.pauseButton.classList.toggle("recording", paused);
    ui.streamState.textContent = paused ? "已暂停" : connected ? "等待新数据" : "等待数据";
    ui.streamState.classList.toggle("live", !paused && connected);
  }

  function exportCsv() {
    if (!samples.length) return;
    const rows = ["time_ms,L1,L2,R1,R2,left_sum,right_sum,CROSS,cross_event"];
    const start = samples[0].time;
    samples.forEach((sample) => rows.push([
      sample.time - start, sample.l1, sample.l2, sample.r1, sample.r2, sample.left, sample.right,
      sample.cross, sample.crossEvent || ""
    ].join(",")));
    const blob = new Blob([`\uFEFF${rows.join("\r\n")}`], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `smart-car-sensors-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function setConnected(value) {
    connected = value;
    if (!value) {
      lastCross = null;
      ui.streamState.textContent = paused ? "已暂停" : "等待数据";
      ui.streamState.classList.remove("live");
    } else if (!paused) {
      ui.streamState.textContent = "等待新数据";
      ui.streamState.classList.add("live");
    }
    render();
  }

  function init() {
    if (initialized) return;
    initialized = true;
    ui.pauseButton.addEventListener("click", togglePause);
    ui.clearButton.addEventListener("click", clear);
    ui.exportButton.addEventListener("click", exportCsv);
    ui.historyLength.addEventListener("change", () => {
      if (samples.length > maxPoints()) samples.splice(0, samples.length - maxPoints());
      ui.sampleCount.textContent = String(samples.length);
      render();
    });
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(render, 120);
    });
    render();
  }

  return { init, push, render, setConnected };
})();
