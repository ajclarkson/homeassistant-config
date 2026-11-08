# homeassistant-config

Home Assistant YAML (helpers, template sensors, dashboards) and the Pulse card in `www/`.

## How changes reach HA

- Pull requests run the Pulse tests (`.github/workflows/pulse.yml`, path-filtered).
- A push to `main` runs the tests again (`.github/workflows/deploy.yml`). When they pass, CI publishes the `deploy` branch: one commit per run, with the previous `deploy` tip and the `main` commit as parents, pushed without force. It also tags the commit `deploy/<UTC date>-<short sha of main>`.
- Only CI writes `deploy`. A failed run leaves it at the last good commit.
- HA currently syncs `main`. It will sync `deploy` once the `cluster-ops` git-sync switch lands.
