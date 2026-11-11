"""Deploy an intact release only to its pinned Morty resources, without DNS changes."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
ACCOUNT = 'b903018a1c3d9d9a4bd68a11eb03e764'
WRANGLER = ['node', str(ROOT / 'node_modules/wrangler/bin/wrangler.js')]


def read(file):
    return json.loads(file.read_text())


def cloud(path, query=None, method=None):
    request = urllib.request.Request('https://api.cloudflare.com/client/v4/accounts/' + ACCOUNT + path, method=method, data=None if query is None else json.dumps(query).encode(), headers={'Authorization': 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN'], 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=40) as response:
        value = json.load(response)
    if not value.get('success'):
        raise RuntimeError('Cloudflare verification failed')
    return value['result']


def run(command, env):
    subprocess.run(command, cwd=ROOT, env=env, check=True, timeout=600)


def upload_objects(command, env):
    """Uploads idempotent R2 objects, retrying a transient storage failure a bounded number of times."""
    for delay in [5, 20]:
        try:
            run(command, env)
            return
        except subprocess.CalledProcessError:
            print(f'R2 upload failed; retrying in {delay} seconds', flush=True)
            time.sleep(delay)
    run(command, env)


def served_versions(deployment):
    return [(version['version_id'], version['percentage']) for version in deployment['versions']]


def restore_workers(expected, previous):
    """Return each Worker to the deployment that served before this release. Database migrations stay applied."""
    for component in previous:
        path = '/workers/scripts/' + expected[component] + '/deployments'
        before = previous[component]
        if served_versions(cloud(path)['deployments'][0]) == served_versions(before):
            continue
        # Keep the restored deployment's message, which names the source revision it serves.
        cloud(path, {'strategy': 'percentage', 'versions': [{'version_id': version_id, 'percentage': percentage} for version_id, percentage in served_versions(before)], 'annotations': {'workers/message': before.get('annotations', {}).get('workers/message', '')}}, method='POST')
        if served_versions(cloud(path)['deployments'][0]) != served_versions(before):
            raise RuntimeError('The restored Worker deployment is not active: ' + component)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('environment', choices=['production'])
    parser.add_argument('--release', type=Path, required=True)
    parser.add_argument('--cli-release', type=Path, help='Accepted CLI manifest and adjacent archive')
    parser.add_argument('--verify-release-only', action='store_true', help='Verify artifact provenance and configuration without cloud access or deployment')
    parser.add_argument('--preflight-only', action='store_true', help='Verify deployment credentials and resources before any write')
    args = parser.parse_args()
    release = args.release.resolve()
    manifest = read(release / 'release.json')
    expected = read(ROOT / 'deployment/targets.json')['environments'][args.environment]
    if manifest['format'] != 'morty-cloud-release-v3' or manifest['account_id'] != ACCOUNT or manifest['environment'] != args.environment or manifest['target'] != expected or manifest['revision'] != os.environ['EXPECTED_REVISION']:
        raise ValueError('Release provenance or destination mismatch')
    actual_files = {p.relative_to(release).as_posix() for p in release.rglob('*') if p.is_file() and p.name != 'release.json'}
    if actual_files != set(manifest['files']):
        raise ValueError('Release file inventory changed')
    for name, checksum in manifest['files'].items():
        file = (release / name).resolve()
        if release not in file.parents or file.is_symlink() or hashlib.sha256(file.read_bytes()).hexdigest() != checksum:
            raise ValueError('Release checksum failed')
    configs = {key: release / value for key, value in manifest['configs'].items()}
    if set(configs) != {'morty'}:
        raise ValueError('Release must contain the consolidated Morty Worker')
    for component, file in configs.items():
        config = read(file)
        if config['account_id'] != ACCOUNT or config['name'] != expected[component] or config.get('routes'):
            raise ValueError('Deployment escaped the independent target')
    morty = read(configs['morty'])
    if 'MORTY_SESSION_SIGNING_SECRET' not in morty.get('secrets', {}).get('required', []) or 'MORTY_SESSION_SIGNING_SECRET' in morty.get('vars', {}):
        raise ValueError('Release must use a dedicated Session signing secret; rebuild older archives before restoring')
    assert morty['d1_databases'][0]['database_id'] == expected['d1_id']
    assert not morty.get('services')
    assert morty['durable_objects']['bindings'] == [{'name': 'COMPUTER_RELAY', 'class_name': 'ComputerRelay'}]
    assert morty['vars']['APP_ORIGIN'] == expected['morty_origin']
    assert json.loads(morty['vars']['MORTY_ALLOWED_ORIGINS']) == [expected['morty_origin']]
    if args.verify_release_only:
        print(json.dumps({'releaseVerified': True, 'architecture': 'single-worker', 'origin': expected['morty_origin'], 'deploymentAttempted': False}))
        return
    if args.environment == 'production':
        version = manifest['cliVersion']
        import re
        if not isinstance(version, str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version):
            raise ValueError('Invalid CLI release version')
        accepted = manifest.get('cliRelease')
        if args.cli_release:
            supplied = read(args.cli_release)
            if accepted is not None and accepted != supplied:
                raise ValueError('Cloud and CLI acceptance records differ')
            accepted = supplied
        if not isinstance(accepted, dict) or accepted.get('name') != '@morty-build/cli' or accepted.get('version') != version or accepted.get('revision') != manifest['revision'] or not re.fullmatch(r'sha512-[A-Za-z0-9+/]{86}==', accepted.get('integrity', '')):
            raise ValueError('Deployment requires the accepted CLI integrity record')
        if not args.cli_release or accepted.get('archive') != 'morty-build-cli-' + version + '.tgz':
            raise ValueError('The accepted CLI archive is required')
        archive = args.cli_release.parent / accepted['archive']
        cli_bytes = archive.read_bytes()
        if archive.is_symlink() or hashlib.sha256(cli_bytes).hexdigest() != accepted.get('sha256') or 'sha512-' + base64.b64encode(hashlib.sha512(cli_bytes).digest()).decode() != accepted['integrity']:
            raise ValueError('CLI archive checksum differs from the acceptance record')
        if not args.preflight_only and os.environ.get('MORTY_ALLOW_RESTORE') != 'true':
            with urllib.request.urlopen(urllib.request.Request('https://registry.npmjs.org/@morty-build%2fcli/latest', headers={'Cache-Control': 'no-cache'}), timeout=30) as response:
                latest = json.load(response)['version']
            if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', latest):
                raise ValueError('Unexpected npm latest version')
            # CLI setup uses the existing service contracts. Publish its accepted bytes before activating its instructions.
            published, accepted_version = (tuple(map(int, item.split('.'))) for item in (latest, version))
            if published != accepted_version:
                raise ValueError('A superseded release cannot automatically replace production')
        if not args.preflight_only:
            # Instructions invoke the CLI from npm; refuse to activate them before the accepted bytes are available.
            with urllib.request.urlopen(urllib.request.Request('https://registry.npmjs.org/@morty-build%2fcli/' + version, headers={'Cache-Control': 'no-cache'}), timeout=30) as response:
                package = json.load(response)
            if package.get('name') != '@morty-build/cli' or package.get('version') != version or package.get('bin', {}).get('morty') != 'dist/cli.js':
                raise ValueError('The exact Morty CLI release is unavailable')
            if package.get('dist', {}).get('integrity') != accepted['integrity']:
                raise ValueError('Published CLI bytes differ from the accepted release')
    env = dict(os.environ, WRANGLER_SEND_METRICS='false')
    for key in ['CLOUDFLARE_ENV', 'CF_ACCOUNT_ID', 'CF_API_TOKEN']:
        env.pop(key, None)
    # Check lifecycle history before uploading assets, applying D1 migrations,
    # or activating any component. Wrangler otherwise replays all migrations
    # when an archive omits the tag already provisioned on the service.
    previous_migrations = {}
    for component, config in [('morty', morty)]:
        current = cloud('/workers/services/' + expected[component])['default_environment']['script'].get('migration_tag')
        previous_migrations[component] = current
        if current and current not in {item['tag'] for item in config.get('migrations', [])}:
            raise ValueError('Release omits an existing Durable Object migration: ' + component)
    secrets_by_component = {'morty': {'MORTY_SESSION_SIGNING_SECRET': os.environ['MORTY_SESSION_SIGNING_SECRET']}}
    if len(secrets_by_component['morty']['MORTY_SESSION_SIGNING_SECRET']) < 32:
        raise ValueError('The Session credential signing secret must be at least 32 characters')
    # Check the single Worker directory before activation.
    cloud('/d1/database/' + expected['d1_id'])
    if args.preflight_only:
        print(json.dumps({'preflightPassed': True, 'revision': manifest['revision'], 'deploymentAttempted': False}))
        return
    previous = {component: cloud('/workers/scripts/' + expected[component] + '/deployments')['deployments'][0] for component in configs}
    types = {'.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8'}
    with tempfile.TemporaryDirectory(prefix='morty-deploy-') as temporary:
        temporary = Path(temporary)
        groups = {extension: [] for extension in types}
        for file in sorted((release / 'client/assets').rglob('*')):
            if not file.is_file() or file.suffix == '.map':
                continue
            if file.suffix not in groups or file.parent != release / 'client/assets':
                raise ValueError('Unexpected generated asset')
            groups[file.suffix].append({'key': file.relative_to(release / 'client').as_posix(), 'file': str(file)})
        for extension, entries in groups.items():
            if not entries:
                continue
            upload = temporary / ('assets' + extension + '.json')
            upload.write_text(json.dumps(entries))
            # Assets are content-addressed and immutable, so uploading one again writes the same bytes.
            upload_objects(WRANGLER + ['r2', 'bulk', 'put', expected['buckets']['web_assets'], '--filename', str(upload), '--content-type', types[extension], '--cache-control', 'public, max-age=31536000, immutable', '--concurrency', '10', '--remote', '--force', '--config', str(configs['morty'])], env)
        run(WRANGLER + ['d1', 'migrations', 'apply', expected['d1_name'], '--remote', '--config', str(configs['morty'])], env)
        # From the first Worker activation on, a failed check restores the Workers that served before this release.
        try:
            for component in ['morty']:
                command = WRANGLER + ['deploy', '--config', str(configs[component]), '--message', 'morty ' + manifest['revision']]
                if secrets_by_component.get(component):
                    secrets = secrets_by_component[component]
                    if not secrets or not all(isinstance(k, str) and isinstance(v, str) and v for k, v in secrets.items()):
                        raise ValueError('Missing deployment secret')
                    secret_file = temporary / (component + '.secrets.json')
                    secret_file.touch(mode=0o600)
                    secret_file.write_text(json.dumps(secrets))
                    command += ['--secrets-file', str(secret_file)]
                run(command, env)
            checks = []
            for url, content in [(expected['morty_origin'] + '/', 'Morty'), (expected['morty_origin'] + '/setup.md', 'morty setup --base-url ' + expected['morty_origin'])]:
                with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Morty-Deployment/1.0', 'Cache-Control': 'no-cache'}), timeout=40) as response:
                    body = response.read()
                    if response.status != 200 or content and content not in body.decode():
                        raise ValueError('Post-deployment health verification failed')
                    checks.append({'url': url, 'status': response.status, 'sha256': hashlib.sha256(body).hexdigest()})
            for extension in ['.js', '.css', '.woff2']:
                entry = groups[extension][0]
                with urllib.request.urlopen(urllib.request.Request(expected['asset_origin'] + '/' + entry['key'], headers={'Origin': expected['morty_origin'], 'User-Agent': 'Morty-Deployment/1.0'}), timeout=40) as response:
                    if hashlib.sha256(response.read()).hexdigest() != hashlib.sha256(Path(entry['file']).read_bytes()).hexdigest() or response.headers.get('Access-Control-Allow-Origin') != expected['morty_origin'] or 'immutable' not in response.headers.get('Cache-Control', ''):
                        raise ValueError('Asset content, CORS, or cache verification failed')
            deployed = {}
            for component in configs:
                deployment = cloud('/workers/scripts/' + expected[component] + '/deployments')['deployments'][0]
                if len(deployment['versions']) != 1 or deployment['versions'][0]['percentage'] != 100:
                    raise ValueError('Unexpected gradual deployment')
                if deployment.get('annotations', {}).get('workers/message') != 'morty ' + manifest['revision']:
                    raise ValueError('Active Worker deployment does not match the accepted source')
                deployed[component] = deployment
            active_secrets = cloud('/workers/scripts/' + expected['morty'] + '/secrets')
            if not secrets_by_component['morty'].keys() <= {item['name'] for item in active_secrets}:
                raise ValueError('The deployed Session signing secret binding is missing')
            run(['node', str(ROOT / 'deployment/verify-session-access.ts')], env)
        except Exception:
            (ROOT / 'deployment-evidence.json').write_text(json.dumps({'passed': False, 'environment': args.environment, 'revision': manifest['revision'], 'previous': previous, 'restored': False}, indent=2) + '\n')
            current_migrations = {component: cloud('/workers/services/' + expected[component])['default_environment']['script'].get('migration_tag') for component in configs}
            if current_migrations != previous_migrations:
                # Cloudflare cannot roll back across namespace creation/deletion.
                # Keep the evidence for forward repair; never claim that old state can be restored.
                print(json.dumps({'passed': False, 'restored': False, 'recovery': 'forward repair required after Durable Object lifecycle change', 'revision': manifest['revision']}))
            else:
                restore_workers(expected, previous)
                (ROOT / 'deployment-evidence.json').write_text(json.dumps({'passed': False, 'environment': args.environment, 'revision': manifest['revision'], 'previous': previous, 'restored': True}, indent=2) + '\n')
                print(json.dumps({'passed': False, 'restored': True, 'revision': manifest['revision']}))
            raise
    evidence = {'passed': True, 'environment': args.environment, 'revision': manifest['revision'], 'cliVersion': manifest['cliVersion'], 'cliIntegrity': accepted['integrity'], 'account': ACCOUNT, 'previous': previous, 'deployed': deployed, 'checks': checks, 'dnsChanged': False}
    (ROOT / 'deployment-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps({'passed': True, 'environment': args.environment, 'revision': manifest['revision']}))


if __name__ == '__main__':
    main()
