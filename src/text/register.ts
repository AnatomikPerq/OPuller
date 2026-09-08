/**
 * Text module bootstrap: loads the bundled font CSS (via fonts.ts), restores
 * fonts uploaded by the user from IndexedDB and re-lays out text when web fonts
 * finish loading.
 */
import { initFonts } from './fonts';

initFonts();
