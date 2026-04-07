# Custom Values Analyzer — Installation

## Prerequisites

- **Python 3.10+** (any OS — macOS, Linux, Windows)
- **Git** (to clone the repo)
- A local clone of the **st_customers** repo (with `AWS/` and/or `Azure/` folders)
- A local copy of the **base Helm values.yaml** (e.g. `~/work/helm/glassbox/values.yaml`)

## Step 1 — Clone the repo

```bash
git clone https://github.com/<YOUR_ORG>/custom_values_analyzer.git
cd custom_values_analyzer
```

## Step 2 — Run

```bash
./run.sh
```

This will:
1. Create a Python virtual environment (`.venv/`) if it doesn't exist
2. Install the single dependency (`PyYAML`)
3. Start the local web server

You'll see:
```
PID: 12345  |  to stop: kill 12345  or  Ctrl+C
Serving http://127.0.0.1:8765/  (Ctrl+C to stop)
```

## Step 3 — Open in browser

Go to **http://127.0.0.1:8765/**

## Step 4 — Configure your paths

On the **Home** page you'll see a **Source paths** section with two text fields:

| Field | What it is | Default |
|-------|-----------|---------|
| **Customers root** | Parent folder containing `AWS/` and `Azure/` | `~/work/st_customers` |
| **Base values.yaml** | The main Helm chart `values.yaml` | `~/work/helm/glassbox/values.yaml` |

Edit the paths to match **your** local filesystem, then click **Save paths**.
The paths are saved to `data/user_config.json` and remembered for future runs.

You can also set paths via environment variables (these override saved config):
```bash
export CVA_CUSTOMERS_ROOT=~/my/path/to/st_customers
export CVA_BASE_VALUES=~/my/path/to/values.yaml
./run.sh
```

## Step 5 — Scan

Click **Scan customers**. This reads your YAML files (read-only — nothing is modified)
and stores the parsed data in a local SQLite database (`data/analyzer.db`).

You're done. Browse the Matrix, Customers, Services, Anomaly, and Service Dive pages.

## Stopping the server

- **Ctrl+C** in the terminal, **or**
- Click the **Stop server** button on the Home page, **or**
- `kill <PID>` (the PID is shown at startup and on the Home page)

## Updating

```bash
cd custom_values_analyzer
git pull
./run.sh
```

No database migration needed — just re-scan after updating.

## Windows

If `./run.sh` doesn't work (no bash), run manually:

```powershell
cd custom_values_analyzer
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
python server.py
```
