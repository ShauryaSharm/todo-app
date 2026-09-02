import admin from "firebase-admin";

// FIREBASE_SERVICE_ACCOUNT arrives from a Vercel env var, which is a lossy channel: the
// outer braces sometimes get dropped when pasting, a BOM can ride along from Notepad, the
// whole thing is occasionally base64'd, and private_key routinely arrives with literal
// "\n" instead of newlines. Repair all four rather than failing with "Unexpected token".
export function initAdmin() {
  if (admin.apps.length) return admin;

  const stripBOM = (s) => s.replace(/^﻿/, "");
  const raw = stripBOM((process.env.FIREBASE_SERVICE_ACCOUNT || "").trim());

  const candidates = [
    raw,
    `{${raw}}`,
    () => stripBOM(Buffer.from(raw, "base64").toString("utf8").trim()),
  ];
  let serviceAccount, jsonErr;
  for (const c of candidates) {
    try { serviceAccount = JSON.parse(typeof c === "function" ? c() : c); break; }
    catch (e) { jsonErr = jsonErr || e; }
  }
  if (!serviceAccount) {
    // Say what was actually received. A bare parse error here has cost hours before.
    const codes = [...raw.slice(0, 4)].map((ch) => ch.charCodeAt(0)).join(",");
    throw new Error(
      `service account unparseable: jsonError="${jsonErr && jsonErr.message}"; ` +
      `len=${raw.length}; firstCharCodes=[${codes}]; hasPrivateKey=${raw.includes("private_key")}`
    );
  }
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\n/g, "\n");
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return admin;
}
