"use strict";

const assert = require("node:assert/strict");

let operations = [];
const listeners = new Map();

function classList() {
  return { add() {}, remove() {}, toggle() {} };
}

function context() {
  return {
    setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    save() {}, restore() {},
    setLineDash(value) { operations.push(["dash", value.join(",")]); },
    fillText(value) { operations.push(["text", value]); }
  };
}

function element(id) {
  const base = {
    id, textContent: "", value: id === "chartHistoryLength" ? "200" : "",
    classList: classList(),
    addEventListener(type, handler) { listeners.set(`${id}:${type}`, handler); }
  };
  if (id === "sensorWaveform" || id === "sideSumWaveform") {
    return Object.assign(base, {
      width: 0, height: 0,
      getBoundingClientRect() { return { width: 500, height: 280 }; },
      getContext() { return context(); }
    });
  }
  return base;
}

const elements = new Map();
global.document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  }
};
global.window = {
  devicePixelRatio: 1,
  addEventListener() {}
};

require("../sensor-charts.js");
const charts = global.window.SmartCarSensorCharts;
charts.init();
charts.setConnected(true);

function push(cross) {
  charts.push({ l1: 100, l2: 200, r1: 300, r2: 400, cross });
}

push(0);
push(1);
push(1);
push(0);
operations = [];
charts.render();

assert.equal(operations.filter(([kind, value]) => kind === "text" && value === "进入").length, 2);
assert.equal(operations.filter(([kind, value]) => kind === "text" && value === "退出").length, 2);
assert.equal(operations.filter(([kind, value]) => kind === "dash" && value === "6,5").length, 4);

listeners.get("clearChartsButton:click")();
push(1);
push(1);
operations = [];
charts.render();

assert.equal(operations.filter(([kind, value]) => kind === "text" && value === "进入").length, 2);
assert.equal(operations.filter(([kind, value]) => kind === "text" && value === "退出").length, 0);

console.log("cross marker tests passed");
