# cypilot

Web-based Operator GUI (`cypilot`) and interactive CLI (`cypilot-ctl`) for [UNIMOC](https://github.com/Tecnologic/unimoc) drives and Cyphal nodes, built with React, TypeScript, and Vite.

## Features

- **Bus & Node Discovery (`src/core/busEngine.ts`, `src/core/status.ts`)**: Connects to simulated clusters (`socketcan:vcan0` with 4 wheel drives, e-bike drive, and BMS), single `native_sim` instances (`slcan:/dev/pts/1`), or bench adapters (`socketcan:can0`, `pcan:PCAN_USBBUS1`). Decodes UNIMOC heartbeat vendor status bits (`0..2` power stage, `3` engaged, `4` trip latched, `5` E-stop latched, `6` settings pending, `7` local control) into live state chips.
- **Capabilities & Ports (`src/core/capabilities.ts`)**: Discovers node capabilities (`registers`, `commands`, `armable`, `setpoints`, `cart drive`, `scope`, `simulation`, `local control`, `log`) from scanned port registers (`uavcan.<pub|sub|srv|cln>.*.id` and `.type`) and resolves per-node readiness subjects (`1024 + node_id` for `65534`).
- **Register Tree & Validation (`src/core/registers.ts`, `src/components/RegisterPanel.tsx`)**: Scans all node registers into a hierarchical dot-grouped tree with recursive filtering, inline editing in native Cyphal types, range and cross-register validation, red highlight on rejected writes, and flash persistence via `STORE_PERSISTENT_STATES`.
- **Settings Profiles (`src/core/profiles.ts`, `src/components/ProfilePanel.tsx`)**: Saves mutable persistent registers to JSON, computes diffs (`changed`, `type`, `missing`, `extra`, `skipped on load`), and performs multi-pass dependency-aware profile loading (`--include-ports`, `--include-identity`, `--dry-run`, `--store`).
- **Per-Node Readiness Control & Watchdog (`src/components/ControlPanel.tsx`)**: Enables and disables drives with configurable setpoint ramps (`current` `i_d, i_q`, `torque`, `speed`, `position`), enforces a 300 ms UI watchdog (putting engaged drives to `SLEEP` on UI stall), keeps **STOP ALL (`Esc`)** and **Emergency Stop (`Shift+Esc`)** always reachable, and runs step-by-step guided recovery (`STANDBY` for latched trips, confirmed `RESTART` for latched E-stop).
- **Plant Simulation Controls (`src/core/simControl.ts`, `src/components/SimulationPanel.tsx`)**: Inspects the 16 kHz virtual control clock (`unimoc.sim.cycle_count`, `cycle_period_ns`), pauses, runs, advances by `N` cycles, resets the plant, and dynamically builds plant input editors from `unimoc.sim.*` registers.
- **Live Multi-Node Telemetry Plot & Recorder (`src/core/signals.ts`, `src/components/PlotPanel.tsx`)**: Subscribes to published typed subjects across nodes on a shared time base, plots live channels with event markers for commands and register writes, exports CSV + `recording.json` bundles, and replays saved recordings.
- **Interactive CLI (`cypilot-ctl`) & Code/CI Audit (`src/components/CliPanel.tsx`, `src/components/CodeReviewPanel.tsx`)**: Full `cypilot-ctl` shell (`nodes`, `regs`, `get`, `set`, `command`, `caps`, `profile`, `run`, `stop`, `recover`, `sim`, `record`, `--json`) and repository style/CI audit viewer.

## Development

```sh
npm install
npm run dev     # starts Vite dev server on 0.0.0.0:3000
npm run lint    # runs TypeScript strict check (tsc --noEmit)
npm run build   # builds production bundle
```

## License

Apache-2.0 (`LICENSE`).
