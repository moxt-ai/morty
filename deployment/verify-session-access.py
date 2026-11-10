"""Exercise production Session issuance and Runtime authorization without executing a local operation."""
import argparse
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request

from deploy import ROOT, read


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(url, credential, body=None):
    operation = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), headers={
        'Authorization': 'Bearer ' + credential,
        'Content-Type': 'application/json',
        'User-Agent': 'Morty-Deployment/1.0',
    })
    try:
        with urllib.request.build_opener(NoRedirect).open(operation, timeout=40) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def fail(operation, status, body):
    error = body.get('error') if isinstance(body, dict) else None
    code = error.get('code') if isinstance(error, dict) else None
    if not isinstance(code, str) or re.fullmatch(r'[a-z][a-z0-9_]{0,63}', code) is None:
        code = 'unknown'
    raise ValueError(f'{operation} failed (HTTP {status}, code {code})')


def verify(origin, app_credential, root_key, revision):
    # Retained historical rows need not satisfy the current routing contract. Provision through the
    # supported boundary, with a stable identity so retries reuse one dedicated verification Project.
    status, project = request(origin + '/dashboard/v1/machine-accounts', app_credential, {
        'displayName': 'Deployment verification', 'idempotencyKey': 'deployment-verification',
        'clientReference': 'deployment-verification', 'locationHint': 'wnam',
    })
    if status != 201:
        fail('Verification Project provisioning', status, project)
    computer_id = project['computerId']
    # A Session is addressed by its harness and native Session ID; the Relay issues credentials without the Runtime.
    target = {'harness': 'codex', 'sessionId': 'deployment-' + revision[:12]}
    session_url = (
        origin + '/v1/computers/' + computer_id + '/harnesses/' + target['harness'] + '/sessions/' + target['sessionId']
    )
    status, access = request(session_url + '/access-credentials', app_credential, {
        'expiresInSeconds': 60,
    })
    if status != 201:
        fail('Production Session issuance', status, access)
    if access.get('computerId') != computer_id or access.get('target') != target:
        raise ValueError('Production issued a Session credential for a different Session')
    credential = access.get('credential', '')
    match = re.fullmatch(r'msession_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]+)_([A-Za-z0-9_-]{43})', credential)
    if match is None:
        raise ValueError('Production issued an invalid Session credential')
    public_id, payload, signature = match.groups()
    signed = ('msession_' + public_id + '_' + payload).encode()
    # Independently verify RFC 5869 extract/expand and the exact configured deployment secret.
    extracted = hmac.digest(b'morty.session-access.v1:', root_key, 'sha256')
    key = hmac.digest(extracted, public_id.encode() + b'\x01', 'sha256')
    encoded_signature = base64.urlsafe_b64encode(hmac.digest(key, signed, 'sha256')).rstrip(b'=').decode()
    if not hmac.compare_digest(signature, encoded_signature):
        raise ValueError('Production Session signature does not match the configured signing secret')
    # The Session credential selects ComputerRelay; the Runtime verifies it before answering this public route.
    verify_url = session_url + '/live-event-subscription-target'
    status, selected = request(verify_url, credential)
    if status != 200 or selected.get('computerId') != computer_id:
        fail('Production Runtime verification', status, selected)
    stored_digest = hashlib.sha256(app_credential.encode()).hexdigest().encode()
    forged = signed.decode() + '_' + base64.urlsafe_b64encode(hmac.digest(stored_digest, signed, 'sha256')).rstrip(b'=').decode()
    rejected_status, rejected = request(verify_url, forged)
    if rejected_status != 401 or rejected.get('error', {}).get('code') != 'project_credential_invalid':
        fail('Stored-digest forgery rejection', rejected_status, rejected)
    return {'passed': True, 'revision': revision, 'issuanceStatus': 201, 'runtimeVerificationStatus': 200, 'storedDigestForgeryStatus': 401, 'configuredSigningKeyVerified': True, 'localOperationExecuted': False}


def main():
    # Releases verify production; the merge queue runs the same check against the release's local relay.
    production = read(ROOT / 'deployment/targets.json')['environments']['production']['relay_origin']
    parser = argparse.ArgumentParser()
    parser.add_argument('--relay-origin', default=production)
    parser.add_argument('--evidence', type=Path, default=ROOT / 'session-access-evidence.json')
    args = parser.parse_args()
    # The credentials may only reach the pinned production relay or a local one.
    origin = urllib.parse.urlsplit(args.relay_origin)
    local = origin.scheme == 'http' and origin.hostname in {'127.0.0.1', 'localhost', '::1'}
    if args.relay_origin != production and not (local and origin.path == '' and not origin.query and not origin.fragment and origin.username is None):
        raise ValueError('Session access is verified only on the production relay or a local one')
    evidence = verify(
        args.relay_origin + '/morty/api', os.environ['MORTY_SERVICE_SECRET'],
        os.environ['MORTY_SESSION_SIGNING_SECRET'].encode(), os.environ['EXPECTED_REVISION'],
    )
    args.evidence.write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(evidence))


if __name__ == '__main__':
    main()
