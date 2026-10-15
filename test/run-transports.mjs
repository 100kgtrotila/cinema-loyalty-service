import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

const project = `loyalty-e2e-${process.pid}`;
const env = {
  ...process.env,
  E2E_PROJECT: project,
  LOYALTY_REPO: resolve('.'),
  MONOLITH_REPO: resolve('../cinema-platform-back'),
};
const compose = [
  'compose',
  '-p',
  project,
  '-f',
  resolve('../cinema-platform-back/docker-compose.yaml'),
  '-f',
  resolve('test/e2e/compose.override.yml'),
];
function capture(command, args) {
  const result = spawnSync(command, args, { env, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(result.stderr || `${command} exited ${result.status}`);
  return result.stdout.trim();
}
function run(command, args, childEnv = env) {
  const result = spawnSync(command, args, { env: childEnv, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited ${result.status}`);
}
function endpoint(service, port) {
  const address = capture('docker', [
    ...compose,
    'port',
    service,
    String(port),
  ]);
  if (!/^127\.0\.0\.1:\d+$/.test(address))
    throw new Error(`Nonlocal endpoint: ${address}`);
  return address;
}
mkdirSync('.tmp', { recursive: true });
for (const name of ['transports-results.json', 'transports-logs.txt']) {
  rmSync(resolve('.tmp', name), { force: true });
}
const versions = {
  loyalty: capture('git', ['rev-parse', 'HEAD']),
  monolith: capture('git', ['-C', env.MONOLITH_REPO, 'rev-parse', 'HEAD']),
};
writeFileSync(
  '.tmp/transports-versions.json',
  JSON.stringify(versions, null, 2),
);
try {
  const config = JSON.parse(
    capture('docker', [...compose, 'config', '--format', 'json']),
  );
  for (const [name, service] of Object.entries(config.services)) {
    if (service.profiles?.includes('manual-seed')) continue;
    if (service.volumes?.length)
      throw new Error(`Unexpected volume mount on ${name}`);
    if (
      service.ports?.some(
        (port) => port.host_ip !== '127.0.0.1' || port.published,
      )
    ) {
      throw new Error(`Ports must use random loopback bindings: ${name}`);
    }
  }
  run('docker', [...compose, 'build', 'monolith-api', 'loyalty-service']);
  run('docker', [
    ...compose,
    'up',
    '-d',
    '--wait',
    'cinema-db',
    'cinema-redis',
    'cinema-rabbitmq',
    'loyalty-db',
    'loyalty-redis',
  ]);
  run('docker', [...compose, 'run', '--rm', '--no-deps', 'monolith-migrate']);
  const databaseUrl = `postgresql://postgres:postgres@${endpoint('loyalty-db', 5432)}/cinema_loyalty_db`;
  const testEnv = {
    ...env,
    DATABASE_URL: databaseUrl,
    E2E_LOYALTY_DATABASE_URL: databaseUrl,
    E2E_MONOLITH_DATABASE_URL: `postgresql://postgres:postgres_password@${endpoint('cinema-db', 5432)}/cinema_local_db`,
    E2E_MONOLITH_REDIS_PORT: endpoint('cinema-redis', 6379).split(':')[1],
    E2E_RABBIT_URL: `amqp://guest:guest@${endpoint('cinema-rabbitmq', 5672)}`,
    E2E_RABBIT_HTTP: `http://${endpoint('cinema-rabbitmq', 15672)}`,
    E2E_COMPOSE_ARGS: JSON.stringify(compose),
    NODE_OPTIONS:
      `${process.env.NODE_OPTIONS ?? ''} --experimental-vm-modules`.trim(),
  };
  run(process.execPath, ['x', 'prisma', 'migrate', 'deploy'], testEnv);
  run('docker', [...compose, 'up', '-d', 'loyalty-service', 'monolith-api']);
  testEnv.E2E_MONOLITH_URL = `http://${endpoint('monolith-api', 8080)}`;
  testEnv.E2E_LOYALTY_URL = `http://${endpoint('loyalty-service', 3000)}`;
  run(
    process.execPath,
    [
      'run',
      'test',
      '--config',
      'test/e2e/jest-transports.json',
      '--runInBand',
      '--json',
      '--outputFile=.tmp/transports-results.json',
    ],
    testEnv,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  const logs = spawnSync(
    'docker',
    [...compose, 'logs', '--no-color', '--tail', '120'],
    { env, encoding: 'utf8' },
  );
  writeFileSync('.tmp/transports-logs.txt', logs.stdout ?? '');
  process.exitCode = 1;
} finally {
  const result = spawnSync(
    'docker',
    [...compose, 'down', '--volumes', '--remove-orphans'],
    { env, stdio: 'inherit' },
  );
  if (result.status !== 0) process.exitCode = 1;
}
