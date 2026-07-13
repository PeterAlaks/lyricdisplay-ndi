/**
 * CLI argument parser for the NDI companion.
 */

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9137;
const DEFAULT_APP_URL = 'http://127.0.0.1:4000';

export function parseArgs(argv) {
  const args = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    appUrl: DEFAULT_APP_URL,
    hashRouting: true,
    authToken: '',
    userDataDir: '',
  };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host' && argv[i + 1]) {
      args.host = argv[++i];
    } else if (argv[i] === '--port' && argv[i + 1]) {
      const p = Number(argv[++i]);
      if (Number.isFinite(p) && p >= 1024 && p <= 65535) args.port = p;
    } else if (argv[i] === '--auth-token' && argv[i + 1]) {
      args.authToken = argv[++i];
    } else if (argv[i] === '--app-url' && argv[i + 1]) {
      args.appUrl = argv[++i];
    } else if (argv[i] === '--no-hash') {
      args.hashRouting = false;
    } else if (argv[i] === '--user-data-dir' && argv[i + 1]) {
      args.userDataDir = argv[++i];
    } else if (argv[i].startsWith('--user-data-dir=')) {
      args.userDataDir = argv[i].slice('--user-data-dir='.length);
    }
  }

  return args;
}
