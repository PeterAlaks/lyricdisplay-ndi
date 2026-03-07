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
  };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host' && argv[i + 1]) {
      args.host = argv[++i];
    } else if (argv[i] === '--port' && argv[i + 1]) {
      const p = Number(argv[++i]);
      if (Number.isFinite(p) && p >= 1024 && p <= 65535) args.port = p;
    } else if (argv[i] === '--app-url' && argv[i + 1]) {
      args.appUrl = argv[++i];
    } else if (argv[i] === '--no-hash') {
      args.hashRouting = false;
    }
  }

  return args;
}
