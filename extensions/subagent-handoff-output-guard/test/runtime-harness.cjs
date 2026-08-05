const JSZip = require("jszip");

const OOXML_PARTS = Object.freeze({
  ".docx": {
    mainMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    partPath: "word/document.xml",
  },
  ".pptx": {
    mainMime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    partPath: "ppt/presentation.xml",
  },
  ".xlsx": {
    mainMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    partPath: "xl/workbook.xml",
  },
});

async function detectMime({ buffer }) {
  const { fileTypeFromBuffer } = await import("file-type");
  const detected = await fileTypeFromBuffer(buffer);
  return detected?.mime;
}

async function createOoxmlBuffer(extension) {
  const definition = OOXML_PARTS[extension];
  if (!definition) return null;
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<Types><Override PartName="/${definition.partPath}" ContentType="${definition.mainMime}.main+xml"/></Types>`,
  );
  zip.file(definition.partPath, "<xml/>");
  return zip.generateAsync({ type: "nodebuffer" });
}

function createRuntime() {
  return {
    media: {
      detectMime,
    },
  };
}

module.exports = {
  createOoxmlBuffer,
  createRuntime,
};
