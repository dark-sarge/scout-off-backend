import fs from 'fs';

export interface MigrationFiles {
  allFiles: string[];
  upFiles: string[];
}

export function getMigrationFiles(migrationsDir: string): MigrationFiles {
  const allFiles = fs
    .readdirSync(migrationsDir)
    .filter((filename) => filename.endsWith('.sql'))
    .sort();

  return {
    allFiles,
    upFiles: allFiles.filter((filename) => !filename.endsWith('.down.sql')),
  };
}
