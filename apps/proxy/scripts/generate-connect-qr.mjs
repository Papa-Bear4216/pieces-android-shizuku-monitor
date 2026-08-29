// Generates a "Scan to Connect" QR code PNG for the mobile app's Setup
// screen. Encodes {"baseUrl": "...", "token": "..."} as JSON — matches
// apps/mobile/src/lib/connectionQr.ts's parser exactly. Deliberately a
// standalone script (not inlined in the PowerShell dialog) so it stays easy
// to run manually or from a different OS's equivalent shortcut later.
//
// Usage: node generate-connect-qr.mjs <baseUrl> <token> <outputPngPath>

import QRCode from "qrcode";

const [, , baseUrl, token, outPath] = process.argv;

if (!baseUrl || !token || !outPath) {
  console.error("Usage: node generate-connect-qr.mjs <baseUrl> <token> <outputPngPath>");
  process.exit(1);
}

const payload = JSON.stringify({ baseUrl, token });

try {
  await QRCode.toFile(outPath, payload, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 400,
  });
  console.log(outPath);
} catch (err) {
  console.error("Failed to generate QR code:", err instanceof Error ? err.message : err);
  process.exit(1);
}
