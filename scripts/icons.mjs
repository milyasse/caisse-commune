// Génère les icônes PNG de la PWA à partir de web/icon.svg (nécessite sharp).
import { createRequire } from 'node:module';
const require = createRequire(process.env.SHARP_FROM ?? import.meta.url);
const sharp = require('sharp');
for (const s of [192, 512]) await sharp('web/icon.svg').resize(s, s).png().toFile(`web/icon-${s}.png`);
// iOS : 180×180, sans transparence (iOS arrondit lui-même les coins)
await sharp('web/icon.svg').resize(180, 180).flatten({ background: '#17633d' }).png().toFile('web/apple-touch-icon.png');
