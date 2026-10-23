import { decryptBackupFile } from '../backup/backup.js';

// Decrypts one backup file for a restore or drill:  decrypt-backup.js <encrypted file> <output>
const [file, out] = process.argv.slice(2);
try {
  if (!file || !out)
    throw new Error('usage: decrypt-backup.js <encrypted file> <output file>');
  await decryptBackupFile(file, process.env['BACKUP_KEY'] ?? '', out);
  console.log(`Decrypted ${file}.`);
} catch (error) {
  console.error(`Decrypt failed: ${(error as Error).message}`);
  process.exitCode = 1;
}
