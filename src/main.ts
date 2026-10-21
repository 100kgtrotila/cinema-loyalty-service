import { bootstrap } from './bootstrap/bootstrap';

if (require.main === module) {
  void bootstrap().catch(() => {
    process.exit(1);
  });
}
