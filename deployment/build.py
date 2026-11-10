"""Build a portable, checksummed release for the Morty account."""
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
    result.update(result.pop('env', {}).get(environment, {}))
    for field in ('$schema', 'routes', 'account_id'):
        result.pop(field, None)
    # Production Workers answer only on their custom domains, behind the zone's security and rate-limit rules.
    result.update(account_id=ACCOUNT, workers_dev=False, preview_urls=False)
    result['main'] = str(file.parent / result['main'])
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('environment', choices=['production'])
    args = parser.parse_args()
    targets = read(ROOT / 'deployment/targets.json')
    assert targets['account_id'] == ACCOUNT
    environment = args.environment
    spec = targets['environments'][environment]
    release = ROOT / '.deployment-output' / environment
    generated = ROOT / 'node_modules/.cache/morty-deployment' / environment
    generated.mkdir(parents=True, exist_ok=True)
    morty = overlay(ROOT / 'wrangler.jsonc', environment)
    morty.update(name=spec['morty'])
    morty['compatibility_flags'] = list(dict.fromkeys(morty.get('compatibility_flags', []) + ['global_fetch_strictly_public']))
    morty['r2_buckets'] = [{'binding': 'CHAT_ATTACHMENTS_APAC', 'bucket_name': spec['buckets']['attachments']}]
    morty['vars'] = {'APP_ORIGIN': spec['morty_origin'], 'MORTY_RELAY_URL': spec['relay_origin']}
    write(generated / 'morty.json', morty)
    env = dict(os.environ, WRANGLER_SEND_METRICS='false', MORTY_SETUP_REVISION=os.environ.get('GITHUB_SHA', subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()))
    env.update(MORTY_WORKER_CONFIG=str(generated / 'morty.json'), MORTY_APP_ORIGIN=spec['morty_origin'], MORTY_ASSET_ORIGIN=spec['asset_origin'])
    env.pop('CLOUDFLARE_ENV', None)
    env.pop('CLOUDFLARE_API_TOKEN', None)
    run(['pnpm', 'build:setup'], env=env)
    run(['pnpm', 'exec', 'vite', 'build', '--outDir', str(release)], env=env)
    relay = overlay(ROOT / 'packages/relay/wrangler.jsonc', environment)
    relay.update(name=spec['relay'], main=str(ROOT / 'deployment/relay-entry.mjs'))
    # These production-only tags shipped immediately after the runtime browser transport.
    insert_at = next(i for i, migration in enumerate(relay['migrations']) if migration['tag'] == 'platform-runtime-browser-transport') + 1
    relay['migrations'][insert_at:insert_at] = [
        {'tag': 'morty-production-migration-control-20261105', 'new_sqlite_classes': ['MigrationControl']},
        {'tag': 'morty-retire-migration-control-20261106', 'deleted_classes': ['MigrationControl']},
    ]
    relay['compatibility_flags'] = list(dict.fromkeys(relay.get('compatibility_flags', []) + ['global_fetch_strictly_public']))
    relay['d1_databases'] = [{'binding': 'RELAY_DIRECTORY_DATABASE', 'database_name': spec['d1_name'], 'database_id': spec['d1_id'], 'migrations_dir': str(ROOT / 'packages/relay/migrations/d1')}]
    relay['r2_buckets'] = [{'binding': 'R2_BUCKET_APAC', 'bucket_name': spec['buckets']['relay_apac']}, {'binding': 'R2_BUCKET_WNAM', 'bucket_name': spec['buckets']['relay_wnam']}]
    relay['vars'] = {**morty['vars'], 'MORTY_ALLOWED_ORIGINS': json.dumps(spec['allowed_origins'])}
    relay['secrets'] = {'required': ['MORTY_SESSION_SIGNING_SECRET', 'MORTY_SERVICE_SECRET']}
    relay.pop('assets', None)
    for label, config in [('relay', relay)]:
        write(generated / (label + '.json'), config)
        run(WRANGLER + ['deploy', '--dry-run', '--config', str(generated / (label + '.json')), '--outdir', str(release / label)], env=env)
        entries = [p for p in (release / label).glob('*.js') if not p.name.endswith('.map')]
        if len(entries) != 1:
            raise ValueError('Expected one bundled Worker entrypoint')
        portable = copy.deepcopy(config)
        portable.update(main=entries[0].name, no_bundle=True, find_additional_modules=True, rules=[{'type': 'ESModule', 'globs': ['**/*.js'], 'fallthrough': True}])
        if label == 'relay':
            portable['d1_databases'][0]['migrations_dir'] = '../d1-migrations'
        write(release / label / 'wrangler.json', portable)
    morty_dir = release / spec['morty'].replace('-', '_')
    built = read(morty_dir / 'wrangler.json')
    allowed = ['name', 'main', 'account_id', 'compatibility_date', 'compatibility_flags', 'durable_objects', 'migrations', 'r2_buckets', 'vars', 'assets', 'observability', 'ratelimits', 'services', 'workers_dev', 'preview_urls', 'secrets', 'placement', 'limits', 'rules', 'triggers']
    portable = {key: built[key] for key in allowed if key in built}
    portable.update(no_bundle=True, find_additional_modules=True)
    write(morty_dir / 'wrangler.json', portable)
    shutil.copytree(ROOT / 'packages/relay/migrations/d1', release / 'd1-migrations', dirs_exist_ok=True)
    shutil.copy2(ROOT / 'packages/setup/dist/setup.mjs', release / 'setup.mjs')
    configs = {'relay': 'relay/wrangler.json', 'morty': morty_dir.relative_to(release).as_posix() + '/wrangler.json'}
    for label, file in configs.items():
        config = read(release / file)
        assert config['account_id'] == ACCOUNT and config['name'] == spec[label] and not config.get('routes')
        assert '95af7a3d67be8c49b1619544e3ce53c0' not in json.dumps(config)
    # Artifact files contain public configuration and compiled code only; secrets are supplied at deploy time.
    cli_release = None
    if os.environ.get('MORTY_CLI_RELEASE_MANIFEST'):
        cli_release = read(ROOT / os.environ['MORTY_CLI_RELEASE_MANIFEST'])
        if cli_release['revision'] != env['MORTY_SETUP_REVISION'] or cli_release['version'] != read(ROOT / 'packages/cli/package.json')['version']:
            raise ValueError('Cloud and CLI release identities differ')
    files = {p.relative_to(release).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(release.rglob('*')) if p.is_file() and p.name != 'release.json'}
    write(release / 'release.json', {'format': 'morty-cloud-release-v2', 'account_id': ACCOUNT, 'environment': environment, 'revision': env['MORTY_SETUP_REVISION'], 'cliVersion': read(ROOT / 'packages/cli/package.json')['version'], 'cliRelease': cli_release, 'configs': configs, 'target': spec, 'files': files})
    print(json.dumps({'release': str(release), 'environment': environment, 'files': len(files)}))


if __name__ == '__main__':
    main()
