/**
 * Stress tests for the command scheduler priority/dedup invariants.
 *
 * Uses a local VM loader because tests/setup.js loadBackgroundScript() is
 * missing the queue / cancel exports added in the P0 priority-preemption
 * commit.  This loader re-uses the same sandbox shape but appends the full
 * export list.
 */

const fs   = require("fs");
const path = require("path");
const vm   = require("vm");

function loadBg() {
    const scriptPath = path.join(__dirname, "..", "..", "background.js");
    const scriptContent = fs.readFileSync(scriptPath, "utf8");

    const sandbox = {
        messenger:      global.messenger,
        fetch:          global.fetch,
        console:        global.console,
        crypto:         global.crypto,
        Date:           global.Date,
        setTimeout:     global.setTimeout,
        setInterval:    global.setInterval,
        clearTimeout:   global.clearTimeout,
        clearInterval:  global.clearInterval,
        Math:           global.Math,
        JSON:           global.JSON,
        Array:          global.Array,
        Object:         global.Object,
        String:         global.String,
        Number:         global.Number,
        Boolean:        global.Boolean,
        Error:          global.Error,
        Promise:        global.Promise,
        Map:            global.Map,
        Set:            global.Set,
        AbortController: global.AbortController,
        AbortSignal:    global.AbortSignal,
        WebSocket:      { OPEN: 1, CONNECTING: 0, CLOSING: 2, CLOSED: 3 },
        CORTEX_TEST_MODE: true,
        __exports__: {},
    };

    const context = vm.createContext(sandbox);

    const wrappedScript = `
        ${scriptContent}

        Object.assign(__exports__, {
            processCommand,
            enqueueCommands,
            runWorkerLoop,
            highCommandQueue,
            fastCommandQueue,
            slowCommandQueue,
            knownCommandIds,
            cancelledJobIds,
            pruneCancelledJobIds,
            removeQueuedCommandsForJob,
            CANCEL_TTL_MS,
            CANCEL_MAX_SIZE,
            _setWs: function(mockWs) { ws = mockWs; },
        });
    `;

    vm.runInContext(wrappedScript, context);
    return context.__exports__;
}

/**
 * Replicate shiftNextCommand() — same priority order as background.js:
 * high > fast (normal) > slow.
 */
function shiftNextCommand(bg) {
    if (bg.highCommandQueue.length > 0) return bg.highCommandQueue.shift();
    if (bg.fastCommandQueue.length > 0) return bg.fastCommandQueue.shift();
    if (bg.slowCommandQueue.length > 0) return bg.slowCommandQueue.shift();
    return null;
}

/** Mulberry32 — deterministic seeded PRNG. */
function mulberry32(seed) {
    let s = seed | 0;
    return function () {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---------------------------------------------------------------------------
describe("Stress: Scheduler priority invariants", () => {
    let bg;

    beforeEach(() => {
        bg = loadBg();
    });

    // -----------------------------------------------------------------------
    it("A: priority dominance — high preempts 10,000 normals", () => {
        const normalCmds = [];
        for (let i = 0; i < 10000; i++) {
            normalCmds.push({ id: `n-${i}`, action: "list_folders" });
        }
        bg.enqueueCommands(normalCmds);
        expect(bg.fastCommandQueue.length).toBe(10000);

        const executed = [];
        let tick = 0;

        while (true) {
            // Inject a high-priority command every 50 ticks
            if (tick > 0 && tick % 50 === 0) {
                bg.highCommandQueue.push({
                    id: `h-${tick}`,
                    action: "cancel_job",
                    priority: "high",
                });
            }

            const cmd = shiftNextCommand(bg);
            if (!cmd) break;
            executed.push(cmd.id);
            tick++;
        }

        // Every high command must have been selected immediately after injection.
        const highIndices = [];
        for (let i = 0; i < executed.length; i++) {
            if (executed[i].startsWith("h-")) highIndices.push(i);
        }

        for (const idx of highIndices) {
            expect(idx % 50).toBe(0);
            expect(idx).toBeGreaterThan(0);
            expect(executed[idx]).toBe(`h-${idx}`);
        }

        expect(highIndices.length).toBeGreaterThan(100);
        expect(executed.length).toBeGreaterThan(10000);
    });

    // -----------------------------------------------------------------------
    it("B: slow never runs while fast/high available (1,000 mixed)", () => {
        for (let i = 0; i < 1000; i++) {
            if (i % 5 === 0) {
                bg.highCommandQueue.push({ id: `H-${i}` });
            } else if (i % 5 < 3) {
                bg.fastCommandQueue.push({ id: `F-${i}` });
            } else {
                bg.slowCommandQueue.push({ id: `S-${i}` });
            }
        }

        let sawFast = false;
        let sawSlow = false;
        let totalDequeued = 0;
        let cmd;

        while ((cmd = shiftNextCommand(bg)) !== null) {
            totalDequeued++;
            const id = cmd.id;

            if (id.startsWith("F-")) sawFast = true;
            if (id.startsWith("S-")) sawSlow = true;

            if (sawFast) {
                expect(bg.highCommandQueue.length).toBe(0);
            }
            if (sawSlow) {
                expect(bg.highCommandQueue.length).toBe(0);
                expect(bg.fastCommandQueue.length).toBe(0);
            }
        }

        expect(totalDequeued).toBe(1000);
        expect(sawFast).toBe(true);
        expect(sawSlow).toBe(true);
    });

    // -----------------------------------------------------------------------
    it("C: dedup survives 1,000 identical pushes via enqueueCommands", () => {
        for (let i = 0; i < 1000; i++) {
            bg.enqueueCommands([{ id: "spam-cmd", action: "list_folders" }]);
        }

        expect(bg.fastCommandQueue.length).toBe(1);
        expect(bg.knownCommandIds.has("spam-cmd")).toBe(true);

        const cmd = shiftNextCommand(bg);
        expect(cmd.id).toBe("spam-cmd");
        expect(shiftNextCommand(bg)).toBeNull();
    });

    // -----------------------------------------------------------------------
    it("C2: dedup across priorities — same id normal then high is deduped", () => {
        bg.enqueueCommands([{ id: "dup-x", action: "list_folders" }]);
        bg.enqueueCommands([{ id: "dup-x", action: "cancel_job", priority: "high" }]);

        expect(bg.fastCommandQueue.length).toBe(1);
        expect(bg.highCommandQueue.length).toBe(0);
        expect(bg.knownCommandIds.size).toBe(1);
    });

    // -----------------------------------------------------------------------
    it("D: property-based soak — 10 seeds x 2,000 events, invariants hold", () => {
        for (let seed = 1; seed <= 10; seed++) {
            // Reset queues (cheaper than reloading VM)
            bg.highCommandQueue.length = 0;
            bg.fastCommandQueue.length = 0;
            bg.slowCommandQueue.length = 0;
            bg.knownCommandIds.clear();

            const rng = mulberry32(seed);
            let nextId = 0;

            for (let event = 0; event < 2000; event++) {
                const r = rng();

                if (r < 0.4) {
                    // Enqueue with random priority
                    const p = rng();
                    const prefix = p < 0.15 ? "H" : p < 0.35 ? "S" : "F";
                    const queue =
                        prefix === "H" ? bg.highCommandQueue :
                        prefix === "S" ? bg.slowCommandQueue :
                        bg.fastCommandQueue;
                    queue.push({ id: `${prefix}-${nextId++}` });
                } else if (r < 0.85) {
                    // Dequeue tick — check invariants BEFORE shifting
                    const hBefore = bg.highCommandQueue.length;
                    const fBefore = bg.fastCommandQueue.length;

                    const cmd = shiftNextCommand(bg);
                    if (cmd) {
                        if (hBefore > 0) {
                            expect(cmd.id.startsWith("H-")).toBe(true);
                        }
                        if (hBefore === 0 && fBefore > 0) {
                            expect(cmd.id.startsWith("F-")).toBe(true);
                        }
                    }
                } else {
                    // cancel-like removal from slow queue
                    if (bg.slowCommandQueue.length > 0) {
                        const idx = Math.floor(rng() * bg.slowCommandQueue.length);
                        bg.slowCommandQueue.splice(idx, 1);
                    }
                }
            }

            // Drain: strict ordering in drain phase (high → fast → slow)
            let phase = "high";
            let cmd;
            while ((cmd = shiftNextCommand(bg)) !== null) {
                const prefix = cmd.id.charAt(0);
                if (phase === "high" && prefix !== "H") phase = "fast";
                if (phase === "fast") {
                    expect(prefix).not.toBe("H");
                    if (prefix !== "F") phase = "slow";
                }
                if (phase === "slow") {
                    expect(prefix).toBe("S");
                }
            }
        }
    });
});
