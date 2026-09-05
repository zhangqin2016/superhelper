#!/usr/bin/env python3
"""Add collaboration WS routing beside an existing mobile relay; test before reload."""
from pathlib import Path
import re
import shutil
import subprocess
import sys

config = Path(sys.argv[1])
source = config.read_text()
if 'location ^~ /api/collaboration/v1/realtime' in source:
    print('Collaboration websocket location already configured')
    raise SystemExit(0)
pattern = r'(    location \^~ /api/mobile/relay \{[^}]*\})'
blocks = re.findall(pattern, source)
if not blocks or any('proxy_set_header Upgrade $http_upgrade;' not in block for block in blocks):
    raise SystemExit('Expected websocket-enabled mobile relay was not found; no changes made')
updated = re.sub(pattern, lambda m: m[1].replace('/api/mobile/relay', '/api/collaboration/v1/realtime') + '\n' + m[1], source)
backup = config.with_suffix(config.suffix + '.before-enterprise-directory')
if backup.exists():
    raise SystemExit('Backup already exists; inspect the previous operation before retrying')
shutil.copy2(config, backup)
config.write_text(updated)
try:
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['nginx', '-s', 'reload'], check=True)
except BaseException:
    shutil.copy2(backup, config)
    raise
print(f'Enabled collaboration websocket routing in {len(blocks)} server blocks; backup: {backup}')
