// Écrit le fichier Excel reconstitué (tests/fixtures/fichier-reel-reconstitue.xlsx).
import { writeFileSync } from 'node:fs';
import { fixtureWorkbook } from '../tests/fixtures/fichier-reel.ts';
writeFileSync(new URL('../tests/fixtures/fichier-reel-reconstitue.xlsx', import.meta.url), fixtureWorkbook());
console.log('tests/fixtures/fichier-reel-reconstitue.xlsx');
