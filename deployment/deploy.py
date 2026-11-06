"""Deploy an intact release only to its pinned Mobius resources, without DNS changes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
ACCOUNT = 'b903018a1c3d9d9a4bd68a11eb03e764'
WRANGLER = ['node', str(ROOT / 'node_modules/wrangler/bin/wrangler.js')]


def read(file):
    return json.loads(file.read_text())


def cloud(path, query=None):
    request = urllib.request.Request('https://api.cloudflare.com/client/v4/accounts/' + ACCOUNT + path, data=None if query is None else json.dumps(query).encode(), headers={'Authorization': 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN'], 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=40) as response:
        value = json.load(response)
    if not value.get('success'):
        raise RuntimeError('Cloudflare verification failed')
    return value['result']


def run(command, env):
    subprocess.run(command, cwd=ROOT, env=env, check=True, timeout=600)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('environment', choices=['production', 'benchmark'])
    parser.add_argument('--release', type=Path, required=True)
    parser.add_argument('--verify-release-only', action='store_true', help='Verify artifact provenance and configuration without cloud access or deployment')
    args = parser.parse_args()
    if not args.verify_release_only and os.environ.get('PRODUCTION_CUTOVER_COMPLETE') != 'true':
        raise ValueError('Production deployment is held until migration takeover is accepted')
    release = args.release.resolve()
    manifest = read(release / 'release.json')
    expected = read(ROOT / 'deployment/targets.json')['environments'][args.environment]
    if manifest['format'] != 'mobius-cloud-release-v1' or manifest['account_id'] != ACCOUNT or manifest['environment'] != args.environment or manifest['target'] != expected or manifest['revision'] != os.environ['EXPECTED_REVISION']:
        raise ValueError('Release provenance or destination mismatch')
    actual_files = {p.relative_to(release).as_posix() for p in release.rglob('*') if p.is_file() and p.name != 'release.json'}
    if actual_files != set(manifest['files']):
        raise ValueError('Release file inventory changed')
    for name, checksum in manifest['files'].items():
        file = (release / name).resolve()
        if release not in file.parents or file.is_symlink() or hashlib.sha256(file.read_bytes()).hexdigest() != checksum:
            raise ValueError('Release checksum failed')
    configs = {key: release / value for key, value in manifest['configs'].items()}
    for component, file in configs.items():
        config = read(file)
        if config['account_id'] != ACCOUNT or config['name'] != expected[component] or config.get('routes'):
            raise ValueError('Deployment escaped the independent target')
    platform, morty = read(configs['platform']), read(configs['morty'])
    control_migration = {'tag': 'morty-production-migration-control-20261105', 'new_sqlite_classes': ['MigrationControl']}
    if control_migration not in platform.get('migrations', []) or {'name': 'MIGRATION_CONTROL', 'class_name': 'MigrationControl'} not in platform.get('durable_objects', {}).get('bindings', []):
        raise ValueError('Release must preserve the migration control namespace; rebuild older archives before restoring')
    assert platform['d1_databases'][0]['database_id'] == expected['d1_id']
    assert {x['bucket_name'] for x in platform['r2_buckets']} == {expected['buckets']['platform_apac'], expected['buckets']['platform_wnam']}
    assert platform['services'] == [{'binding': 'RECORDING', 'service': expected['recording']}]
    assert morty['vars']['MOBIUS_BASE_URL'] == expected['platform_origin'] and morty['vars']['MOBIUS_APP_ID'] == expected['app_id']
    assert morty['r2_buckets'] == [{'binding': 'CHAT_ATTACHMENTS_APAC', 'bucket_name': expected['buckets']['attachments']}]
    assert morty['vars']['APP_ORIGIN'] == expected['morty_origin']
    assert json.loads(platform['vars']['MOBIUS_PLATFORM_ALLOWED_ORIGINS']) == expected['allowed_origins']
    if args.verify_release_only:
        print(json.dumps({'releaseVerified': True, 'appId': expected['app_id'], 'origin': expected['morty_origin'], 'deploymentAttempted': False}))
        return
    # Check lifecycle history before uploading assets, applying D1 migrations,
    # or activating any component. Wrangler otherwise replays all migrations
    # when an archive omits the tag already provisioned on the service.
    for component, config in [('platform', platform), ('morty', morty)]:
        current = cloud('/workers/services/' + expected[component])['default_environment']['script'].get('migration_tag')
        if current and current not in {item['tag'] for item in config.get('migrations', [])}:
            raise ValueError('Release omits an existing Durable Object migration: ' + component)
    # Validate the migrated identity and its deploy-time secret before any R2,
    # D1 migration, or Worker write. A successful health page is not sufficient.
    secrets_by_component = {component: json.loads(os.environ[component.upper() + '_SECRETS_JSON']) for component in ['platform', 'morty']}
    app_secret = secrets_by_component['morty'].get('MOBIUS_APP_SECRET')
    if not isinstance(app_secret, str) or not app_secret:
        raise ValueError('Missing production application credential')
    credentials = cloud('/d1/database/' + expected['d1_id'] + '/query', {'sql': "SELECT c.secret_digest FROM platform_app_credentials c JOIN platform_apps a ON a.app_id = c.app_id WHERE a.app_id = ? AND a.lifecycle = 'active' AND c.revoked_at IS NULL", 'params': [expected['app_id']]})
    if not all(item.get('success') and item.get('meta', {}).get('rows_written', 0) == 0 for item in credentials):
        raise ValueError('Production credential verification failed')
    digest = hashlib.sha256(app_secret.encode()).hexdigest()
    if not any(row['secret_digest'] == digest for item in credentials for row in item['results']):
        raise ValueError('Deployment secret does not match the migrated application')
    env = dict(os.environ, WRANGLER_SEND_METRICS='false')
    for key in ['CLOUDFLARE_ENV', 'CF_ACCOUNT_ID', 'CF_API_TOKEN']:
        env.pop(key, None)
    previous = {component: cloud('/workers/scripts/' + expected[component] + '/deployments')['deployments'][0] for component in configs}
    types = {'.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf'}
    with tempfile.TemporaryDirectory(prefix='mobius-deploy-') as temporary:
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
            run(WRANGLER + ['r2', 'bulk', 'put', expected['buckets']['web_assets'], '--filename', str(upload), '--content-type', types[extension], '--cache-control', 'public, max-age=31536000, immutable', '--concurrency', '10', '--remote', '--force', '--config', str(configs['morty'])], env)
        run(WRANGLER + ['r2', 'object', 'put', expected['buckets']['attachments'] + '/artifacts/setup.mjs', '--file', str(release / 'setup.mjs'), '--content-type', 'text/javascript; charset=utf-8', '--remote', '--config', str(configs['morty'])], env)
        run(WRANGLER + ['d1', 'migrations', 'apply', expected['d1_name'], '--remote', '--config', str(configs['platform'])], env)
        for component in ['recording', 'platform', 'morty']:
            command = WRANGLER + ['deploy', '--config', str(configs[component]), '--message', 'mobius-morty ' + manifest['revision']]
            if component != 'recording':
                secrets = secrets_by_component[component]
                if not secrets or not all(isinstance(k, str) and isinstance(v, str) and v for k, v in secrets.items()):
                    raise ValueError('Missing deployment secret')
                secret_file = temporary / (component + '.secrets.json')
                secret_file.touch(mode=0o600)
                secret_file.write_text(json.dumps(secrets))
                command += ['--secrets-file', str(secret_file)]
            run(command, env)
        checks = []
        for url, content in [(expected['platform_origin'] + '/mobius/api/dashboard/health', 'mobius-relay-platform'), (expected['morty_origin'] + '/', 'Morty'), (expected['morty_origin'] + '/setup.mjs', None)]:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mobius-Deployment/1.0'}), timeout=40) as response:
                body = response.read()
                if response.status != 200 or content and content not in body.decode():
                    raise ValueError('Post-deployment health verification failed')
                checks.append({'url': url, 'status': response.status, 'sha256': hashlib.sha256(body).hexdigest()})
        for extension in ['.js', '.css', '.woff2']:
            entry = groups[extension][0]
            with urllib.request.urlopen(urllib.request.Request(expected['asset_origin'] + '/' + entry['key'], headers={'Origin': expected['morty_origin'], 'User-Agent': 'Mobius-Deployment/1.0'}), timeout=40) as response:
                if hashlib.sha256(response.read()).hexdigest() != hashlib.sha256(Path(entry['file']).read_bytes()).hexdigest() or response.headers.get('Access-Control-Allow-Origin') != expected['morty_origin'] or 'immutable' not in response.headers.get('Cache-Control', ''):
                    raise ValueError('Asset content, CORS, or cache verification failed')
        deployed = {}
        for component in configs:
            deployment = cloud('/workers/scripts/' + expected[component] + '/deployments')['deployments'][0]
            if len(deployment['versions']) != 1 or deployment['versions'][0]['percentage'] != 100:
                raise ValueError('Unexpected gradual deployment')
            deployed[component] = deployment
    evidence = {'passed': True, 'environment': args.environment, 'revision': manifest['revision'], 'account': ACCOUNT, 'previous': previous, 'deployed': deployed, 'checks': checks, 'dnsChanged': False}
    (ROOT / 'deployment-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps({'passed': True, 'environment': args.environment, 'revision': manifest['revision']}))


if __name__ == '__main__':
    main()
