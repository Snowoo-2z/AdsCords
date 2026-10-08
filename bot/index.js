/**
 * Point d'entrée JavaScript pour KataBump.
 * KataBump lance un fichier JS depuis l'onglet Startup ; tsx charge ensuite le bot TypeScript.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const workingDirectory = dirname(fileURLToPath(import.meta.url));
const bot = spawn(process.execPath, ['--import', 'tsx', 'bot.ts'], {
  cwd: workingDirectory,
  stdio: 'inherit'
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => bot.kill(signal));
}

bot.once('error', (error) => {
  console.error('[AdsCords] Impossible de démarrer le bot.', error);
  process.exitCode = 1;
});

bot.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
