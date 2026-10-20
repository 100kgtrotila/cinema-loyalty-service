import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const project = `loyalty-rmq-${process.pid}`;
const compose = ['compose', '-p', project, '-f', 'test/docker-compose.rmq.yml'];
const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, {
    env,
    stdio: 'inherit',
    timeout: 480000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited ${result.status}`);
};
const capture = (args) => {
  const result = spawnSync('docker', [...compose, ...args], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (result.status !== 0) throw new Error('Local fixture inspection failed');
  return result.stdout.trim();
};
const endpoint = (service, port) => {
  const address = capture(['port', service, String(port)]);
  if (!/^127\.0\.0\.1:\d+$/.test(address))
    throw new Error('Fixture must bind random loopback ports');
  return address;
};
mkdirSync('.tmp', { recursive: true });
try {
  const config = JSON.parse(capture(['config', '--format', 'json']));
  for (const service of Object.values(config.services)) {
    if (
      service.volumes?.length ||
      service.ports?.some((p) => p.host_ip !== '127.0.0.1' || p.published)
    )
      throw new Error('Unexpected shared fixture mount or port');
    if (!service.mem_limit || !service.cpus || !service.pids_limit)
      throw new Error('Fixture resource limits are required');
  }
  run('docker', [...compose, 'up', '-d', '--wait']);
  const database = `postgresql://loyalty_test:loyalty_test@${endpoint('postgres', 5432)}/loyalty_rmq`;
  const env = {
    ...process.env,
    DATABASE_URL: database,
    RMQ_TEST_DATABASE_URL: database,
    RMQ_TEST_RABBIT_URL: `amqp://loyalty_test:loyalty_test@${endpoint('rabbitmq', 5672)}`,
    RMQ_TEST_RABBIT_HTTP: `http://${endpoint('rabbitmq', 15672)}`,
    NODE_OPTIONS:
      `${process.env.NODE_OPTIONS ?? ''} --experimental-vm-modules`.trim(),
  };
  run(process.execPath, ['x', 'prisma', 'generate'], env);
  run(process.execPath, ['x', 'prisma', 'migrate', 'deploy'], env);
  run(process.execPath, ['run', 'build'], env);
  writeFileSync(
    '.tmp/rmq-fixture.json',
    JSON.stringify({ project, config, node: process.version }, null, 2),
  );
  run(
    'node',
    [
      resolve('node_modules/jest/bin/jest.js'),
      '--config',
      'test/rmq/jest-rmq.json',
      '--runInBand',
      '--json',
      '--outputFile=.tmp/rmq-results.json',
    ],
    env,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : 'RMQ fixture failed');
  process.exitCode = 1;
} finally {
  const result = spawnSync(
    'docker',
    [...compose, 'down', '--volumes', '--remove-orphans'],
    { stdio: 'inherit', timeout: 60000 },
  );
  if (result.status !== 0) process.exitCode = 1;
}
