"""Exercise production Session issuance and Runtime authorization without executing a local operation."""
import argparse
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import time
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


def encode(value):
    return base64.urlsafe_b64encode(value).rstrip(b'=').decode()


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
    # A Session credential carries the access of one of the computer's holders, and the verification Project has
    # none. Production issuance must consult the computer's identities and refuse it.
    holder = {'kind': 'device', 'deviceId': 'deployment-verification'}
    status, refused = request(session_url + '/access-credentials', app_credential, {
        'expiresInSeconds': 60, 'holder': holder,
    })
    if status != 401 or refused.get('error', {}).get('code') != 'credential_revoked':
        fail('Production Session issuance refusal', status, refused)
    # Sign a credential for that holder exactly as the Relay does, with RFC 5869 extract/expand of the configured
    # deployment secret. The Runtime authenticates its signature and refuses it only for the holder's access, so a
    # refusal as revoked rather than invalid verifies the configured signing secret.
    match = re.fullmatch(r'mapp_([A-Za-z0-9_-]{22})_[A-Za-z0-9_-]{43}', app_credential)
    if match is None:
        raise ValueError('The deployment AppCredential is invalid')
    public_id = match.group(1)
    now = int(time.time() * 1000)
    claims = {
        'expiresAtEpochMilliseconds': now + 60_000, 'issuedAtEpochMilliseconds': now, 'computerId': computer_id,
        'purpose': 'session-access', 'holder': holder, 'target': target,
    }
    signed = ('msession_' + public_id + '_' + encode(json.dumps(claims, separators=(',', ':')).encode())).encode()
    extracted = hmac.digest(b'morty.session-access.v2:', root_key, 'sha256')
    key = hmac.digest(extracted, public_id.encode() + b'\x01', 'sha256')
    credential = signed.decode() + '_' + encode(hmac.digest(key, signed, 'sha256'))
    # The Session credential selects ComputerRelay; the Runtime verifies it before answering this public route.
    verify_url = session_url + '/live-event-subscription-target'
    status, selected = request(verify_url, credential)
    if status != 401 or selected.get('error', {}).get('code') != 'credential_revoked':
        fail('Production Runtime verification', status, selected)
    stored_digest = hashlib.sha256(app_credential.encode()).hexdigest().encode()
    forged = signed.decode() + '_' + encode(hmac.digest(stored_digest, signed, 'sha256'))
    rejected_status, rejected = request(verify_url, forged)
    if rejected_status != 401 or rejected.get('error', {}).get('code') != 'project_credential_invalid':
        fail('Stored-digest forgery rejection', rejected_status, rejected)
    return {'passed': True, 'revision': revision, 'issuanceWithoutAccessStatus': 401, 'runtimeVerificationStatus': 401, 'storedDigestForgeryStatus': 401, 'configuredSigningKeyVerified': True, 'localOperationExecuted': False}


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
