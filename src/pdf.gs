/**
 * PDF blob to plain text, via Drive's PDF-to-Docs conversion.
 *
 * Apps Script has no PDF library. Uploading a PDF with a Google Docs target
 * mime type makes Drive convert it, and DocumentApp can then read the text.
 * For a text-layer PDF this is clean; it is not OCR and does not need to be.
 *
 * The temporary Doc is a copy of a document containing patient data, so it
 * is deleted outright rather than trashed, in a finally block so a failure
 * while reading still removes it.
 */
function pdfToText(blob) {
  // Drive advanced service v2: the method is `insert` (not v3's `create`) and
  // the title field is `title` (not v3's `name`). v2 is what the Apps Script
  // editor offers, and it is stable — do not "modernise" these names without
  // also changing the version in appsscript.json.
  var tempFile = Drive.Files.insert(
    {
      title: 'tmp-pdf-extract-' + Utilities.getUuid(),
      mimeType: MimeType.GOOGLE_DOCS
    },
    blob
  );

  try {
    return DocumentApp.openById(tempFile.id).getBody().getText();
  } finally {
    try {
      Drive.Files.remove(tempFile.id);
    } catch (err) {
      // Never let cleanup failure mask the real outcome — but do make it
      // visible, since an orphaned copy holds patient data.
      console.error('Temporary Doc cleanup failed for ' + tempFile.id + ': ' + err);
    }
  }
}
