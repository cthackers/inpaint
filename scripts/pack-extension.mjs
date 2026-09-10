// Packs the browser extension into a ZIP archive (unzip, then "Load unpacked") and a CRX3 file signed with
// an RSA key (drag and drop onto chrome://extensions).
// Usage: node scripts/pack-extension.mjs <extension folder> <key.pem> <output folder>
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { deflateRawSync } from "node:zlib";

const [source, keyPath, output] = process.argv.slice(2).map((path) => path && resolve(path));
if (!source || !keyPath || !output) {
  console.error("Usage: node scripts/pack-extension.mjs <extension folder> <key.pem> <output folder>");
  process.exit(2);
}
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

// Notes, npm metadata, keys and earlier packages stay out of the package.
const SKIPPED = [/^\./, /\.md$/i, /^package(-lock)?\.json$/, /^node_modules$/, /\.pem$/, /\.crx$/, /\.zip$/];

function listFiles(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED.some((pattern) => pattern.test(entry.name))) return [];
    const path = join(folder, entry.name);
    return entry.isDirectory() ? listFiles(path) : entry.isFile() ? [path] : [];
  });
}

const names = listFiles(source).map((path) => relative(source, path).split(sep).join("/")).sort();
const manifestPath = join(source, "manifest.json");
if (!names.includes("manifest.json")) fail(`No manifest.json in ${source}`);
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  fail(`manifest.json is not valid JSON: ${error.message}`);
}

// Files the manifest names must be in the package, or the browser refuses to load it.
const icons = (value) => (value && typeof value === "object" ? Object.values(value) : [value]);
const referenced = [
  ...icons(manifest.icons),
  ...icons(manifest.action?.default_icon),
  manifest.action?.default_popup,
  manifest.background?.service_worker,
  manifest.options_page,
  manifest.options_ui?.page,
  manifest.side_panel?.default_path,
  manifest.devtools_page,
  ...(manifest.content_scripts ?? []).flatMap((script) => [...(script.js ?? []), ...(script.css ?? [])]),
].filter((path) => typeof path === "string").map((path) => path.replace(/^\/+/, ""));
const missing = [...new Set(referenced)].filter((path) => !names.includes(path));
if (missing.length) fail(`manifest.json names files that are not in the package:\n  ${missing.join("\n  ")}`);

const CRC_TABLE = Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Every entry gets the same 1980-01-01 timestamp, so unchanged files give an identical archive.
function zip(entries) {
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const path = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    const method = deflated.length < data.length ? 8 : 0;
    const body = method ? deflated : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(path.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made on Unix, zip 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(path.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
    central.writeUInt32LE(offset, 42);
    parts.push(local, path, body);
    directory.push(central, path);
    offset += local.length + path.length + body.length;
  }
  const listing = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(listing.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, listing, end]);
}

function varint(value) {
  const bytes = [];
  for (; value > 0x7f; value = Math.floor(value / 128)) bytes.push((value % 128) | 0x80);
  bytes.push(value);
  return Buffer.from(bytes);
}

const bytesField = (number, bytes) => Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);

const crxIdOf = (publicKey) => createHash("sha256").update(publicKey).digest().subarray(0, 16);
// Extension ids spell the CRX id's hex digits with the letters a-p.
const extensionIdOf = (publicKey) =>
  [...crxIdOf(publicKey).toString("hex")].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("");

// CRX3: "Cr24", version 3, the header length, a CrxFileHeader protobuf, then the ZIP archive. The header
// holds the public key and an RSA-SHA256 signature over "CRX3 SignedData\0", the length of the signed
// header data, that data (the CRX id: the first 16 bytes of the public key's SHA-256) and the archive.
function crx(archive, privateKey, publicKey) {
  const signedData = bytesField(1, crxIdOf(publicKey));
  const signedLength = Buffer.alloc(4);
  signedLength.writeUInt32LE(signedData.length);
  const signature = sign("sha256", Buffer.concat([Buffer.from("CRX3 SignedData\0", "latin1"), signedLength, signedData, archive]), privateKey);
  const header = Buffer.concat([
    bytesField(2, Buffer.concat([bytesField(1, publicKey), bytesField(2, signature)])), // sha256_with_rsa
    bytesField(10000, signedData), // signed_header_data
  ]);
  const prefix = Buffer.alloc(12);
  prefix.write("Cr24", 0, "latin1");
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, archive]);
}

function writeAtomically(path, data) {
  const staged = `${path}.partial-${process.pid}`;
  writeFileSync(staged, data, { mode: 0o644 });
  renameSync(staged, path);
}

// The extension's ID is fixed by the manifest's "key" (the public key): an unpacked copy takes its ID from
// that field and a CRX from the key that signs it. Builds must sign with the matching private key, so every
// package keeps the ID and installs as an update of the copy people already have.
const pinned = typeof manifest.key === "string" ? Buffer.from(manifest.key.replace(/\s+/g, ""), "base64") : null;
if (!existsSync(keyPath)) {
  if (pinned) {
    fail(`manifest.json fixes the extension ID ${extensionIdOf(pinned)}, but its signing key is not at ${keyPath}.
Copy extension-key.pem from the machine that made it, or pass --key FILE. Loading the folder unpacked keeps working without it.`);
  }
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  console.log(`Created the signing key ${keyPath}. Keep it private and back it up: updates must be signed with it.`);
}
let privateKey;
try {
  privateKey = createPrivateKey(readFileSync(keyPath));
} catch (error) {
  fail(`Cannot read the signing key ${keyPath}: ${error.message}`);
}
if (privateKey.asymmetricKeyType !== "rsa") fail(`${keyPath} is not an RSA key`);
const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
const id = extensionIdOf(publicKey);
if (pinned && !pinned.equals(publicKey)) {
  fail(`${keyPath} would sign the extension as ID ${id}, but manifest.json fixes ID ${extensionIdOf(pinned)}.
Build with the key that made it (--key FILE): installed copies cannot update to a package with another ID.`);
}
if (!pinned) {
  const text = readFileSync(manifestPath, "utf8");
  const indent = text.match(/\n([ \t]+)"/)?.[1] ?? "  ";
  const encoded = publicKey.toString("base64");
  const updated = text.replace(/^\s*\{/, (brace) => `${brace}\n${indent}"key": "${encoded}",`);
  let written;
  try {
    written = JSON.parse(updated).key;
  } catch {}
  if (written !== encoded) fail(`Could not add "key" to manifest.json. Add it yourself: "key": "${encoded}"`);
  writeFileSync(manifestPath, updated);
  console.log(`Fixed the extension ID ${id} with a "key" field in manifest.json. Commit that change.`);
}

const archive = zip(names.map((name) => ({ name, data: readFileSync(join(source, name)) })));
mkdirSync(output, { recursive: true });
const zipPath = join(output, "inpaint-extension.zip");
const crxPath = join(output, "inpaint-extension.crx");
writeAtomically(zipPath, archive);
writeAtomically(crxPath, crx(archive, privateKey, publicKey));
console.log(`Packed ${names.length} files of ${manifest.name ?? "the extension"} ${manifest.version ?? ""}`.trimEnd());
console.log(`  ${crxPath}`);
console.log(`  ${zipPath}`);
console.log(`Extension ID: ${id}`);
