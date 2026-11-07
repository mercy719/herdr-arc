// Images on a todo. A pasted or dropped image is copied into the app's folder, because image() draws only from there.
// No Herdr imports, so node --test can load it; exec is passed in. Adapted from claude-chat's images.js (MIT).
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// pbpaste can't read images: take the clipboard's PNG, or turn its TIFF into one.
const READ_CLIPBOARD = `ObjC.import("AppKit");
function run(argv) {
  var board = $.NSPasteboard.generalPasteboard;
  var data = board.dataForType("public.png");
  if (data.isNil()) {
    var tiff = board.dataForType("public.tiff");
    if (tiff.isNil()) return "none";
    var rep = $.NSBitmapImageRep.imageRepWithData(tiff);
    if (rep.isNil()) return "none";
    data = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
  }
  return data.writeToFileAtomically(argv[0], true) ? "ok" : "none";
}`;

export const IMAGE_FOLDER = "board-images";
export const isImagePath = (path) => IMAGE.test(String(path ?? "")) && !CONTROL.test(path);
const dir = (home) => `${home}/${IMAGE_FOLDER}`;
const fresh = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export async function clipboardImage(exec, home) {
  const path = `${dir(home)}/${fresh()}.png`;
  await exec("mkdir", ["-p", "-m", "700", dir(home)]);
  const r = await exec("osascript", ["-l", "JavaScript", "-e", READ_CLIPBOARD, path]);
  return r.code === 0 && r.stdout.trim() === "ok" ? path : null;
}

export async function droppedImage(exec, home, path) {
  const copy = `${dir(home)}/${fresh()}${path.slice(path.lastIndexOf(".")).toLowerCase()}`;
  await exec("mkdir", ["-p", "-m", "700", dir(home)]).catch(() => null);
  const r = await exec("cp", ["--", path, copy]).catch(() => null);
  return r?.code === 0 ? copy : null;
}

// The home-relative path image() wants, or null for a file outside the folder.
export const previewPath = (home, path) =>
  String(path).startsWith(`${dir(home)}/`) && !String(path).includes("/../") ? path.slice(home.length + 1) : null;

// Claude Code reads image paths on their own lines as attachments.
export const withImages = (text, images) => [text, ...images].filter(Boolean).join("\n");
