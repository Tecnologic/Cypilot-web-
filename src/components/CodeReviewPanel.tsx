// SPDX-License-Identifier: Apache-2.0
import React from 'react';

export const CodeReviewPanel: React.FC = () => {
  const checks = [
    {
      category: '1. Ruff Linter & Formatter',
      status: 'ENFORCED IN CI',
      tone: 'emerald',
      location: 'pyproject.toml [tool.ruff] & .github/workflows/ci.yml (lines 19–20)',
      details:
        'Enforces line-length = 110, target-version = "py311", src = ["src", "tests"], and lint rule sets E, F, W, I (isort), B (bugbear), UP (pyupgrade), SIM (simplify), and RUF. CI runs both `ruff check .` and `ruff format --check .` on ubuntu-24.04.',
      finding:
        'Style across all 37 Python files is 100% consistent: double quotes, 110-char max width, sorted imports, PEP 604 unions (`X | Y`), and explicit `# noqa: B008` annotations on Qt default-argument overrides (`QModelIndex()`).',
    },
    {
      category: '2. Static Type Checking (Mypy)',
      status: 'PARTIAL GAP IN CI',
      tone: 'amber',
      location: 'pyproject.toml [tool.mypy] (lines 62–73) & .github/workflows/ci.yml (line 21)',
      details:
        'Configured with `strict = true`, `python_version = "3.11"`, `ignore_missing_imports = true` (since DSDL packages `uavcan`, `reg`, `unimoc`, `cymon` are compiled at runtime), and `files = ["src/cypilot"]`.',
      finding:
        'GAP: `files = ["src/cypilot"]` excludes `tests/` from `mypy` when `mypy` is invoked without arguments in `.github/workflows/ci.yml`, even though `tests/` contains full type annotations and `# type: ignore[arg-type]` comments. Recommendation: set `files = ["src/cypilot", "tests"]` and `mypy_path = ["tests"]` in `pyproject.toml`.',
    },
    {
      category: '3. Architecture Boundary (`No Qt import in core/`)',
      status: 'CONSISTENT IN CODE · NOT ENFORCED BY LINTER',
      tone: 'amber',
      location: 'AGENTS.md & src/cypilot/core/*.py',
      details:
        'Rule in AGENTS.md: "No Qt import in `core/`." All 9 modules in `src/cypilot/core/` (`transport`, `session`, `registers`, `status`, `capabilities`, `profiles`, `control`, `sim_control`, `signals`) have zero `PySide6` or `pyqtgraph` imports.',
      finding:
        'GAP: While the code strictly obeys this boundary today, Ruff does not have `TID251` (`flake8-tidy-imports.banned-api`) configured per-directory to fail CI if a contributor imports `PySide6` or `pyqtgraph` inside `src/cypilot/core/`.',
    },
    {
      category: '4. SPDX License Header Rule',
      status: 'CONSISTENT IN CODE · NOT ENFORCED BY CI',
      tone: 'amber',
      location: 'AGENTS.md & all 37 files in src/ and tests/',
      details:
        'Rule in AGENTS.md: "Every source file starts with `# SPDX-License-Identifier: Apache-2.0`."',
      finding:
        'Verified: 37 / 37 `.py` files in `src/` and `tests/` begin with `# SPDX-License-Identifier: Apache-2.0` on line 1. However, `.github/workflows/ci.yml` does not check for missing SPDX headers on new files.',
    },
    {
      category: '5. Cross-Platform & Simulation Test Matrix',
      status: 'ENFORCED IN CI',
      tone: 'emerald',
      location: '.github/workflows/ci.yml (lines 23–50)',
      details:
        'Runs `pytest -v` across a 4-job matrix: `os: [ubuntu-24.04, windows-latest]` × `python: ["3.11", "3.13"]` with `fail-fast: false`. Caches `~/.cache/cypilot` keyed on `hashFiles("src/cypilot/dsdl.py")`.',
      finding:
        'Installs headless Qt dependencies (`libegl1 libxkbcommon0 libfontconfig1`) on Linux and runs offscreen GUI tests (`QT_QPA_PLATFORM=offscreen`) plus live `native_sim` integration tests on Linux while cleanly skipping `native_sim` on Windows.',
    },
  ];

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto bg-white p-4 text-xs">
      <div className="rounded border border-slate-200 bg-slate-50 p-3.5">
        <h3 className="text-sm font-semibold text-slate-900">
          Repository Code Style &amp; CI Enforcement Review (`Tecnologic/cypilot`)
        </h3>
        <p className="mt-1 text-slate-600">
          Audit of <code>pyproject.toml</code>, <code>.github/workflows/ci.yml</code>,{' '}
          <code>AGENTS.md</code>, <code>src/cypilot/**</code>, and <code>tests/**</code>.
        </p>
      </div>

      <div className="space-y-3">
        {checks.map((item) => (
          <div
            key={item.category}
            className="rounded border border-slate-200 bg-white p-3.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2">
              <span className="font-semibold text-slate-900">{item.category}</span>
              <span
                className={`font-mono text-[11px] font-semibold ${
                  item.tone === 'emerald' ? 'text-emerald-700' : 'text-amber-700'
                }`}
              >
                {item.status}
              </span>
            </div>
            <div className="mt-2 font-mono text-[11px] text-slate-500">
              Location: {item.location}
            </div>
            <p className="mt-1.5 text-slate-700 leading-relaxed">{item.details}</p>
            <p className="mt-1.5 font-medium text-slate-900 leading-relaxed">
              Finding: {item.finding}
            </p>
          </div>
        ))}
      </div>

      <div className="rounded border border-slate-200 bg-slate-50 p-3.5">
        <h4 className="font-semibold text-slate-900">
          Recommended `pyproject.toml` Hardening Snippet
        </h4>
        <pre className="mt-2 overflow-x-auto rounded border border-slate-200 bg-white p-3 font-mono text-[11px] text-slate-800">
{`[tool.ruff.lint]
select = ["E", "F", "W", "I", "B", "UP", "SIM", "RUF", "TID"]

[tool.ruff.lint.per-file-ignores]
# Enforce "No Qt import in core/" via flake8-tidy-imports
"src/cypilot/core/**" = ["TID251"]

[tool.ruff.lint.flake8-tidy-imports.banned-api]
"PySide6".msg = "Qt imports are banned in cypilot.core (see AGENTS.md)"
"pyqtgraph".msg = "pyqtgraph imports are banned in cypilot.core (see AGENTS.md)"

[tool.mypy]
python_version = "3.11"
files = ["src/cypilot", "tests"]
mypy_path = ["tests"]
strict = true`}
        </pre>
      </div>
    </div>
  );
};
