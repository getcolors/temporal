#!/usr/bin/env python3
"""Check the singleton's reviewed compute/state boundary in a build tree."""
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
profile = root.name
shared = root / 'compute/shared'
nodes = list((root / 'compute/nodes').iterdir())
assert len(nodes) == 1, 'Temporal must render exactly one node'
for stage, key in [(shared, f'{profile}/compute/shared.tfstate'),
                   (nodes[0], f'{profile}/compute/nodes/{nodes[0].name}.tfstate')]:
    documents = [json.loads(path.read_text()) for path in stage.glob('*.tf.json')]
    backend = json.loads((stage / 'backend.tf.json').read_text())['terraform']['backend']['s3']
    assert backend['key'] == key
    assert not {'access_key', 'secret_key', 'token'} & backend.keys()
    assert documents
    assert all('provisioner' not in json.dumps(document) for document in documents)
assert not (root / 'temporal-infrastructure').exists(), 'old compute stage must not be applied'
assert (root / 'temporal-dns/backend.tf.json').is_file(), 'application DNS remains separate'

if len(sys.argv) > 2:
    managed = any('registration' in json.loads(p.read_text()).get('output', {}) for p in shared.glob('*.tf.json'))
    assert managed == (sys.argv[2] == 'managed'), 'registration ownership must match key mode'

# Both committed desired-state fixtures explicitly request provider backups.
node_documents = [json.loads(p.read_text()) for p in nodes[0].glob("*.tf.json")]
droplets = [d.get("resource", {}).get("digitalocean_droplet", {}).get("node") for d in node_documents]
assert any(d and d.get("backups") is True for d in droplets), "the library must preserve requested backups"
