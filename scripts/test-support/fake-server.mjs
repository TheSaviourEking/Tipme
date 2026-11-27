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
function server({ envName, envBody, composeName, stack, env: extraEnv }) {
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
    FAKE_WORKER: join(home, 'worker'),
    HEALTH_TRIES: '2',
    ...extraEnv(home),
  };
  /**
   * What GitHub Actions does before deploying: load the image(s) and copy that version's files.
   * `web`: a version with the self-hosted website (26 Nov 2026): its compose file names the web
   * image, and (unless `webImage: false`) that image is loaded too. Without it, a version from
   * before the website moved off Vercel.
   */
  const ship = (version, compose, { web = false, webImage = web } = {}) => {
    mkdirSync(join(home, 'releases', version), { recursive: true });
    const file =
      compose ??
      (web
        ? `services:\n  web:\n    image: tipme-web-${stack}:\${TIPME_VERSION}\n`
        : 'services: {}\n');
    writeFileSync(join(home, 'releases', version, composeName), file);
    writeFileSync(env.FAKE_IMAGES, `tipme-app:${version}\n`, { flag: 'a' });
    if (webImage)
      writeFileSync(env.FAKE_IMAGES, `tipme-web-${stack}:${version}\n`, {
        flag: 'a',
      });
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
    envBody: `API_HOST=api.staging.example.test\nWEB_ORIGIN=https://staging.example.test\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_RUNTIME_PASSWORD=runtime-password-1234\nPOSTGRES_MIGRATOR_PASSWORD=migrator-password-1234\nPOSTGRES_BACKUP_PASSWORD=backup-password-1234\n`,
    composeName: 'compose.staging.yml',
    stack: 'staging',
    env: (home) => ({ FAKE_WEB: join(home, 'web-running') }),
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
# The website: \`up ... web\` runs it on that version.
if [[ " $* " == *" up "* && " $* " == *" web "* ]]; then echo "$TIPME_VERSION" > "$FAKE_WEB"; fi
# The worker: \`up\` runs it on that version; \`stop\` keeps its container (worker.stopped), which
# \`start\` runs again unchanged. Its version is in $FAKE_WORKER while it runs.
if [[ " $* " == *" up "* && " $* " == *" worker "* ]]; then echo "$TIPME_VERSION" > "$FAKE_WORKER"; rm -f "$FAKE_WORKER.stopped"; fi
if [[ " $* " == *" ps --services --status running "* ]]; then
  [[ -f "$FAKE_WORKER" ]] && echo worker
  [[ -f "$FAKE_RUNNING" ]] && echo api
  exit 0
fi
if [[ " $* " == *" stop "*" worker "* ]]; then [[ ! -f "$FAKE_WORKER" ]] || mv "$FAKE_WORKER" "$FAKE_WORKER.stopped"; exit 0; fi
if [[ " $* " == *" start "*" worker "* ]]; then [[ -f "$FAKE_WORKER.stopped" ]] || exit 1; mv "$FAKE_WORKER.stopped" "$FAKE_WORKER"; exit 0; fi
if [[ " $* " == *" run --rm migrate "* && -n "$FAKE_MIGRATE_FAILS" ]]; then exit 1; fi
if [[ "$1" == "inspect" ]]; then echo "tipme-staging_internal $([[ -f "$FAKE_ATTACHED" ]] && echo edge-staging)"; exit 0; fi
if [[ "$1 $2" == "network connect" ]]; then touch "$FAKE_ATTACHED"; exit 0; fi
# config --services: what the version's compose file defines (versions marked new add retention).
if [[ " $* " == *" config --services "* ]]; then
  printf 'api\nworker\ncaddy\nbackup\npostgres\n'
  if [[ " $FAKE_NEW_VERSIONS " == *" $TIPME_VERSION "* ]]; then echo retention; fi
  # The version's own compose file says whether it has the website.
  file=""; prev=""; for arg in "$@"; do [[ "$prev" == "-f" ]] && file=$arg; prev=$arg; done
  grep -q 'image: tipme-web-' "$file" 2>/dev/null && echo web
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
  // curl: healthy unless the running version is the broken one. The website answers /api/version
  // with the version it runs, unless it is FAKE_WEB_BROKEN.
  fake(
    'curl',
    `echo "curl \${!#}" >> "$FAKE_LOG"
if [[ "\${!#}" == */api/version ]]; then
  web=$(cat "$FAKE_WEB" 2>/dev/null) || exit 7
  [[ -n "$FAKE_WEB_BROKEN" && "$web" == "$FAKE_WEB_BROKEN" ]] && exit 22
  echo "{\\"version\\":\\"$web\\"}"
  exit 0
fi
running=$(cat "$FAKE_RUNNING" 2>/dev/null)
if [[ -n "$FAKE_BROKEN" && "$running" == "$FAKE_BROKEN" ]]; then exit 22; fi
case "$*" in *release*) echo "{\\"data\\":{\\"version\\":\\"$running\\"}}" ;; esac
exit 0`,
  );
  fake('sleep', 'exit 0');
  // The fake-binary writer is internal to this module.
  const rest = { ...s };
  delete rest.fake;
  return rest;
}

// Values are dummies; the tests check messages name settings, never these values.
export const PRODUCTION_ENV = {
  API_HOST: 'api.production.example.test',
  WEB_ORIGIN: 'https://www.production.example.test',
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
    stack: 'production',
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
# config: what Compose read for the switch, in each colour, unless a test says it read otherwise.
if [[ "$last" == "config" ]]; then
  echo "\${FAKE_COMPOSE_NOISE-}"
  [[ -z "$FAKE_COMPOSE_FAILS" ]] || { echo "\${FAKE_COMPOSE_NOISE-}" >&2; exit 1; }
  if [[ -n "\${FAKE_COMPOSE_LIVE+x}" ]]; then said=$FAKE_COMPOSE_LIVE; else
    said=$(grep -E '^PAYMENTS_LIVE_ENABLED=' "$TIPME_HOME/production.env" | cut -d= -f2-)
    said=\${said:-false}
  fi
  [[ -z "$said" ]] || printf '    environment:\\n      PAYMENTS_LIVE_ENABLED: "%b"\\n' "$said"
  exit 0
fi
if [[ " $* " == *" up "* ]]; then
  # Every service named (a colour's API and website start together).
  for name in "$@"; do
    case "$name" in
      api-blue|web-blue) v=$TIPME_BLUE_VERSION ;;
      api-green|web-green) v=$TIPME_GREEN_VERSION ;;
      worker-a|worker-b) echo "$TIPME_VERSION" > "$FAKE_STATE/$name"; continue ;;
      *) continue ;;
    esac
    [[ -n "$FAKE_UP_FAILS" && "$v" == "$FAKE_UP_FAILS" ]] && exit 1
    echo "$v" > "$FAKE_STATE/$name"
    rm -f "$FAKE_STATE/$name.stopped"
    # The edge's turn starts again with the colours in order (blue first), so the colour that was
    # already serving can still answer before the new one does.
    rm -f "$FAKE_STATE/turn" "$FAKE_STATE/webturn"
  done
  exit 0
fi
# What runs: every colour or worker with a state file.
if [[ " $* " == *" ps --services --status running "* ]]; then
  for f in "$FAKE_STATE"/api-blue "$FAKE_STATE"/api-green "$FAKE_STATE"/worker-a "$FAKE_STATE"/worker-b; do
    [[ -f "$f" ]] && basename "$f"
  done
  exit 0
fi
# \`stop\` keeps each named container (<name>.stopped); \`start\` runs it again unchanged, and fails
# for a service with no container (as Compose does) or when FAKE_START_FAILS is set.
if [[ " $* " == *" stop "* || " $* " == *" start "* ]]; then
  for name in "$@"; do
    [[ "$name" == api-* || "$name" == web-* || "$name" == worker-* ]] || continue
    if [[ " $* " == *" stop "* ]]; then
      [[ ! -f "$FAKE_STATE/$name" ]] || mv "$FAKE_STATE/$name" "$FAKE_STATE/$name.stopped"
    else
      [[ -z "$FAKE_START_FAILS" && -f "$FAKE_STATE/$name.stopped" ]] || exit 1
      mv "$FAKE_STATE/$name.stopped" "$FAKE_STATE/$name"
    fi
  done
  exit 0
fi
# exec into a colour's website: works only while it runs (the drain flag).
if [[ " $* " == *" exec "* ]]; then
  for name in "$@"; do [[ "$name" == web-* ]] && { [[ -f "$FAKE_STATE/$name" ]]; exit $?; }; done
  exit 0
fi
if [[ " $* " == *" run --rm migrate "* && -n "$FAKE_MIGRATE_FAILS" ]]; then exit 1; fi
# The SSH session running the deploy drops while the migrations run.
if [[ " $* " == *" run --rm migrate "* && -n "$FAKE_MIGRATE_HANGUP" ]]; then kill -HUP "$PPID"; exit 0; fi
exit 0`,
  );
  fake('git', 'echo "git $*" >> "$FAKE_LOG"; exit 1');
  // The website: the edge round-robins /api/version over the running web colours, skipping copies
  // of FAKE_WEB_BROKEN.
  fake(
    'curl',
    `url=\${!#}
if [[ "$url" == */api/version ]]; then
  webs=()
  for colour in blue green; do
    v=$(cat "$FAKE_STATE/web-$colour" 2>/dev/null) || continue
    [[ -n "$FAKE_WEB_BROKEN" && "$v" == "$FAKE_WEB_BROKEN" ]] && continue
    webs+=("$v")
  done
  if [[ \${#webs[@]} -eq 0 ]]; then echo "curl $url -> 503" >> "$FAKE_LOG"; exit 22; fi
  n=$(cat "$FAKE_STATE/webturn" 2>/dev/null || echo 0)
  echo $((n + 1)) > "$FAKE_STATE/webturn"
  v=\${webs[$((n % \${#webs[@]}))]}
  echo "curl $url -> $v" >> "$FAKE_LOG"
  echo "{\\"version\\":\\"$v\\"}"
  exit 0
fi
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
  fake('sleep', 'echo "sleep $*" >> "$FAKE_LOG"; exit 0');
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
  // The fake-binary writer is internal to this module.
  const rest = { ...s };
  delete rest.fake;
  return { ...rest, running, colours };
}
