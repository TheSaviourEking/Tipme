import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The real server scripts (deploy/scripts), with docker, git, curl and sleep replaced by
// stand-ins that record what they were asked and simulate a healthy or broken version.
// Images are built and shipped by GitHub Actions: the server never builds or fetches code.
// Shared by deploy-scripts.test.mjs (staging) and deploy-production.test.mjs.
const SCRIPTS = resolve('deploy/scripts');

/** A temp $TIPME_HOME with a bin/ of fakes ahead of the real PATH. */
function server({ envName, envBody, composeName, env: extraEnv }) {
  const home = mkdtempSync(join(tmpdir(), 'tipme-deploy-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(home, envName), envBody);
  const fake = (name, body) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    TIPME_HOME: home,
    FAKE_LOG: join(home, 'calls.log'),
    FAKE_RUNNING: join(home, 'running'),
    FAKE_IMAGES: join(home, 'images'),
    FAKE_ATTACHED: join(home, 'attached'),
    HEALTH_TRIES: '2',
    ...extraEnv(home),
  };
  /** What GitHub Actions does before deploying: load the image and copy that version's files. */
  const ship = (version, compose = 'services: {}\n') => {
    mkdirSync(join(home, 'releases', version), { recursive: true });
    writeFileSync(join(home, 'releases', version, composeName), compose);
    writeFileSync(env.FAKE_IMAGES, `tipme-app:${version}\n`, { flag: 'a' });
  };
  const run = (script, args = [], extra = {}) =>
    spawnSync('bash', [join(SCRIPTS, script), ...args], {
      env: { ...env, ...extra },
      encoding: 'utf8',
    });
  const read = (file) => {
    try {
      return readFileSync(join(home, file), 'utf8');
    } catch {
      return '';
    }
  };
  const exists = (file) => existsSync(join(home, file));
  return { run, read, ship, exists, home, fake };
}

/** Staging: one Compose project, one API, the edge reached through edge-staging. */
export function stage({ password = 'hexpassword0123456789abcdef' } = {}) {
  const s = server({
    envName: 'staging.env',
    envBody: `API_HOST=api.staging.example.test\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_RUNTIME_PASSWORD=runtime-password-1234\nPOSTGRES_MIGRATOR_PASSWORD=migrator-password-1234\nPOSTGRES_BACKUP_PASSWORD=backup-password-1234\n`,
    composeName: 'compose.staging.yml',
    env: () => ({}),
  });
  const { fake } = s;
  // docker: log every call; `compose ... up ... api` makes TIPME_VERSION the running version;
  // `image inspect/rm` use a list of loaded images.
  fake(
    'docker',
    `echo "docker $* | version=$TIPME_VERSION confirm=$MIGRATE_CONFIRM_DATABASE backup=$MIGRATE_BACKUP_DONE" >> "$FAKE_LOG"
if [[ "$1 $2" == "network inspect" ]]; then [[ -z "$FAKE_NO_EDGE" ]]; exit $?; fi
if [[ "$1 $2" == "image inspect" ]]; then grep -qx "$3" "$FAKE_IMAGES" 2>/dev/null; exit $?; fi
if [[ "$1 $2" == "image rm" ]]; then grep -vx "$3" "$FAKE_IMAGES" > "$FAKE_IMAGES.tmp"; mv "$FAKE_IMAGES.tmp" "$FAKE_IMAGES"; exit 0; fi
if [[ " $* " == *" up "* && " $* " == *" api "* ]]; then
  echo "$TIPME_VERSION" > "$FAKE_RUNNING"
  # Versions from before the edge move leave their API off edge-staging.
  if [[ " $FAKE_PREMOVE_VERSIONS " == *" $TIPME_VERSION "* ]]; then rm -f "$FAKE_ATTACHED"; else touch "$FAKE_ATTACHED"; fi
fi
if [[ " $* " == *" ps -q api "* ]]; then echo api-container; exit 0; fi
if [[ "$1" == "inspect" ]]; then echo "tipme-staging_internal $([[ -f "$FAKE_ATTACHED" ]] && echo edge-staging)"; exit 0; fi
if [[ "$1 $2" == "network connect" ]]; then touch "$FAKE_ATTACHED"; exit 0; fi
# config --services: what the version's compose file defines (versions marked new add retention).
if [[ " $* " == *" config --services "* ]]; then
  printf 'api\nworker\ncaddy\nbackup\npostgres\n'
  if [[ " $FAKE_NEW_VERSIONS " == *" $TIPME_VERSION "* ]]; then echo retention; fi
fi
exit 0`,
  );
  fake('git', 'echo "git $*" >> "$FAKE_LOG"; exit 1');
  // lib.sh checks that backups are owned by the image user (uid 1000). The temp dir is not.
  fake(
    'stat',
    `if [[ "$1" == "-c" && "$2" == "%u" ]]; then echo "\${FAKE_STAT_UID:-1000}"; exit 0; fi
echo "unexpected stat $*" >&2
exit 1`,
  );
  // curl: healthy unless the running version is the broken one.
  fake(
    'curl',
    `running=$(cat "$FAKE_RUNNING" 2>/dev/null)
if [[ -n "$FAKE_BROKEN" && "$running" == "$FAKE_BROKEN" ]]; then exit 22; fi
case "$*" in *release*) echo "{\\"data\\":{\\"version\\":\\"$running\\"}}" ;; esac
exit 0`,
  );
  fake('sleep', 'exit 0');
  const { fake: _fake, ...rest } = s;
  return rest;
}

// Values are dummies; the tests check messages name settings, never these values.
export const PRODUCTION_ENV = {
  API_HOST: 'api.production.example.test',
  DATABASE_URL: 'postgres://runtime:dummy-runtime-url@db.example.test/tipme',
  MIGRATION_DATABASE_URL:
    'postgres://migrator:dummy-migrator-url@db.example.test/tipme',
  DATABASE_ADMIN_URL: 'postgres://admin:dummy-admin-url@db.example.test/tipme',
  POSTGRES_RUNTIME_PASSWORD: 'runtime-password-1234',
  POSTGRES_MIGRATOR_PASSWORD: 'migrator-password-1234',
  POSTGRES_BACKUP_PASSWORD: 'backup-password-1234',
  MIGRATE_CONFIRM_DATABASE: 'tipme',
  MIGRATE_BACKUP_DONE: '',
  TIPME_VERSION: '',
  TIPME_BLUE_VERSION: '',
  TIPME_GREEN_VERSION: '',
};

/**
 * Production: two API colours behind a round-robin edge, two workers, Redis, Aiven outside.
 * docker logs every call with the versions and home it was given; `up api-<colour>` starts that
 * colour on TIPME_<COLOUR>_VERSION, `stop api-<colour>` stops it. curl answers from the running
 * colours in turn (as the edge does), skipping copies of FAKE_BROKEN (they never get ready).
 */
export function stageProduction({ env: overrides = {}, caFile = true } = {}) {
  const settings = { ...PRODUCTION_ENV, ...overrides };
  const envBody = Object.entries(settings)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}=${value}\n`)
    .join('');
  const s = server({
    envName: 'production.env',
    envBody,
    composeName: 'compose.production.yml',
    env: (home) => ({
      TIPME_STACK: 'production',
      FAKE_STATE: join(home, 'fake'),
      HEALTH_TRIES: '4',
    }),
  });
  const { fake, home } = s;
  mkdirSync(join(home, 'fake'));
  if (caFile) writeFileSync(join(home, 'db-ca.pem'), 'dummy certificate\n');
  fake(
    'docker',
    `echo "docker $* | version=\${TIPME_VERSION-UNSET} blue=\${TIPME_BLUE_VERSION-UNSET} green=\${TIPME_GREEN_VERSION-UNSET} home=\${TIPME_HOME-UNSET} confirm=$MIGRATE_CONFIRM_DATABASE backup=$MIGRATE_BACKUP_DONE" >> "$FAKE_LOG"
if [[ "$1 $2" == "network inspect" ]]; then [[ -z "$FAKE_NO_EDGE" ]]; exit $?; fi
if [[ "$1 $2" == "image inspect" ]]; then grep -qx "$3" "$FAKE_IMAGES" 2>/dev/null; exit $?; fi
if [[ "$1 $2" == "image rm" ]]; then grep -vx "$3" "$FAKE_IMAGES" > "$FAKE_IMAGES.tmp"; mv "$FAKE_IMAGES.tmp" "$FAKE_IMAGES"; exit 0; fi
[[ "$1" == "compose" ]] || exit 0
last=\${!#}
if [[ " $* " == *" up "* ]]; then
  case "$last" in
    api-blue) v=$TIPME_BLUE_VERSION ;;
    api-green) v=$TIPME_GREEN_VERSION ;;
    worker-a|worker-b) echo "$TIPME_VERSION" > "$FAKE_STATE/$last"; exit 0 ;;
    *) exit 0 ;;
  esac
  [[ -n "$FAKE_UP_FAILS" && "$v" == "$FAKE_UP_FAILS" ]] && exit 1
  echo "$v" > "$FAKE_STATE/$last"
  # The edge's turn starts again with the colours in order (blue first), so the colour that was
  # already serving can still answer before the new one does.
  rm -f "$FAKE_STATE/turn"
  exit 0
fi
if [[ " $* " == *" stop "* ]]; then rm -f "$FAKE_STATE/$last"; exit 0; fi
if [[ " $* " == *" run --rm migrate "* && -n "$FAKE_MIGRATE_FAILS" ]]; then exit 1; fi
exit 0`,
  );
  fake('git', 'echo "git $*" >> "$FAKE_LOG"; exit 1');
  fake(
    'curl',
    `url=\${!#}
serving=()
for colour in blue green; do
  v=$(cat "$FAKE_STATE/api-$colour" 2>/dev/null) || continue
  [[ -n "$FAKE_BROKEN" && "$v" == "$FAKE_BROKEN" ]] && continue
  serving+=("$v")
done
if [[ \${#serving[@]} -eq 0 ]]; then echo "curl $url -> 503" >> "$FAKE_LOG"; exit 22; fi
case "$url" in
  */health/release)
    n=$(cat "$FAKE_STATE/turn" 2>/dev/null || echo 0)
    echo $((n + 1)) > "$FAKE_STATE/turn"
    v=\${serving[$((n % \${#serving[@]}))]}
    echo "curl $url -> $v" >> "$FAKE_LOG"
    echo "{\\"data\\":{\\"version\\":\\"$v\\"}}" ;;
  *) echo "curl $url -> 200" >> "$FAKE_LOG" ;;
esac
exit 0`,
  );
  fake('sleep', 'exit 0');
  /** Which version each colour or worker runs now ('' when stopped). */
  const running = (service) => s.read(`fake/${service}`).trim();
  const colours = () =>
    Object.fromEntries(
      s
        .read('releases/colours')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('=')),
    );
  const { fake: _fake, ...rest } = s;
  return { ...rest, running, colours };
}
