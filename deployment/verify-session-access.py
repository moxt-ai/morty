"""Exercise production Session issuance and Runtime authorization without executing a local operation."""
import base64
import hashlib
import hmac
import json
import os
import re
import urllib.error
import urllib.request

from deploy import ROOT, cloud, read


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


def main():
    target = read(ROOT / 'deployment/targets.json')['environments']['production']
    app_credential = os.environ['MORTY_SERVICE_SECRET']
    root_key = os.environ['MORTY_SESSION_SIGNING_SECRET'].encode()
    projects = cloud('/d1/database/' + target['d1_id'] + '/query', {
        'sql': "SELECT project_id FROM platform_projects WHERE app_id = ? AND lifecycle = 'active' LIMIT 1",
        'params': [target['app_id']],
    })
    if not all(item.get('success') and item.get('meta', {}).get('rows_written', 0) == 0 for item in projects):
        raise ValueError('Cannot select the deployment verification Project')
    project_ids = [row['project_id'] for item in projects for row in item['results']]
    origin = target['platform_origin'] + '/morty/api'
    if not project_ids:
        # A fresh installation has no user Project. Reuse one dedicated, idempotently provisioned probe Project.
        status, project = request(origin + '/dashboard/v1/apps/' + target['app_id'] + '/projects', app_credential, {
            'displayName': 'Deployment verification', 'idempotencyKey': 'deployment-verification',
            'clientReference': 'deployment-verification', 'locationHint': 'wnam',
        })
        if status != 201:
            raise ValueError('Cannot provision the deployment verification Project')
        project_ids = [project['projectId']]
    project_id = project_ids[0]
    session_id = 'deployment-' + os.environ['EXPECTED_REVISION'][:12]
    runtime_id = 'deployment-verification'
    status, access = request(origin + '/v1/projects/' + project_id + '/sessions/' + session_id + '/access-credentials', app_credential, {
        'expiresInSeconds': 60, 'runtimeId': runtime_id,
    })
    if status != 201:
        raise ValueError('Production Session issuance failed')
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
    # The Session credential selects RuntimeRelay; the Runtime verifies it before answering this public route.
    verify_url = origin + '/v1/projects/' + project_id + '/sessions/' + session_id + '/live-event-subscription-target'
    status, selected = request(verify_url, credential)
    if status != 200 or selected.get('projectId') != project_id or selected.get('runtimeId') != runtime_id:
        raise ValueError('Production Runtime rejected the newly issued Session credential')
    stored_digest = hashlib.sha256(app_credential.encode()).hexdigest().encode()
    forged = signed.decode() + '_' + base64.urlsafe_b64encode(hmac.digest(stored_digest, signed, 'sha256')).rstrip(b'=').decode()
    rejected_status, rejected = request(verify_url, forged)
    if rejected_status != 401 or rejected.get('error', {}).get('code') != 'project_credential_invalid':
        raise ValueError('Production Runtime accepted a database-digest forgery')
    evidence = {'passed': True, 'revision': os.environ['EXPECTED_REVISION'], 'issuanceStatus': 201, 'runtimeVerificationStatus': 200, 'storedDigestForgeryStatus': 401, 'configuredSigningKeyVerified': True, 'localOperationExecuted': False}
    (ROOT / 'session-access-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(evidence))


if __name__ == '__main__':
    main()
