/**
 * IO module wiring: clipboard hooks, drag & drop overlay, autosave, recovery
 * check and the test API (window.__opullerIO).
 */
import './io.css';
import { registerViewportSlot } from '@/canvas/viewportSlots';
import { DropOverlay } from './DropOverlay';
import { installClipboard, handleDataTransfer, pasteTextContent, selectionSvg, smartPaste, pasteFromSystemClipboard } from './clipboard';
import { startAutosave, checkRecovery, saveAutosaveNow, loadAutosave, clearAutosave } from './autosave';
import { exportSvg, exportSvgAll, exportRegions, renderRegion, withTextOutlines, prettyPrintSvg, roundNumbers } from './svgExport';
import { importSvg, itemsToLayers, parseSvgLength } from './svgImport';
import { renderToCanvas, renderToDataUrl, renderToBlob, rasterizeAll, pixelSize } from './raster';
import { exportPdf } from './pdf';
import { serializeProject, parseProject, validateDocument, embedImages } from './project';
import { fontFaceCss } from './fontEmbed';
import { placeSvgText, placeImageBlob, placeText, placeFiles, placeItems, documentFromSvg, documentFromImage, saveDocument, loadDocument, newDocument, openDocumentFromFile, confirmDiscard, revertDocument } from './fileOps';
import { recentEntries, addRecent, loadRecent, clearRecent, removeRecent } from './recent';

installClipboard();
registerViewportSlot('html', 'io-drop', DropOverlay);
startAutosave();
void checkRecovery();

/** Programmatic access for tests and scripting. */
(window as any).__opullerIO = {
  exportSvg,
  exportSvgAll,
  exportRegions,
  renderRegion,
  withTextOutlines,
  prettyPrintSvg,
  roundNumbers,
  importSvg,
  itemsToLayers,
  parseSvgLength,
  renderToCanvas,
  renderToDataUrl,
  renderToBlob,
  rasterizeAll,
  pixelSize,
  exportPdf,
  serializeProject,
  parseProject,
  validateDocument,
  embedImages,
  fontFaceCss,
  placeSvgText,
  placeImageBlob,
  placeText,
  placeFiles,
  placeItems,
  documentFromSvg,
  documentFromImage,
  saveDocument,
  loadDocument,
  newDocument,
  openDocumentFromFile,
  confirmDiscard,
  revertDocument,
  handleDataTransfer,
  pasteTextContent,
  pasteFromSystemClipboard,
  smartPaste,
  selectionSvg,
  saveAutosaveNow,
  loadAutosave,
  clearAutosave,
  recentEntries,
  addRecent,
  loadRecent,
  clearRecent,
  removeRecent,
};
