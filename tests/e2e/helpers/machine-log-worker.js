"use strict";

/** Observe the real named Worker; optional holds reproduce stale deliveries without changing application code. */
async function probeMachineLogWorker(page, options = {}) {
  await page.evaluate(({ holdResult, failStartup }) => {
    const Original = window.Worker;
    const probe = { phases: [], ticks: 0, payloadBytes: 0, held: false, released: false, terminated: false };
    window.__machineLogWorkerProbe = probe;
    window.Worker = new Proxy(Original, {
      construct(Target, args) {
        if (args[1]?.name !== "forgex-machine-log") return Reflect.construct(Target, args);
        if (failStartup) throw new Error("test: unavailable Worker");
        window.Worker = Original;
        const worker = Reflect.construct(Target, args);
        const descriptor = Object.getOwnPropertyDescriptor(Original.prototype, "onmessage");
        let measuring = false;
        const tick = () => {
          if (measuring) {
            probe.ticks++;
            requestAnimationFrame(tick);
          }
        };
        const terminate = worker.terminate.bind(worker);
        worker.terminate = () => {
          probe.terminated = true;
          measuring = false;
          terminate();
        };
        Object.defineProperty(worker, "onmessage", {
          set(handler) {
            descriptor.set.call(worker, (event) => {
              const message = event.data;
              if (message.type === "progress") {
                probe.phases.push(message.phase);
                if (message.phase === "parse" && message.progress === 0) {
                  measuring = true;
                  requestAnimationFrame(tick);
                }
              }
              if (message.type === "result") {
                measuring = false;
                probe.log = message.log;
                probe.payloadBytes = new TextEncoder().encode(JSON.stringify(message)).byteLength;
                if (holdResult) {
                  probe.held = true;
                  window.__releaseMachineLogWorker = () => {
                    handler.call(worker, event);
                    probe.released = true;
                  };
                  return;
                }
              }
              handler.call(worker, event);
            });
          },
        });
        return worker;
      },
    });
  }, options);
}
module.exports = { probeMachineLogWorker };
