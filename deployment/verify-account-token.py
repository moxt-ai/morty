"""Verify account-owned deployment authority without disclosing its credential."""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
account = json.loads((ROOT / 'deployment/targets.json').read_text())['account_id']
token = os.environ['CLOUDFLARE_API_TOKEN']
if not token.startswith('cfat_'):
    raise ValueError('Morty CI requires a scannable Cloudflare Account API Token')
request = urllib.request.Request(
    f'https://api.cloudflare.com/client/v4/accounts/{account}/tokens/verify',
    headers={'Authorization': 'Bearer ' + token},
)
with urllib.request.urlopen(request, timeout=30) as response:
    envelope = json.load(response)
result = envelope.get('result')
if (
    envelope.get('success') is not True
    or not isinstance(result, dict)
    or result.get('status') != 'active'
    or not isinstance(result.get('id'), str)
    or re.fullmatch(r'[a-f0-9]{32}', result['id']) is None
):
    raise ValueError('The deployment token is not active in the pinned Morty account')
expires_on = result.get('expires_on')
if not isinstance(expires_on, str) or not expires_on:
    raise ValueError('The deployment token must have an expiration; rotate it in morty-production')
try:
    expiration = datetime.fromisoformat(expires_on.replace('Z', '+00:00'))
except ValueError:
    raise ValueError('The deployment token has an invalid expiration') from None
now = datetime.now(timezone.utc)
if expiration.tzinfo is None or expiration <= now:
    raise ValueError('The deployment token must have a valid future expiration')
if expiration - now <= timedelta(days=30):
    print('::warning::The Cloudflare deployment token expires within 30 days. Rotate the morty-production secret and verify a deployment before revoking the old token.')
evidence = {
    'account': account,
    'kind': 'account_api_token',
    'id': result['id'],
    'status': result['status'],
    'expiresOn': expires_on,
}
(ROOT / 'account-token-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
print(json.dumps(evidence))
