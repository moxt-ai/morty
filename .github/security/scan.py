"""Run reviewed upstream security rules locally; no source or metrics leave the runner."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from ruamel.yaml import YAML

rules_root = Path(sys.argv[1])
rules = []
yaml = YAML(typ="safe")
for language in ['javascript', 'typescript', 'python', 'yaml/github-actions']:
    for path in sorted((rules_root / language).rglob('*.yaml')):
        document = yaml.load(path.read_text())
        if not isinstance(document, dict):
            continue
        for rule in document.get('rules', []):
            metadata = rule.get('metadata', {})
            # Audit heuristics require human investigation; the blocking gate uses actionable security rules.
            if metadata.get('category') == 'security' and metadata.get('confidence') in ['MEDIUM', 'HIGH']:
                rules.append({**rule, 'id': '.'.join(path.relative_to(rules_root).with_suffix('').parts) + '.' + rule['id']})
if not rules:
    raise SystemExit('No security rules were loaded')
with tempfile.TemporaryDirectory(prefix='morty-security-') as directory:
    config = Path(directory) / 'rules.json'
    config.write_text(json.dumps({'rules': rules}))
    print(f'Running {len(rules)} medium/high-confidence security rules', flush=True)
    result = subprocess.run([
        'semgrep', 'scan', '--metrics=off', '--disable-version-check', '--error',
        '--config', str(config), 'packages', 'scripts', 'deployment', '.github',
    ], env={**os.environ, 'SEMGREP_SEND_METRICS': 'off'}, timeout=600, check=False)
    raise SystemExit(result.returncode)
