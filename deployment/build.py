"""Build a portable, checksummed release for the independent Mobius account."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent
ACCOUNT = 'b903018a1c3d9d9a4bd68a11eb03e764'
PLATFORM = ROOT / 'third-party/platform'
SDK = ROOT / 'third-party/mobius'
WRANGLER = ['node', str(ROOT / 'node_modules/wrangler/bin/wrangler.js')]


def read(path):
    return json.loads(path.read_text())


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def run(command, cwd=ROOT, env=None):
    subprocess.run(command, cwd=cwd, env=env, check=True, timeout=1200)


def overlay(file, environment):
    result = read(file)
    result.update(result.pop('env')[environment])
    for field in ('$schema', 'routes', 'account_id'):
        result.pop(field, None)
    result.update(account_id=ACCOUNT, workers_dev=True, preview_urls=False)
    result['main'] = str(file.parent / result['main'])
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('environment', choices=['production'])
    args = parser.parse_args()
    targets = read(ROOT / 'deployment/targets.json')
    assert targets['account_id'] == ACCOUNT
    for directory, expected in [(SDK, targets['morty_sdk_revision']), (PLATFORM, targets['mobius_revision'])]:
        actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=directory, text=True).strip()
        if actual != expected:
            raise ValueError('Pinned source revision differs from the deployment target')
    environment = args.environment
    spec, auth = targets['environments'][environment], targets['auth'][environment]
    release = ROOT / '.deployment-output' / environment
    generated = ROOT / 'node_modules/.cache/mobius-deployment' / environment
    generated.mkdir(parents=True, exist_ok=True)
    morty = overlay(ROOT / 'wrangler.jsonc', environment)
    morty.update(name=spec['morty'])
    morty['compatibility_flags'] = list(dict.fromkeys(morty.get('compatibility_flags', []) + ['global_fetch_strictly_public']))
    morty['r2_buckets'] = [{'binding': 'CHAT_ATTACHMENTS_APAC', 'bucket_name': spec['buckets']['attachments']}]
    morty['vars'] = {'APP_ORIGIN': spec['morty_origin'], 'MOBIUS_BASE_URL': spec['platform_origin'], 'MOBIUS_APP_ID': spec['app_id']}
    write(generated / 'morty.json', morty)
    vite = (ROOT / 'vite.config.ts').read_text()
    for anchor in ['cloudflare()', 'process.env["CLOUDFLARE_ENV"]', './packages/web/src']:
        if vite.count(anchor) != 1:
            raise ValueError('Vite configuration changed; review the deployment integration')
    vite = vite.replace('cloudflare()', 'cloudflare({ configPath: ' + json.dumps(str(generated / 'morty.json')) + ' })')
    vite = vite.replace('process.env["CLOUDFLARE_ENV"]', json.dumps(environment))
    vite = vite.replace('./packages/web/src', str(ROOT / 'packages/web/src'))
    for original in ['https://morty.paradev.biz', 'https://morty.build']:
        vite = vite.replace(original, spec['morty_origin'])
    for original in ['https://assets.morty.paradev.biz', 'https://assets.morty.build']:
        vite = vite.replace(original, spec['asset_origin'])
    (generated / 'vite.config.ts').write_text(vite)
    env = dict(os.environ, WRANGLER_SEND_METRICS='false', MORTY_SETUP_REVISION=os.environ.get('GITHUB_SHA', subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()))
    env.pop('CLOUDFLARE_ENV', None)
    env.pop('CLOUDFLARE_API_TOKEN', None)
    run(['pnpm', 'build:setup'], env=env)
    run(['pnpm', 'exec', 'vite', 'build', '--config', str(generated / 'vite.config.ts'), '--outDir', str(release)], env=env)
    run(['node', str(ROOT / 'deployment/build-platform-app.mjs'), environment], env=env)
    recording = overlay(PLATFORM / 'packages/recording-cloudflare/wrangler.jsonc', environment)
    recording.update(name=spec['recording'], workers_dev=False)
    platform = overlay(PLATFORM / 'packages/relay-cloudflare-platform/wrangler.jsonc', environment)
    platform.update(name=spec['platform'], main=str(ROOT / 'deployment/platform-entry.mjs'))
    platform['migrations'].append({'tag': 'morty-production-migration-control-20261105', 'new_sqlite_classes': ['MigrationControl']})
    platform['durable_objects']['bindings'].append({'name': 'MIGRATION_CONTROL', 'class_name': 'MigrationControl'})
    platform['compatibility_flags'] = list(dict.fromkeys(platform.get('compatibility_flags', []) + ['global_fetch_strictly_public']))
    platform['d1_databases'] = [{'binding': 'PLATFORM_DIRECTORY_DATABASE', 'database_name': spec['d1_name'], 'database_id': spec['d1_id'], 'migrations_dir': str(PLATFORM / 'packages/relay-cloudflare-platform/migrations/d1')}]
    platform['r2_buckets'] = [{'binding': 'R2_BUCKET_APAC', 'bucket_name': spec['buckets']['platform_apac']}, {'binding': 'R2_BUCKET_WNAM', 'bucket_name': spec['buckets']['platform_wnam']}]
    platform['services'] = [{'binding': 'RECORDING', 'service': spec['recording']}]
    platform['vars'] = {'RECORDING_PROVIDER_ID': spec['recording'], 'MOBIUS_PLATFORM_ALLOWED_ORIGINS': json.dumps(spec['allowed_origins']), 'MOBIUS_PLATFORM_OIDC_PROVIDERS': json.dumps([{'providerId': 'clerk', 'issuer': auth['issuer'], 'audience': 'mobius-platform', 'jwksUrl': (auth['proxyUrl'] or auth['issuer']) + '/.well-known/jwks.json', 'allowedAlgorithms': ['RS256'], 'safeMetadataClaims': ['email', 'name']}]), 'MOBIUS_PLATFORM_OPERATOR_SUBJECTS': '[]'}
    if auth['proxyUrl']:
        platform['vars']['CLERK_PROXY_URL'] = auth['proxyUrl']
    platform['assets'] = {'directory': str(release / 'platform-assets'), 'not_found_handling': 'single-page-application', 'run_worker_first': ['/mobius/api/*', '/__clerk', '/__clerk/*']}
    for label, config in [('recording', recording), ('platform', platform)]:
        write(generated / (label + '.json'), config)
        run(WRANGLER + ['deploy', '--dry-run', '--config', str(generated / (label + '.json')), '--outdir', str(release / label)], env=env)
        entries = [p for p in (release / label).glob('*.js') if not p.name.endswith('.map')]
        if len(entries) != 1:
            raise ValueError('Expected one bundled Worker entrypoint')
        portable = copy.deepcopy(config)
        portable.update(main=entries[0].name, no_bundle=True, find_additional_modules=True, rules=[{'type': 'ESModule', 'globs': ['**/*.js'], 'fallthrough': True}])
        if label == 'platform':
            portable['assets']['directory'] = '../platform-assets'
            portable['d1_databases'][0]['migrations_dir'] = '../d1-migrations'
        write(release / label / 'wrangler.json', portable)
    morty_dir = release / spec['morty'].replace('-', '_')
    built = read(morty_dir / 'wrangler.json')
    allowed = ['name', 'main', 'account_id', 'compatibility_date', 'compatibility_flags', 'durable_objects', 'migrations', 'r2_buckets', 'vars', 'assets', 'observability', 'ratelimits', 'services', 'workers_dev', 'preview_urls', 'secrets', 'placement', 'limits', 'rules', 'triggers']
    portable = {key: built[key] for key in allowed if key in built}
    portable.update(no_bundle=True, find_additional_modules=True)
    write(morty_dir / 'wrangler.json', portable)
    shutil.copytree(PLATFORM / 'packages/relay-cloudflare-platform/migrations/d1', release / 'd1-migrations', dirs_exist_ok=True)
    shutil.copy2(ROOT / 'packages/setup/dist/setup.mjs', release / 'setup.mjs')
    configs = {'recording': 'recording/wrangler.json', 'platform': 'platform/wrangler.json', 'morty': morty_dir.relative_to(release).as_posix() + '/wrangler.json'}
    for label, file in configs.items():
        config = read(release / file)
        assert config['account_id'] == ACCOUNT and config['name'] == spec[label] and not config.get('routes')
        assert '95af7a3d67be8c49b1619544e3ce53c0' not in json.dumps(config)
    # Artifact files contain public configuration and compiled code only; secrets are supplied at deploy time.
    files = {p.relative_to(release).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(release.rglob('*')) if p.is_file() and p.name != 'release.json'}
    write(release / 'release.json', {'format': 'mobius-cloud-release-v1', 'account_id': ACCOUNT, 'environment': environment, 'revision': env['MORTY_SETUP_REVISION'], 'sdkRevision': targets['morty_sdk_revision'], 'platformRevision': targets['mobius_revision'], 'configs': configs, 'target': spec, 'files': files})
    print(json.dumps({'release': str(release), 'environment': environment, 'files': len(files)}))


if __name__ == '__main__':
    main()
