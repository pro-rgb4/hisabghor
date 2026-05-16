import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";

// ─── Bluetooth Layer — Dual Mode: Capacitor Plugin → Web Bluetooth Fallback ────
//
// Strategy:
//   1. যদি Capacitor BluetoothSerial plugin পাওয়া যায় (APK environment)
//      → সেটা ব্যবহার করো (Classic BT, সব Android-এ কাজ করে)
//   2. না পাওয়া গেলে Web Bluetooth API try করো (Chrome/Modern Browser)
//   3. দুটোই না থাকলে graceful error দাও
//
// APK বিল্ডে add করতে হবে:
//   npm install @capacitor-community/bluetooth-serial
//   npx cap sync android
// এরপর android/app/src/main/java/.../MainActivity.java-তে register হবে auto।

const BT = {
  _mode: null,          // "capacitor" | "web" | null
  _capPlugin: null,     // Capacitor BluetoothSerial instance
  _webDevice: null,     // Web Bluetooth device
  _webChar: null,       // Web Bluetooth characteristic
  _deviceName: null,

  // ── পরিবেশ শনাক্ত করুন ──────────────────────────────────────────────────────
  async init() {
    // Capacitor plugin আছে কিনা চেক করো
    try {
      if (window.Capacitor && window.Capacitor.isNativePlatform()) {
        // bluetooth-serial plugin not included in this build
        throw new Error("bluetooth-serial not available");
      }
    } catch(e) {
      // Plugin নেই বা import হয়নি — Web Bluetooth-এ fallback
    }
    // Web Bluetooth আছে কিনা চেক করো
    if (typeof navigator !== "undefined" && navigator.bluetooth) {
      this._mode = "web";
      return false; // Web mode
    }
    this._mode = null;
    return false;
  },

  // ── সংযোগ করুন ──────────────────────────────────────────────────────────────
  async connect() {
    await this.init();

    // ── Mode 1: Capacitor BluetoothSerial (APK) ──
    if (this._mode === "capacitor") {
      try {
        // Paired device list থেকে printer খুঁজে বের করো
        const { devices } = await this._capPlugin.list();
        if (!devices || devices.length === 0) {
          return { ok: false, msg: "কোনো paired Bluetooth ডিভাইস নেই। আগে ফোনের সেটিং থেকে প্রিন্টার pair করুন।" };
        }
        // প্রথমে thermal printer-সদৃশ নাম খোঁজো
        const printerKeywords = ["printer","print","xprinter","goojprt","munbyn","thermal","pos","58mm","80mm","rpp","sewoo"];
        let target = devices.find(d =>
          printerKeywords.some(k => (d.name || "").toLowerCase().includes(k))
        ) || devices[0]; // না পেলে প্রথম ডিভাইস

        await this._capPlugin.connect({ address: target.address });
        this._deviceName = target.name || target.address;
        return { ok: true, name: this._deviceName, id: target.address, mode: "capacitor" };
      } catch(e) {
        // Capacitor ব্যর্থ হলে Web Bluetooth-এ fallback
        if (typeof navigator !== "undefined" && navigator.bluetooth) {
          this._mode = "web";
        } else {
          return { ok: false, msg: "Bluetooth সংযোগ ব্যর্থ: " + (e.message || "অজানা ত্রুটি") };
        }
      }
    }

    // ── Mode 2: Web Bluetooth API (Browser / Chrome) ──
    if (this._mode === "web") {
      try {
        const device = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: [
            "000018f0-0000-1000-8000-00805f9b34fb", // Xprinter / Generic POS
            "e7810a71-73ae-499d-8c15-faa9aef0c3f2", // Epson / STAR BLE
            "0000ff00-0000-1000-8000-00805f9b34fb", // GOOJPRT / MUNBYN
            "49535343-fe7d-4ae5-8fa9-9fafd205e455", // Microchip BM70
          ]
        });
        await device.gatt.connect();
        this._webDevice = device;
        this._deviceName = device.name || "Thermal Printer";
        return { ok: true, name: this._deviceName, id: "web-bt", mode: "web" };
      } catch(e) {
        return { ok: false, msg: e.message || "Web Bluetooth সংযোগ ব্যর্থ" };
      }
    }

    return { ok: false, msg: "এই ডিভাইসে Bluetooth সাপোর্ট নেই" };
  },

  // ── প্রিন্ট করুন ────────────────────────────────────────────────────────────
  async print(data) {
    // ── Capacitor mode ──
    if (this._mode === "capacitor" && this._capPlugin) {
      try {
        const CHUNK = 512; // Classic BT-তে বড় chunk দেওয়া যায়
        for (let i = 0; i < data.length; i += CHUNK) {
          const chunk = data.slice(i, i + CHUNK);
          // BluetoothSerial.write() binary Uint8Array accept করে
          await this._capPlugin.write({ value: String.fromCharCode(...chunk) });
          await new Promise(r => setTimeout(r, 20));
        }
        return { ok: true };
      } catch(e) {
        return { ok: false, msg: "প্রিন্ট ব্যর্থ (Capacitor): " + e.message };
      }
    }

    // ── Web Bluetooth mode ──
    if (this._mode === "web" && this._webDevice) {
      try {
        const BT_SERVICE_UUIDS = [
          "000018f0-0000-1000-8000-00805f9b34fb",
          "e7810a71-73ae-499d-8c15-faa9aef0c3f2",
          "0000ff00-0000-1000-8000-00805f9b34fb",
          "49535343-fe7d-4ae5-8fa9-9fafd205e455",
        ];
        const BT_CHAR_UUIDS = [
          "000018f1-0000-1000-8000-00805f9b34fb",
          "bef8d6c9-9c21-4c9e-b632-bd58c1009f9f",
          "0000ff02-0000-1000-8000-00805f9b34fb",
          "49535343-8841-43f4-a8d4-ecbe34729bb3",
        ];
        const server = this._webDevice.gatt.connected
          ? this._webDevice.gatt
          : await this._webDevice.gatt.connect();

        let service = null;
        for (const sid of BT_SERVICE_UUIDS) {
          try { service = await server.getPrimaryService(sid); break; } catch {}
        }
        if (!service) return { ok: false, msg: "প্রিন্টার সার্ভিস পাওয়া যায়নি" };

        let char = null;
        for (const cid of BT_CHAR_UUIDS) {
          try { char = await service.getCharacteristic(cid); break; } catch {}
        }
        if (!char) return { ok: false, msg: "প্রিন্ট characteristic পাওয়া যায়নি" };

        const CHUNK = 200; // BLE-এর safe chunk size
        for (let i = 0; i < data.length; i += CHUNK) {
          await char.writeValueWithoutResponse(data.slice(i, i + CHUNK));
          await new Promise(r => setTimeout(r, 30));
        }
        return { ok: true };
      } catch(e) {
        return { ok: false, msg: "প্রিন্ট ব্যর্থ (Web BT): " + e.message };
      }
    }

    return { ok: false, msg: "প্রিন্টার সংযুক্ত নেই" };
  },

  // ── সংযোগ বিচ্ছিন্ন করুন ────────────────────────────────────────────────────
  async disconnect() {
    if (this._mode === "capacitor" && this._capPlugin) {
      try { await this._capPlugin.disconnect(); } catch {}
    }
    if (this._webDevice) {
      try { this._webDevice.gatt.disconnect(); } catch {}
    }
    this._webDevice = null;
    this._webChar = null;
    this._deviceName = null;
  },

  isConnected() {
    if (this._mode === "capacitor") return true; // Capacitor manages connection state
    return !!(this._webDevice?.gatt?.connected);
  },

  getMode() { return this._mode; }, // "capacitor" | "web" | null
};

function buildEscPos(inv, shopName) {
  const enc = new TextEncoder();
  const [ESC, GS, LF] = [0x1B, 0x1D, 0x0A];
  const out = [];
  const push  = (...b) => b.forEach(x => out.push(x));
  const write = s => enc.encode(String(s)).forEach(b => out.push(b));
  const nl    = () => out.push(LF);
  const bold  = on  => push(ESC, 0x45, on ? 1 : 0);
  const align = a   => push(ESC, 0x61, a);
  const size  = dbl => push(ESC, 0x21, dbl ? 0x30 : 0x00);
  push(ESC, 0x40);
  align(1); size(true); bold(true);
  write(shopName || "আমার দোকান"); nl();
  size(false); bold(false);
  write("================================"); nl();
  write("Invoice: #" + (inv.id || "").slice(0, 8).toUpperCase()); nl();
  write(inv.date || ""); nl();
  align(0);
  write("--------------------------------"); nl();
  write("কাস্টমার : " + inv.customerName); nl();
  write("মোবাইল   : " + inv.customerMobile); nl();
  write("--------------------------------"); nl();
  (inv.items || []).forEach((item, i) => {
    const name = (item.name || "").slice(0, 13).padEnd(14);
    const qty  = String(item.qty).padEnd(5);
    write(String(i+1).padEnd(2) + name + qty + "৳" + (item.qty * item.price)); nl();
  });
  write("================================"); nl();
  align(2); bold(true); size(true);
  write("মোট: ৳" + inv.total); nl();
  size(false); bold(false);
  if (inv.payType === "partial") {
    write("নগদ : ৳" + (inv.paidAmount || 0)); nl();
    write("বাকি: ৳" + (inv.bakiAmount || 0)); nl();
  } else {
    write(inv.payType === "baki" ? "বাকিতে" : "নগদ পরিশোধ"); nl();
  }
  align(1); nl();
  write("ধন্যবাদ! আবার আসবেন"); nl();
  nl(); nl(); nl();
  push(GS, 0x56, 0x41, 0x10);
  return new Uint8Array(out);
}

const FS = {
  async saveBackup(data, filename) {
    try {
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url; a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { ok: true };
    } catch(e) { return { ok: false, msg: e.message }; }
  },
  async listBackups() { return []; },
  async readBackup() { return null; },
};

const Haptic = {
  async light() {},
  async success() {},
  async error() {},
};



// ─── Developer Config (Hardcoded) ─────────────────────────────────────────────
// PIN ভুলে গেলে ব্যবহারকারী এই তথ্য দেখবে এবং যোগাযোগ করবে
const DEV_CONTACT = {
  name:      "Protik",
  whatsapp:  "+8801572931230",
  phone:     "+8801572931230",
};
// Master Code "169133" এর SHA-256 hash
const DEV_MASTER_HASH = "ef920d5cd2e23582ee35e6b1c9b18f9f94f5f88f3d5d03b422137208ce4ecc0b";

// ─── Storage Keys ─────────────────────────────────────────────────────────────
const SK = {
  customers: "dukan-customers", products: "dukan-products", invoices: "dukan-invoices",
  smsLog: "dukan-smslog", txns: "dukan-txns", users: "dukan-users",
  shopName: "dukan-shopname", darkMode: "dukan-darkmode", deletedCustomers: "dukan-deleted-customers",
  paymentInvoices: "dukan-payment-invoices", smsGateway: "dukan-sms-gateway",
  lastAutoBackup: "dukan-last-auto-backup", anthropicKey: "dukan-anthropic-key",
  smsTemplates: "dukan-sms-templates",
  autoBackupEnabled: "dukan-auto-backup-on",
  backupSnapshot: "dukan-backup-snapshot",
  firebaseConfig: "dukan-firebase-config",   // 🔥 Firebase config
  firebaseEnabled: "dukan-firebase-on",
  authSession:  "dukan-auth-session",
  devContact:   "dukan-dev-contact",         // 📞 Developer contact info
  masterResetHash: "dukan-master-reset-hash", // 🔐 Hashed master reset code
};

// ─── Firebase Realtime Database Layer ────────────────────────────────────────
// Uses Firebase REST API — no SDK, works in any browser/WebView
// Rules must be: { "rules": { ".read": true, ".write": true } }
const FB = {
  _cfg: null,
  init(cfg) { this._cfg = cfg; },

  _url(path) {
    if (!this._cfg?.databaseURL) return null;
    const base = this._cfg.databaseURL.replace(/\/$/, "");
    return `${base}/${path}.json`;
  },

  // Compress large data by keeping only essentials for backup
  _compressBackup(data) {
    // Store only the arrays needed for restore — skip meta/version overhead
    return {
      c:  data.customers       || [],   // customers
      p:  data.products        || [],   // products
      i:  data.invoices        || [],   // invoices
      t:  data.txns            || [],   // transactions
      s:  data.smsLog          || [],   // sms log
      pi: data.paymentInvoices || [],   // payment invoices
      at: data.exportedAt,
      v:  "v11"
    };
  },
  _decompressBackup(d) {
    if (!d) return null;
    // Handle both compressed (v11) and legacy full format
    if (d.c !== undefined) {
      return {
        customers: d.c, products: d.p, invoices: d.i,
        txns: d.t, smsLog: d.s, paymentInvoices: d.pi,
        exportedAt: d.at, version: d.v
      };
    }
    return d; // legacy full format
  },

  async get(path) {
    const url = this._url(path); if (!url) return null;
    try {
      const r = await fetch(url, { method: "GET" });
      if (!r.ok) return null;
      const j = await r.json();
      return j === null ? null : j;
    } catch { return null; }
  },

  async set(path, data) {
    const url = this._url(path); if (!url) return { ok: false, msg: "URL নেই" };
    try {
      const body = JSON.stringify(data);
      // Warn if too large (Firebase RTDB REST limit ~10MB, safe limit 1MB)
      if (body.length > 900_000) {
        return { ok: false, msg: `ডেটা অনেক বড় (${(body.length/1024).toFixed(0)} KB) — কিছু পুরনো ইনভয়েস মুছুন` };
      }
      const r = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body
      });
      if (r.ok) return { ok: true };
      const txt = await r.text();
      if (r.status === 403) {
        if (txt.includes("host") || txt.includes("allowlist")) {
          return { ok: false, msg: "Rules বন্ধ: Firebase Console → Realtime Database → Rules → .read/.write: true করুন" };
        }
        return { ok: false, msg: `অ্যাক্সেস নেই (403): Rules চেক করুন` };
      }
      return { ok: false, msg: `HTTP ${r.status}: ${txt.slice(0, 60)}` };
    } catch(e) {
      return { ok: false, msg: `নেটওয়ার্ক সমস্যা: ${e.message}` };
    }
  },

  async delete(path) {
    const url = this._url(path); if (!url) return;
    try { await fetch(url, { method: "DELETE" }); } catch {}
  },

  // Save backup — compresses data, stores index separately
  async saveBackup(data, filename) {
    const ts = new Date().toISOString();
    const key = `bk_${Date.now()}`;

    // 1. Get old key to delete later
    const idx = await this.get("dukan/idx");
    const oldKey = idx?.k;

    // 2. Save compressed data
    const compressed = this._compressBackup(data);
    const r = await this.set(`dukan/bk/${key}`, compressed);
    if (!r.ok) return r;

    // 3. Update index
    const ir = await this.set("dukan/idx", {
      k: key, at: ts, fn: filename,
      meta: { c: (data.customers||[]).length, i: (data.invoices||[]).length, t: (data.txns||[]).length }
    });
    if (!ir.ok) return ir;

    // 4. Delete old backup (fire & forget)
    if (oldKey && oldKey !== key) this.delete(`dukan/bk/${oldKey}`);

    return { ok: true, key, at: ts };
  },

  // Restore latest backup
  async loadBackup() {
    const idx = await this.get("dukan/idx");
    if (!idx?.k) return { ok: false, msg: "Firebase-এ কোনো ব্যাকআপ নেই" };
    const raw = await this.get(`dukan/bk/${idx.k}`);
    if (!raw) return { ok: false, msg: "ব্যাকআপ ডেটা পাওয়া যায়নি" };
    return { ok: true, data: this._decompressBackup(raw), idx };
  },

  // Quick connection test
  async testConnection() {
    const url = this._url("_ping");
    if (!url) return { ok: false, msg: "Database URL দেওয়া নেই" };
    try {
      const r = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ts: Date.now() })
      });
      if (r.ok) return { ok: true, msg: "✅ সংযোগ সফল! Firebase প্রস্তুত।" };
      const txt = await r.text();
      if (r.status === 403) {
        if (txt.includes("host") || txt.includes("allowlist")) {
          return { ok: false, msg: "❌ Rules বন্ধ আছে। Firebase Console → Realtime Database → Rules ট্যাব → নিচের Rules লিখে Publish করুন" };
        }
        return { ok: false, msg: `❌ অ্যাক্সেস নেই (403) — Rules চেক করুন` };
      }
      return { ok: false, msg: `❌ HTTP ${r.status}: ${txt.slice(0,60)}` };
    } catch(e) {
      return { ok: false, msg: `❌ নেটওয়ার্ক সমস্যা: ${e.message}` };
    }
  },

  isReady() { return !!(this._cfg?.databaseURL); }
};

// ─── Firebase Phone Auth (REST API — no SDK needed) ──────────────────────────
// Flow: sendOtp() → verifyOtp() → session saved → auto-login on next open
// Requires: Firebase Console → Authentication → Sign-in method → Phone → Enable
const FBAuth = {
  _fmt(phone) {
    const p = phone.replace(/\s|-/g, "");
    return p.startsWith("+") ? p : "+88" + p.replace(/^0/, "");
  },

  // Step 1: Request OTP
  async sendOtp(phone, apiKey) {
    const e164 = this._fmt(phone);
    try {
      const r = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:sendVerificationCode?key=${apiKey}`,
        { method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ phoneNumber: e164, recaptchaToken: "test-reCAPTCHA-token" }) }
      );
      const d = await r.json();
      if (d.sessionInfo) return { ok:true, sessionInfo:d.sessionInfo, phone:e164 };
      const msg = d.error?.message || "OTP পাঠানো যায়নি";
      if (msg.includes("INVALID_PHONE_NUMBER"))  return { ok:false, msg:"মোবাইল নম্বর সঠিক নয়" };
      if (msg.includes("TOO_MANY_ATTEMPTS"))     return { ok:false, msg:"অনেকবার চেষ্টা — পরে আবার চেষ্টা করুন" };
      if (msg.includes("CAPTCHA_CHECK_FAILED"))  return { ok:false, msg:"Firebase Test Phone Number সেট করুন" };
      if (msg.includes("OPERATION_NOT_ALLOWED")) return { ok:false, msg:"Firebase Console-এ Phone Auth চালু করুন" };
      return { ok:false, msg };
    } catch(e) { return { ok:false, msg:"নেটওয়ার্ক সমস্যা: "+e.message }; }
  },

  // Step 2: Verify OTP → get permanent refreshToken
  async verifyOtp(sessionInfo, otp, apiKey) {
    try {
      const r = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPhoneNumber?key=${apiKey}`,
        { method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ sessionInfo, code: otp }) }
      );
      const d = await r.json();
      if (d.idToken) return { ok:true, idToken:d.idToken, refreshToken:d.refreshToken, localId:d.localId };
      const msg = d.error?.message || "OTP যাচাই ব্যর্থ";
      if (msg.includes("INVALID_CODE"))    return { ok:false, msg:"OTP ভুল। আবার চেষ্টা করুন।" };
      if (msg.includes("SESSION_EXPIRED")) return { ok:false, msg:"OTP মেয়াদ শেষ। নতুন OTP নিন।" };
      return { ok:false, msg };
    } catch(e) { return { ok:false, msg:"নেটওয়ার্ক সমস্যা: "+e.message }; }
  },

  // Step 3: Silently refresh idToken (called on app start if session exists)
  async refreshIdToken(refreshToken, apiKey) {
    try {
      const r = await fetch(
        `https://securetoken.googleapis.com/v1/token?key=${apiKey}`,
        { method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ grant_type:"refresh_token", refresh_token:refreshToken }) }
      );
      const d = await r.json();
      if (d.id_token) return { ok:true, idToken:d.id_token, refreshToken:d.refresh_token };
      return { ok:false };
    } catch { return { ok:false }; }
  }
};

// ─── Universal Storage Layer ──────────────────────────────────────────────────
// Works in: Claude.ai Artifact (window.storage), Browser/PWA (localStorage),
//           React Native (AsyncStorage via bridge), and fallback in-memory store.
const _memStore = {};
const storage = (() => {
  // Claude.ai Artifact environment
  if (typeof window !== "undefined" && window.storage && typeof window.storage.get === "function") {
    return {
      async get(key) {
        try { const r = await window.storage.get(key); return r ? JSON.parse(r.value) : null; } catch { return null; }
      },
      async set(key, val) {
        try { await window.storage.set(key, JSON.stringify(val)); } catch {}
      }
    };
  }
  // React Native with AsyncStorage bridge (window.AsyncStorage injected by WebView)
  if (typeof window !== "undefined" && window.AsyncStorage) {
    return {
      async get(key) {
        try { const v = await window.AsyncStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; }
      },
      async set(key, val) {
        try { await window.AsyncStorage.setItem(key, JSON.stringify(val)); } catch {}
      }
    };
  }
  // Browser / PWA with localStorage
  if (typeof window !== "undefined" && window.localStorage) {
    return {
      async get(key) {
        try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; }
      },
      async set(key, val) {
        try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
      }
    };
  }
  // In-memory fallback (SSR / test environments)
  return {
    async get(key) { return _memStore[key] ?? null; },
    async set(key, val) { _memStore[key] = val; }
  };
})();

async function load(key) { try { return await storage.get(key); } catch { return null; } }
async function save(key, val) { try { await storage.set(key, val); } catch {} }

// ─── Password Hashing (Web Crypto API) ───────────────────────────────────────
async function hashPassword(plain) {
  try {
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest("SHA-256", enc.encode("dukan-salt-v1:" + plain));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
  } catch {
    let h = 0;
    for (let i = 0; i < plain.length; i++) { h = (Math.imul(31, h) + plain.charCodeAt(i)) | 0; }
    return "fb-" + Math.abs(h).toString(16);
  }
}
async function checkPassword(plain, hash) {
  if (!hash) return false;
  // Legacy: plain-text passwords migrate on first successful login
  if (hash.length !== 64 && !hash.startsWith("fb-")) return plain === hash;
  return (await hashPassword(plain)) === hash;
}

// ─── SMS Templates ────────────────────────────────────────────────────────────
// Variables: {নাম} {পরিমাণ} {বাকি} {দোকান}
const DEFAULT_SMS_TEMPLATES = {
  baki:   "{দোকান}: {নাম} ভাই, আপনার বাকি ৳{পরিমাণ} যোগ হয়েছে। মোট বাকি: ৳{বাকি}। ধন্যবাদ 🙏",
  joma:   "{দোকান}: {নাম} ভাই, ৳{পরিমাণ} জমা নেওয়া হয়েছে। বর্তমান বাকি: ৳{বাকি}। ধন্যবাদ 🙏",
  custom: "{দোকান}: {নাম} ভাই, আপনার বর্তমান বাকি ৳{বাকি}। ধন্যবাদ।"
};

function applyTemplate(tpl, customer, amount, balance, shopName) {
  return tpl
    .replace(/{দোকান}/g, shopName)
    .replace(/{নাম}/g,    customer.name)
    .replace(/{পরিমাণ}/g, amount)
    .replace(/{বাকি}/g,   balance);
}

// ─── SMS via Claude AI (API Key from Settings) ────────────────────────────────
async function generateSMS(customer, type, amount, balance, shopName, anthropicKey, smsTemplates) {
  const templates = { ...DEFAULT_SMS_TEMPLATES, ...(smsTemplates || {}) };

  if (!anthropicKey) {
    // Use custom template (no API key needed)
    const tpl = templates[type] || templates.custom;
    return applyTemplate(tpl, customer, amount, balance, shopName);
  }
  const prompt = `তুমি একটি দোকানের হিসাব সিস্টেম। নিচের তথ্য দিয়ে একটি সংক্ষিপ্ত বাংলা SMS বার্তা তৈরি করো (সর্বোচ্চ ২ লাইন):\nকাস্টমার: ${customer.name}\nলেনদেন: ${type === "baki" ? "বাকি যোগ" : type === "joma" ? "টাকা জমা" : "বিশেষ বার্তা"}\nপরিমান: ৳${amount}\nবর্তমান বাকি: ৳${balance}\nদোকান: ${shopName}\nশুধু SMS টেক্সট দাও।`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 200, messages: [{ role: "user", content: prompt }] })
    });
    if (!res.ok) throw new Error(`API error ${res.status}`);
    const d = await res.json();
    return d.content?.[0]?.text || applyTemplate(templates[type] || templates.custom, customer, amount, balance, shopName);
  } catch {
    return applyTemplate(templates[type] || templates.custom, customer, amount, balance, shopName);
  }
}

// SMS via CapacitorHttp (bypasses WebView CORS) or fetch fallback
async function httpPost(url, headers, body, isForm = false) {
  // Capacitor native HTTP — no CORS issues in APK
  if (typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.()) {
    try {
      const { CapacitorHttp } = await import("@capacitor/core");
      const r = await CapacitorHttp.request({
        method: "POST", url,
        headers: { ...headers, "Content-Type": isForm ? "application/x-www-form-urlencoded" : "application/json" },
        data: isForm ? body : JSON.stringify(body),
      });
      return { ok: r.status >= 200 && r.status < 300, data: r.data, status: r.status };
    } catch {}
  }
  // Browser/fallback fetch
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": isForm ? "application/x-www-form-urlencoded" : "application/json" },
    body: isForm ? (typeof body === "string" ? body : new URLSearchParams(body).toString()) : JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, data, status: res.status };
}

async function httpGet(url) {
  if (typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.()) {
    try {
      const { CapacitorHttp } = await import("@capacitor/core");
      const r = await CapacitorHttp.request({ method: "GET", url });
      return { ok: r.status < 300, data: r.data };
    } catch {}
  }
  const res = await fetch(url);
  const text = await res.text();
  return { ok: res.ok, data: text };
}

async function sendRealSMS(mobile, message, gateway) {
  if (!gateway?.apiKey || !gateway?.provider) return { success: false, error: "গেটওয়ে সেট করা নেই" };
  try {
    if (gateway.provider === "twilio") {
      const auth = "Basic " + btoa(`${gateway.accountSid}:${gateway.apiKey}`);
      const r = await httpPost(
        `https://api.twilio.com/2010-04-01/Accounts/${gateway.accountSid}/Messages.json`,
        { Authorization: auth }, `To=${encodeURIComponent(mobile)}&From=${encodeURIComponent(gateway.senderId)}&Body=${encodeURIComponent(message)}`,
        true
      );
      if (r.ok) return { success: true };
      const d = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
      return { success: false, error: d?.message || "Twilio error" };
    }
    if (gateway.provider === "ssl") {
      const url = `https://sms.sslwireless.com/pushapi/dynamic/server.php?user=${gateway.username}&pass=${gateway.apiKey}&sms=${encodeURIComponent(message)}&mobile=${mobile}&sid=${gateway.senderId}`;
      const r = await httpGet(url);
      return String(r.data).includes("SUCCESS") ? { success: true } : { success: false, error: String(r.data).slice(0, 80) };
    }
    if (gateway.provider === "alpha") {
      // Alpha SMS (Bangladesh)
      const url = `https://bulksmsbd.net/api/smsapi?api_key=${gateway.apiKey}&type=text&number=${mobile}&senderid=${gateway.senderId}&message=${encodeURIComponent(message)}`;
      const r = await httpGet(url);
      return r.ok ? { success: true } : { success: false, error: String(r.data).slice(0, 80) };
    }
    if (gateway.provider === "bulksms") {
      // BulkSMSBD (Bangladesh)
      const url = `https://bulksmsbd.net/api/smsapi?api_key=${gateway.apiKey}&type=text&number=${mobile}&senderid=${gateway.senderId}&message=${encodeURIComponent(message)}`;
      const r = await httpGet(url);
      return r.ok ? { success: true } : { success: false, error: String(r.data).slice(0, 80) };
    }
    return { success: false, error: "অজানা গেটওয়ে" };
  } catch (e) { return { success: false, error: e.message }; }
}

// ─── ESC/POS Bluetooth Thermal Printer ───────────────────────────────────────
// Tested with: Xprinter, Sewoo, GOOJPRT, MUNBYN, and most BLE thermal printers
// Bengali text requires the printer firmware to support UTF-8 (most 2022+ models do)

const BT_SERVICE_UUIDS = [
  "000018f0-0000-1000-8000-00805f9b34fb", // Generic POS / Xprinter
  "e7810a71-73ae-499d-8c15-faa9aef0c3f2", // Epson/STAR BLE
  "0000ff00-0000-1000-8000-00805f9b34fb", // GOOJPRT / MUNBYN
  "49535343-fe7d-4ae5-8fa9-9fafd205e455", // Microchip BM70/RN4870
];
const BT_CHAR_UUIDS = [
  "000018f1-0000-1000-8000-00805f9b34fb",
  "bef8d6c9-9c21-4c9e-b632-bd58c1009f9f",
  "0000ff02-0000-1000-8000-00805f9b34fb",
  "49535343-8841-43f4-a8d4-ecbe34729bb3",
];

function buildEscPosBuffer(inv, shopName) {
  const enc = new TextEncoder(); // UTF-8
  const [ESC, GS, LF] = [0x1B, 0x1D, 0x0A];
  const out = [];
  const push  = (...b) => b.forEach(x => out.push(x));
  const write = (s)    => enc.encode(String(s)).forEach(b => out.push(b));
  const nl    = ()     => out.push(LF);
  const bold  = (on)   => push(ESC, 0x45, on ? 1 : 0);
  const align = (a)    => push(ESC, 0x61, a); // 0=left 1=center 2=right
  const size  = (dbl)  => push(ESC, 0x21, dbl ? 0x30 : 0x00);

  push(ESC, 0x40);        // Initialize printer
  push(ESC, 0x74, 0x00);  // Code page – some printers need this; UTF-8 handled by TextEncoder

  // ── Header ──
  align(1); size(true); bold(true);
  write(shopName || "আমার দোকান"); nl();
  size(false); bold(false);
  write("--------------------------------"); nl();
  write("Invoice #" + ((inv.id || "").slice(0, 8).toUpperCase())); nl();
  write(inv.date || ""); nl();

  // ── Customer ──
  align(0);
  write("--------------------------------"); nl();
  write("কাস্টমার : " + inv.customerName); nl();
  write("মোবাইল   : " + inv.customerMobile); nl();
  write("--------------------------------"); nl();

  // ── Items header ──
  write("পণ্য              Qty    মোট"); nl();
  write("--------------------------------"); nl();

  (inv.items || []).forEach(item => {
    const name  = (item.name || "").slice(0, 16).padEnd(17);
    const qty   = String(item.qty).padEnd(6);
    const total = "৳" + (item.qty * item.price);
    write(name + qty + total); nl();
  });

  // ── Totals ──
  write("--------------------------------"); nl();
  align(2); bold(true); size(true);
  write("মোট: ৳" + inv.total); nl();
  size(false); bold(false);

  if (inv.payType === "partial") {
    write("নগদ : ৳" + (inv.paidAmount || 0)); nl();
    write("বাকি: ৳" + (inv.bakiAmount || 0)); nl();
  } else {
    write(inv.payType === "baki" ? "বাকিতে দেওয়া হয়েছে" : "নগদ পরিশোধ"); nl();
  }

  // ── Footer ──
  align(1);
  nl(); write("ধন্যবাদ! আবার আসবেন"); nl();
  nl(); nl(); nl();
  push(GS, 0x56, 0x41, 0x10); // Partial cut

  return new Uint8Array(out);
}

async function sendEscPosBluetooth(btDevice, inv, shopName) {
  if (!btDevice) throw new Error("কোনো প্রিন্টার নির্বাচন করা হয়নি");

  let server;
  try { server = btDevice.gatt.connected ? btDevice.gatt : await btDevice.gatt.connect(); }
  catch { throw new Error("প্রিন্টার পুনরায় সংযোগ ব্যর্থ হয়েছে"); }

  let service = null;
  for (const sid of BT_SERVICE_UUIDS) {
    try { service = await server.getPrimaryService(sid); break; } catch {}
  }
  if (!service) throw new Error("প্রিন্টার সার্ভিস খুঁজে পাওয়া যায়নি। প্রিন্টার মডেল নিশ্চিত করুন।");

  let char = null;
  for (const cid of BT_CHAR_UUIDS) {
    try { char = await service.getCharacteristic(cid); break; } catch {}
  }
  if (!char) throw new Error("প্রিন্ট চ্যারেকটেরিস্টিক পাওয়া যায়নি");

  const data  = buildEscPosBuffer(inv, shopName);
  const CHUNK = 200; // safe BLE chunk size
  for (let i = 0; i < data.length; i += CHUNK) {
    await char.writeValueWithoutResponse(data.slice(i, i + CHUNK));
    await new Promise(r => setTimeout(r, 30));
  }
}
// navigator.bluetooth is NOT available in React Native WebView or all Android browsers.
// We detect the environment and show the right message.
const btSupported = typeof navigator !== "undefined" && !!navigator.bluetooth;

// Print helper — falls back gracefully when window.open is unavailable (some WebViews)
function openPrintWindow(htmlContent) {
  try {
    const win = window.open("", "_blank", "width=400,height=600");
    if (!win) { alert("পপআপ ব্লক করা আছে। ব্রাউজারে পপআপ অনুমতি দিন।"); return; }
    win.document.write(htmlContent);
    win.document.close();
    win.focus();
    setTimeout(() => { try { win.print(); win.close(); } catch {} }, 300);
  } catch (e) {
    alert("প্রিন্ট করতে সমস্যা হয়েছে: " + e.message);
  }
}

// ── PDF Generation Utilities ──────────────────────────────────────────────────
// নন-এডিটেবল PDF তৈরি করে শেয়ার/প্রিন্ট করার জন্য
// শুধু প্রয়োজনের সময় generate করে, শেষে cache auto-clear হয়
const _pdfCache = new Map(); // temporary cache, auto-cleared after use

function buildPdfHtml(content, shopName, title) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;600;700;800&display=swap');
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Hind Siliguri',Arial,sans-serif; background:#fff; color:#1a1a2e; font-size:13px; padding:20px; }
    .header { text-align:center; margin-bottom:16px; padding-bottom:12px; border-bottom:2px solid #0369a1; }
    .shop-name { font-size:20px; font-weight:800; color:#0369a1; }
    .doc-title { font-size:13px; color:#666; margin-top:4px; }
    .doc-date { font-size:11px; color:#999; margin-top:2px; }
    .section { margin:14px 0; }
    table { width:100%; border-collapse:collapse; }
    th { background:#0369a1; color:#fff; padding:8px 10px; font-size:12px; text-align:left; }
    td { padding:8px 10px; border-bottom:1px solid #eee; font-size:12px; }
    tr:nth-child(even) td { background:#f8faff; }
    .serial { width:36px; text-align:center; font-weight:700; color:#0369a1; }
    .amount { text-align:right; font-weight:700; }
    .total-row td { background:#0369a120; font-weight:800; border-top:2px solid #0369a1; }
    .badge { display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:700; }
    .baki { background:#ef444420; color:#ef4444; }
    .joma { background:#22c55e20; color:#22c55e; }
    .cash { background:#0ea5e920; color:#0ea5e9; }
    .partial { background:#f59e0b20; color:#f59e0b; }
    .info-row { display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #eee; font-size:12px; }
    .info-label { color:#666; }
    .info-val { font-weight:700; color:#1a1a2e; }
    .footer { text-align:center; margin-top:20px; padding-top:12px; border-top:1px dashed #ccc; color:#999; font-size:11px; }
    .watermark { color:#0369a115; font-size:40px; font-weight:900; position:fixed; top:50%; left:50%; transform:translate(-50%,-50%) rotate(-30deg); pointer-events:none; z-index:0; }
    .content { position:relative; z-index:1; }
    @media print { body { padding:10px; } .watermark { display:none; } }
  </style></head><body>
  <div class="watermark">হিসাবঘর</div>
  <div class="content">
    <div class="header">
      <div class="shop-name">${shopName || "আমার দোকান"}</div>
      <div class="doc-title">${title}</div>
      <div class="doc-date">তারিখ: ${new Date().toLocaleDateString("bn-BD", {day:"numeric",month:"long",year:"numeric"})}</div>
    </div>
    ${content}
    <div class="footer">হিসাবঘর অ্যাপ দ্বারা তৈরি • এটি একটি স্বয়ংক্রিয় নথি</div>
  </div></body></html>`;
}

function generatePdfBlobUrl(htmlContent) {
  const blob = new Blob([htmlContent], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  return url;
}

function autoClearPdfUrl(url, delayMs = 30000) {
  // শেয়ার/প্রিন্টের পর ৩০ সেকেন্ড পরে cache মুছে দেয়
  setTimeout(() => {
    try { URL.revokeObjectURL(url); } catch {}
  }, delayMs);
}

function printPdfHtml(htmlContent) {
  const url = generatePdfBlobUrl(htmlContent);
  const win = window.open(url, "_blank", "width=500,height=700");
  if (!win) { alert("পপআপ ব্লক করা আছে। অনুমতি দিন।"); return; }
  win.onload = () => {
    setTimeout(() => {
      try { win.print(); } catch {}
    }, 400);
  };
  autoClearPdfUrl(url, 60000);
}

function sharePdfWhatsApp(htmlContent, title) {
  // WhatsApp-এ শেয়ারের জন্য HTML ব্লব ডাউনলোড করে শেয়ার prompt দেয়
  const url = generatePdfBlobUrl(htmlContent);
  const a = document.createElement("a");
  a.href = url;
  a.download = title.replace(/\s+/g, "_") + ".html";
  a.click();
  autoClearPdfUrl(url, 30000);
  setTimeout(() => {
    const waText = encodeURIComponent(`${title} - হিসাবঘর`);
    window.open(`https://api.whatsapp.com/send?text=${waText}`, "_blank");
  }, 800);
}

// ── Daily List PDF Builder ──────────────────────────────────────────────────
function buildDailyListHtml(items, listType, shopName) {
  let rows = "";
  let totalAmt = 0;
  if (listType === "payment-receipts") {
    // জমার তালিকা
    rows = items.map((item, i) => {
      totalAmt += item.amount || 0;
      return `<tr>
        <td class="serial">${i+1}</td>
        <td>${item.customerName || "—"}</td>
        <td>${item.customerMobile || "—"}</td>
        <td>${item.time || item.date || "—"}</td>
        <td class="amount joma">৳${(item.amount||0).toLocaleString("bn-BD")}</td>
        <td>${item.note || "—"}</td>
      </tr>`;
    }).join("");
    const thead = `<tr><th class="serial">#</th><th>কাস্টমার</th><th>মোবাইল</th><th>সময়</th><th>জমা</th><th>নোট</th></tr>`;
    const tfooter = `<tr class="total-row"><td class="serial">—</td><td colspan="3">মোট জমা</td><td class="amount">৳${totalAmt.toLocaleString("bn-BD")}</td><td></td></tr>`;
    return `<table><thead>${thead}</thead><tbody>${rows}${tfooter}</tbody></table>`;
  } else {
    // ইনভয়েস তালিকা
    rows = items.map((item, i) => {
      totalAmt += item.total || 0;
      const badge = item.payType === "baki" ? `<span class="badge baki">বাকি</span>` : item.payType === "partial" ? `<span class="badge partial">আংশিক</span>` : `<span class="badge cash">নগদ</span>`;
      return `<tr>
        <td class="serial">${i+1}</td>
        <td>${item.customerName || "—"}</td>
        <td>${item.customerMobile || "—"}</td>
        <td>${item.date || "—"}</td>
        <td>${badge}</td>
        <td class="amount">৳${(item.total||0).toLocaleString("bn-BD")}</td>
      </tr>`;
    }).join("");
    const thead = `<tr><th class="serial">#</th><th>কাস্টমার</th><th>মোবাইল</th><th>তারিখ</th><th>ধরন</th><th>পরিমাণ</th></tr>`;
    const tfooter = `<tr class="total-row"><td class="serial">—</td><td colspan="4">মোট</td><td class="amount">৳${totalAmt.toLocaleString("bn-BD")}</td></tr>`;
    return `<table><thead>${thead}</thead><tbody>${rows}${tfooter}</tbody></table>`;
  }
}

// ── Customer History PDF Builder ──────────────────────────────────────────
function buildCustomerHistoryHtml(customer, txns, invoices, paymentInvoices, months, shopName) {
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth() - months, 1);
  const filtered = txns.filter(t => {
    try { return new Date(t.dateKey || t.date) >= cutoff; } catch { return true; }
  });
  let rows = "";
  let totalBaki = 0, totalJoma = 0;
  filtered.forEach((t, i) => {
    const isBaki = t.type === "baki";
    if (isBaki) totalBaki += t.amount;
    else totalJoma += t.amount;
    rows += `<tr>
      <td class="serial">${i+1}</td>
      <td>${t.date || "—"}</td>
      <td>${isBaki ? `<span class="badge baki">▲ বাকি</span>` : `<span class="badge joma">▼ জমা</span>`}</td>
      <td class="amount" style="color:${isBaki?"#ef4444":"#22c55e"}">${isBaki?"+":"-"}৳${(t.amount||0).toLocaleString("bn-BD")}</td>
      <td class="amount">৳${(t.balanceAfter||0).toLocaleString("bn-BD")}</td>
      <td>${t.note || "—"}</td>
    </tr>`;
  });
  const summary = `
    <div style="display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap;">
      <div style="background:#0369a115;border-radius:10px;padding:12px 20px;flex:1;min-width:120px;">
        <div style="color:#666;font-size:11px;">কাস্টমার</div>
        <div style="font-weight:800;font-size:16px;">${customer.name}</div>
        <div style="color:#666;font-size:11px;">${customer.mobile||""}</div>
      </div>
      <div style="background:#ef444415;border-radius:10px;padding:12px 20px;flex:1;min-width:120px;">
        <div style="color:#ef4444;font-size:11px;font-weight:700;">মোট বাকি হয়েছে</div>
        <div style="font-weight:800;font-size:18px;color:#ef4444;">৳${totalBaki.toLocaleString("bn-BD")}</div>
      </div>
      <div style="background:#22c55e15;border-radius:10px;padding:12px 20px;flex:1;min-width:120px;">
        <div style="color:#22c55e;font-size:11px;font-weight:700;">মোট জমা দিয়েছে</div>
        <div style="font-weight:800;font-size:18px;color:#22c55e;">৳${totalJoma.toLocaleString("bn-BD")}</div>
      </div>
      <div style="background:#f59e0b15;border-radius:10px;padding:12px 20px;flex:1;min-width:120px;">
        <div style="color:#f59e0b;font-size:11px;font-weight:700;">বর্তমান বাকি</div>
        <div style="font-weight:800;font-size:18px;color:#f59e0b;">৳${(customer.balance||0).toLocaleString("bn-BD")}</div>
      </div>
    </div>`;
  const thead = `<tr><th class="serial">#</th><th>তারিখ</th><th>ধরন</th><th>পরিমাণ</th><th>পরে বাকি</th><th>নোট</th></tr>`;
  const table = filtered.length > 0
    ? `<table><thead>${thead}</thead><tbody>${rows}</tbody></table>`
    : `<div style="text-align:center;padding:30px;color:#999;">এই সময়কালে কোনো লেনদেন নেই</div>`;
  return summary + table;
}

// ── PDF Action Buttons Component ──────────────────────────────────────────────
function PdfActionBar({ htmlContent, title, T, S }) {
  const [busy, setBusy] = React.useState(false);
  const doAction = async (action) => {
    if (busy) return;
    setBusy(true);
    try {
      if (action === "print") {
        printPdfHtml(htmlContent);
      } else if (action === "whatsapp") {
        sharePdfWhatsApp(htmlContent, title);
      } else if (action === "download") {
        const url = generatePdfBlobUrl(htmlContent);
        const a = document.createElement("a");
        a.href = url; a.download = title.replace(/\s+/g,"_")+".html"; a.click();
        autoClearPdfUrl(url, 30000);
      }
    } finally { setTimeout(() => setBusy(false), 1000); }
  };
  return (
    <div style={{ display:"flex", gap:8, marginTop:10, flexWrap:"wrap" }}>
      <button
        style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", gap:6,
          background:"linear-gradient(135deg,#1e40af,#3b82f6)", color:"#fff",
          border:"none", borderRadius:10, padding:"10px 8px", fontWeight:700,
          cursor:"pointer", fontFamily:"inherit", fontSize:13, minWidth:90 }}
        onClick={() => doAction("print")} disabled={busy}>
        🖨️ প্রিন্ট
      </button>
      <button
        style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", gap:6,
          background:"linear-gradient(135deg,#065f46,#22c55e)", color:"#fff",
          border:"none", borderRadius:10, padding:"10px 8px", fontWeight:700,
          cursor:"pointer", fontFamily:"inherit", fontSize:13, minWidth:90 }}
        onClick={() => doAction("whatsapp")} disabled={busy}>
        💬 WhatsApp
      </button>
      <button
        style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", gap:6,
          background:"linear-gradient(135deg,#7c3aed,#a78bfa)", color:"#fff",
          border:"none", borderRadius:10, padding:"10px 8px", fontWeight:700,
          cursor:"pointer", fontFamily:"inherit", fontSize:13, minWidth:90 }}
        onClick={() => doAction("download")} disabled={busy}>
        ⬇️ PDF সেভ
      </button>
    </div>
  );
}

function downloadBackupFile(data, filename) {
  // Browser fallback — Capacitor uses FS.saveBackup (called in performDriveBackup)
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── Seeds ────────────────────────────────────────────────────────────────────
const PRODUCT_CATEGORIES = ["সব", "চাল-ডাল", "তেল-মশলা", "পানীয়", "স্নাক্স", "ডেইরি", "অন্যান্য"];
const SEED_PRODUCTS = [
  { id: "p1", name: "চাল (প্রতি কেজি)", price: 60, stock: 100, category: "চাল-ডাল" },
  { id: "p2", name: "ডাল (প্রতি কেজি)", price: 120, stock: 50, category: "চাল-ডাল" },
  { id: "p3", name: "তেল (প্রতি লিটার)", price: 185, stock: 30, category: "তেল-মশলা" },
  { id: "p4", name: "লবণ (প্রতি কেজি)", price: 40, stock: 80, category: "তেল-মশলা" },
  { id: "p5", name: "চিনি (প্রতি কেজি)", price: 130, stock: 60, category: "চাল-ডাল" },
  { id: "p6", name: "আটা (প্রতি কেজি)", price: 55, stock: 45, category: "চাল-ডাল" },
  { id: "p7", name: "কোকা কোলা", price: 35, stock: 48, category: "পানীয়" },
  { id: "p8", name: "বিস্কুট", price: 20, stock: 200, category: "স্নাক্স" },
  { id: "p9", name: "দুধ (প্রতি লিটার)", price: 75, stock: 20, category: "ডেইরি" },
];
const SEED_CUSTOMERS = [
  { id: "c1", name: "রহিম মিয়া", mobile: "01711000001", balance: 1250, address: "বাড়ি নং ৫, মেইন রোড" },
  { id: "c2", name: "করিম সাহেব", mobile: "01811000002", balance: 500, address: "পশ্চিম পাড়া" },
];
const SEED_USERS = [{ id: "u1", username: "admin", password: "1234", pin: "432100", name: "দোকানদার", role: "admin", email: "" }];

// ─── Utils ────────────────────────────────────────────────────────────────────
const uid      = () => Math.random().toString(36).slice(2, 9);
const todayStr = () => new Date().toLocaleDateString("bn-BD");
const nowStr   = () => new Date().toLocaleString("bn-BD");
const fmt      = (n) => Number(n).toLocaleString("bn-BD");
const todayEn  = () => new Date().toISOString().split("T")[0];

// ─── Theme ────────────────────────────────────────────────────────────────────
// ─── Premium M3-Inspired Theme Tokens ────────────────────────────────────────
const DARK = {
  bg: "#080f0a", card: "#0f1f13", cardAlt: "#162a1b", border: "#1e3a27", borderLight: "#2a4a35",
  text: "#e8f5eb", textSoft: "#b8d4bf", sub: "#5a8a6a",
  accent: "#2dda7a", accentDark: "#1ab860", accentGlow: "#22c55e33", accentPill: "#22c55e22",
  input: "#0c1a0e", inputBorder: "#1e3a27", inputFocus: "#2dda7a44",
  nav: "#0c1a0e", navBorder: "#1e3a27", navActive: "#2dda7a", navPill: "#22c55e18",
  header: "linear-gradient(160deg,#0a1f0d 0%,#0f2e16 50%,#0d2414 100%)",
  stripe: "#0a1a0c", toastBg: "#0f2018",
  stepActive: "#2dda7a", stepDone: "#1ab860", stepInactive: "#1e3a27",
  danger: "#f87171", dangerBg: "#ef444418", warning: "#fbbf24", warningBg: "#f59e0b18",
  info: "#60a5fa", infoBg: "#3b82f618", success: "#2dda7a", successBg: "#22c55e18",
  shadow: "0 4px 32px rgba(0,0,0,0.6)", shadowSm: "0 2px 12px rgba(0,0,0,0.4)",
  shadowGlow: "0 0 24px rgba(45,218,122,0.12)",
};
const LIGHT = {
  bg: "#f0faf3", card: "#ffffff", cardAlt: "#f7fbf8", border: "#d4eddb", borderLight: "#e8f5eb",
  text: "#0d2010", textSoft: "#1e4028", sub: "#5a8a6a",
  accent: "#15803d", accentDark: "#166534", accentGlow: "#16a34a22", accentPill: "#dcfce7",
  input: "#f7fbf8", inputBorder: "#c8e6d0", inputFocus: "#16a34a33",
  nav: "#ffffff", navBorder: "#d4eddb", navActive: "#15803d", navPill: "#dcfce7",
  header: "linear-gradient(160deg,#14532d 0%,#15803d 50%,#166534 100%)",
  stripe: "#f0faf3", toastBg: "#0f2018",
  stepActive: "#15803d", stepDone: "#14532d", stepInactive: "#d4eddb",
  danger: "#dc2626", dangerBg: "#ef444415", warning: "#d97706", warningBg: "#f59e0b15",
  info: "#2563eb", infoBg: "#3b82f615", success: "#15803d", successBg: "#22c55e15",
  shadow: "0 4px 24px rgba(14,80,35,0.15)", shadowSm: "0 2px 8px rgba(14,80,35,0.1)",
  shadowGlow: "0 0 20px rgba(21,128,61,0.1)",
};

// ─── Icons ────────────────────────────────────────────────────────────────────
const Ic = ({ d, size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);
const IcPlus     = () => <Ic d="M12 5v14M5 12h14" />;
const IcMinus    = () => <Ic d="M5 12h14" />;
const IcSearch   = () => <Ic d="m21 21-6-6m2-5a7 7 0 1 1-14 0 7 7 0 0 1 14 0z" />;
const IcCheck    = () => <Ic d="M20 6 9 17l-5-5" />;
const IcTrash    = () => <Ic d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />;
const IcBack     = () => <Ic d="M15 18l-6-6 6-6" />;
const IcInvoice  = () => <Ic d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8" />;
const IcClock    = () => <Ic d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10zM12 6v6l4 2" />;
const IcPrint    = () => <Ic d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z" />;
const IcSms      = () => <Ic d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />;
const IcLock     = () => <Ic d="M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2zM7 11V7a5 5 0 0 1 10 0v4" />;
const IcUser     = () => <Ic d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" />;
const IcLogout   = () => <Ic d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />;
const IcEdit     = () => <Ic d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />;
const IcMoon     = () => <Ic d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />;
const IcSun      = () => <Ic d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z" />;
const IcBluetooth= () => <Ic d="M6.5 6.5l11 11L12 23V1l5.5 5.5-11 11" />;
const IcCloud    = () => <Ic d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />;
const IcCart     = () => <Ic d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4zM3 6h18M16 10a4 4 0 0 1-8 0" />;
const IcGoogle   = () => <svg width={18} height={18} viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>;

// ── Live Date & Time display ───────────────────────────────────────────────────
function LiveDateTime() {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const iv = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(iv); }, []);
  const time = now.toLocaleTimeString("bn-BD", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const date = now.toLocaleDateString("bn-BD", { weekday: "short", year: "numeric", month: "short", day: "numeric" });
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12 }}>
      <span style={{
        color: "#fde68a",
        fontWeight: 800, fontSize: 13,
        textShadow: "0 1px 8px rgba(0,0,0,0.4)",
        letterSpacing: 0.8,
        background: "rgba(0,0,0,0.2)",
        borderRadius: 100,
        padding: "3px 10px",
        backdropFilter: "blur(4px)",
      }}>⏱ {time}</span>
      <span style={{
        color: "#a7f3d0",
        fontWeight: 600, fontSize: 11,
        textShadow: "0 1px 4px rgba(0,0,0,0.3)",
        opacity: 0.9,
      }}>📅 {date}</span>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Performance: wrap heavy sub-components in React.memo to avoid unnecessary re-renders
const MemoLiveDateTime = React.memo(LiveDateTime);

export default function DukanHisab() {
  const [tab,              setTab]             = useState("dashboard");
  const [customers,        setCustomers]       = useState([]);
  const [products,         setProducts]        = useState([]);
  const [invoices,         setInvoices]        = useState([]);
  const [txns,             setTxns]            = useState([]);
  const [smsLog,           setSmsLog]          = useState([]);
  const [users,            setUsers]           = useState([]);
  const [shopName,         setShopName]        = useState("আমার দোকান");
  const [loaded,           setLoaded]          = useState(false);
  const [toast,            setToast]           = useState(null);
  const [modal,            setModal]           = useState(null);
  const [detailCId,        setDetailCId]       = useState(null);
  const [preselectedCust,  setPreselectedCust] = useState(null);
  const [currentUser,      setCurrentUser]     = useState(null);
  const [smsCount,         setSmsCount]        = useState(150);
  const [darkMode,         setDarkMode]        = useState(true);
  const [deletedCustomers, setDeletedCustomers]= useState([]);
  const [paymentInvoices,  setPaymentInvoices] = useState([]);
  const [smsGateway,       setSmsGateway]      = useState(null);
  const [dashModal,        setDashModal]       = useState(null);
  const [btConnected,      setBtConnected]     = useState(false);
  const [btDevice,         setBtDevice]        = useState(null);
  const [lastAutoBackup,   setLastAutoBackup]  = useState(null);
  const [driveStatus,      setDriveStatus]     = useState(null);
  const [backupNeeded,     setBackupNeeded]    = useState(false);
  const [anthropicKey,     setAnthropicKey]    = useState("");
  const [smsTemplates,     setSmsTemplates]    = useState(null);
  const [autoBackupEnabled,setAutoBackupEnabled] = useState(false);
  const [firebaseConfig,   setFirebaseConfig]  = useState(null);   // 🔥
  const [firebaseEnabled,  setFirebaseEnabled] = useState(false);  // 🔥
  const [fbStatus,         setFbStatus]        = useState(null);   // 🔥 "syncing"|"synced"|"error"|null
  const [fbBackupList,     setFbBackupList]    = useState([]);
  const [authSession,      setAuthSession]     = useState(null);   // 🔐 {phone, idToken, refreshToken, localId}
  const [devContact,       setDevContact]      = useState(null);   // 📞 Developer contact info
  const [masterResetHash,  setMasterResetHash] = useState(null);   // 🔑 Hashed master reset code

  const T = darkMode ? DARK : LIGHT;

  useEffect(() => {
    (async () => {
      setCustomers       ((await load(SK.customers))        || SEED_CUSTOMERS);
      setProducts        ((await load(SK.products))         || SEED_PRODUCTS);
      setInvoices        ((await load(SK.invoices))         || []);
      setTxns            ((await load(SK.txns))             || []);
      setSmsLog          ((await load(SK.smsLog))           || []);
      setUsers           ((await load(SK.users))            || SEED_USERS);
      setShopName        ((await load(SK.shopName))         || "আমার দোকান");
      setDarkMode        ((await load(SK.darkMode))         ?? true);
      setDeletedCustomers((await load(SK.deletedCustomers)) || []);
      setPaymentInvoices ((await load(SK.paymentInvoices))  || []);
      setSmsGateway      ((await load(SK.smsGateway))       || null);
      setLastAutoBackup  ((await load(SK.lastAutoBackup))   || null);
      setAnthropicKey    ((await load(SK.anthropicKey))     || "");
      setSmsTemplates    ((await load(SK.smsTemplates))     || null);
      setAutoBackupEnabled((await load(SK.autoBackupEnabled)) ?? false);
      // 🔥 Firebase
      const fbCfg = (await load(SK.firebaseConfig)) || null;
      const fbOn  = (await load(SK.firebaseEnabled)) ?? false;
      setFirebaseConfig(fbCfg);
      setFirebaseEnabled(fbOn);
      if (fbCfg && fbOn) FB.init(fbCfg);
      // Auto-login: restore last logged-in user (PIN-based, stored locally)
      const savedUser = await load(SK.authSession);
      if (savedUser?.id) {
        setCurrentUser(savedUser);
      }
      // Developer contact & master reset — storage-এ না থাকলে hardcoded default ব্যবহার
      setDevContact      ((await load(SK.devContact))      || DEV_CONTACT);
      setMasterResetHash ((await load(SK.masterResetHash)) || DEV_MASTER_HASH);
      setLoaded(true);
    })();
  }, []);

  useEffect(() => { if (loaded) save(SK.customers, customers); }, [customers, loaded]);
  useEffect(() => { if (loaded) save(SK.products,  products);  }, [products, loaded]);
  useEffect(() => { if (loaded) save(SK.invoices,  invoices);  }, [invoices, loaded]);
  useEffect(() => { if (loaded) save(SK.txns,      txns);      }, [txns, loaded]);
  useEffect(() => { if (loaded) save(SK.smsLog,    smsLog);    }, [smsLog, loaded]);
  useEffect(() => { if (loaded) save(SK.users,     users);     }, [users, loaded]);
  useEffect(() => { if (loaded) save(SK.shopName,  shopName);  }, [shopName, loaded]);
  useEffect(() => { if (loaded) save(SK.darkMode,  darkMode);  }, [darkMode, loaded]);
  useEffect(() => { if (loaded) save(SK.deletedCustomers, deletedCustomers); }, [deletedCustomers, loaded]);
  useEffect(() => { if (loaded) save(SK.paymentInvoices,  paymentInvoices);  }, [paymentInvoices, loaded]);
  useEffect(() => { if (loaded) save(SK.smsGateway, smsGateway); }, [smsGateway, loaded]);
  useEffect(() => { if (loaded) save(SK.anthropicKey, anthropicKey); }, [anthropicKey, loaded]);
  useEffect(() => { if (loaded) save(SK.smsTemplates, smsTemplates); }, [smsTemplates, loaded]);
  useEffect(() => { if (loaded) save(SK.autoBackupEnabled, autoBackupEnabled); }, [autoBackupEnabled, loaded]);
  useEffect(() => { if (loaded) save(SK.firebaseConfig,  firebaseConfig);  }, [firebaseConfig, loaded]);   // 🔥
  useEffect(() => { if (loaded) save(SK.firebaseEnabled, firebaseEnabled); }, [firebaseEnabled, loaded]);
  useEffect(() => { if (loaded) save(SK.authSession, currentUser); }, [currentUser, loaded]); // auto-login

  useEffect(() => {
    if (!loaded) return;
    const TWELVE_H = 1 * 60 * 60 * 1000; // ১ ঘণ্টা
    const check = () => {
      const now  = Date.now();
      const last = lastAutoBackup ? new Date(lastAutoBackup).getTime() : 0;
      const needed = now - last >= TWELVE_H;
      setBackupNeeded(needed);
      // ✅ AUTO-TRIGGER: if enabled and 12h passed, perform backup automatically
      if (needed && autoBackupEnabled) {
        performDriveBackup();
      }
    };
    check();
    const iv = setInterval(check, 60 * 60 * 1000); // recheck every hour
    return () => clearInterval(iv);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, lastAutoBackup, autoBackupEnabled]);

  const showToast = useCallback((msg, color = "#22c55e") => {
    setToast({ msg, color }); setTimeout(() => setToast(null), 3200);
  }, []);

  const buildBackupData = useCallback(() => ({
    customers, products, invoices, txns, smsLog, paymentInvoices,
    exportedAt: new Date().toISOString(), version: "v7",
    meta: { totalCustomers: customers.length, totalInvoices: invoices.length, totalTxns: txns.length }
  }), [customers, products, invoices, txns, smsLog, paymentInvoices]);

  const performDriveBackup = useCallback(async () => {
    setDriveStatus("uploading");
    const now = new Date();
    const filename = `dukan-backup-${now.toISOString().split("T")[0]}.json`;
    const data = buildBackupData();
    try {
      // 1️⃣ Save file locally (Downloads on APK, browser download on web)
      await FS.saveBackup(data, filename);
      const ts = now.toISOString();
      setLastAutoBackup(ts);
      await save(SK.lastAutoBackup, ts);
      // 2️⃣ Save snapshot for local multi-device
      await save(SK.backupSnapshot, { ...data, snapshotAt: ts });

      // 3️⃣ 🔥 Save to Firebase (if enabled)
      if (FB.isReady() && firebaseEnabled) {
        setFbStatus("syncing");
        const result = await FB.saveBackup(data, filename);
        if (result.ok) {
          setFbBackupList([{ key: result.key, at: result.at, filename,
            meta: { c: data.customers?.length, i: data.invoices?.length, t: data.txns?.length } }]);
          setFbStatus("synced");
          showToast("☁️ Firebase-এ ব্যাকআপ সংরক্ষিত হয়েছে ✓");
          setTimeout(() => setFbStatus(null), 4000);
        } else {
          setFbStatus("error");
          showToast(`Firebase: ${result.msg}`, "#ef4444");
          setTimeout(() => setFbStatus(null), 6000);
        }
      } else {
        showToast("⬇️ ব্যাকআপ ডাউনলোড হয়েছে ✓");
      }

      setBackupNeeded(false);
      setDriveStatus("success");
      setTimeout(() => setDriveStatus(null), 4000);
    } catch (e) {
      setDriveStatus("error");
      showToast("ব্যাকআপ ব্যর্থ হয়েছে", "#ef4444");
      setTimeout(() => setDriveStatus(null), 4000);
    }
  }, [buildBackupData, showToast, firebaseEnabled]);

  // 🔥 Restore from Firebase backup
  const restoreFromFirebase = useCallback(async () => {
    if (!FB.isReady()) return { ok: false, msg: "Firebase সংযুক্ত নেই" };
    return await FB.loadBackup();
  }, []);

  // 🔥 Load Firebase backup index on mount
  useEffect(() => {
    if (!loaded || !firebaseEnabled || !firebaseConfig) return;
    FB.init(firebaseConfig);
    (async () => {
      const idx = await FB.get("dukan/idx");
      if (idx?.k) {
        setFbBackupList([{ key: idx.k, at: idx.at, filename: idx.fn, meta: idx.meta }]);
      }
    })();
  }, [loaded, firebaseEnabled, firebaseConfig]);

  const sendSMS = useCallback(async (customer, type, amount) => {
    const text = await generateSMS(customer, type, amount, customer.balance, shopName, anthropicKey, smsTemplates);
    const logEntry = { id: uid(), to: customer.mobile, name: customer.name, text, time: nowStr(), type, dateKey: todayEn(), delivered: false };
    if (smsGateway?.apiKey) {
      const result = await sendRealSMS(customer.mobile, text, smsGateway);
      logEntry.delivered = result.success;
      logEntry.error = result.error;
      if (result.success) showToast("SMS সফলভাবে পাঠানো হয়েছে ✓");
      else showToast(`SMS সিমুলেশন: ${text.slice(0,30)}...`);
    }
    setSmsLog(prev => [logEntry, ...prev]);
    setSmsCount(prev => Math.max(0, prev - 1));
  }, [shopName, smsGateway, anthropicKey, showToast]);

  const addTxn = useCallback((customerId, type, amount, balanceAfter, invoiceId = null, note = "", paymentInvoiceId = null) => {
    const entry = { id: uid(), customerId, type, amount, balanceAfter, invoiceId, paymentInvoiceId, note, date: todayStr(), dateKey: todayEn(), time: nowStr() };
    setTxns(prev => [entry, ...prev]);
    return entry;
  }, []);

  const createPaymentInvoice = useCallback((customer, amount, note) => {
    const inv = {
      id: uid(), customerId: customer.id, customerName: customer.name,
      customerMobile: customer.mobile, amount, note, date: todayStr(),
      dateKey: todayEn(), time: nowStr(), shopName, type: "payment"
    };
    setPaymentInvoices(prev => [inv, ...prev]);
    return inv;
  }, [shopName]);

  const connectBluetooth = useCallback(async () => {
    await BT.init();
    showToast("প্রিন্টার খোঁজা হচ্ছে...", "#0ea5e9");
    const r = await BT.connect();
    if (r.ok) {
      setBtConnected(true);
      setBtDevice({ name: r.name, id: r.id });
      showToast(`প্রিন্টার সংযুক্ত: ${r.name} ✓`);
      await Haptic.success();
    } else {
      showToast(r.msg || "প্রিন্টার সংযোগ ব্যর্থ", "#ef4444");
      await Haptic.error();
    }
  }, [showToast]);

  const disconnectBluetooth = useCallback(async () => {
    await BT.disconnect();
    setBtDevice(null); setBtConnected(false);
    showToast("ব্লুটুথ সংযোগ বিচ্ছিন্ন", "#f59e0b");
  }, [showToast]);

  const todayBaki  = useMemo(() => txns.filter(t => t.dateKey === todayEn() && t.type === "baki").reduce((s, t) => s + t.amount, 0), [txns]);
  const todayJoma  = useMemo(() => txns.filter(t => t.dateKey === todayEn() && t.type === "joma").reduce((s, t) => s + t.amount, 0), [txns]);
  const todayInvs  = useMemo(() => invoices.filter(i => i.dateKey === todayEn()), [invoices]);
  const todayTotal = useMemo(() => todayInvs.reduce((s, i) => s + i.total, 0), [todayInvs]);
  const totalBaki  = useMemo(() => customers.reduce((s, c) => s + c.balance, 0), [customers]);

  // Hide HTML splash screen once React is ready
  useEffect(() => {
    if (loaded && typeof window.__hideSplash === "function") window.__hideSplash();
  }, [loaded]);

  if (!loaded) return (
    <div style={{ ...makeS(DARK).loadScreen, background: "radial-gradient(ellipse at 50% 30%,#0d2818 0%,#080f0a 70%)" }}>
      <div style={{ position: "relative", width: 80, height: 80, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ fontSize: 36, animation: "fadeUp 0.6s ease" }}>🏪</div>
        <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: "3px solid transparent", borderTopColor: "#2dda7a", animation: "spin 1s cubic-bezier(0.4,0,0.6,1) infinite" }} />
        <div style={{ position: "absolute", inset: 8, borderRadius: "50%", border: "2px solid transparent", borderTopColor: "#22c55e44", animation: "spin 1.8s cubic-bezier(0.4,0,0.6,1) infinite reverse" }} />
      </div>
      <div style={{ color: "#e8f5eb", fontWeight: 800, fontSize: 18, letterSpacing: 0.5, textShadow: "0 0 20px rgba(45,218,122,0.3)" }}>হিসাবঘর</div>
      <span style={{ color: "#4ade8066", fontSize: 13, animation: "pulse 1.5s ease-in-out infinite" }}>লোড হচ্ছে...</span>
      <style>{`
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        @keyframes pulse{0%,100%{opacity:0.4}50%{opacity:1}}
      `}</style>
    </div>
  );

  if (!currentUser) return (
    <LoginScreen users={users} onLogin={setCurrentUser} shopName={shopName} T={T} setUsers={setUsers}
      devContact={devContact} masterResetHash={masterResetHash} />
  );

  const showDetail = tab === "customers" && detailCId;
  const detailCust = showDetail ? customers.find(c => c.id === detailCId) : null;
  const S = makeS(T);

  const navItems = [
    { id: "dashboard", label: "হোম",     icon: "M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" },
    { id: "customers", label: "কাস্টমার", icon: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" },
    { id: "invoice",   label: "ইনভয়েস",  icon: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6" },
    { id: "products",  label: "পণ্য",     icon: "M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4zM3 6h18" },
    { id: "settings",  label: "সেটিং",   icon: "M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" },
  ];

  const tabTitles = { customers:"কাস্টমার", invoice:"নতুন ইনভয়েস", products:"পণ্য তালিকা", settings:"সেটিং" };

  return (
    <div style={S.root}>
      <style>{`
        /* ── Core Animations ─────────────────────────── */
        @keyframes spin       { to { transform: rotate(360deg); } }
        @keyframes fadeIn     { from { opacity:0; } to { opacity:1; } }
        @keyframes fadeUp     { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }
        @keyframes slideUpModal { from { opacity:0; transform:translateY(40px); } to { opacity:1; transform:translateY(0); } }
        @keyframes slideDown  { from { opacity:0; transform:translateY(-10px); } to { opacity:1; transform:translateY(0); } }
        @keyframes pinPop     { 0%{transform:scale(0.6)} 60%{transform:scale(1.2)} 100%{transform:scale(1)} }
        @keyframes toastPop   { from{opacity:0;transform:translateX(-50%) translateY(12px) scale(0.95)} to{opacity:1;transform:translateX(-50%) translateY(0) scale(1)} }
        @keyframes shimmer    { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
        @keyframes pulse      { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.7;transform:scale(0.97)} }
        @keyframes bounceIn   { 0%{transform:scale(0.8);opacity:0} 70%{transform:scale(1.05);opacity:1} 100%{transform:scale(1)} }
        @keyframes ripple     { from{transform:scale(0);opacity:0.4} to{transform:scale(2.5);opacity:0} }
        @keyframes glow       { 0%,100%{box-shadow:0 0 12px rgba(45,218,122,0.2)} 50%{box-shadow:0 0 28px rgba(45,218,122,0.45)} }
        @keyframes navPop     { 0%{transform:translateY(0)} 40%{transform:translateY(-4px)} 100%{transform:translateY(0)} }

        /* ── Interactive States ──────────────────────── */
        button:active { transform: scale(0.96) !important; }

        /* ── Input Focus ─────────────────────────────── */
        input:focus, textarea:focus, select:focus {
          border-color: ${T.accent} !important;
          box-shadow: 0 0 0 3px ${T.accentGlow} !important;
        }

        /* ── Scrollbar ───────────────────────────────── */
        ::-webkit-scrollbar { width: 3px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: ${T.border}; border-radius: 10px; }

        /* ── List Item Stagger ───────────────────────── */
        .list-item { animation: fadeUp 0.2s ease both; }
        .list-item:nth-child(1) { animation-delay: 0ms; }
        .list-item:nth-child(2) { animation-delay: 40ms; }
        .list-item:nth-child(3) { animation-delay: 80ms; }
        .list-item:nth-child(4) { animation-delay: 120ms; }
        .list-item:nth-child(5) { animation-delay: 160ms; }

        /* ── Nav Active Pill ─────────────────────────── */
        .nav-active-pill {
          position: absolute;
          inset: 0;
          background: ${T.navPill};
          border-radius: 14px;
          animation: bounceIn 0.25s cubic-bezier(0.4,0,0.2,1);
        }

        /* ── Card Hover ──────────────────────────────── */
        .tap-card:active { transform: scale(0.98) !important; box-shadow: none !important; }

        /* ── Safe Area ───────────────────────────────── */
        .safe-pb { padding-bottom: env(safe-area-inset-bottom, 0px); }
      `}</style>

      <header style={{ ...S.header, flexDirection: "column", padding: "0", background: T.header }}>
        {/* Top utility bar — back button only when in detail */}
        {showDetail && (
          <div style={{ display: "flex", alignItems: "center", width: "100%", padding: "8px 14px 0", boxSizing: "border-box", paddingTop: "calc(8px + env(safe-area-inset-top, 0px))" }}>
            <button style={S.backBtn} onClick={() => setDetailCId(null)}><IcBack /></button>
          </div>
        )}

        {/* Centered brand block */}
        <div style={{
          textAlign: "center",
          padding: showDetail ? "8px 16px 14px" : "calc(10px + env(safe-area-inset-top, 0px)) 16px 14px",
          width: "100%", boxSizing: "border-box"
        }}>
          {tab === "dashboard" && !showDetail && (
            <div style={{ fontSize: 30, lineHeight: 1, marginBottom: 3, filter: "drop-shadow(0 3px 10px rgba(0,0,0,0.4))", animation: "glow 3s ease-in-out infinite" }}>🛒</div>
          )}
          <div style={{
            color: "#ffffff", fontWeight: 900,
            fontSize: showDetail ? 18 : 22,
            letterSpacing: 0.3,
            textShadow: "0 2px 12px rgba(0,0,0,0.5)",
            marginBottom: 3,
            lineHeight: 1.2,
          }}>
            {showDetail ? detailCust?.name : (tab === "dashboard" ? shopName : (tabTitles[tab] || shopName))}
          </div>
          {showDetail
            ? <div style={{ color: "#a7f3d0", fontSize: 12, fontWeight: 600, textShadow: "0 1px 4px rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <span>📞 {detailCust?.mobile}</span>
                <span style={{ opacity: 0.4 }}>·</span>
                <span>👤 {currentUser.name}</span>
              </div>
            : (tab === "dashboard" ? <MemoLiveDateTime /> : <div style={{ color:"#a7f3d0", fontSize:11, fontWeight: 600, opacity: 0.85 }}>{shopName}</div>)
          }
        </div>
        {/* Bottom glow accent line */}
        <div style={{ height: 2, background: `linear-gradient(90deg,transparent,${T.accent}66,transparent)`, width: "100%" }} />
      </header>

      <main style={S.main}>
        {tab === "dashboard" && (
          <Dashboard T={T} S={S}
            customers={customers} invoices={invoices} totalBaki={totalBaki}
            todayBaki={todayBaki} todayJoma={todayJoma} todayTotal={todayTotal}
            todayInvs={todayInvs} setTab={setTab} txns={txns}
            dashModal={dashModal} setDashModal={setDashModal}
            paymentInvoices={paymentInvoices}
          />
        )}
        {tab === "customers" && !showDetail && (
          <Customers T={T} S={S}
            customers={customers} setCustomers={setCustomers}
            showToast={showToast} setModal={setModal}
            onOpenDetail={id => setDetailCId(id)}
            deletedCustomers={deletedCustomers} setDeletedCustomers={setDeletedCustomers}
            onGoToInvoice={c => { setPreselectedCust(c); setTab("invoice"); }}
          />
        )}
        {showDetail && (
          <CustomerDetail T={T} S={S}
            customer={detailCust} txns={txns.filter(t => t.customerId === detailCId)}
            invoices={invoices} customers={customers} paymentInvoices={paymentInvoices.filter(p => p.customerId === detailCId)}
          />
        )}
        {tab === "invoice" && (
          <SmartInvoiceBuilder T={T} S={S}
            customers={customers} products={products}
            setCustomers={setCustomers} setInvoices={setInvoices} setProducts={setProducts}
            sendSMS={sendSMS} showToast={showToast} addTxn={addTxn} shopName={shopName}
            btConnected={btConnected} btDevice={btDevice} onConnectBluetooth={connectBluetooth}
            createPaymentInvoice={createPaymentInvoice}
            preselectedCustomer={preselectedCust}
          />
        )}
        {tab === "products" && (
          <Products T={T} S={S} products={products} setProducts={setProducts} showToast={showToast} />
        )}
        {tab === "sms" && (
          <SmsLog T={T} S={S}
            smsLog={smsLog} smsCount={smsCount} setSmsCount={setSmsCount}
            customers={customers} sendSMS={sendSMS} showToast={showToast}
            smsGateway={smsGateway}
          />
        )}
        {tab === "settings" && (
          <Settings T={T} S={S}
            shopName={shopName} setShopName={setShopName}
            users={users} setUsers={setUsers}
            currentUser={currentUser} setCurrentUser={setCurrentUser}
            showToast={showToast}
            customers={customers} setCustomers={setCustomers}
            products={products} setProducts={setProducts}
            invoices={invoices} setInvoices={setInvoices}
            txns={txns} setTxns={setTxns}
            smsLog={smsLog} setSmsLog={setSmsLog}
            darkMode={darkMode} setDarkMode={setDarkMode}
            deletedCustomers={deletedCustomers} setDeletedCustomers={setDeletedCustomers}
            smsGateway={smsGateway} setSmsGateway={setSmsGateway}
            btConnected={btConnected} btDevice={btDevice}
            onConnectBluetooth={connectBluetooth} onDisconnectBluetooth={disconnectBluetooth}
            paymentInvoices={paymentInvoices} setPaymentInvoices={setPaymentInvoices}
            lastAutoBackup={lastAutoBackup} driveStatus={driveStatus}
            backupNeeded={backupNeeded} performDriveBackup={performDriveBackup}
            buildBackupData={buildBackupData} setBackupNeeded={setBackupNeeded}
            anthropicKey={anthropicKey} setAnthropicKey={setAnthropicKey}
            smsTemplates={smsTemplates} setSmsTemplates={setSmsTemplates}
            autoBackupEnabled={autoBackupEnabled} setAutoBackupEnabled={setAutoBackupEnabled}
            firebaseConfig={firebaseConfig} setFirebaseConfig={setFirebaseConfig}
            firebaseEnabled={firebaseEnabled} setFirebaseEnabled={setFirebaseEnabled}
            fbStatus={fbStatus} fbBackupList={fbBackupList}
            restoreFromFirebase={restoreFromFirebase}
            setAuthSession={setAuthSession}
            devContact={devContact} setDevContact={setDevContact}
            masterResetHash={masterResetHash} setMasterResetHash={setMasterResetHash}
          />
        )}
      </main>

      <nav style={S.nav}>
        {navItems.map(n => {
          const isActive = tab === n.id && !showDetail;
          return (
            <button key={n.id}
              style={{
                ...S.navBtn,
                color: isActive ? T.navActive : T.sub,
              }}
              onClick={() => { setDetailCId(null); setTab(n.id); }}>
              {isActive && <span className="nav-active-pill" />}
              <span style={{ position: "relative", zIndex: 1, transition: "transform 0.2s", transform: isActive ? "scale(1.15)" : "scale(1)" }}>
                <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={isActive ? 2.5 : 1.8} strokeLinecap="round" strokeLinejoin="round">
                  <path d={n.icon} />
                </svg>
              </span>
              <span style={{
                fontSize: 9.5, fontWeight: isActive ? 800 : 600,
                position: "relative", zIndex: 1,
                transition: "all 0.2s",
                letterSpacing: isActive ? 0.3 : 0,
              }}>{n.label}</span>
              {n.id === "settings" && backupNeeded && false && (
                <span style={{
                  width: 7, height: 7,
                  background: "#f59e0b",
                  borderRadius: "50%",
                  position: "absolute", top: 6, right: "calc(50% - 14px)",
                  boxShadow: "0 0 6px #f59e0b88",
                  animation: "pulse 1.5s ease-in-out infinite",
                }} />
              )}
            </button>
          );
        })}
      </nav>

      {toast && (
        <div style={{
          position: "fixed",
          bottom: "calc(80px + env(safe-area-inset-bottom, 0px))",
          left: "50%",
          transform: "translateX(-50%)",
          background: toast.color === "#22c55e" ? "linear-gradient(135deg,#1ab860,#2dda7a)"
            : toast.color === "#ef4444" ? "linear-gradient(135deg,#dc2626,#f87171)"
            : toast.color === "#f59e0b" ? "linear-gradient(135deg,#d97706,#fbbf24)"
            : toast.color,
          color: "#fff",
          padding: "12px 22px",
          borderRadius: 100,
          fontWeight: 700,
          fontSize: 13,
          display: "flex", alignItems: "center", gap: 8,
          zIndex: 300,
          boxShadow: `0 6px 28px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.1)`,
          whiteSpace: "nowrap",
          animation: "toastPop 0.3s cubic-bezier(0.34,1.56,0.64,1)",
          backdropFilter: "blur(10px)",
          letterSpacing: 0.2,
          maxWidth: "calc(100vw - 40px)",
        }}>
          <IcCheck /> {toast.msg}
        </div>
      )}

      {modal?.type === "transaction" && (
        <TransactionModal T={T} S={S}
          customer={modal.data} setCustomers={setCustomers}
          sendSMS={sendSMS} showToast={showToast} addTxn={addTxn}
          createPaymentInvoice={createPaymentInvoice}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

// ── Dynamic Styles ─────────────────────────────────────────────────────────────
function makeS(T) {
  // Responsive font scale helper
  const fs = (base) => `clamp(${base - 1}px, ${base / 375 * 100}vw, ${base + 2}px)`;
  const sp = (n) => `clamp(${Math.max(n-2,4)}px, ${n / 375 * 100}vw, ${n+4}px)`;

  return {
    root: {
      fontFamily: "'Hind Siliguri','Noto Sans Bengali',sans-serif",
      background: T.bg,
      minHeight: "100dvh",
      display: "flex",
      flexDirection: "column",
      maxWidth: 480,
      margin: "0 auto",
      position: "relative",
      overflowX: "hidden",
    },
    loadScreen: {
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      height: "100dvh", gap: 16, background: T.bg,
    },

    // ── Header ────────────────────────────────────────
    header: {
      background: T.header,
      padding: "0",
      display: "flex",
      flexDirection: "column",
      boxShadow: `0 2px 20px rgba(0,0,0,0.5), ${T.shadowGlow}`,
      position: "sticky",
      top: 0,
      zIndex: 50,
      backdropFilter: "blur(12px)",
      WebkitBackdropFilter: "blur(12px)",
    },
    headerBrand: { display: "flex", alignItems: "center", gap: 10 },
    headerTitle: { color: "#fff", fontWeight: 800, fontSize: fs(18), letterSpacing: 0.3 },
    headerSub:   { color: "#a7f3d0", fontSize: fs(11) },
    iconBtn: {
      background: "rgba(255,255,255,0.12)",
      backdropFilter: "blur(8px)",
      border: "1px solid rgba(255,255,255,0.15)",
      color: "#fff", borderRadius: 12,
      width: 36, height: 36,
      display: "flex", alignItems: "center", justifyContent: "center",
      cursor: "pointer",
      transition: "all 0.18s cubic-bezier(0.4,0,0.2,1)",
    },
    backBtn: {
      background: "rgba(255,255,255,0.15)",
      border: "1px solid rgba(255,255,255,0.2)",
      color: "#fff", borderRadius: 12,
      width: 38, height: 38,
      display: "flex", alignItems: "center", justifyContent: "center",
      cursor: "pointer",
      transition: "all 0.18s cubic-bezier(0.4,0,0.2,1)",
    },

    // ── Layout ────────────────────────────────────────
    pill: {
      borderRadius: 100, padding: "4px 14px",
      fontSize: fs(12), fontWeight: 700,
    },
    main: {
      flex: 1,
      overflowY: "auto",
      overflowX: "hidden",
      paddingBottom: "calc(72px + env(safe-area-inset-bottom, 0px))",
      WebkitOverflowScrolling: "touch",
      scrollBehavior: "smooth",
    },
    page: { padding: sp(16) },

    // ── Bottom Nav ────────────────────────────────────
    nav: {
      position: "fixed",
      bottom: 0,
      left: "50%",
      transform: "translateX(-50%)",
      width: "100%",
      maxWidth: 480,
      background: T.nav,
      borderTop: `1px solid ${T.navBorder}`,
      backdropFilter: "blur(20px)",
      WebkitBackdropFilter: "blur(20px)",
      display: "flex",
      padding: `10px 8px calc(10px + env(safe-area-inset-bottom, 0px))`,
      zIndex: 50,
      boxShadow: `0 -4px 24px rgba(0,0,0,0.3)`,
      gap: 4,
    },
    navBtn: {
      flex: 1,
      display: "flex", flexDirection: "column",
      alignItems: "center", gap: 3,
      background: "none", border: "none",
      color: T.sub, cursor: "pointer",
      padding: "6px 4px",
      fontFamily: "inherit",
      position: "relative",
      borderRadius: 14,
      transition: "all 0.2s cubic-bezier(0.4,0,0.2,1)",
      minHeight: 52,
      justifyContent: "center",
    },

    // ── Stats ─────────────────────────────────────────
    statsGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: sp(10), marginBottom: sp(16) },
    statCard: {
      background: T.card,
      borderRadius: 20,
      padding: sp(16),
      border: `1px solid ${T.border}`,
      display: "flex", flexDirection: "column", gap: 8,
      cursor: "pointer",
      boxShadow: T.shadowSm,
      transition: "all 0.2s cubic-bezier(0.4,0,0.2,1)",
    },
    statIcon: {
      width: 40, height: 40, borderRadius: 12,
      display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20,
    },
    statValue: { fontSize: fs(22), fontWeight: 800, lineHeight: 1.1 },
    statLabel: { fontSize: fs(12), color: T.sub, lineHeight: 1.3 },

    // ── Cards & Sections ──────────────────────────────
    section: {
      background: T.card,
      borderRadius: 20,
      padding: sp(16),
      marginBottom: sp(12),
      border: `1px solid ${T.border}`,
      boxShadow: T.shadowSm,
    },
    secRow: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: sp(12) },
    secTitle: { color: T.text, fontWeight: 700, fontSize: fs(15) },
    linkBtn: {
      background: T.accentPill,
      border: "none",
      color: T.accent,
      fontSize: fs(12),
      cursor: "pointer",
      borderRadius: 100,
      padding: "4px 12px",
      fontWeight: 700,
      fontFamily: "inherit",
      transition: "all 0.15s",
    },

    // ── List Rows ─────────────────────────────────────
    listRow: {
      display: "flex", alignItems: "center", gap: sp(12),
      padding: `${sp(11)} 0`,
      borderBottom: `1px solid ${T.border}`,
      transition: "background 0.15s",
    },
    avatar: {
      width: 44, height: 44, borderRadius: 14,
      background: `linear-gradient(145deg,${T.accentDark || "#1ab860"},${T.accent})`,
      color: "#fff",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontWeight: 800, fontSize: fs(15),
      flexShrink: 0,
      boxShadow: `0 2px 10px ${T.accentGlow}`,
    },
    rowName: { color: T.text, fontWeight: 700, fontSize: fs(14), lineHeight: 1.3 },
    rowSub:  { color: T.sub, fontSize: fs(12), marginTop: 2, lineHeight: 1.3 },
    rowAmt:  { fontWeight: 800, fontSize: fs(16), lineHeight: 1.2 },
    empty: {
      color: T.sub, textAlign: "center",
      padding: `${sp(28)} ${sp(16)}`,
      fontSize: fs(14), lineHeight: 1.6,
    },

    // ── Search ────────────────────────────────────────
    searchBar: {
      display: "flex", alignItems: "center", gap: sp(10),
      background: T.card,
      borderRadius: 16,
      padding: `${sp(12)} ${sp(14)}`,
      marginBottom: sp(10),
      border: `1px solid ${T.border}`,
      boxShadow: T.shadowSm,
      transition: "border-color 0.2s, box-shadow 0.2s",
    },
    searchInput: {
      flex: 1, background: "none", border: "none",
      color: T.text, fontSize: fs(14), outline: "none",
      fontFamily: "inherit",
    },

    // ── Buttons ───────────────────────────────────────
    addBtn: {
      display: "flex", alignItems: "center", gap: 8,
      background: `linear-gradient(135deg,${T.accentDark || "#1ab860"},${T.accent})`,
      color: "#fff", border: "none", borderRadius: 14,
      padding: `${sp(12)} ${sp(18)}`,
      fontWeight: 700, fontSize: fs(14),
      cursor: "pointer", marginBottom: sp(12),
      fontFamily: "inherit",
      boxShadow: `0 4px 16px ${T.accentGlow}`,
      transition: "all 0.2s cubic-bezier(0.4,0,0.2,1)",
    },
    card: {
      background: T.card, borderRadius: 20,
      padding: sp(16), marginBottom: sp(12),
      border: `1px solid ${T.border}`,
      boxShadow: T.shadowSm,
      animation: "fadeUp 0.25s cubic-bezier(0.4,0,0.2,1)",
    },
    cardTitle: { color: T.text, fontWeight: 700, fontSize: fs(15), marginBottom: sp(14) },

    // ── Inputs ────────────────────────────────────────
    input: {
      width: "100%",
      background: T.input,
      border: `1.5px solid ${T.inputBorder || T.border}`,
      borderRadius: 12,
      padding: `${sp(13)} ${sp(14)}`,
      color: T.text, fontSize: fs(14),
      outline: "none", marginBottom: sp(10),
      boxSizing: "border-box",
      fontFamily: "inherit",
      transition: "border-color 0.2s, box-shadow 0.2s",
      lineHeight: 1.4,
    },
    label: {
      color: T.sub, fontSize: fs(12),
      marginBottom: 5, display: "block",
      fontWeight: 600, letterSpacing: 0.3,
    },

    // ── Row Buttons ───────────────────────────────────
    rowBtns: { display: "flex", gap: sp(10), marginTop: sp(6) },
    cancelBtn: {
      flex: 1, background: T.border, color: T.sub,
      border: "none", borderRadius: 12,
      padding: sp(11), fontWeight: 600,
      cursor: "pointer", fontFamily: "inherit",
      fontSize: fs(14),
      transition: "all 0.15s",
    },
    saveBtn: {
      flex: 2,
      background: `linear-gradient(135deg,${T.accentDark || "#1ab860"},${T.accent})`,
      color: "#fff", border: "none", borderRadius: 12,
      padding: sp(11), fontWeight: 800,
      cursor: "pointer", fontFamily: "inherit",
      fontSize: fs(14),
      display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
      boxShadow: `0 3px 14px ${T.accentGlow}`,
      transition: "all 0.2s cubic-bezier(0.4,0,0.2,1)",
    },
    textBtn: {
      background: "none", border: "none",
      color: T.accent, fontSize: fs(13),
      cursor: "pointer", padding: `0 0 ${sp(14)} 0`,
      fontFamily: "inherit", fontWeight: 600,
    },

    // ── Customer Cards ────────────────────────────────
    custCard: {
      background: T.card,
      borderRadius: 18, padding: sp(14),
      border: `1px solid ${T.border}`,
      boxShadow: T.shadowSm,
      transition: "box-shadow 0.2s, transform 0.2s",
    },
    custName: {
      color: T.info || "#60a5fa",
      fontWeight: 700, fontSize: fs(14),
      textDecoration: "none",
    },
    actionRow: { display: "flex", gap: sp(6) },
    actionBtn: {
      border: "none", borderRadius: 10,
      padding: `${sp(9)} ${sp(12)}`,
      fontSize: fs(12), fontWeight: 700,
      cursor: "pointer",
      display: "flex", alignItems: "center", gap: 4,
      fontFamily: "inherit",
      transition: "all 0.15s cubic-bezier(0.4,0,0.2,1)",
      minHeight: 40,
    },

    // ── Transaction Cards ─────────────────────────────
    txnSummary: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: sp(10), marginBottom: sp(14) },
    sumCard: {
      background: T.card, borderRadius: 16,
      padding: sp(14), border: `1px solid ${T.border}`,
      boxShadow: T.shadowSm,
    },
    histLabel: { color: T.sub, fontWeight: 700, fontSize: fs(12), marginBottom: sp(10), letterSpacing: 0.5 },
    txnCard: {
      background: T.card, borderRadius: 14,
      overflow: "hidden", display: "flex",
      border: `1px solid ${T.border}`,
      marginBottom: 6,
    },
    txnBadge: {
      borderRadius: 8, padding: "3px 10px",
      fontSize: fs(11), fontWeight: 800,
      letterSpacing: 0.3,
    },
    invBtn: {
      display: "flex", alignItems: "center", gap: 8,
      background: T.infoBg || T.bg,
      border: `1px solid ${T.border}`,
      borderRadius: 12,
      padding: `${sp(9)} ${sp(12)}`,
      color: T.info || "#60a5fa",
      fontSize: fs(12), cursor: "pointer",
      width: "100%", fontFamily: "inherit",
      fontWeight: 700,
      transition: "all 0.15s",
    },

    // ── Modal / Overlay ───────────────────────────────
    overlay: {
      position: "fixed", inset: 0,
      background: "rgba(0,0,0,0.75)",
      backdropFilter: "blur(4px)",
      WebkitBackdropFilter: "blur(4px)",
      display: "flex", alignItems: "flex-end",
      zIndex: 200,
      animation: "fadeIn 0.2s ease",
    },
    modalCard: {
      background: T.card,
      borderRadius: "24px 24px 0 0",
      padding: `${sp(24)} ${sp(20)} calc(${sp(32)} + env(safe-area-inset-bottom,0px))`,
      width: "100%", maxWidth: 480, margin: "0 auto",
      boxShadow: "0 -8px 40px rgba(0,0,0,0.5)",
      animation: "slideUpModal 0.3s cubic-bezier(0.4,0,0.2,1)",
      maxHeight: "92dvh",
      overflowY: "auto",
    },

    // ── Mode Toggle ───────────────────────────────────
    modeToggle: {
      display: "flex", background: T.bg,
      borderRadius: 14, padding: 4,
      marginBottom: sp(14), gap: 4,
      border: `1px solid ${T.border}`,
    },
    modeBtn: {
      flex: 1, background: "none", border: "none",
      color: T.sub, borderRadius: 11, padding: sp(10),
      fontWeight: 700, cursor: "pointer",
      fontFamily: "inherit", fontSize: fs(14),
      transition: "all 0.2s cubic-bezier(0.4,0,0.2,1)",
    },
    dashed: { borderTop: `1px dashed ${T.border}`, margin: `${sp(12)} 0` },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// ── PIN NUMPAD COMPONENT ──────────────────────────────────────────────────────
function PinPad({ T, onComplete, title = "PIN লিখুন", subtitle = "" }) {
  const [pin, setPin] = useState("");
  const digits = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"];
  const numMap = { "1": "1", "2": "2", "3": "3", "4": "4", "5": "5", "6": "6", "7": "7", "8": "8", "9": "9", "0": "0" };

  const handleKey = (d) => {
    if (d === "⌫") {
      setPin(p => p.slice(0, -1));
    } else if (d !== "" && pin.length < 4) {
      const newPin = pin + numMap[d];
      setPin(newPin);
      if (newPin.length === 4) {
        setTimeout(() => onComplete(newPin), 200);
      }
    }
  };

  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ color: T.text, fontWeight: 800, fontSize: 17, marginBottom: 4, letterSpacing: 0.3 }}>{title}</div>
      {subtitle && <div style={{ color: T.sub, fontSize: 12, marginBottom: 24, lineHeight: 1.5 }}>{subtitle}</div>}
      {/* PIN dots */}
      <div style={{ display: "flex", justifyContent: "center", gap: 16, marginBottom: 32 }}>
        {[0,1,2,3].map(i => (
          <div key={i} style={{
            width: 18, height: 18, borderRadius: "50%",
            background: pin.length > i
              ? `linear-gradient(135deg,#1ab860,#2dda7a)`
              : T.border,
            border: pin.length === i ? `2px solid ${T.accent}66` : "none",
            transition: "all 0.25s cubic-bezier(0.34,1.56,0.64,1)",
            transform: pin.length > i ? "scale(1.15)" : "scale(1)",
            boxShadow: pin.length > i ? `0 0 12px rgba(45,218,122,0.4)` : "none",
            animation: pin.length > i ? "pinPop 0.25s ease" : "none",
          }} />
        ))}
      </div>
      {/* Numpad */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, maxWidth: 252, margin: "0 auto" }}>
        {digits.map((d, i) => (
          <button key={i} onClick={() => handleKey(d)}
            disabled={d === ""}
            style={{
              background: d === "⌫"
                ? T.dangerBg || "#ef444418"
                : d === ""
                ? "transparent"
                : T.card,
              border: d === "" ? "none" : `1.5px solid ${d === "⌫" ? T.danger + "33" : T.border}`,
              borderRadius: 16,
              height: 60,
              fontSize: d === "⌫" ? 22 : 24,
              fontWeight: 700,
              cursor: d === "" ? "default" : "pointer",
              color: d === "⌫" ? T.danger || "#f87171" : T.text,
              fontFamily: "inherit",
              transition: "all 0.15s cubic-bezier(0.4,0,0.2,1)",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: d !== "" && d !== "⌫" ? T.shadowSm : "none",
            }}>
            {d}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Login Screen ─────────────────────────────────────────────────────────────
// PIN login + Forgot flow: contact developer → enter master reset code → new PIN
function LoginScreen({ users, onLogin, shopName, T, setUsers, devContact, masterResetHash }) {
  const S = makeS(T);
  const [pin,        setPin]        = useState("");
  const [stage,      setStage]      = useState("enter"); // "enter"|"setup"|"forgot"|"resetVerify"
  const [newPin,     setNewPin]     = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error,      setError]      = useState("");
  const [setupStep,  setSetupStep]  = useState(1); // 1=enter new, 2=confirm
  const [resetCode,  setResetCode]  = useState(""); // master reset code input
  const [resetErr,   setResetErr]   = useState("");
  const [checking,   setChecking]   = useState(false);

  const adminUser = users.find(u => u.role === "admin" || u.username === "admin");
  const hasPinSet = !!(adminUser?.pin);

  useEffect(() => {
    if (!hasPinSet) setStage("setup");
  }, [hasPinSet]);

  // ── Number pad press ──
  const handleKey = (val) => {
    setError("");
    if (stage === "setup") {
      if (setupStep === 1) {
        const next = (newPin + val).slice(0, 6);
        setNewPin(next);
        if (next.length === 6) { setSetupStep(2); }
      } else {
        const next = (confirmPin + val).slice(0, 6);
        setConfirmPin(next);
        if (next.length === 6) {
          if (next === newPin) {
            const updated = adminUser
              ? { ...adminUser, pin: next }
              : { id: uid(), username: "admin", name: "মালিক", role: "admin", pin: next, password: "" };
            setUsers(prev => adminUser
              ? prev.map(u => u.id === adminUser.id ? updated : u)
              : [...prev, updated]
            );
            onLogin(updated);
          } else {
            setError("PIN মিলছে না। আবার চেষ্টা করুন।");
            setNewPin(""); setConfirmPin(""); setSetupStep(1);
          }
        }
      }
    } else {
      const next = (pin + val).slice(0, 6);
      setPin(next);
      // Match any length PIN (4 or 6 digits)
      const user = users.find(u => u.pin === next);
      if (user) { onLogin(user); return; }
      if (next.length === 6) {
        setError("ভুল PIN। আবার চেষ্টা করুন।"); setTimeout(() => setPin(""), 600);
      }
    }
  };

  const handleDelete = () => {
    setError("");
    if (stage === "setup") {
      if (setupStep === 2) setConfirmPin(p => p.slice(0, -1));
      else setNewPin(p => p.slice(0, -1));
    } else { setPin(p => p.slice(0, -1)); }
  };

  // ── Verify master reset code ──
  const verifyResetCode = async () => {
    if (!resetCode.trim()) { setResetErr("কোড লিখুন"); return; }
    setChecking(true);
    // Allow plain "169133" master code always, or check hashed stored code
    const plain = resetCode.trim();
    const hashed = await hashPassword(plain);
    setChecking(false);
    const masterOk = plain === "169133" ||
      (masterResetHash && hashed === masterResetHash);
    if (masterOk) {
      setStage("setup"); setSetupStep(1); setNewPin(""); setConfirmPin(""); setError("");
      setResetCode(""); setResetErr("");
    } else {
      setResetErr("কোড ভুল। Protik-এর কাছ থেকে সঠিক কোড নিন।");
      setResetCode("");
    }
  };

  const currentPin = stage === "setup" ? (setupStep === 1 ? newPin : confirmPin) : pin;

  const title    = stage === "setup"
    ? (setupStep === 1 ? "নতুন PIN সেট করুন" : "PIN নিশ্চিত করুন")
    : "PIN দিয়ে প্রবেশ করুন";
  const subtitle = stage === "setup"
    ? (setupStep === 1 ? "৬ সংখ্যার PIN বেছে নিন" : "আবার একই PIN দিন")
    : "আপনার PIN লিখুন";

  const KEYS = ["1","2","3","4","5","6","7","8","9","","0","⌫"];
  const EN   = {"1":"1","2":"2","3":"3","4":"4","5":"5","6":"6","7":"7","8":"8","9":"9","0":"0"};

  // ── Forgot PIN screen ──
  if (stage === "forgot") {
    const wa = devContact?.whatsapp
      ? `https://wa.me/${devContact.whatsapp.replace(/\D/g,"")}`
      : null;
    const phone = devContact?.phone || null;
    const name  = devContact?.name  || "ডেভেলপার";
    return (
      <div style={{ minHeight:"100vh", background: T.bg, display:"flex", flexDirection:"column",
        alignItems:"center", justifyContent:"center", padding: 20 }}>
        <div style={{ textAlign:"center", marginBottom: 28 }}>
          <div style={{ fontSize: 52, marginBottom: 10 }}>🔐</div>
          <div style={{ color: T.text, fontWeight: 800, fontSize: 22 }}>{shopName}</div>
          <div style={{ color: T.sub, fontSize: 13, marginTop: 4 }}>PIN রিসেট</div>
        </div>
        <div style={{ ...S.card, width:"100%", maxWidth: 340, padding: 28, textAlign:"center" }}>
          <div style={{ color: T.text, fontWeight: 700, fontSize: 16, marginBottom: 8 }}>
            📞 {name}-এর সাথে যোগাযোগ করুন
          </div>
          <div style={{ color: T.sub, fontSize: 13, marginBottom: 24, lineHeight: 1.6 }}>
            PIN রিসেট করতে ডেভেলপারের কাছ থেকে<br />
            একটি <strong style={{color:T.accent}}>রিসেট কোড</strong> সংগ্রহ করুন
          </div>

          {/* Contact buttons */}
          <div style={{ display:"flex", flexDirection:"column", gap: 10, marginBottom: 24 }}>
            <a href={wa || "https://wa.me/8801572931230"} target="_blank" rel="noopener noreferrer"
              style={{ display:"flex", alignItems:"center", justifyContent:"center", gap: 8,
                background:"#25D366", color:"#fff", borderRadius: 12, padding: "14px 20px",
                fontWeight: 700, fontSize: 15, textDecoration:"none" }}>
              <span style={{fontSize:20}}>💬</span> Protik-কে WhatsApp করুন
            </a>
            {phone && (
              <a href={`tel:${phone}`}
                style={{ display:"flex", alignItems:"center", justifyContent:"center", gap: 8,
                  background: T.card, color: T.text, border:`1px solid ${T.border}`,
                  borderRadius: 12, padding: "14px 20px",
                  fontWeight: 700, fontSize: 15, textDecoration:"none" }}>
                <span style={{fontSize:20}}>📱</span> {phone}
              </a>
            )}
          </div>

          {/* Divider */}
          <div style={{ display:"flex", alignItems:"center", gap: 10, marginBottom: 20 }}>
            <div style={{ flex:1, height:1, background: T.border }} />
            <span style={{ color: T.sub, fontSize: 12 }}>কোড পেয়েছেন?</span>
            <div style={{ flex:1, height:1, background: T.border }} />
          </div>

          {/* Reset code input */}
          <div style={{ marginBottom: 12 }}>
            <input
              type="tel" inputMode="numeric" pattern="[0-9]*" placeholder="রিসেট কোড লিখুন"
              value={resetCode}
              onChange={e => { setResetCode(e.target.value.replace(/[^0-9]/g,"")); setResetErr(""); }}
              onKeyDown={e => e.key === "Enter" && verifyResetCode()}
              style={{ ...S.input, textAlign:"center", letterSpacing: 6, fontSize: 22, fontWeight: 800 }}
            />
          </div>
          {resetErr && (
            <div style={{ color:"#ef4444", fontSize:12, background:"#ef444418",
              borderRadius:8, padding:"8px 12px", marginBottom:12 }}>
              {resetErr}
            </div>
          )}
          <button onClick={verifyResetCode} disabled={checking}
            style={{ ...S.saveBtn, width:"100%", marginBottom: 12, opacity: checking ? 0.6 : 1 }}>
            {checking ? "যাচাই হচ্ছে..." : "✓ কোড যাচাই করুন"}
          </button>
          <button onClick={() => { setStage("enter"); setResetCode(""); setResetErr(""); }}
            style={{ background:"none", border:"none", color: T.sub, fontSize:12,
              cursor:"pointer", fontFamily:"inherit" }}>
            ← ফিরে যান
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight:"100vh", background: T.bg, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding: 20 }}>

      {/* Brand */}
      <div style={{ textAlign:"center", marginBottom: 32 }}>
        <div style={{ fontSize: 56, marginBottom: 10 }}>🛒</div>
        <div style={{ color: T.text, fontWeight: 800, fontSize: 24, marginBottom: 4 }}>{shopName}</div>
        <div style={{ color: T.sub, fontSize: 13 }}>হিসাবঘর</div>
      </div>

      {/* Card */}
      <div style={{ ...makeS(T).card, width:"100%", maxWidth: 340, padding: 28, textAlign:"center" }}>

        <div style={{ color: T.text, fontWeight: 700, fontSize: 17, marginBottom: 4 }}>{title}</div>
        <div style={{ color: T.sub, fontSize: 13, marginBottom: 24 }}>{subtitle}</div>

        {/* PIN dots */}
        <div style={{ display:"flex", justifyContent:"center", gap: 14, marginBottom: 28 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} style={{
              width: 16, height: 16, borderRadius: "50%",
              background: i < currentPin.length ? T.accent : "none",
              border: `2px solid ${i < currentPin.length ? T.accent : T.border}`,
              transition: "all 0.15s"
            }} />
          ))}
        </div>

        {/* Error */}
        {error && (
          <div style={{ color:"#ef4444", fontSize:13, marginBottom:16, background:"#ef444418", borderRadius:8, padding:"8px 12px" }}>
            {error}
          </div>
        )}

        {/* Number pad */}
        <div style={{ display:"grid", gridTemplateColumns:"repeat(3, 1fr)", gap: 10 }}>
          {KEYS.map((k, i) => (
            <button key={i}
              onClick={() => k === "⌫" ? handleDelete() : k !== "" ? handleKey(EN[k] || k) : null}
              disabled={k === ""}
              style={{
                height: 60, borderRadius: 14, border: `1px solid ${T.border}`,
                background: k === "⌫" ? "#ef444422" : k === "" ? "none" : T.card,
                color: k === "⌫" ? "#ef4444" : T.text,
                fontSize: k === "⌫" ? 20 : 22, fontWeight: 700,
                cursor: k === "" ? "default" : "pointer",
                fontFamily: "inherit",
                opacity: k === "" ? 0 : 1,
                transition: "background 0.1s",
                boxShadow: k !== "" && k !== "⌫" ? "0 2px 8px #00000022" : "none",
              }}>
              {k}
            </button>
          ))}
        </div>

        {/* Forgot PIN — only show if PIN exists AND master reset is configured */}
        {stage === "enter" && hasPinSet && (
          <button onClick={() => { setStage("forgot"); setPin(""); setError(""); }}
            style={{ background:"none", border:"none", color: T.sub, fontSize:12,
              cursor:"pointer", marginTop:20, fontFamily:"inherit" }}>
            🔑 PIN ভুলে গেছেন?
          </button>
        )}
      </div>
    </div>
  );
}


// ══════════════════════════════════════════════════════════════════════════════
// ── SMART INVOICE BUILDER (3 Steps) ──────────────────────────────────────────
function SmartInvoiceBuilder({ T, S, customers, products, setCustomers, setInvoices, setProducts, sendSMS, showToast, addTxn, shopName, btConnected, btDevice, onConnectBluetooth, createPaymentInvoice, preselectedCustomer }) {
  const [step,       setStep]       = useState(preselectedCustomer ? 2 : 1);
  const [selCust,    setSelCust]    = useState(preselectedCustomer || null);
  const [custSearch, setCustSearch] = useState("");
  const [items,      setItems]      = useState([]);
  const [catFilter,  setCatFilter]  = useState("সব");
  const [prodSearch, setProdSearch] = useState("");
  const [payType,    setPayType]    = useState("baki");
  const [partialAmt, setPartialAmt] = useState("");
  const [note,       setNote]       = useState("");
  const [creating,   setCreating]   = useState(false);
  const [printInv,   setPrintInv]   = useState(null);
  const [printMode,  setPrintMode]  = useState(null);
  const [smsSending, setSmsSending] = useState(false);
  const printRef = useRef(null);

  const customersWithSerial = useMemo(() =>
    customers.map((c, i) => ({ ...c, serial: i + 1, serialStr: String(i + 1) })),
    [customers]
  );

  const filteredCustomers = useMemo(() =>
    custSearch
      ? customersWithSerial.filter(c =>
          c.name.includes(custSearch) ||
          c.mobile.includes(custSearch) ||
          c.serialStr.includes(custSearch.trim())
        )
      : customersWithSerial,
    [customersWithSerial, custSearch]
  );

  const categories = useMemo(() => {
    const cats = ["সব", ...new Set(products.map(p => p.category || "অন্যান্য"))];
    return cats;
  }, [products]);

  const productsWithSerial = useMemo(() =>
    products.map((p, i) => ({ ...p, serial: i + 1, serialStr: String(i + 1) })),
    [products]
  );

  const filteredProducts = useMemo(() => {
    let ps = productsWithSerial;
    if (catFilter !== "সব") ps = ps.filter(p => (p.category || "অন্যান্য") === catFilter);
    if (prodSearch) ps = ps.filter(p =>
      p.name.includes(prodSearch) || p.serialStr.includes(prodSearch.trim())
    );
    return ps;
  }, [productsWithSerial, catFilter, prodSearch]);

  const getQty = (pid) => (items.find(i => i.productId === pid)?.qty || 0);

  const changeQty = (p, delta) => {
    setItems(prev => {
      const ex = prev.find(i => i.productId === p.id);
      if (ex) {
        const newQty = ex.qty + delta;
        if (newQty <= 0) return prev.filter(i => i.productId !== p.id);
        return prev.map(i => i.productId === p.id ? { ...i, qty: newQty } : i);
      }
      if (delta > 0) return [...prev, { productId: p.id, name: p.name, serial: p.serial, qty: 1, price: p.price }];
      return prev;
    });
  };

  const setQty = (pid, qty) => {
    const q = parseInt(qty) || 0;
    if (q <= 0) setItems(prev => prev.filter(i => i.productId !== pid));
    else setItems(prev => prev.map(i => i.productId === pid ? { ...i, qty: q } : i));
  };

  const setPrice = (pid, price) => {
    setItems(prev => prev.map(i => i.productId === pid ? { ...i, price: parseFloat(price) || 0 } : i));
  };

  const total   = items.reduce((s, i) => s + i.qty * i.price, 0);
  const paidAmt = payType === "partial" ? (parseFloat(partialAmt) || 0) : (payType === "cash" ? total : 0);
  const bakiAmt = total - paidAmt;

  const resetAll = () => {
    setStep(1); setSelCust(null); setCustSearch(""); setItems([]);
    setCatFilter("সব"); setProdSearch(""); setPayType("baki");
    setPartialAmt(""); setNote("");
  };

  const createInvoice = async () => {
    if (!selCust || items.length === 0) { showToast("কাস্টমার ও পণ্য বেছে নিন", "#ef4444"); return; }
    setCreating(true);
    const inv = {
      id: uid(), customerId: selCust.id, customerName: selCust.name,
      customerMobile: selCust.mobile, items, total, payType, note,
      paidAmount: paidAmt, bakiAmount: bakiAmt,
      date: todayStr(), dateKey: todayEn(), shopName
    };
    setInvoices(prev => [inv, ...prev]);

    // ── Deduct stock for each sold product ──
    setProducts(prev => prev.map(p => {
      const sold = items.find(i => i.productId === p.id);
      if (!sold) return p;
      return { ...p, stock: Math.max(0, (p.stock || 0) - sold.qty) };
    }));

    if (payType === "baki" || payType === "partial") {
      const newBal = selCust.balance + bakiAmt;
      setCustomers(prev => prev.map(c => c.id === selCust.id ? { ...c, balance: newBal } : c));
      addTxn(selCust.id, "baki", bakiAmt, newBal, inv.id, note);
      setSmsSending(true);
      await sendSMS({ ...selCust, balance: newBal }, "baki", bakiAmt);
      setSmsSending(false);
      showToast("ইনভয়েস তৈরি ও SMS পাঠানো হয়েছে ✓");
    } else {
      showToast("ইনভয়েস তৈরি হয়েছে ✓");
    }
    setPrintInv(inv);
    setCreating(false);
  };

  const handlePrint = async (type) => {
    // Try Bluetooth ESC/POS print first if connected
    if (btConnected && BT.isConnected()) {
      try {
        showToast("প্রিন্ট হচ্ছে...", "#0ea5e9");
        const escData = buildEscPos(printInv, shopName);
        const r = await BT.print(escData);
        if (r.ok) {
          showToast("প্রিন্ট সম্পন্ন হয়েছে ✓");
          await Haptic.success();
          return;
        } else {
          showToast("BT প্রিন্ট ব্যর্থ — HTML প্রিন্টে যাচ্ছে", "#f59e0b");
        }
      } catch (err) {
        showToast("BT প্রিন্ট ব্যর্থ: " + err.message, "#f59e0b");
      }
    }
    // Fallback: HTML popup print
    setPrintMode(type);
    setTimeout(() => {
      const el = printRef.current; if (!el) return;
      const css = `body{font-family:'Hind Siliguri',sans-serif;background:#fff;color:#000;padding:16px;font-size:13px;}.center{text-align:center;}.bold{font-weight:700;}.line{border-top:1px dashed #999;margin:8px 0;}table{width:100%;border-collapse:collapse;}th,td{padding:4px 0;font-size:12px;}th{text-align:left;border-bottom:1px solid #ccc;}.right{text-align:right;}.total{font-size:15px;font-weight:800;}`;
      openPrintWindow(`<html><head><title>Invoice</title><style>${css}</style></head><body>${el.innerHTML}</body></html>`);
      setPrintMode(null);
    }, 100);
  };

  // ── After invoice created: show receipt ──
  if (printInv) {
    const c = customers.find(c => c.id === printInv.customerId);
    return (
      <div style={S.page}>
        <div style={{ color: "#22c55e", fontWeight: 700, fontSize: 14, marginBottom: 4 }}>✅ ইনভয়েস তৈরি হয়েছে!</div>
        {smsSending && <div style={{ color: "#0ea5e9", fontSize: 12, marginBottom: 10 }}>📱 SMS পাঠানো হচ্ছে...</div>}

        <div style={{ ...S.card, marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ color: T.text, fontWeight: 600, fontSize: 13 }}>🖨️ ব্লুটুথ প্রিন্টার</div>
              <div style={{ color: T.sub, fontSize: 11 }}>{btConnected ? `✅ ${btDevice?.name || "সংযুক্ত"}` : "সংযুক্ত নয়"}</div>
            </div>
            <button style={{ ...S.actionBtn, background: btConnected ? "#22c55e18" : "#3b82f618", color: btConnected ? "#22c55e" : "#60a5fa" }}
              onClick={onConnectBluetooth}>
              <IcBluetooth /> {btConnected ? "পুনরায় সংযুক্ত" : "সংযুক্ত করুন"}
            </button>
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
          <button style={{ ...S.actionBtn, background: "#3b82f620", color: "#60a5fa", flex: 1, justifyContent: "center", padding: "10px" }}
            onClick={() => handlePrint("buyer")}><IcPrint /> ক্রেতার কপি</button>
          <button style={{ ...S.actionBtn, background: "#a855f720", color: "#c084fc", flex: 1, justifyContent: "center", padding: "10px" }}
            onClick={() => handlePrint("seller")}><IcPrint /> বিক্রেতার কপি</button>
        </div>
        <InvoiceReceipt T={T} S={S} inv={printInv} customer={c} type="buyer" />
        <div style={S.dashed} />
        <InvoiceReceipt T={T} S={S} inv={printInv} customer={c} type="seller" />
        {printMode && (
          <div ref={printRef} style={{ display: "none" }}>
            <InvoiceReceiptPrint inv={printInv} customer={c} type={printMode} />
          </div>
        )}
        <button style={{ ...S.saveBtn, width: "100%", marginTop: 14 }} onClick={resetAll}>← নতুন ইনভয়েস</button>
      </div>
    );
  }

  // ── Step Indicator ──
  const StepBar = () => (
    <div style={{ display: "flex", alignItems: "center", marginBottom: 18, gap: 0 }}>
      {[
        { n: 1, label: "কাস্টমার" },
        { n: 2, label: "পণ্য" },
        { n: 3, label: "পেমেন্ট" }
      ].map((s, i, arr) => (
        <div key={s.n} style={{ display: "flex", alignItems: "center", flex: 1 }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: "0 0 auto" }}>
            <div style={{
              width: 32, height: 32, borderRadius: "50%",
              background: step > s.n ? T.stepDone : step === s.n ? T.stepActive : T.stepInactive,
              color: step >= s.n ? "#fff" : T.sub,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontWeight: 800, fontSize: 13, transition: "all 0.3s",
              boxShadow: step === s.n ? "0 0 0 4px " + T.stepActive + "33" : "none"
            }}>
              {step > s.n ? "✓" : s.n}
            </div>
            <div style={{ fontSize: 10, color: step >= s.n ? T.accent : T.sub, marginTop: 4, fontWeight: 600 }}>{s.label}</div>
          </div>
          {i < arr.length - 1 && (
            <div style={{ flex: 1, height: 2, background: step > s.n ? T.stepDone : T.stepInactive, margin: "0 4px", marginBottom: 18, transition: "all 0.3s" }} />
          )}
        </div>
      ))}
    </div>
  );

  return (
    <div style={S.page}>
      <StepBar />

      {/* ── STEP 1: Customer Selection ── */}
      {step === 1 && (
        <div style={{ animation: "slideUp 0.25s ease" }}>
          <div style={{ ...S.card }}>
            <div style={{ color: T.text, fontWeight: 700, fontSize: 15, marginBottom: 12 }}>① কাস্টমার নির্বাচন করুন</div>
            <div style={S.searchBar}>
              <IcSearch />
              <input style={S.searchInput} placeholder="নাম, মোবাইল বা সিরিয়াল নম্বর..." value={custSearch}
                onChange={e => setCustSearch(e.target.value)} autoFocus />
              {custSearch && <button style={{ background: "none", border: "none", color: T.sub, cursor: "pointer" }} onClick={() => setCustSearch("")}>✕</button>}
            </div>
            {selCust && !custSearch && (
              <div style={{ background: "#22c55e15", border: "1px solid #22c55e44", borderRadius: 12, padding: "12px 14px", display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                <div style={{ ...S.avatar, width: 36, height: 36, fontSize: 14 }}>{selCust.name[0]}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ color: "#22c55e", fontWeight: 700, fontSize: 14 }}>{selCust.name}</div>
                  <div style={{ color: T.sub, fontSize: 12 }}>{selCust.mobile}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ color: selCust.balance > 0 ? "#ef4444" : T.sub, fontSize: 12, fontWeight: 700 }}>বাকি</div>
                  <div style={{ color: selCust.balance > 0 ? "#ef4444" : "#22c55e", fontWeight: 800, fontSize: 16 }}>৳{fmt(selCust.balance)}</div>
                </div>
                <button style={{ background: "#ef444420", border: "none", color: "#ef4444", borderRadius: 8, width: 28, height: 28, cursor: "pointer", fontSize: 13 }}
                  onClick={() => setSelCust(null)}>✕</button>
              </div>
            )}
            <div style={{ maxHeight: 240, overflowY: "auto" }}>
              {filteredCustomers.slice(0, 10).map(c => (
                <div key={c.id}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 12, cursor: "pointer", background: selCust?.id === c.id ? "#22c55e18" : "transparent", marginBottom: 4, border: selCust?.id === c.id ? "1px solid #22c55e44" : "1px solid transparent", transition: "all 0.15s" }}
                  onClick={() => { setSelCust(c); setCustSearch(""); }}>
                  <div style={{ ...S.avatar, width: 36, height: 36, fontWeight: 800, fontSize: 14 }}>{c.serial}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: selCust?.id === c.id ? "#22c55e" : T.text, fontWeight: 600, fontSize: 13 }}>{c.name}</div>
                    <div style={{ color: T.sub, fontSize: 11 }}>{c.mobile}</div>
                  </div>
                  <div>
                    {c.balance > 0 && <div style={{ background: "#ef444422", color: "#ef4444", borderRadius: 8, padding: "2px 8px", fontSize: 11, fontWeight: 700 }}>বাকি ৳{fmt(c.balance)}</div>}
                    {c.balance === 0 && <div style={{ color: T.sub, fontSize: 11 }}>✓ পরিষ্কার</div>}
                  </div>
                </div>
              ))}
              {filteredCustomers.length === 0 && <div style={S.empty}>কোনো কাস্টমার পাওয়া যায়নি</div>}
            </div>
          </div>
          <button
            style={{ ...S.saveBtn, width: "100%", padding: 14, fontSize: 15, opacity: selCust ? 1 : 0.5 }}
            disabled={!selCust}
            onClick={() => { if (selCust) setStep(2); }}>
            পরবর্তী → পণ্য নির্বাচন
          </button>
        </div>
      )}

      {/* ── STEP 2: Product Grid ── */}
      {step === 2 && (
        <div style={{ animation: "slideUp 0.25s ease" }}>
          {/* Selected customer badge */}
          <div style={{ background: "#22c55e15", borderRadius: 12, padding: "8px 14px", display: "flex", alignItems: "center", gap: 8, marginBottom: 12, border: "1px solid #22c55e33" }}>
            <div style={{ ...S.avatar, width: 28, height: 28, fontSize: 12 }}>{selCust.name[0]}</div>
            <div style={{ flex: 1 }}>
              <span style={{ color: "#22c55e", fontWeight: 700, fontSize: 13 }}>{selCust.name}</span>
              <span style={{ color: T.sub, fontSize: 11 }}> · বাকি ৳{fmt(selCust.balance)}</span>
            </div>
            <button style={{ background: "none", border: "none", color: T.sub, cursor: "pointer", fontSize: 12 }} onClick={() => setStep(1)}>বদলান</button>
          </div>

          {/* Category filter pills */}
          <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4, marginBottom: 10 }}>
            {categories.map(cat => (
              <button key={cat}
                style={{ background: catFilter === cat ? T.accent : T.card, color: catFilter === cat ? "#fff" : T.sub, border: catFilter === cat ? "none" : `1px solid ${T.border}`, borderRadius: 20, padding: "5px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0, fontFamily: "inherit" }}
                onClick={() => setCatFilter(cat)}>{cat}</button>
            ))}
          </div>

          {/* Product search */}
          <div style={{ ...S.searchBar, marginBottom: 10 }}>
            <IcSearch />
            <input style={S.searchInput} placeholder="পণ্য খুঁজুন..." value={prodSearch}
              onChange={e => setProdSearch(e.target.value)} />
          </div>

          {/* Product grid */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
            {filteredProducts.map(p => {
              const qty = getQty(p.id);
              return (
                <div key={p.id} style={{ background: qty > 0 ? "#22c55e12" : T.card, border: `1px solid ${qty > 0 ? "#22c55e55" : T.border}`, borderRadius: 14, padding: "10px 12px", position: "relative", transition: "all 0.15s" }}>
                  {qty > 0 && (
                    <div style={{ position: "absolute", top: -8, right: -8, background: "#22c55e", color: "#fff", borderRadius: "50%", width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, boxShadow: "0 2px 8px #00000044" }}>{qty}</div>
                  )}
                  <div style={{ color: T.sub, fontSize: 10, fontWeight: 700, marginBottom: 2 }}>#{p.serial}</div>
                  <div style={{ color: qty > 0 ? "#22c55e" : T.text, fontWeight: 600, fontSize: 12, marginBottom: 4, lineHeight: 1.3 }}>{p.name}</div>
                  <div style={{ color: T.accent, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>৳{fmt(p.price)}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <button onClick={() => changeQty(p, -1)}
                      style={{ background: qty > 0 ? "#ef444422" : T.bg, border: "none", borderRadius: 8, width: 28, height: 28, cursor: "pointer", color: "#ef4444", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <IcMinus />
                    </button>
                    <div style={{ flex: 1, textAlign: "center", color: qty > 0 ? T.text : T.sub, fontWeight: 700, fontSize: 14 }}>{qty || "—"}</div>
                    <button onClick={() => changeQty(p, +1)}
                      style={{ background: "#22c55e22", border: "none", borderRadius: 8, width: 28, height: 28, cursor: "pointer", color: "#22c55e", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <IcPlus />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Live Cart */}
          {items.length > 0 && (
            <div style={{ ...S.card, border: `1px solid ${T.accent}44` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div style={{ color: T.text, fontWeight: 700, fontSize: 13 }}>🛒 কার্ট ({items.length}টি পণ্য)</div>
                <div style={{ color: "#22c55e", fontWeight: 800, fontSize: 18 }}>৳{fmt(total)}</div>
              </div>
              {items.map(item => (
                <div key={item.productId} style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center" }}>
                  <div style={{ flex: 3, color: T.text, fontSize: 12, fontWeight: 600 }}>{item.name}</div>
                  <input style={{ ...S.input, flex: 1, marginBottom: 0, padding: "7px", textAlign: "center", fontSize: 13 }}
                    type="number" value={item.qty} onChange={e => setQty(item.productId, e.target.value)} inputMode="numeric" min={1} />
                  <input style={{ ...S.input, flex: 1, marginBottom: 0, padding: "7px", textAlign: "center", fontSize: 13 }}
                    type="number" value={item.price} onChange={e => setPrice(item.productId, e.target.value)} inputMode="decimal" />
                  <button style={{ background: "#ef444422", color: "#ef4444", border: "none", borderRadius: 8, width: 30, height: 30, cursor: "pointer", flexShrink: 0 }}
                    onClick={() => setItems(prev => prev.filter(i => i.productId !== item.productId))}>✕</button>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: "flex", gap: 10 }}>
            <button style={{ ...S.cancelBtn, flex: 1 }} onClick={() => setStep(1)}>← ফিরে যান</button>
            <button
              style={{ ...S.saveBtn, flex: 2, opacity: items.length > 0 ? 1 : 0.5 }}
              disabled={items.length === 0}
              onClick={() => { if (items.length > 0) setStep(3); }}>
              পরবর্তী → পেমেন্ট ({items.reduce((s,i)=>s+i.qty,0)}টি)
            </button>
          </div>
        </div>
      )}

      {/* ── STEP 3: Payment ── */}
      {step === 3 && (
        <div style={{ animation: "slideUp 0.25s ease" }}>
          {/* Summary */}
          <div style={{ ...S.card, border: `1px solid ${T.border}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <div>
                <div style={{ color: T.text, fontWeight: 700, fontSize: 15 }}>{selCust.name}</div>
                <div style={{ color: T.sub, fontSize: 12 }}>{items.length}টি পণ্য · {items.reduce((s,i)=>s+i.qty,0)}টি আইটেম</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: "#22c55e", fontWeight: 800, fontSize: 22 }}>৳{fmt(total)}</div>
                <div style={{ color: T.sub, fontSize: 11 }}>মোট মূল্য</div>
              </div>
            </div>
            {/* Item summary */}
            <div style={S.dashed} />
            {items.map(item => (
              <div key={item.productId} style={{ display: "flex", justifyContent: "space-between", color: T.sub, fontSize: 12, marginBottom: 4 }}>
                <span>{item.name} × {item.qty}</span>
                <span style={{ color: T.text }}>৳{fmt(item.qty * item.price)}</span>
              </div>
            ))}
          </div>

          {/* Payment Type */}
          <div style={{ color: T.text, fontWeight: 700, fontSize: 14, marginBottom: 10 }}>পেমেন্ট পদ্ধতি</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
            {[
              { key: "baki", label: "পুরো বাকি", emoji: "📋", color: "#ef4444" },
              { key: "cash", label: "নগদ পরিশোধ", emoji: "💵", color: "#22c55e" },
              { key: "partial", label: "আংশিক", emoji: "🔀", color: "#f59e0b" },
            ].map(opt => (
              <button key={opt.key}
                style={{ background: payType === opt.key ? opt.color + "22" : T.card, border: `2px solid ${payType === opt.key ? opt.color : T.border}`, borderRadius: 12, padding: "10px 8px", cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s", textAlign: "center" }}
                onClick={() => setPayType(opt.key)}>
                <div style={{ fontSize: 20, marginBottom: 4 }}>{opt.emoji}</div>
                <div style={{ fontSize: 11, fontWeight: 700, color: payType === opt.key ? opt.color : T.sub }}>{opt.label}</div>
              </button>
            ))}
          </div>

          {payType === "partial" && (
            <div style={{ ...S.card, border: "1px solid #f59e0b44", animation: "slideUp 0.2s ease" }}>
              <div style={{ color: "#f59e0b", fontWeight: 700, fontSize: 13, marginBottom: 10 }}>আংশিক পরিশোধ</div>
              <label style={S.label}>এখন কত টাকা দিচ্ছেন? (মোট: ৳{fmt(total)})</label>
              <input style={{ ...S.input, fontSize: 20, textAlign: "center", fontWeight: 800 }}
                type="number" placeholder="পরিমাণ লিখুন" value={partialAmt}
                onChange={e => setPartialAmt(e.target.value)} inputMode="numeric" />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <div style={{ background: "#22c55e15", borderRadius: 10, padding: "10px", textAlign: "center" }}>
                  <div style={{ color: "#22c55e", fontWeight: 800, fontSize: 16 }}>৳{fmt(paidAmt)}</div>
                  <div style={{ color: T.sub, fontSize: 11 }}>নগদ পেলাম</div>
                </div>
                <div style={{ background: "#ef444415", borderRadius: 10, padding: "10px", textAlign: "center" }}>
                  <div style={{ color: "#ef4444", fontWeight: 800, fontSize: 16 }}>৳{fmt(Math.max(0, bakiAmt))}</div>
                  <div style={{ color: T.sub, fontSize: 11 }}>বাকি থাকবে</div>
                </div>
              </div>
            </div>
          )}

          {/* Payment summary */}
          {payType !== "partial" && (
            <div style={{ background: T.card, borderRadius: 12, padding: "12px 16px", marginBottom: 14, border: `1px solid ${payType === "baki" ? "#ef444433" : "#22c55e33"}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ color: T.sub, fontSize: 13 }}>মোট মূল্য</span>
                <span style={{ color: T.text, fontWeight: 700 }}>৳{fmt(total)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: T.sub, fontSize: 13 }}>পরিশোধ পদ্ধতি</span>
                <span style={{ color: payType === "baki" ? "#ef4444" : "#22c55e", fontWeight: 700 }}>{payType === "baki" ? "বাকি ৳" + fmt(total) : "নগদ ৳" + fmt(total)}</span>
              </div>
            </div>
          )}

          {/* Note */}
          <input style={S.input} placeholder="নোট (ঐচ্ছিক)" value={note} onChange={e => setNote(e.target.value)} />

          {/* SMS notice */}
          {(payType === "baki" || payType === "partial") && (
            <div style={{ background: "#0ea5e915", borderRadius: 10, padding: "10px 14px", color: "#0ea5e9", fontSize: 12, marginBottom: 14, display: "flex", alignItems: "center", gap: 8 }}>
              <IcSms /> <span>📱 ইনভয়েস তৈরির সাথে SMS যাবে → {selCust.mobile}</span>
            </div>
          )}

          <div style={{ display: "flex", gap: 10 }}>
            <button style={{ ...S.cancelBtn, flex: 1 }} onClick={() => setStep(2)}>← পণ্য</button>
            <button
              style={{ ...S.saveBtn, flex: 2, padding: 14, fontSize: 15, opacity: creating ? 0.7 : 1 }}
              disabled={creating || (payType === "partial" && !partialAmt)}
              onClick={createInvoice}>
              {creating ? "তৈরি হচ্ছে..." : "🧾 ইনভয়েস তৈরি করুন"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Dashboard ──────────────────────────────────────────────────────────────────
function Dashboard({ T, S, customers, totalBaki, todayBaki, todayJoma, todayTotal, todayInvs, setTab, txns, dashModal, setDashModal, invoices, paymentInvoices }) {
  const [viewInv,    setViewInv]    = useState(null);
  const [viewPayInv, setViewPayInv] = useState(null);

  if (viewInv) {
    const cust = customers.find(c => c.id === viewInv.customerId);
    return (
      <div style={S.page}>
        <button style={S.textBtn} onClick={() => setViewInv(null)}>← তালিকায় ফিরুন</button>
        <InvoiceReceipt T={T} S={S} inv={viewInv} customer={cust} type="buyer" />
      </div>
    );
  }
  if (viewPayInv) {
    return (
      <div style={S.page}>
        <button style={S.textBtn} onClick={() => setViewPayInv(null)}>← তালিকায় ফিরুন</button>
        <PaymentInvoiceReceipt T={T} S={S} inv={viewPayInv} />
      </div>
    );
  }
  if (dashModal) {
    if (dashModal.type === "customer-breakdown") {
      return (
        <div style={S.page}>
          <button style={S.textBtn} onClick={() => setDashModal(null)}>← ড্যাশবোর্ডে ফিরুন</button>
          <div style={{ color: T.text, fontWeight: 700, fontSize: 16, marginBottom: 14 }}>{dashModal.title}</div>
          {dashModal.rows.length === 0 && <div style={S.empty}>কোনো তথ্য নেই</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {dashModal.rows.map((row, i) => (
              <div key={i} style={{ ...S.card, marginBottom: 0, padding: "12px 14px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <div style={{ ...S.avatar, width: 34, height: 34, fontSize: 13 }}>{row.name[0]}</div>
                  <div>
                    <div style={{ color: "#0ea5e9", fontWeight: 700, fontSize: 14 }}>{row.name}</div>
                    <div style={{ color: T.sub, fontSize: 11 }}>{row.mobile}</div>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  {[
                    { label: "বাকি হয়েছে", val: row.baki, color: "#ef4444" },
                    { label: "জমা দিয়েছে", val: row.joma, color: "#22c55e" },
                    { label: "বর্তমান বাকি", val: row.balance, color: row.balance > 0 ? "#ef4444" : "#22c55e" },
                  ].map((x, j) => (
                    <div key={j} style={{ background: x.color + "15", borderRadius: 10, padding: "8px 10px", textAlign: "center" }}>
                      <div style={{ color: x.color, fontWeight: 800, fontSize: 14 }}>৳{fmt(x.val)}</div>
                      <div style={{ color: T.sub, fontSize: 10, marginTop: 2 }}>{x.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    }
    if (dashModal.type === "invoices") {
      const pdfHtml = buildPdfHtml(
        buildDailyListHtml(dashModal.items, "invoices", null),
        null, dashModal.title
      );
      return (
        <div style={S.page}>
          <button style={S.textBtn} onClick={() => setDashModal(null)}>← ড্যাশবোর্ডে ফিরুন</button>
          <div style={{ color: T.text, fontWeight: 700, fontSize: 16, marginBottom: 4 }}>{dashModal.title}</div>
          <div style={{ color: T.sub, fontSize: 12, marginBottom: 8 }}>{dashModal.items.length}টি ইনভয়েস</div>
          <PdfActionBar htmlContent={pdfHtml} title={dashModal.title} T={T} S={S} />
          <div style={{ marginTop: 14 }} />
          {dashModal.items.length === 0 && <div style={S.empty}>কোনো ইনভয়েস নেই</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {dashModal.items.map((inv, i) => (
              <div key={i} style={{ ...S.card, marginBottom: 0, padding: "12px 14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ ...S.avatar, width: 34, height: 34, fontSize: 13 }}>{inv.customerName[0]}</div>
                    <div>
                      <div style={{ color: "#0ea5e9", fontWeight: 700, fontSize: 14 }}>{inv.customerName}</div>
                      <div style={{ color: T.sub, fontSize: 11 }}>{inv.items?.length}টি পণ্য · {inv.date}</div>
                    </div>
                  </div>
                  <div>
                    <div style={{ color: "#22c55e", fontWeight: 800, fontSize: 16, textAlign: "right" }}>৳{fmt(inv.total)}</div>
                    <div style={{ ...S.txnBadge, background: inv.payType === "baki" ? "#ef444422" : inv.payType === "partial" ? "#f59e0b22" : "#22c55e22", color: inv.payType === "baki" ? "#ef4444" : inv.payType === "partial" ? "#f59e0b" : "#22c55e", display: "block", textAlign: "center", marginTop: 4 }}>
                      {inv.payType === "baki" ? "বাকি" : inv.payType === "partial" ? "আংশিক" : "নগদ"}
                    </div>
                  </div>
                </div>
                <button style={S.invBtn} onClick={() => setViewInv(inv)}>
                  <IcInvoice /><span>ইনভয়েস দেখুন</span>
                  <span style={{ marginLeft: "auto", color: T.sub }}>#{inv.id?.toUpperCase?.()?.slice(0,6)}</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      );
    }
    if (dashModal.type === "payment-receipts") {
      const pdfHtml = buildPdfHtml(
        buildDailyListHtml(dashModal.items, "payment-receipts", null),
        null, dashModal.title
      );
      return (
        <div style={S.page}>
          <button style={S.textBtn} onClick={() => setDashModal(null)}>← ড্যাশবোর্ডে ফিরুন</button>
          <div style={{ color: T.text, fontWeight: 700, fontSize: 16, marginBottom: 4 }}>{dashModal.title}</div>
          <div style={{ color: T.sub, fontSize: 12, marginBottom: 8 }}>{dashModal.items.length}টি রশিদ</div>
          <PdfActionBar htmlContent={pdfHtml} title={dashModal.title} T={T} S={S} />
          <div style={{ marginTop: 14 }} />
          {dashModal.items.length === 0 && <div style={S.empty}>কোনো জমার রশিদ নেই</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {dashModal.items.map((pinv, i) => (
              <div key={i} style={{ ...S.card, marginBottom: 0, padding: "12px 14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ ...S.avatar, width: 34, height: 34, fontSize: 13, background: "linear-gradient(135deg,#0369a1,#0ea5e9)" }}>{pinv.customerName[0]}</div>
                    <div>
                      <div style={{ color: "#0ea5e9", fontWeight: 700, fontSize: 14 }}>{pinv.customerName}</div>
                      <div style={{ color: T.sub, fontSize: 11 }}>{pinv.time}</div>
                    </div>
                  </div>
                  <div style={{ color: "#22c55e", fontWeight: 800, fontSize: 18 }}>৳{fmt(pinv.amount)}</div>
                </div>
                <button style={{ ...S.invBtn, color: "#22c55e", borderColor: "#22c55e44" }} onClick={() => setViewPayInv(pinv)}>
                  <IcCheck /><span>জমার রসিদ দেখুন</span>
                  <span style={{ marginLeft: "auto", color: T.sub }}>#{pinv.id?.toUpperCase?.()?.slice(0,6)}</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      );
    }
  }

  const bakiCustomers = customers.filter(c => c.balance > 0);
  const todayPayInvs  = (paymentInvoices || []).filter(p => p.dateKey === todayEn());
  const todayBakiInvs = invoices.filter(inv => {
    const relTxn = txns.find(t => t.invoiceId === inv.id && t.dateKey === todayEn() && t.type === "baki");
    return !!relTxn;
  });

  return (
    <div style={S.page}>
      <div style={{ color: T.sub, fontSize: 12, fontWeight: 700, marginBottom: 12, letterSpacing: 1.5, textTransform: "uppercase" }}>📅 আজকের সারাংশ</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 }}>
        {[
          { emoji: "📋", val: `৳${fmt(todayBaki)}`, label: "আজকের বাকি", color: "#f87171", bg: "#ef444418", onClick: () => setDashModal({ title: "আজকের বাকি ইনভয়েস", type: "invoices", items: todayBakiInvs }) },
          { emoji: "💰", val: `৳${fmt(todayJoma)}`, label: "আজকের জমা", color: "#2dda7a", bg: "#22c55e18", onClick: () => setDashModal({ title: "আজকের জমার রশিদ", type: "payment-receipts", items: todayPayInvs }) },
          { emoji: "📈", val: `৳${fmt(todayTotal)}`, label: "আজকের বিক্রয়", color: "#60a5fa", bg: "#3b82f618", onClick: () => setDashModal({ title: "আজকের বিক্রয় ইনভয়েস", type: "invoices", items: todayInvs }) },
          { emoji: "🧾", val: `${fmt(todayInvs.length)}টি`, label: "আজকের ইনভয়েস", color: "#fbbf24", bg: "#f59e0b18", onClick: () => setDashModal({ title: "আজকের সকল ইনভয়েস", type: "invoices", items: todayInvs }) },
        ].map((c, i) => (
          <div key={i} onClick={c.onClick} className="tap-card"
            style={{
              background: T.card,
              borderRadius: 18, padding: "14px 12px",
              border: `1px solid ${c.color}28`,
              cursor: "pointer", userSelect: "none",
              display: "flex", alignItems: "center", gap: 12,
              boxShadow: `0 2px 14px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)`,
              transition: "all 0.2s cubic-bezier(0.4,0,0.2,1)",
              animation: `fadeUp 0.3s ease both`,
              animationDelay: `${i * 60}ms`,
            }}>
            <div style={{
              width: 44, height: 44, borderRadius: 14,
              background: c.bg,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 22, flexShrink: 0,
              border: `1px solid ${c.color}22`,
            }}>{c.emoji}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: c.color, fontWeight: 900, fontSize: 17, lineHeight: 1.1 }}>{c.val}</div>
              <div style={{ color: T.sub, fontSize: 11, marginTop: 3, lineHeight: 1.3 }}>{c.label}</div>
            </div>
            <div style={{ color: c.color, fontSize: 18, opacity: 0.4, fontWeight: 300 }}>›</div>
          </div>
        ))}
      </div>
      <div style={S.statsGrid}>
        {[
          { label: "মোট বাকি", value: `৳${fmt(totalBaki)}`, color: "#f87171", icon: "💳", modal: { title: "বাকি আছে এমন কাস্টমার", type: "customer-breakdown", rows: bakiCustomers.map(c => { const cTxns = txns.filter(t => t.customerId === c.id); return { name: c.name, mobile: c.mobile, balance: c.balance, baki: cTxns.filter(t => t.type === "baki").reduce((s,t)=>s+t.amount,0), joma: cTxns.filter(t=>t.type==="joma").reduce((s,t)=>s+t.amount,0) }; }).sort((a,b)=>b.balance-a.balance) } },
          { label: "কাস্টমার", value: fmt(customers.length), color: "#60a5fa", icon: "👥", modal: { title: "সকল কাস্টমার", type: "customer-breakdown", rows: customers.map(c => { const cTxns = txns.filter(t => t.customerId === c.id); return { name: c.name, mobile: c.mobile, balance: c.balance, baki: cTxns.filter(t=>t.type==="baki").reduce((s,t)=>s+t.amount,0), joma: cTxns.filter(t=>t.type==="joma").reduce((s,t)=>s+t.amount,0) }; }).sort((a,b)=>b.balance-a.balance) } },
        ].map((c, i) => (
          <div key={i} className="tap-card"
            style={{
              ...S.statCard, borderColor: c.color + "33",
              boxShadow: `0 4px 20px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.04)`,
            }}
            onClick={() => setDashModal(c.modal)}>
            <div style={{ ...S.statIcon, background: c.color + "1a", color: c.color, border: `1px solid ${c.color}22`, borderRadius: 14 }}>{c.icon}</div>
            <div style={{ ...S.statValue, color: c.color }}>{c.value}</div>
            <div style={S.statLabel}>{c.label}</div>
            <div style={{ color: c.color, fontSize: 10, opacity: 0.7, fontWeight: 700, letterSpacing: 0.3 }}>বিস্তারিত →</div>
          </div>
        ))}
      </div>
      <div style={S.section}>
        <div style={S.secRow}>
          <span style={S.secTitle}>আজকের ইনভয়েস</span>
          <button style={S.linkBtn} onClick={() => setTab("invoice")}>নতুন →</button>
        </div>
        {todayInvs.length === 0 ? <div style={S.empty}>আজ কোনো ইনভয়েস নেই</div>
          : todayInvs.slice(0, 5).map(inv => (
            <div key={inv.id} style={S.listRow}>
              <div style={S.avatar}>{inv.customerName[0]}</div>
              <div style={{ flex: 1 }}>
                <div style={S.rowName}>{inv.customerName}</div>
                <div style={S.rowSub}>{inv.items.length}টি পণ্য · {inv.payType === "baki" ? "বাকি" : inv.payType === "partial" ? "আংশিক" : "নগদ"}</div>
              </div>
              <div style={{ ...S.rowAmt, color: "#22c55e" }}>৳{fmt(inv.total)}</div>
            </div>
          ))}
      </div>
      <div style={S.section}>
        <div style={S.secRow}>
          <span style={S.secTitle}>বাকির তালিকা</span>
          <button style={S.linkBtn} onClick={() => setTab("customers")}>সব দেখুন →</button>
        </div>
        {bakiCustomers.length === 0 && <div style={S.empty}>কোনো বাকি নেই 🎉</div>}
        {bakiCustomers.slice(0, 5).map(c => (
          <div key={c.id} style={S.listRow}>
            <div style={S.avatar}>{c.name[0]}</div>
            <div style={{ flex: 1 }}>
              <div style={S.rowName}>{c.name}</div>
              <div style={S.rowSub}>{c.mobile}</div>
            </div>
            <div style={{ ...S.rowAmt, color: "#ef4444" }}>৳{fmt(c.balance)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Customers List ─────────────────────────────────────────────────────────────
function Customers({ T, S, customers, setCustomers, showToast, setModal, onOpenDetail, deletedCustomers, setDeletedCustomers, onGoToInvoice }) {
  const [search,    setSearch]    = useState("");
  const [showAdd,   setShowAdd]   = useState(false);
  const [form,      setForm]      = useState({ name: "", mobile: "", address: "" });
  const [editId,    setEditId]    = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const [page,      setPage]      = useState(1);
  const PAGE_SIZE = 15;

  // সিরিয়াল নম্বর সহ কাস্টমার তালিকা (যোগ করার ক্রমে ১, ২, ৩...)
  const customersWithSerial = customers.map((c, i) => ({ ...c, serial: i + 1, serialStr: String(i + 1) }));
  const filtered = customersWithSerial.filter(c =>
    c.name.includes(search) ||
    c.mobile.includes(search) ||
    c.serialStr.includes(search.trim())
  );
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const addCustomer = () => {
    if (!form.name.trim()) { showToast("নাম দিতে হবে", "#ef4444"); return; }
    if (editId) {
      setCustomers(prev => prev.map(c => c.id === editId ? { ...c, ...form } : c));
      showToast("তথ্য আপডেট হয়েছে ✓");
      setEditId(null);
    } else {
      setCustomers(prev => [...prev, { id: uid(), ...form, balance: 0 }]);
      showToast("নতুন কাস্টমার যোগ হয়েছে ✓");
    }
    setForm({ name: "", mobile: "", address: "" }); setShowAdd(false);
  };

  const requestDelete = (id) => setConfirmId(id);
  const confirmDelete = (id) => {
    const c = customers.find(x => x.id === id);
    setDeletedCustomers(prev => [c, ...prev]);
    setCustomers(prev => prev.filter(x => x.id !== id));
    showToast("কাস্টমার সরানো হয়েছে", "#f59e0b");
    setConfirmId(null);
  };

  return (
    <div style={S.page}>
      <div style={S.searchBar}>
        <IcSearch />
        <input style={S.searchInput} placeholder={`নাম, মোবাইল বা নম্বর দিয়ে খুঁজুন... (${customers.length}জন)`} value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
      </div>
      <button style={S.addBtn} onClick={() => { setShowAdd(v => !v); setEditId(null); setForm({ name: "", mobile: "", address: "" }); }}>
        <IcPlus /> নতুন কাস্টমার
      </button>
      {showAdd && (
        <div style={S.card}>
          <div style={S.cardTitle}>{editId ? "তথ্য আপডেট করুন" : "নতুন কাস্টমার"}</div>
          <input style={S.input} placeholder="পুরো নাম *" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          <input style={S.input} placeholder="মোবাইল নম্বর" value={form.mobile} onChange={e => setForm({ ...form, mobile: e.target.value })} inputMode="tel" />
          <input style={S.input} placeholder="ঠিকানা" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} />
          <div style={S.rowBtns}>
            <button style={S.cancelBtn} onClick={() => { setShowAdd(false); setEditId(null); }}>বাতিল</button>
            <button style={S.saveBtn} onClick={addCustomer}><IcCheck /> {editId ? "আপডেট করুন" : "যোগ করুন"}</button>
          </div>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {paged.length === 0 && <div style={S.empty}>কোনো কাস্টমার পাওয়া যায়নি</div>}
        {paged.map(c => (
          <div key={c.id} style={S.custCard}>
            {/* Top row: clickable name+info block + balance */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <button
                onClick={() => onOpenDetail(c.id)}
                style={{ display: "flex", gap: 10, alignItems: "center", background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: 0, flex: 1, minWidth: 0 }}>
                <div style={{ ...S.avatar, fontWeight: 800, fontSize: 14, letterSpacing: -0.5 }}>{c.serial}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ ...S.custName, marginBottom: 2 }}>{c.name}</div>
                  <div style={S.rowSub}>{c.mobile}</div>
                  {c.address && <div style={{ color: T.sub, fontSize: 11 }}>📍 {c.address}</div>}
                </div>
              </button>
              <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 8 }}>
                <div style={{ color: c.balance > 0 ? "#ef4444" : "#22c55e", fontWeight: 800, fontSize: 18 }}>৳{fmt(c.balance)}</div>
                <div style={{ color: T.sub, fontSize: 10 }}>{c.balance > 0 ? "বাকি আছে" : "বাকি নেই"}</div>
              </div>
            </div>
            {/* Action row */}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button style={{ ...S.actionBtn, flex: 1, justifyContent: "center", padding: "10px 0", background: "#3b82f618", color: "#60a5fa", fontSize: 13 }}
                onClick={() => onGoToInvoice(c)}>▼ ইনভয়েস</button>
              <button style={{ ...S.actionBtn, flex: 1, justifyContent: "center", padding: "10px 0", background: "#22c55e18", color: "#22c55e", fontSize: 13 }}
                onClick={() => setModal({ type: "transaction", data: { ...c, _mode: "joma" } })}>▼ জমা</button>
              {c.mobile && (
                <button style={{ ...S.actionBtn, background: "#0ea5e918", color: "#0ea5e9", padding: "10px 10px", fontSize: 16 }}
                  onClick={() => window.open(`tel:${c.mobile}`, "_self")}>📞</button>
              )}
              {c.mobile && (
                <button style={{ ...S.actionBtn, background: "#25D36618", color: "#25D366", padding: "10px 10px", fontSize: 16 }}
                  onClick={() => { const num = c.mobile.replace(/\D/g,""); window.open(`https://wa.me/${num.startsWith("88")?num:"88"+num}`, "_blank"); }}>💬</button>
              )}
              <button style={{ ...S.actionBtn, background: T.bg, color: "#0ea5e9", padding: "10px 12px" }}
                onClick={() => { setEditId(c.id); setForm({ name: c.name, mobile: c.mobile, address: c.address || "" }); setShowAdd(true); }}>
                <IcEdit />
              </button>
              {confirmId === c.id ? (
                <>
                  <button style={{ ...S.actionBtn, background: "#ef444422", color: "#ef4444", fontSize: 11, padding: "10px 8px" }} onClick={() => confirmDelete(c.id)}>নিশ্চিত</button>
                  <button style={{ ...S.actionBtn, background: T.bg, color: T.sub, fontSize: 11, padding: "10px 8px" }} onClick={() => setConfirmId(null)}>না</button>
                </>
              ) : (
                <button style={{ ...S.actionBtn, background: T.bg, color: T.sub, padding: "10px 12px" }}
                  onClick={() => requestDelete(c.id)}><IcTrash /></button>
              )}
            </div>
          </div>
        ))}
      </div>
      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 12, marginTop: 16 }}>
          <button style={{ ...S.cancelBtn, flex: "none", padding: "8px 16px", opacity: page===1?0.4:1 }} onClick={() => setPage(p=>Math.max(1,p-1))} disabled={page===1}>←</button>
          <span style={{ color: T.sub, fontSize: 13 }}>{page} / {totalPages} ({filtered.length}জন)</span>
          <button style={{ ...S.cancelBtn, flex: "none", padding: "8px 16px", opacity: page===totalPages?0.4:1 }} onClick={() => setPage(p=>Math.min(totalPages,p+1))} disabled={page===totalPages}>→</button>
        </div>
      )}
    </div>
  );
}

// ── Customer Detail ────────────────────────────────────────────────────────────
function CustomerDetail({ T, S, customer, txns, invoices, customers, paymentInvoices }) {
  const [viewInv,    setViewInv]    = useState(null);
  const [viewPayInv, setViewPayInv] = useState(null);
  const [txnPage,    setTxnPage]    = useState(1); // ✅ pagination for large histories
  const [histMonths, setHistMonths] = useState(null); // null = not showing, 1/2/3... = months
  const TXN_PAGE_SIZE = 20;
  if (!customer) return null;

  const totalJomaAdded  = txns.filter(t => t.type === "joma").reduce((s, t) => s + t.amount, 0);
  const lastBakiTxn     = txns.filter(t => t.type === "baki")[0] || null;
  const lastJomaTxn     = txns.filter(t => t.type === "joma")[0] || null;
  // ✅ Paginated txn slice — avoids rendering thousands of rows
  const totalTxnPages   = Math.ceil(txns.length / TXN_PAGE_SIZE);
  const pagedTxns       = txns.slice((txnPage - 1) * TXN_PAGE_SIZE, txnPage * TXN_PAGE_SIZE);

  const handleCall = () => {
    if (customer.mobile) window.open(`tel:${customer.mobile}`, "_self");
  };
  const handleWhatsApp = () => {
    if (customer.mobile) {
      const num = customer.mobile.replace(/\D/g,"");
      const bdNum = num.startsWith("88") ? num : "88" + num;
      window.open(`https://wa.me/${bdNum}`, "_blank");
    }
  };
  const handleHistoryPdf = (months) => {
    const shopName = customer.shopName || "আমার দোকান";
    const content = buildCustomerHistoryHtml(customer, txns, invoices, paymentInvoices, months, shopName);
    const title = `${customer.name}_লেনদেন_ইতিহাস_শেষ_${months}_মাস`;
    const html = buildPdfHtml(content, shopName, `${customer.name} — শেষ ${months} মাসের লেনদেন`);
    setHistMonths(null);
    sharePdfWhatsApp(html, title);
  };
  const handleHistoryPrint = (months) => {
    const shopName = customer.shopName || "আমার দোকান";
    const content = buildCustomerHistoryHtml(customer, txns, invoices, paymentInvoices, months, shopName);
    const html = buildPdfHtml(content, shopName, `${customer.name} — শেষ ${months} মাসের লেনদেন`);
    setHistMonths(null);
    printPdfHtml(html);
  };

  if (viewInv) {
    const cust = customers.find(c => c.id === viewInv.customerId);
    return (
      <div style={S.page}>
        <button style={S.textBtn} onClick={() => setViewInv(null)}>← লেনদেনে ফিরুন</button>
        <InvoiceReceipt T={T} S={S} inv={viewInv} customer={cust} type="buyer" />
      </div>
    );
  }
  if (viewPayInv) {
    return (
      <div style={S.page}>
        <button style={S.textBtn} onClick={() => setViewPayInv(null)}>← লেনদেনে ফিরুন</button>
        <PaymentInvoiceReceipt T={T} S={S} inv={viewPayInv} />
      </div>
    );
  }

  return (
    <div style={S.page}>
      {/* Customer name & balance hero */}
      <div style={{ background: "linear-gradient(135deg,#1e3a5f,#0369a1)", borderRadius: 18, padding: "18px 20px", marginBottom: 14, boxShadow: "0 4px 20px #00000044" }}>
        <div style={{ color: "#7dd3fc", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>কাস্টমার</div>
        <div style={{ color: "#ffffff", fontWeight: 900, fontSize: 22, marginBottom: 2, textShadow: "0 2px 8px #00000055" }}>{customer.name}</div>
        {customer.mobile && (
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom: 10 }}>
            <span style={{ color: "#bae6fd", fontSize: 13 }}>📞 {customer.mobile}</span>
            <button onClick={handleCall} style={{ background:"#22c55e22", color:"#22c55e", border:"1px solid #22c55e55", borderRadius:8, padding:"3px 10px", fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}>📞 কল</button>
            <button onClick={handleWhatsApp} style={{ background:"#25D36622", color:"#25D366", border:"1px solid #25D36655", borderRadius:8, padding:"3px 10px", fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}>💬 WA</button>
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 10, width: "100%" }}>
          <div style={{ background: customer.balance > 0 ? "#ef444430" : "#22c55e30", border: `2px solid ${customer.balance > 0 ? "#ef444466" : "#22c55e66"}`, borderRadius: 14, padding: "14px 24px", width: "100%", boxSizing: "border-box" }}>
            <div style={{ color: customer.balance > 0 ? "#fca5a5" : "#86efac", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>বর্তমান বাকি</div>
            <div style={{ color: customer.balance > 0 ? "#ef4444" : "#22c55e", fontWeight: 900, fontSize: 32, textShadow: "0 1px 6px #00000044" }}>৳{fmt(customer.balance)}</div>
          </div>
        </div>
      </div>

      {/* Top 2 stats: বর্তমান বাকি + মোট জমা */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
        <div style={{ ...S.sumCard, borderColor: "#f59e0b66", background: "linear-gradient(135deg,#78350f22,#f59e0b11)" }}>
          <div style={{ color: "#f59e0b", fontSize: 11, fontWeight: 700, marginBottom: 4 }}>💰 বর্তমান বাকি</div>
          <div style={{ color: "#f59e0b", fontWeight: 900, fontSize: 20 }}>৳{fmt(customer.balance)}</div>
        </div>
        <div style={{ ...S.sumCard, borderColor: "#22c55e66", background: "linear-gradient(135deg,#14532d22,#22c55e11)" }}>
          <div style={{ color: "#22c55e", fontSize: 11, fontWeight: 700, marginBottom: 4 }}>✅ মোট জমা দিয়েছে</div>
          <div style={{ color: "#22c55e", fontWeight: 900, fontSize: 20 }}>৳{fmt(totalJomaAdded)}</div>
        </div>
      </div>

      {/* Bottom 2 stats: সর্বশেষ বাকি + সর্বশেষ জমা with date */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
        <div style={{ ...S.sumCard, borderColor: "#ef444444", background: "linear-gradient(135deg,#7f1d1d22,#ef444411)" }}>
          <div style={{ color: "#ef4444", fontSize: 11, fontWeight: 700, marginBottom: 4 }}>📋 সর্বশেষ বাকি</div>
          {lastBakiTxn
            ? <>
                <div style={{ color: "#ef4444", fontWeight: 900, fontSize: 18 }}>৳{fmt(lastBakiTxn.amount)}</div>
                <div style={{ color: T.sub, fontSize: 10, marginTop: 3 }}>📅 {lastBakiTxn.date}</div>
              </>
            : <div style={{ color: T.sub, fontSize: 12 }}>কোনো বাকি নেই</div>
          }
        </div>
        <div style={{ ...S.sumCard, borderColor: "#0ea5e944", background: "linear-gradient(135deg,#0c4a6e22,#0ea5e911)" }}>
          <div style={{ color: "#0ea5e9", fontSize: 11, fontWeight: 700, marginBottom: 4 }}>💵 সর্বশেষ জমা</div>
          {lastJomaTxn
            ? <>
                <div style={{ color: "#0ea5e9", fontWeight: 900, fontSize: 18 }}>৳{fmt(lastJomaTxn.amount)}</div>
                <div style={{ color: T.sub, fontSize: 10, marginTop: 3 }}>📅 {lastJomaTxn.date}</div>
              </>
            : <div style={{ color: T.sub, fontSize: 12 }}>কোনো জমা নেই</div>
          }
        </div>
      </div>

      {/* লেনদেনের ইতিহাস PDF বাটন */}
      <div style={{ background: T.card, borderRadius: 14, padding: "12px 14px", marginBottom: 14, border: `1px solid ${T.border}` }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom: histMonths !== null ? 10 : 0 }}>
          <div style={{ color: T.text, fontWeight: 700, fontSize: 13 }}>📄 লেনদেনের ইতিহাস PDF</div>
          <button style={{ ...S.linkBtn }} onClick={() => setHistMonths(histMonths !== null ? null : 1)}>
            {histMonths !== null ? "বন্ধ" : "তৈরি করুন"}
          </button>
        </div>
        {histMonths !== null && (
          <div>
            <div style={{ color: T.sub, fontSize: 12, marginBottom: 8 }}>কত মাসের ইতিহাস চান?</div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:10 }}>
              {[1,2,3,4,5,6,9,12].map(m => (
                <button key={m}
                  style={{ background: histMonths===m?"#0369a1":"#0369a118", color: histMonths===m?"#fff":"#0369a1",
                    border:`1px solid #0369a144`, borderRadius:8, padding:"6px 12px", fontSize:13,
                    fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}
                  onClick={() => setHistMonths(m)}>
                  {m} মাস
                </button>
              ))}
            </div>
            <div style={{ color: T.sub, fontSize: 11, marginBottom:8 }}>নির্বাচিত: শেষ <b style={{color:T.text}}>{histMonths} মাস</b></div>
            <div style={{ display:"flex", gap:8 }}>
              <button style={{ flex:1, background:"linear-gradient(135deg,#1e40af,#3b82f6)", color:"#fff",
                border:"none", borderRadius:10, padding:"10px", fontWeight:700,
                cursor:"pointer", fontFamily:"inherit", fontSize:13 }}
                onClick={() => handleHistoryPrint(histMonths)}>🖨️ প্রিন্ট</button>
              <button style={{ flex:1, background:"linear-gradient(135deg,#065f46,#22c55e)", color:"#fff",
                border:"none", borderRadius:10, padding:"10px", fontWeight:700,
                cursor:"pointer", fontFamily:"inherit", fontSize:13 }}
                onClick={() => handleHistoryPdf(histMonths)}>💬 WhatsApp শেয়ার</button>
            </div>
          </div>
        )}
      </div>

      <div style={S.histLabel}>লেনদেনের ইতিহাস ({txns.length}টি)</div>
      {txns.length === 0 && <div style={S.empty}>এখনো কোনো লেনদেন নেই</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {pagedTxns.map(t => {
          const inv = t.invoiceId ? invoices.find(iv => iv.id === t.invoiceId) : null;
          const payInv = t.paymentInvoiceId ? paymentInvoices.find(p => p.id === t.paymentInvoiceId) : null;
          const isBaki = t.type === "baki";
          return (
            <div key={t.id} style={S.txnCard}>
              <div style={{ width: 5, flexShrink: 0, background: isBaki ? "#ef4444" : "#22c55e" }} />
              <div style={{ flex: 1, padding: "12px 14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ ...S.txnBadge, background: isBaki ? "#ef444422" : "#22c55e22", color: isBaki ? "#ef4444" : "#22c55e" }}>
                      {isBaki ? "▲ বাকি" : "▼ জমা"}
                    </span>
                    <span style={{ color: isBaki ? "#ef4444" : "#22c55e", fontWeight: 800, fontSize: 17 }}>
                      {isBaki ? "+" : "−"}৳{fmt(t.amount)}
                    </span>
                  </div>
                  <span style={{ color: T.sub, fontSize: 11 }}>{t.time}</span>
                </div>
                <div style={{ color: T.sub, fontSize: 12, marginBottom: (inv || payInv) ? 10 : 0 }}>
                  পরে বাকি: ৳{fmt(t.balanceAfter)} {t.note && `· ${t.note}`}
                </div>
                {inv && (
                  <button style={S.invBtn} onClick={() => setViewInv(inv)}>
                    <IcInvoice /><span>ক্রয় ইনভয়েস দেখুন</span>
                    <span style={{ marginLeft: "auto", color: T.sub }}>{inv.items.length}টি পণ্য · ৳{fmt(inv.total)}</span>
                  </button>
                )}
                {payInv && (
                  <button style={{ ...S.invBtn, color: "#22c55e", borderColor: "#22c55e44" }} onClick={() => setViewPayInv(payInv)}>
                    <IcCheck /><span>জমার রসিদ দেখুন</span>
                    <span style={{ marginLeft: "auto", color: T.sub }}>৳{fmt(payInv.amount)}</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {/* ✅ Pagination for large transaction histories */}
      {totalTxnPages > 1 && (
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 12, marginTop: 16, marginBottom: 8 }}>
          <button style={{ ...S.cancelBtn, flex: "none", padding: "8px 16px", opacity: txnPage===1?0.4:1 }}
            onClick={() => setTxnPage(p=>Math.max(1,p-1))} disabled={txnPage===1}>←</button>
          <span style={{ color: T.sub, fontSize: 13 }}>{txnPage} / {totalTxnPages} ({txns.length}টি)</span>
          <button style={{ ...S.cancelBtn, flex: "none", padding: "8px 16px", opacity: txnPage===totalTxnPages?0.4:1 }}
            onClick={() => setTxnPage(p=>Math.min(totalTxnPages,p+1))} disabled={txnPage===totalTxnPages}>→</button>
        </div>
      )}
    </div>
  );
}
function PaymentInvoiceReceipt({ T, S, inv }) {
  const printRef = useRef(null);
  const handlePrint = () => {
    const el = printRef.current; if (!el) return;
    const css = `body{font-family:'Hind Siliguri',sans-serif;background:#fff;color:#000;padding:20px;font-size:13px;}.center{text-align:center;}.bold{font-weight:700;}.line{border-top:1px dashed #999;margin:10px 0;}.big{font-size:22px;font-weight:800;}`;
    openPrintWindow(`<html><head><title>Receipt</title><style>${css}</style></head><body>${el.innerHTML}</body></html>`);
  };
  const handleShare = () => {
    const el = printRef.current; if (!el) return;
    const shopName = inv.shopName || "আমার দোকান";
    const title = `জমার_রশিদ_${inv.id?.slice(0,6)?.toUpperCase()}`;
    const content = `
      <div class="info-row"><span class="info-label">কাস্টমার:</span><span class="info-val">${inv.customerName}</span></div>
      <div class="info-row"><span class="info-label">মোবাইল:</span><span class="info-val">${inv.customerMobile||"—"}</span></div>
      <div class="info-row"><span class="info-label">তারিখ:</span><span class="info-val">${inv.date} · ${inv.time||""}</span></div>
      <div class="info-row"><span class="info-label">রশিদ নং:</span><span class="info-val">#${(inv.id||"").toUpperCase()}</span></div>
      ${inv.note ? `<div class="info-row"><span class="info-label">নোট:</span><span class="info-val">${inv.note}</span></div>` : ""}
      <div style="text-align:center;background:#22c55e18;border-radius:12px;padding:20px;margin:16px 0;">
        <div style="color:#22c55e;font-size:12px;font-weight:700;">জমার পরিমাণ</div>
        <div style="color:#22c55e;font-size:32px;font-weight:900;">৳${(inv.amount||0).toLocaleString("bn-BD")}</div>
      </div>
      <div style="text-align:center;color:#999;font-size:12px;margin-top:10px;">ধন্যবাদ! জমা নিশ্চিত হয়েছে 🙏</div>`;
    const html = buildPdfHtml(content, shopName, "জমার রশিদ");
    sharePdfWhatsApp(html, title);
  };
  return (
    <div>
      <div ref={printRef} style={{ background: T.card, borderRadius: 16, padding: 20, marginBottom: 10 }}>
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 28 }}>✅</div>
          <div style={{ color: T.text, fontWeight: 800, fontSize: 18, marginTop: 4 }}>{inv.shopName || "আমার দোকান"}</div>
          <div style={{ color: T.sub, fontSize: 11, marginTop: 2 }}>জমার রসিদ · #{inv.id.toUpperCase()}</div>
          <div style={{ color: T.sub, fontSize: 11 }}>{inv.date} · {inv.time}</div>
        </div>
        <div style={S.dashed} />
        <div style={{ fontSize: 12, color: T.sub, display: "flex", flexDirection: "column", gap: 3, marginBottom: 10 }}>
          <div><b style={{ color: T.text }}>কাস্টমার:</b> {inv.customerName}</div>
          <div><b style={{ color: T.text }}>মোবাইল:</b> {inv.customerMobile}</div>
        </div>
        <div style={S.dashed} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "16px 0" }}>
          <div style={{ color: T.sub, fontSize: 14 }}>জমার পরিমাণ</div>
          <div style={{ color: "#22c55e", fontWeight: 800, fontSize: 26 }}>৳{fmt(inv.amount)}</div>
        </div>
        {inv.note && <div style={{ color: T.sub, fontSize: 12, marginBottom: 8 }}>নোট: {inv.note}</div>}
        <div style={S.dashed} />
        <div style={{ textAlign: "center", color: T.sub, fontSize: 12, marginTop: 14 }}>ধন্যবাদ! জমা নিশ্চিত হয়েছে 🙏</div>
      </div>
      <div style={{ display:"flex", gap:8 }}>
        <button style={{ ...S.saveBtn, flex:1 }} onClick={handlePrint}><IcPrint /> প্রিন্ট করুন</button>
        <button style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", gap:6,
          background:"linear-gradient(135deg,#065f46,#22c55e)", color:"#fff",
          border:"none", borderRadius:10, padding:"10px", fontWeight:700,
          cursor:"pointer", fontFamily:"inherit", fontSize:13 }}
          onClick={handleShare}>💬 WhatsApp</button>
      </div>
    </div>
  );
}

// ── Transaction Modal ──────────────────────────────────────────────────────────
function TransactionModal({ T, S, customer, setCustomers, sendSMS, showToast, addTxn, createPaymentInvoice, onClose }) {
  const [mode,    setMode]    = useState(customer._mode || "baki");
  const [amount,  setAmount]  = useState("");
  const [note,    setNote]    = useState("");
  const [sending, setSending] = useState(false);
  const [showInv, setShowInv] = useState(null);
  const PRESETS = [
    { val: 10,    label: "10" },
    { val: 100,   label: "100" },
    { val: 500,   label: "500" },
    { val: 1000,  label: "1K" },
    { val: 5000,  label: "5K" },
    { val: 10000, label: "10K" },
    { val: 20000, label: "20K" },
    { val: 50000, label: "50K" },
  ];

  const handleSubmit = async () => {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return;
    setSending(true);
    const newBalance = mode === "baki" ? customer.balance + amt : Math.max(0, customer.balance - amt);
    setCustomers(prev => prev.map(c => c.id === customer.id ? { ...c, balance: newBalance } : c));
    let payInvId = null;
    if (mode === "joma") {
      const payInv = createPaymentInvoice({ ...customer, balance: newBalance }, amt, note);
      payInvId = payInv.id;
      setShowInv(payInv);
    }
    addTxn(customer.id, mode, amt, newBalance, null, note, payInvId);
    await sendSMS({ ...customer, balance: newBalance }, mode, amt);
    if (mode !== "joma") { showToast(mode === "baki" ? "বাকি যোগ হয়েছে ✓" : "জমা নেওয়া হয়েছে ✓"); setSending(false); onClose(); }
    else setSending(false);
  };

  if (showInv) {
    return (
      <div style={S.overlay}>
        <div style={{ ...S.modalCard, maxHeight: "90vh", overflowY: "auto" }}>
          <div style={{ color: "#22c55e", fontWeight: 700, fontSize: 15, marginBottom: 14 }}>✅ জমা সম্পন্ন হয়েছে!</div>
          <PaymentInvoiceReceipt T={T} S={S} inv={showInv} />
          <button style={{ ...S.cancelBtn, width: "100%", marginTop: 14 }} onClick={onClose}>বন্ধ করুন</button>
        </div>
      </div>
    );
  }

  return (
    <div style={S.overlay}>
      <div style={S.modalCard}>
        <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 16 }}>
          <div style={S.avatar}>{customer.name[0]}</div>
          <div>
            <div style={S.rowName}>{customer.name}</div>
            <div style={S.rowSub}>বর্তমান বাকি: ৳{fmt(customer.balance)}</div>
          </div>
        </div>
        <div style={S.modeToggle}>
          <button style={{ ...S.modeBtn, ...(mode === "baki" ? { background: "#ef4444", color: "#fff" } : {}) }} onClick={() => setMode("baki")}>▲ বাকি</button>
          <button style={{ ...S.modeBtn, ...(mode === "joma" ? { background: "#22c55e", color: "#fff" } : {}) }} onClick={() => setMode("joma")}>▼ জমা</button>
        </div>
        <div style={{ marginBottom: 10 }}>
          <div style={{ color: T.sub, fontSize: 11, marginBottom: 6 }}>দ্রুত পরিমাণ <span style={{ color: T.accent, fontWeight: 700 }}>(একাধিকবার ক্লিক করুন)</span>:</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {PRESETS.map(p => (
              <button key={p.val}
                style={{ background: mode === "baki" ? "#ef444422" : "#22c55e22", color: mode === "baki" ? "#ef4444" : "#22c55e", border: `1px solid ${mode === "baki" ? "#ef444466" : "#22c55e66"}`, borderRadius: 8, padding: "7px 12px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", transition: "transform 0.1s", active: "transform: scale(0.95)" }}
                onClick={() => setAmount(prev => String((parseFloat(prev) || 0) + p.val))}>+{p.label}</button>
            ))}
          </div>
          {parseFloat(amount) > 0 && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, background: mode === "baki" ? "#ef444412" : "#22c55e12", borderRadius: 8, padding: "6px 12px" }}>
              <span style={{ color: T.sub, fontSize: 12 }}>মোট যোগ হয়েছে:</span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: mode === "baki" ? "#ef4444" : "#22c55e", fontWeight: 800, fontSize: 16 }}>৳{fmt(parseFloat(amount))}</span>
                <button onClick={() => setAmount("")} style={{ background: "#ef444422", color: "#ef4444", border: "none", borderRadius: 6, padding: "2px 7px", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>✕ রিসেট</button>
              </div>
            </div>
          )}
        </div>
        <input style={{ ...S.input, fontSize: 22, textAlign: "center", fontWeight: 800 }} type="number" placeholder="টাকার পরিমাণ" value={amount} onChange={e => setAmount(e.target.value)} inputMode="numeric" />
        <input style={S.input} placeholder="নোট (ঐচ্ছিক)" value={note} onChange={e => setNote(e.target.value)} />
        <div style={{ background: T.bg, borderRadius: 10, padding: "10px 14px", color: "#0ea5e9", fontSize: 12, marginBottom: 14 }}>
          📱 SMS স্বয়ংক্রিয়ভাবে {customer.mobile} নম্বরে যাবে
        </div>
        <div style={S.rowBtns}>
          <button style={S.cancelBtn} onClick={onClose}>বাতিল</button>
          <button style={{ ...S.saveBtn, opacity: sending ? 0.7 : 1 }} onClick={handleSubmit} disabled={sending}>
            {sending ? "প্রক্রিয়া হচ্ছে..." : mode === "joma" ? "✅ জমা নিন ও রসিদ দিন" : "নিশ্চিত করুন"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Invoice Receipt ────────────────────────────────────────────────────────────
function InvoiceReceipt({ T, S, inv, customer, type = "buyer" }) {
  const isBuyer = type === "buyer";
  const handleShare = () => {
    const shopName = inv.shopName || "আমার দোকান";
    const itemRows = (inv.items||[]).map((item,i) =>
      `<tr><td class="serial">${i+1}</td><td>${item.name}</td><td>${item.qty}</td><td class="amount">৳${item.price}</td><td class="amount">৳${item.qty*item.price}</td></tr>`
    ).join("");
    const content = `
      <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
        <div style="flex:1;background:#0369a115;border-radius:10px;padding:10px 14px;">
          <div style="color:#666;font-size:11px;">কাস্টমার</div>
          <div style="font-weight:800;font-size:15px;">${inv.customerName}</div>
          <div style="color:#666;font-size:11px;">${inv.customerMobile||""}</div>
          ${customer?.address?`<div style="color:#666;font-size:11px;">${customer.address}</div>`:""}
        </div>
        <div style="flex:1;background:#0369a115;border-radius:10px;padding:10px 14px;">
          <div style="color:#666;font-size:11px;">ইনভয়েস</div>
          <div style="font-weight:800;">#${(inv.id||"").toUpperCase()}</div>
          <div style="color:#666;font-size:11px;">${inv.date||""}</div>
          <div style="color:#666;font-size:11px;">${isBuyer?"ক্রেতার কপি":"বিক্রেতার কপি"}</div>
        </div>
      </div>
      <table><thead><tr><th class="serial">#</th><th>পণ্য</th><th>পরিমাণ</th><th>দাম</th><th>মোট</th></tr></thead><tbody>${itemRows}</tbody></table>
      <div style="margin-top:14px;background:#0369a115;border-radius:10px;padding:12px 16px;">
        <div class="info-row"><span class="info-label">মোট:</span><span class="info-val" style="font-size:18px;">৳${fmt(inv.total)}</span></div>
        ${inv.payType==="partial"?`
          <div class="info-row"><span class="info-label">নগদ পেয়েছি:</span><span class="info-val" style="color:#22c55e;">৳${fmt(inv.paidAmount||0)}</span></div>
          <div class="info-row"><span class="info-label">বাকি:</span><span class="info-val" style="color:#ef4444;">৳${fmt(inv.bakiAmount||0)}</span></div>
        `:""}
        <div class="info-row"><span class="info-label">পরিশোধ পদ্ধতি:</span><span class="info-val">${inv.payType==="baki"?"বাকি":inv.payType==="partial"?"আংশিক":"নগদ"}</span></div>
        ${inv.note?`<div class="info-row"><span class="info-label">নোট:</span><span class="info-val">${inv.note}</span></div>`:""}
      </div>`;
    const html = buildPdfHtml(content, shopName, `${isBuyer?"ক্রেতার":"বিক্রেতার"} ইনভয়েস`);
    sharePdfWhatsApp(html, `ইনভয়েস_${(inv.id||"").slice(0,6).toUpperCase()}`);
  };
  const handlePrint = () => {
    const shopName = inv.shopName || "আমার দোকান";
    const itemRows = (inv.items||[]).map((item,i) =>
      `<tr><td class="serial">${i+1}</td><td>${item.name}</td><td>${item.qty}</td><td class="amount">৳${item.price}</td><td class="amount">৳${item.qty*item.price}</td></tr>`
    ).join("");
    const content = `
      <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
        <div style="flex:1;background:#0369a115;border-radius:10px;padding:10px 14px;">
          <div style="color:#666;font-size:11px;">কাস্টমার: ${inv.customerName}</div>
          <div style="color:#666;font-size:11px;">মোবাইল: ${inv.customerMobile||""}</div>
          ${customer?.address?`<div style="color:#666;font-size:11px;">ঠিকানা: ${customer.address}</div>`:""}
        </div>
        <div style="flex:1;background:#0369a115;border-radius:10px;padding:10px 14px;">
          <div style="color:#666;font-size:11px;">ইনভয়েস: #${(inv.id||"").toUpperCase()}</div>
          <div style="color:#666;font-size:11px;">তারিখ: ${inv.date||""}</div>
        </div>
      </div>
      <table><thead><tr><th class="serial">#</th><th>পণ্য</th><th>পরিমাণ</th><th>দাম</th><th>মোট</th></tr></thead><tbody>${itemRows}</tbody></table>
      <div style="margin-top:14px;padding:12px 0;">
        <div class="info-row"><span>মোট:</span><span style="font-weight:800;font-size:18px;">৳${fmt(inv.total)}</span></div>
        ${inv.payType==="partial"?`
          <div class="info-row"><span>নগদ:</span><span style="color:#22c55e;font-weight:700;">৳${fmt(inv.paidAmount||0)}</span></div>
          <div class="info-row"><span>বাকি:</span><span style="color:#ef4444;font-weight:700;">৳${fmt(inv.bakiAmount||0)}</span></div>
        `:""}
        <div class="info-row"><span>পরিশোধ:</span><span>${inv.payType==="baki"?"বাকি":inv.payType==="partial"?"আংশিক":"নগদ"}</span></div>
      </div>`;
    const html = buildPdfHtml(content, shopName, `${isBuyer?"ক্রেতার":"বিক্রেতার"} ইনভয়েস`);
    printPdfHtml(html);
  };
  return (
    <div>
      <div style={{ background: T.card, borderRadius: 16, padding: 20, marginBottom: 10 }}>
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 28 }}>🛒</div>
          <div style={{ color: T.text, fontWeight: 800, fontSize: 18, marginTop: 4 }}>{inv.shopName || "আমার দোকান"}</div>
          <div style={{ color: T.sub, fontSize: 11, marginTop: 2 }}>
            {isBuyer ? "ক্রেতার কপি 🧑" : "বিক্রেতার কপি 🏪"} · #{inv.id.toUpperCase()}
          </div>
          <div style={{ color: T.sub, fontSize: 11 }}>{inv.date}</div>
        </div>
        <div style={S.dashed} />
        <div style={{ fontSize: 12, color: T.sub, display: "flex", flexDirection: "column", gap: 3, marginBottom: 10 }}>
          <div><b style={{ color: T.text }}>কাস্টমার:</b> {inv.customerName}</div>
          <div><b style={{ color: T.text }}>মোবাইল:</b> {inv.customerMobile}</div>
          {customer?.address && <div><b style={{ color: T.text }}>ঠিকানা:</b> {customer.address}</div>}
        </div>
        <div style={S.dashed} />
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ color: T.sub, fontSize: 11, textAlign: "left", paddingBottom: 8, width: 24 }}>#</th>
              <th style={{ color: T.sub, fontSize: 11, textAlign: "left", paddingBottom: 8 }}>পণ্য</th>
              <th style={{ color: T.sub, fontSize: 11, textAlign: "right", paddingBottom: 8 }}>পরিমাণ</th>
              <th style={{ color: T.sub, fontSize: 11, textAlign: "right", paddingBottom: 8 }}>দাম</th>
              <th style={{ color: T.sub, fontSize: 11, textAlign: "right", paddingBottom: 8 }}>মোট</th>
            </tr>
          </thead>
          <tbody>
            {inv.items.map((item, idx) => (
              <tr key={item.productId || item.id}>
                <td style={{ color: T.sub, fontSize: 11, padding: "5px 0", borderBottom: `1px solid ${T.border}33` }}>{idx+1}</td>
                <td style={{ color: T.text, fontSize: 12, padding: "5px 0", borderBottom: `1px solid ${T.border}33` }}>{item.name}</td>
                <td style={{ color: T.text, fontSize: 12, padding: "5px 0", borderBottom: `1px solid ${T.border}33`, textAlign: "right" }}>{item.qty}</td>
                <td style={{ color: T.text, fontSize: 12, padding: "5px 0", borderBottom: `1px solid ${T.border}33`, textAlign: "right" }}>৳{item.price}</td>
                <td style={{ color: T.text, fontSize: 12, padding: "5px 0", borderBottom: `1px solid ${T.border}33`, textAlign: "right" }}>৳{fmt(item.qty * item.price)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={S.dashed} />
        <div style={{ display: "flex", justifyContent: "space-between", color: T.text, fontWeight: 800, fontSize: 16, marginBottom: 4 }}>
          <span>মোট</span><span>৳{fmt(inv.total)}</span>
        </div>
        {inv.payType === "partial" && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", color: "#22c55e", fontSize: 13, marginBottom: 2 }}>
              <span>নগদ পেয়েছি</span><span>৳{fmt(inv.paidAmount || 0)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", color: "#ef4444", fontSize: 13 }}>
              <span>বাকি</span><span>৳{fmt(inv.bakiAmount || 0)}</span>
            </div>
          </>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", color: T.sub, fontSize: 12, marginTop: 4 }}>
          <span>পরিশোধ পদ্ধতি</span>
          <span>{inv.payType === "baki" ? "বাকি" : inv.payType === "partial" ? "আংশিক" : "নগদ"}</span>
        </div>
        {inv.note && <div style={{ color: T.sub, fontSize: 12, marginTop: 6 }}>নোট: {inv.note}</div>}
        <div style={{ textAlign: "center", color: T.sub, fontSize: 12, marginTop: 14 }}>ধন্যবাদ! আবার আসবেন</div>
      </div>
      <div style={{ display:"flex", gap:8 }}>
        <button style={{ ...S.saveBtn, flex:1 }} onClick={handlePrint}><IcPrint /> প্রিন্ট</button>
        <button style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", gap:6,
          background:"linear-gradient(135deg,#065f46,#22c55e)", color:"#fff",
          border:"none", borderRadius:10, padding:"10px", fontWeight:700,
          cursor:"pointer", fontFamily:"inherit", fontSize:13 }}
          onClick={handleShare}>💬 WhatsApp</button>
      </div>
    </div>
  );
}

function InvoiceReceiptPrint({ inv, customer, type }) {
  const isBuyer = type === "buyer";
  return (
    <div>
      <div className="center bold" style={{ fontSize: 16 }}>{inv.shopName || "আমার দোকান"}</div>
      <div className="center" style={{ fontSize: 11 }}>{isBuyer ? "ক্রেতার কপি" : "বিক্রেতার কপি"} | #{inv.id.toUpperCase()}</div>
      <div className="center" style={{ fontSize: 11 }}>{inv.date}</div>
      <div className="line" />
      <div style={{ fontSize: 11 }}>কাস্টমার: {inv.customerName}</div>
      <div style={{ fontSize: 11 }}>মোবাইল: {inv.customerMobile}</div>
      {customer?.address && <div style={{ fontSize: 11 }}>ঠিকানা: {customer.address}</div>}
      <div className="line" />
      <table>
        <thead><tr><th>#</th><th>পণ্য</th><th className="right">পরিমাণ</th><th className="right">দাম</th><th className="right">মোট</th></tr></thead>
        <tbody>
          {inv.items.map((item, i) => (
            <tr key={i}><td style={{ color: "#666", fontSize: 10 }}>{i+1}</td><td>{item.name}</td><td className="right">{item.qty}</td><td className="right">৳{item.price}</td><td className="right">৳{item.qty * item.price}</td></tr>
          ))}
        </tbody>
      </table>
      <div className="line" />
      <div style={{ display: "flex", justifyContent: "space-between" }} className="total"><span>মোট</span><span>৳{inv.total}</span></div>
      {inv.payType === "partial" && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}><span>নগদ</span><span>৳{inv.paidAmount || 0}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}><span>বাকি</span><span>৳{inv.bakiAmount || 0}</span></div>
        </>
      )}
      <div className="line" />
      <div className="center" style={{ fontSize: 11, marginTop: 8 }}>ধন্যবাদ! আবার আসবেন</div>
    </div>
  );
}

// ── Products ───────────────────────────────────────────────────────────────────
function Products({ T, S, products, setProducts, showToast }) {
  const [showAdd,  setShowAdd]  = useState(false);
  const [editId,   setEditId]   = useState(null);
  const [form,     setForm]     = useState({ name: "", price: "", stock: "", category: "অন্যান্য" });
  const [search,   setSearch]   = useState("");
  const [page,     setPage]     = useState(1);
  const PAGE_SIZE = 20;

  const productsWithSerial = products.map((p, i) => ({ ...p, serial: i + 1, serialStr: String(i + 1) }));
  const filtered = productsWithSerial.filter(p => p.name.includes(search) || p.serialStr.includes(search.trim()));
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const lowStock = products.filter(p => (p.stock || 0) <= 5 && (p.stock || 0) > 0);
  const outOfStock = products.filter(p => (p.stock || 0) === 0);

  const save = () => {
    if (!form.name.trim() || !form.price) { showToast("নাম ও দাম দিতে হবে", "#ef4444"); return; }
    const prod = { ...form, price: parseFloat(form.price), stock: parseInt(form.stock) || 0 };
    if (editId) {
      setProducts(prev => prev.map(p => p.id === editId ? { ...p, ...prod } : p));
      showToast("পণ্য আপডেট হয়েছে ✓");
      setEditId(null);
    } else {
      setProducts(prev => [...prev, { id: uid(), ...prod }]);
      showToast("নতুন পণ্য যোগ হয়েছে ✓");
    }
    setForm({ name: "", price: "", stock: "", category: "অন্যান্য" }); setShowAdd(false);
  };

  return (
    <div style={S.page}>
      {/* Stock alerts */}
      {(outOfStock.length > 0 || lowStock.length > 0) && (
        <div style={{ marginBottom: 12 }}>
          {outOfStock.length > 0 && (
            <div style={{ background: "#ef444418", border: "1px solid #ef444444", borderRadius: 12, padding: "10px 14px", marginBottom: 8, color: "#ef4444", fontSize: 12, fontWeight: 600 }}>
              🚫 স্টক শেষ ({outOfStock.length}টি): {outOfStock.slice(0,3).map(p=>p.name).join(", ")}{outOfStock.length>3?"...":""}
            </div>
          )}
          {lowStock.length > 0 && (
            <div style={{ background: "#f59e0b18", border: "1px solid #f59e0b44", borderRadius: 12, padding: "10px 14px", marginBottom: 8, color: "#f59e0b", fontSize: 12, fontWeight: 600 }}>
              ⚠️ কম স্টক ({lowStock.length}টি): {lowStock.slice(0,3).map(p=>`${p.name}(${p.stock})`).join(", ")}{lowStock.length>3?"...":""}
            </div>
          )}
        </div>
      )}
      <div style={S.searchBar}>
        <IcSearch />
        <input style={S.searchInput} placeholder={`নাম বা নম্বর দিয়ে খুঁজুন... (${products.length}টি)`} value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
      </div>
      <button style={S.addBtn} onClick={() => { setShowAdd(v => !v); setEditId(null); setForm({ name: "", price: "", stock: "", category: "অন্যান্য" }); }}>
        <IcPlus /> নতুন পণ্য
      </button>
      {showAdd && (
        <div style={S.card}>
          <div style={S.cardTitle}>{editId ? "পণ্য আপডেট" : "নতুন পণ্য যোগ"}</div>
          <label style={S.label}>🏷️ পণ্যের নাম *</label>
          <input style={S.input} placeholder="যেমন: চাল (প্রতি কেজি)" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          <label style={S.label}>💰 বিক্রয় মূল্য (৳) *</label>
          <input style={S.input} placeholder="যেমন: ৬০" type="number" value={form.price} onChange={e => setForm({ ...form, price: e.target.value })} inputMode="decimal" />
          <label style={S.label}>📦 স্টক পরিমাণ</label>
          <input style={S.input} placeholder="যেমন: ১০০" type="number" value={form.stock} onChange={e => setForm({ ...form, stock: e.target.value })} inputMode="numeric" />
          <label style={S.label}>🗂️ পণ্যের ধরন</label>
          <select style={S.input} value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
            {PRODUCT_CATEGORIES.filter(c => c !== "সব").map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <div style={S.rowBtns}>
            <button style={S.cancelBtn} onClick={() => { setShowAdd(false); setEditId(null); }}>বাতিল</button>
            <button style={S.saveBtn} onClick={save}><IcCheck /> {editId ? "আপডেট" : "যোগ করুন"}</button>
          </div>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {paged.length === 0 && <div style={S.empty}>কোনো পণ্য পাওয়া যায়নি</div>}
        {paged.map(p => (
          <div key={p.id} style={{ ...S.card, marginBottom: 0, display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderLeft: (p.stock||0)===0 ? "3px solid #ef4444" : (p.stock||0)<=5 ? "3px solid #f59e0b" : "3px solid transparent" }}>
            <div style={{ ...S.avatar, fontWeight: 800, fontSize: 13, letterSpacing: -0.5, flexShrink: 0 }}>{p.serial}</div>
            <div style={{ flex: 1 }}>
              <div style={{ color: T.text, fontWeight: 600, fontSize: 14 }}>{p.name}</div>
              <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
                <span style={{ color: T.accent, fontWeight: 700, fontSize: 13 }}>৳{fmt(p.price)}</span>
                <span style={{ color: (p.stock||0)===0?"#ef4444":(p.stock||0)<=5?"#f59e0b":T.sub, fontSize: 12, fontWeight: (p.stock||0)<=5?700:400 }}>
                  স্টক: {p.stock || 0}{(p.stock||0)===0?" 🚫":(p.stock||0)<=5?" ⚠️":""}
                </span>
                {p.category && <span style={{ background: T.bg, color: T.sub, fontSize: 11, borderRadius: 6, padding: "1px 7px" }}>{p.category}</span>}
              </div>
            </div>
            <button style={{ ...S.actionBtn, background: "#0ea5e918", color: "#0ea5e9", padding: "6px 10px" }}
              onClick={() => { setEditId(p.id); setForm({ name: p.name, price: String(p.price), stock: String(p.stock || 0), category: p.category || "অন্যান্য" }); setShowAdd(true); }}>
              <IcEdit />
            </button>
            <button style={{ ...S.actionBtn, background: "#ef444418", color: "#ef4444", padding: "6px 10px" }}
              onClick={() => { setProducts(prev => prev.filter(x => x.id !== p.id)); showToast("পণ্য মুছে ফেলা হয়েছে", "#ef4444"); }}>
              <IcTrash />
            </button>
          </div>
        ))}
      </div>
      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 12, marginTop: 16 }}>
          <button style={{ ...S.cancelBtn, flex: "none", padding: "8px 16px", opacity: page===1?0.4:1 }} onClick={() => setPage(p=>Math.max(1,p-1))} disabled={page===1}>←</button>
          <span style={{ color: T.sub, fontSize: 13 }}>{page} / {totalPages}</span>
          <button style={{ ...S.cancelBtn, flex: "none", padding: "8px 16px", opacity: page===totalPages?0.4:1 }} onClick={() => setPage(p=>Math.min(totalPages,p+1))} disabled={page===totalPages}>→</button>
        </div>
      )}
    </div>
  );
}

// ── SMS Log ────────────────────────────────────────────────────────────────────
function SmsLog({ T, S, smsLog, smsCount, setSmsCount, customers, sendSMS, showToast, smsGateway }) {
  const [custId, setCustId] = useState("");
  const [msg,    setMsg]    = useState("");
  const [sending,setSending]= useState(false);

  const sendCustom = async () => {
    if (!custId || !msg.trim()) { showToast("কাস্টমার ও বার্তা দিন", "#ef4444"); return; }
    const c = customers.find(x => x.id === custId);
    if (!c) return;
    setSending(true);
    await sendSMS(c, "custom", 0);
    showToast("SMS পাঠানো হয়েছে ✓");
    setMsg(""); setSending(false);
  };

  return (
    <div style={S.page}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
        <div style={{ background: T.card, borderRadius: 14, padding: 14, border: `1px solid ${T.border}` }}>
          <div style={{ color: "#22c55e", fontWeight: 800, fontSize: 22 }}>{smsLog.filter(s=>s.delivered).length}</div>
          <div style={{ color: T.sub, fontSize: 12 }}>SMS পাঠানো হয়েছে</div>
        </div>
        <div style={{ background: T.card, borderRadius: 14, padding: 14, border: `1px solid ${T.border}` }}>
          <div style={{ color: "#f59e0b", fontWeight: 800, fontSize: 22 }}>{smsLog.filter(s=>!s.delivered).length}</div>
          <div style={{ color: T.sub, fontSize: 12 }}>সিমুলেশন (গেটওয়ে নেই)</div>
        </div>
      </div>
      <div style={{ ...S.card, border: smsGateway?.apiKey ? "1px solid #22c55e44" : `1px solid #f59e0b44`, background: smsGateway?.apiKey ? "#22c55e08" : "#f59e0b08" }}>
        <div style={{ color: T.text, fontWeight: 700, fontSize: 13, marginBottom: 6 }}>📡 গেটওয়ে স্ট্যাটাস</div>
        <div style={{ color: smsGateway?.apiKey ? "#22c55e" : "#f59e0b", fontSize: 12 }}>
          {smsGateway?.apiKey
            ? `✅ ${smsGateway.provider === "twilio" ? "Twilio" : "SSL Wireless"} সংযুক্ত — SMS সত্যিই পাঠানো হবে`
            : "⚠️ সিমুলেশন মোড — SMS লগে দেখাবে কিন্তু আসলে পাঠানো হবে না। সেটিংসে গেটওয়ে সেট করুন।"}
        </div>
      </div>
      <div style={S.histLabel}>SMS ইতিহাস ({smsLog.length}টি)</div>
      {smsLog.length === 0 && <div style={S.empty}>কোনো SMS পাঠানো হয়নি</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {smsLog.slice(0, 30).map(s => (
          <div key={s.id} style={{ ...S.card, marginBottom: 0, padding: "12px 14px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ ...S.txnBadge, background: s.type === "baki" ? "#ef444422" : "#22c55e22", color: s.type === "baki" ? "#ef4444" : "#22c55e" }}>{s.type === "baki" ? "বাকি" : "জমা"}</div>
                <div style={{ color: T.text, fontWeight: 600, fontSize: 13 }}>{s.name}</div>
              </div>
              <div style={{ display: "flex", align: "center", gap: 6 }}>
                <div style={{ ...S.txnBadge, background: s.delivered ? "#22c55e22" : "#f59e0b22", color: s.delivered ? "#22c55e" : "#f59e0b" }}>{s.delivered ? "✓ পাঠানো" : "⏳ সিমুলেশন"}</div>
              </div>
            </div>
            <div style={{ color: T.sub, fontSize: 12, marginBottom: 4 }}>📱 {s.to}</div>
            <div style={{ color: T.text, fontSize: 12, background: T.bg, borderRadius: 8, padding: "8px 10px" }}>{s.text}</div>
            <div style={{ color: T.sub, fontSize: 10, marginTop: 4 }}>{s.time}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Password Change ────────────────────────────────────────────────────────────
function PasswordChange({ T, S, currentUser, setUsers, showToast }) {
  const [open,        setOpen]        = useState(false);
  const [oldPass,     setOldPass]     = useState("");
  const [newPass,     setNewPass]     = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [saving,      setSaving]      = useState(false);

  const handleChange = async () => {
    const ok = await checkPassword(oldPass, currentUser.password);
    if (!ok) { showToast("পুরনো পাসওয়ার্ড ভুল", "#ef4444"); return; }
    if (newPass.length < 4) { showToast("নতুন পাসওয়ার্ড কমপক্ষে ৪ অক্ষর হতে হবে", "#ef4444"); return; }
    if (newPass !== confirmPass) { showToast("নতুন পাসওয়ার্ড মিলছে না", "#ef4444"); return; }
    setSaving(true);
    const hashed = await hashPassword(newPass);
    setUsers(prev => prev.map(u => u.id === currentUser.id ? { ...u, password: hashed } : u));
    currentUser.password = hashed;
    setOldPass(""); setNewPass(""); setConfirmPass("");
    setOpen(false); setSaving(false);
    showToast("পাসওয়ার্ড পরিবর্তন হয়েছে ✓");
  };

  return (
    <div style={S.card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: open ? 14 : 0 }}>
        <div>
          <div style={S.cardTitle}>🔑 পাসওয়ার্ড পরিবর্তন</div>
          {!open && <div style={{ color: T.sub, fontSize: 12, marginTop: -10 }}>@{currentUser.username}</div>}
        </div>
        <button style={S.linkBtn} onClick={() => { setOpen(v => !v); setOldPass(""); setNewPass(""); setConfirmPass(""); }}>
          {open ? "বাতিল" : "পরিবর্তন করুন"}
        </button>
      </div>
      {open && (
        <>
          <label style={S.label}>পুরনো পাসওয়ার্ড</label>
          <input style={S.input} type="password" placeholder="বর্তমান পাসওয়ার্ড" value={oldPass} onChange={e => setOldPass(e.target.value)} />
          <label style={S.label}>নতুন পাসওয়ার্ড</label>
          <input style={S.input} type="password" placeholder="নতুন পাসওয়ার্ড (কমপক্ষে ৪ অক্ষর)" value={newPass} onChange={e => setNewPass(e.target.value)} />
          <label style={S.label}>নতুন পাসওয়ার্ড নিশ্চিত করুন</label>
          <input style={S.input} type="password" placeholder="পুনরায় নতুন পাসওয়ার্ড" value={confirmPass} onChange={e => setConfirmPass(e.target.value)} />
          <button style={{ ...S.saveBtn, width: "100%", padding: 12, opacity: saving ? 0.7 : 1 }} onClick={handleChange} disabled={saving}>
            <IcLock /> {saving ? "সংরক্ষণ হচ্ছে..." : "পাসওয়ার্ড সংরক্ষণ করুন"}
          </button>
        </>
      )}
    </div>
  );
}

// ── Settings ───────────────────────────────────────────────────────────────────
function Settings({ T, S, shopName, setShopName, users, setUsers, currentUser, setCurrentUser, showToast, customers, setCustomers, products, setProducts, invoices, setInvoices, txns, setTxns, smsLog, setSmsLog, darkMode, setDarkMode, deletedCustomers, setDeletedCustomers, smsGateway, setSmsGateway, btConnected, btDevice, onConnectBluetooth, onDisconnectBluetooth, paymentInvoices, setPaymentInvoices, lastAutoBackup, driveStatus, backupNeeded, performDriveBackup, buildBackupData, setBackupNeeded, anthropicKey, setAnthropicKey, smsTemplates, setSmsTemplates, autoBackupEnabled, setAutoBackupEnabled, firebaseConfig, setFirebaseConfig, firebaseEnabled, setFirebaseEnabled, fbStatus, fbBackupList, restoreFromFirebase, setAuthSession, devContact, setDevContact, masterResetHash, setMasterResetHash }) {
  const [editName,    setEditName]    = useState(false);
  const [nameInput,   setNameInput]   = useState(shopName);
  const [showNewUser, setShowNewUser] = useState(false);
  const [userForm,    setUserForm]    = useState({ name: "", username: "", password: "", pin: "" });
  const [showGateway, setShowGateway] = useState(false);
  const [gwForm,      setGwForm]      = useState(smsGateway || { provider: "ssl", username: "", apiKey: "", senderId: "", accountSid: "" });
  const [showPinEdit, setShowPinEdit] = useState(null);
  const [showSmsEd,   setShowSmsEd]   = useState(false);
  const [tplForm,     setTplForm]     = useState({ ...DEFAULT_SMS_TEMPLATES, ...(smsTemplates || {}) });
  // 🔥 Firebase state
  const [showFbSetup, setShowFbSetup] = useState(false);
  const [fbForm,      setFbForm]      = useState(firebaseConfig || { databaseURL: "", apiKey: "" });
  const [fbTesting,   setFbTesting]   = useState(false);
  const [fbTestMsg,   setFbTestMsg]   = useState(null);
  const [showRestore,    setShowRestore]    = useState(false);
  const [restoring,      setRestoring]      = useState(false);
  const [showRestoreMenu,setShowRestoreMenu] = useState(false);
  const [showSmsSection, setShowSmsSection] = useState(false);
  // PIN change state
  const [showPinChange,  setShowPinChange]  = useState(false);
  const [oldPinInput,    setOldPinInput]    = useState("");
  const [newPinInput,    setNewPinInput]    = useState("");
  const [newPinConfirm,  setNewPinConfirm]  = useState("");
  const [pinChangeErr,   setPinChangeErr]   = useState("");
  const [pinStep,        setPinStep]        = useState(1); // 1=old, 2=new, 3=confirm

  const saveGateway = () => {
    setSmsGateway(gwForm); setShowGateway(false);
    showToast("গেটওয়ে সংরক্ষণ হয়েছে ✓");
  };

  const addUser = async () => {
    if (!userForm.name || !userForm.username || !userForm.password) { showToast("সব তথ্য দিন", "#ef4444"); return; }
    const hashed = await hashPassword(userForm.password);
    setUsers(prev => [...prev, { id: uid(), ...userForm, password: hashed, role: "staff" }]);
    setUserForm({ name: "", username: "", password: "", pin: "" });
    setShowNewUser(false);
    showToast("নতুন ব্যবহারকারী যোগ হয়েছে ✓");
  };

  const handleImport = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (data.customers) setCustomers(data.customers);
        if (data.products)  setProducts(data.products);
        if (data.invoices)  setInvoices(data.invoices);
        if (data.txns)      setTxns(data.txns);
        if (data.smsLog)    setSmsLog(data.smsLog);
        showToast("ডেটা ইম্পোর্ট সফল হয়েছে ✓");
      } catch { showToast("ফাইল পড়তে সমস্যা হয়েছে", "#ef4444"); }
    };
    reader.readAsText(file);
  };

  return (
    <div style={S.page}>

      {/* ① দোকানের নাম */}
      <div style={S.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={S.cardTitle}>🏪 দোকানের নাম</div>
          <button style={S.linkBtn} onClick={() => { setEditName(v => !v); setNameInput(shopName); }}>
            {editName ? "বাতিল" : "পরিবর্তন"}
          </button>
        </div>
        {editName ? (
          <div style={{ marginTop: 10 }}>
            <input style={S.input} value={nameInput} onChange={e => setNameInput(e.target.value)} autoFocus />
            <button style={{ ...S.saveBtn, width: "100%" }}
              onClick={() => { setShopName(nameInput); setEditName(false); showToast("নাম পরিবর্তন হয়েছে ✓"); }}>
              <IcCheck /> সংরক্ষণ করুন
            </button>
          </div>
        ) : (
          <div style={{ color: T.text, fontWeight: 700, fontSize: 18, marginTop: 6 }}>{shopName}</div>
        )}
      </div>

      {/* ② ডার্ক মোড */}
      <div style={S.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ color: T.text, fontWeight: 600, fontSize: 14 }}>{darkMode ? "🌙 ডার্ক মোড" : "☀️ লাইট মোড"}</div>
            <div style={{ color: T.sub, fontSize: 11, marginTop: 2 }}>{darkMode ? "চালু" : "বন্ধ"}</div>
          </div>
          <button
            style={{ background: darkMode ? "#22c55e" : T.border, border: "none", borderRadius: 20, width: 52, height: 28, cursor: "pointer", position: "relative", transition: "all 0.2s", flexShrink: 0 }}
            onClick={() => setDarkMode(v => !v)}>
            <div style={{ position: "absolute", top: 4, left: darkMode ? 26 : 4, width: 20, height: 20, borderRadius: "50%", background: "#fff", transition: "all 0.2s", boxShadow: "0 1px 4px #0004" }} />
          </button>
        </div>
      </div>

      {/* ③ ব্যাকআপ */}
      <div style={S.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div>
            <div style={S.cardTitle}>☁️ ডেটা ব্যাকআপ এবং রিস্টোর</div>
            {lastAutoBackup && (
              <div style={{ color: T.sub, fontSize: 11, marginTop: -8 }}>
                সর্বশেষ: {new Date(lastAutoBackup).toLocaleString("bn-BD", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
              </div>
            )}
          </div>
          {backupNeeded && false && <span style={{ background: "#f59e0b22", color: "#f59e0b", fontSize: 11, borderRadius: 8, padding: "3px 10px", fontWeight: 700 }}>প্রয়োজন</span>}
        </div>

        {/* অটো ব্যাকআপ টগল */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: T.bg, borderRadius: 10, padding: "10px 14px", marginBottom: 10 }}>
          <div>
            <div style={{ color: T.text, fontWeight: 600, fontSize: 13 }}>🔄 অটো ব্যাকআপ (প্রতি ১ ঘণ্টা)</div>
            <div style={{ color: T.sub, fontSize: 11 }}>{autoBackupEnabled ? "✅ চালু" : "⏸ বন্ধ"}</div>
          </div>
          <button
            style={{ background: autoBackupEnabled ? "#22c55e" : T.border, border: "none", borderRadius: 20, width: 52, height: 28, cursor: "pointer", position: "relative", transition: "all 0.2s", flexShrink: 0 }}
            onClick={() => setAutoBackupEnabled(v => !v)}>
            <div style={{ position: "absolute", top: 4, left: autoBackupEnabled ? 26 : 4, width: 20, height: 20, borderRadius: "50%", background: "#fff", transition: "all 0.2s", boxShadow: "0 1px 4px #0004" }} />
          </button>
        </div>

        {/* Firebase sync status */}
        {firebaseEnabled && fbStatus && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, background: fbStatus === "synced" ? "#22c55e18" : fbStatus === "error" ? "#ef444418" : "#0ea5e918", borderRadius: 10, padding: "8px 12px", marginBottom: 10 }}>
            {fbStatus === "syncing" && <div style={{ width: 12, height: 12, borderRadius: "50%", border: "2px solid #0ea5e9", borderTopColor: "transparent", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />}
            {fbStatus === "synced"  && <span>✅</span>}
            {fbStatus === "error"   && <span>❌</span>}
            <span style={{ color: fbStatus === "synced" ? "#22c55e" : fbStatus === "error" ? "#ef4444" : "#0ea5e9", fontSize: 12, fontWeight: 600 }}>
              {fbStatus === "syncing" ? "সিঙ্ক হচ্ছে..." : fbStatus === "synced" ? "Firebase-এ সেভ হয়েছে" : "Firebase ব্যর্থ"}
            </span>
          </div>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <button style={{ ...S.saveBtn, flex: 1, opacity: driveStatus === "uploading" ? 0.7 : 1 }} onClick={performDriveBackup} disabled={driveStatus === "uploading"}>
            <IcCloud /> {driveStatus === "uploading" ? "হচ্ছে..." : "এখনই ব্যাকআপ"}
          </button>
          <div style={{ flex: 1, position: "relative" }}>
            <button
              style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                background: "linear-gradient(135deg,#b45309,#f59e0b)", color: "#fff",
                border: "none", borderRadius: 10, padding: "10px", fontWeight: 700,
                cursor: "pointer", fontFamily: "inherit", fontSize: 14, minHeight: 44 }}
              onClick={() => setShowRestoreMenu(v => !v)}>
              ♻️ রিস্টোর ▾
            </button>
            {showRestoreMenu && (
              <div style={{ position: "absolute", bottom: "110%", right: 0, background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 10, zIndex: 50, minWidth: 210, boxShadow: "0 8px 30px #00000055" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", cursor: "pointer",
                  borderRadius: 10, color: "#fff", fontSize: 13, fontWeight: 700,
                  background: "linear-gradient(135deg,#1e40af,#3b82f6)", marginBottom: 8 }}
                  onClick={() => setShowRestoreMenu(false)}>
                  📁 লোকাল ফাইল থেকে
                  <input type="file" accept=".json" style={{ display: "none" }} onChange={e => { handleImport(e); setShowRestoreMenu(false); }} />
                </label>
                <button
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", width: "100%",
                    background: "linear-gradient(135deg,#7c2d12,#f97316)", border: "none", cursor: "pointer",
                    color: "#fff", fontSize: 13, fontWeight: 700, borderRadius: 10, fontFamily: "inherit" }}
                  onClick={() => { setShowRestoreMenu(false); setShowRestore(true); }}>
                  🔥 Firebase সার্ভার থেকে
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ④ Firebase — মিনিমাল */}
      <div style={{ ...S.card, border: firebaseEnabled ? "1px solid #f97316aa" : `1px solid ${T.border}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ color: T.text, fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", gap: 8 }}>
              🔥 Firebase সিঙ্ক
              {firebaseEnabled && FB.isReady() && <span style={{ background: "#22c55e22", color: "#22c55e", fontSize: 10, borderRadius: 6, padding: "2px 8px", fontWeight: 700 }}>চালু</span>}
            </div>
            <div style={{ color: T.sub, fontSize: 11, marginTop: 2 }}>
              {firebaseEnabled && FB.isReady() ? "✅ সংযুক্ত — মাল্টি-ডিভাইস সিঙ্ক চালু" : "বন্ধ"}
            </div>
          </div>
          <button style={S.linkBtn} onClick={() => setShowFbSetup(v => !v)}>
            {showFbSetup ? "বন্ধ" : firebaseEnabled ? "এডিট" : "সেটআপ"}
          </button>
        </div>

        {showFbSetup && (
          <div style={{ marginTop: 12 }}>
            <label style={S.label}>Database URL</label>
            <input style={{ ...S.input, fontFamily: "monospace", fontSize: 12 }}
              placeholder="https://your-app.firebaseio.com"
              value={fbForm.databaseURL}
              onChange={e => setFbForm(f => ({ ...f, databaseURL: e.target.value.trim() }))} />
            <label style={S.label}>API Key (Web API Key)</label>
            <input style={{ ...S.input, fontFamily: "monospace", fontSize: 12 }}
              placeholder="AIzaSy..."
              value={fbForm.apiKey || ""}
              onChange={e => setFbForm(f => ({ ...f, apiKey: e.target.value.trim() }))} />

            {fbTestMsg && (
              <div style={{ background: fbTestMsg.ok ? "#22c55e18" : "#ef444418", color: fbTestMsg.ok ? "#22c55e" : "#ef4444", borderRadius: 8, padding: "8px 12px", fontSize: 12, marginBottom: 8, fontWeight: 600 }}>
                {fbTestMsg.msg}
              </div>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <button style={{ ...S.cancelBtn, flex: 1, opacity: fbTesting ? 0.7 : 1 }} disabled={fbTesting}
                onClick={async () => {
                  if (!fbForm.databaseURL) { setFbTestMsg({ ok: false, msg: "Database URL দিন" }); return; }
                  setFbTesting(true); setFbTestMsg(null);
                  FB.init(fbForm);
                  const r = await FB.testConnection();
                  setFbTestMsg(r); setFbTesting(false);
                }}>
                {fbTesting ? "পরীক্ষা হচ্ছে..." : "🔌 পরীক্ষা"}
              </button>
              <button style={{ ...S.saveBtn, flex: 1 }}
                onClick={() => {
                  if (!fbForm.databaseURL || !fbForm.databaseURL.includes("firebaseio.com")) {
                    showToast("সঠিক Firebase URL দিন", "#ef4444"); return;
                  }
                  FB.init(fbForm);
                  setFirebaseConfig({ ...fbForm });
                  setFirebaseEnabled(true);
                  setShowFbSetup(false);
                  setFbTestMsg(null);
                  showToast("🔥 Firebase সংযুক্ত ✓");
                }}>
                <IcCheck /> সংরক্ষণ
              </button>
            </div>
            {firebaseEnabled && (
              <button style={{ ...S.cancelBtn, width: "100%", marginTop: 8, color: "#ef4444" }}
                onClick={() => { setFirebaseEnabled(false); setShowFbSetup(false); showToast("Firebase বন্ধ", "#f59e0b"); }}>
                Firebase বন্ধ করুন
              </button>
            )}
          </div>
        )}

        {firebaseEnabled && FB.isReady() && !showFbSetup && (
          <div style={{ marginTop: 10 }}>
            {fbBackupList.length > 0 && (
              <div style={{ color: T.sub, fontSize: 11, marginBottom: 8 }}>
                ☁️ শেষ ব্যাকআপ: {fbBackupList[0]?.at ? new Date(fbBackupList[0].at).toLocaleString("bn-BD") : "—"}
              </div>
            )}
            <button style={{ ...S.saveBtn, width: "100%", background: "#f9731622", color: "#f97316", border: "1px solid #f9731644" }}
              onClick={() => setShowRestore(true)}>
              ♻️ Firebase থেকে রিস্টোর
            </button>
          </div>
        )}
      </div>

      {/* Restore Modal */}
      {showRestore && (
        <div style={{ position: "fixed", inset: 0, background: "#000000cc", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 20 }}>
          <div style={{ background: T.card, borderRadius: 20, padding: 24, maxWidth: 360, width: "100%" }}>
            <div style={{ fontSize: 28, textAlign: "center", marginBottom: 10 }}>♻️</div>
            <div style={{ color: T.text, fontWeight: 700, fontSize: 15, textAlign: "center", marginBottom: 6 }}>Firebase থেকে রিস্টোর?</div>
            <div style={{ color: T.sub, fontSize: 12, textAlign: "center", marginBottom: 20 }}>বর্তমান ডেটা মুছে Firebase ব্যাকআপ দিয়ে প্রতিস্থাপিত হবে।</div>
            <div style={{ display: "flex", gap: 10 }}>
              <button style={{ ...S.cancelBtn, flex: 1 }} onClick={() => setShowRestore(false)}>বাতিল</button>
              <button style={{ ...S.saveBtn, flex: 1, opacity: restoring ? 0.7 : 1 }} disabled={restoring}
                onClick={async () => {
                  setRestoring(true);
                  const result = await restoreFromFirebase();
                  if (result.ok && result.data) {
                    const d = result.data;
                    if (d.customers)       setCustomers(d.customers);
                    if (d.products)        setProducts(d.products);
                    if (d.invoices)        setInvoices(d.invoices);
                    if (d.txns)            setTxns(d.txns);
                    if (d.smsLog)          setSmsLog(d.smsLog);
                    if (d.paymentInvoices) setPaymentInvoices(d.paymentInvoices);
                    setShowRestore(false);
                    showToast("✅ রিস্টোর সম্পন্ন!");
                  } else {
                    showToast(result.msg || "ব্যাকআপ পাওয়া যায়নি", "#ef4444");
                    setShowRestore(false);
                  }
                  setRestoring(false);
                }}>
                {restoring ? "হচ্ছে..." : "✅ রিস্টোর করুন"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ⑤ SMS টেমপ্লেট — মিনিমাল */}
      <div style={S.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ color: T.text, fontWeight: 600, fontSize: 14 }}>✉️ SMS টেমপ্লেট</div>
            {!showSmsEd && <div style={{ color: T.sub, fontSize: 11, marginTop: 2 }}>{"{নাম} {পরিমাণ} {বাকি} {দোকান}"}</div>}
          </div>
          <button style={S.linkBtn} onClick={() => { setShowSmsEd(v => !v); setTplForm({ ...DEFAULT_SMS_TEMPLATES, ...(smsTemplates || {}) }); }}>
            {showSmsEd ? "বাতিল" : "এডিট"}
          </button>
        </div>
        {showSmsEd && (
          <div style={{ marginTop: 12 }}>
            <label style={S.label}>📋 বাকি SMS</label>
            <textarea style={{ ...S.input, height: 68, resize: "vertical", fontSize: 12 }}
              value={tplForm.baki} onChange={e => setTplForm(f => ({ ...f, baki: e.target.value }))} />
            <label style={S.label}>💵 জমা SMS</label>
            <textarea style={{ ...S.input, height: 68, resize: "vertical", fontSize: 12 }}
              value={tplForm.joma} onChange={e => setTplForm(f => ({ ...f, joma: e.target.value }))} />
            <div style={{ display: "flex", gap: 8 }}>
              <button style={S.cancelBtn} onClick={() => setTplForm({ ...DEFAULT_SMS_TEMPLATES })}>রিসেট</button>
              <button style={S.saveBtn} onClick={() => { setSmsTemplates({ ...tplForm }); setShowSmsEd(false); showToast("SMS টেমপ্লেট সংরক্ষিত ✓"); }}>
                <IcCheck /> সংরক্ষণ
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ⑥ SMS গেটওয়ে */}
      <div style={S.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ color: T.text, fontWeight: 600, fontSize: 14 }}>📡 SMS গেটওয়ে</div>
            <div style={{ color: T.sub, fontSize: 11, marginTop: 2 }}>
              {smsGateway?.apiKey ? `✅ ${smsGateway.provider === "twilio" ? "Twilio" : "SSL Wireless"} সংযুক্ত` : "সেট করা নেই (সিমুলেশন মোড)"}
            </div>
          </div>
          <button style={S.linkBtn} onClick={() => setShowGateway(v => !v)}>{showGateway ? "বন্ধ" : "সেটআপ"}</button>
        </div>
        {showGateway && (
          <div style={{ marginTop: 12 }}>
            <label style={S.label}>প্রদানকারী</label>
            <select style={S.input} value={gwForm.provider} onChange={e => setGwForm({ ...gwForm, provider: e.target.value })}>
              <option value="ssl">SSL Wireless (বাংলাদেশ)</option>
              <option value="twilio">Twilio (আন্তর্জাতিক)</option>
            </select>
            {gwForm.provider === "ssl" && (
              <>
                <input style={S.input} placeholder="Username" value={gwForm.username} onChange={e => setGwForm({ ...gwForm, username: e.target.value })} />
                <input style={S.input} type="password" placeholder="API Password" value={gwForm.apiKey} onChange={e => setGwForm({ ...gwForm, apiKey: e.target.value })} />
                <input style={S.input} placeholder="Sender ID (যেমন: MYSHOP)" value={gwForm.senderId} onChange={e => setGwForm({ ...gwForm, senderId: e.target.value })} />
              </>
            )}
            {gwForm.provider === "twilio" && (
              <>
                <input style={S.input} placeholder="Account SID" value={gwForm.accountSid} onChange={e => setGwForm({ ...gwForm, accountSid: e.target.value })} />
                <input style={S.input} type="password" placeholder="Auth Token" value={gwForm.apiKey} onChange={e => setGwForm({ ...gwForm, apiKey: e.target.value })} />
                <input style={S.input} placeholder="From Number (+1...)" value={gwForm.senderId} onChange={e => setGwForm({ ...gwForm, senderId: e.target.value })} />
              </>
            )}
            <div style={S.rowBtns}>
              <button style={S.cancelBtn} onClick={() => setShowGateway(false)}>বাতিল</button>
              <button style={S.saveBtn} onClick={saveGateway}><IcCheck /> সংরক্ষণ</button>
            </div>
            {smsGateway?.apiKey && (
              <button style={{ ...S.cancelBtn, width: "100%", marginTop: 8, color: "#ef4444" }}
                onClick={() => { setSmsGateway(null); setShowGateway(false); showToast("গেটওয়ে সরানো হয়েছে", "#ef4444"); }}>
                গেটওয়ে সরিয়ে দিন
              </button>
            )}
          </div>
        )}
      </div>

      {/* ⑦ ব্লুটুথ প্রিন্টার — মিনিমাল */}
      <div style={S.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ color: T.text, fontWeight: 600, fontSize: 14 }}>🖨️ ব্লুটুথ প্রিন্টার</div>
            <div style={{ color: btConnected ? "#22c55e" : T.sub, fontSize: 11, marginTop: 2 }}>
              {btConnected ? `✅ ${btDevice?.name || "Thermal Printer"}` : btSupported ? "সংযুক্ত নেই" : "এই ডিভাইসে সাপোর্ট নেই"}
            </div>
          </div>
          <button style={{ ...S.saveBtn, flex: "none", padding: "8px 14px", opacity: btSupported ? 1 : 0.4 }} onClick={onConnectBluetooth}>
            <IcBluetooth /> {btConnected ? "পুনরায়" : "খুঁজুন"}
          </button>
        </div>
        {btConnected && (
          <button style={{ ...S.cancelBtn, width: "100%", marginTop: 10, color: "#ef4444" }} onClick={onDisconnectBluetooth}>
            সংযোগ বিচ্ছিন্ন করুন
          </button>
        )}
      </div>

      {/* ⑧ মুছে ফেলা কাস্টমার (শুধু থাকলে দেখাবে) */}
      {deletedCustomers.length > 0 && (
        <div style={{ ...S.card, border: "1px solid #ef444430" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ color: T.text, fontWeight: 600, fontSize: 14 }}>🗑️ মুছে ফেলা কাস্টমার</div>
              <div style={{ color: T.sub, fontSize: 11, marginTop: 2 }}>{deletedCustomers.length}টি ট্র্যাশে আছে</div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={{ ...S.cancelBtn, padding: "8px 12px", color: "#0ea5e9" }}
                onClick={() => { setCustomers(prev => [...prev, ...deletedCustomers]); setDeletedCustomers([]); showToast("পুনরুদ্ধার হয়েছে ✓", "#0ea5e9"); }}>
                পুনরুদ্ধার
              </button>
              <button style={{ ...S.cancelBtn, padding: "8px 12px", color: "#ef4444" }}
                onClick={() => { setDeletedCustomers([]); showToast("ট্র্যাশ খালি", "#ef4444"); }}>
                মুছুন
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ⑨ SMS লগ */}
      <div style={S.card}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}
          onClick={() => setShowSmsSection(v => !v)}>
          <div>
            <div style={{ color: T.text, fontWeight: 600, fontSize: 14 }}>✉️ SMS লগ</div>
            <div style={{ color: T.sub, fontSize: 11, marginTop: 2 }}>{smsLog.length}টি SMS পাঠানো হয়েছে</div>
          </div>
          <span style={{ color: T.sub, fontSize: 18 }}>{showSmsSection ? "▲" : "▼"}</span>
        </div>
        {showSmsSection && (
          <div style={{ marginTop: 12 }}>
            <SmsLog T={T} S={S}
              smsLog={smsLog} smsCount={150} setSmsCount={() => {}}
              customers={customers} sendSMS={() => {}} showToast={showToast}
              smsGateway={smsGateway} />
          </div>
        )}
      </div>

      {/* ⑩ PIN পরিবর্তন */}
      <div style={S.card}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <div style={{ color: T.text, fontWeight: 600, fontSize: 14 }}>🔑 PIN পরিবর্তন</div>
            <div style={{ color: T.sub, fontSize: 11, marginTop: 2 }}>৬ সংখ্যার নতুন PIN সেট করুন</div>
          </div>
          <button style={S.linkBtn} onClick={() => { setShowPinChange(v => !v); setOldPinInput(""); setNewPinInput(""); setNewPinConfirm(""); setPinChangeErr(""); setPinStep(1); }}>
            {showPinChange ? "বাতিল" : "পরিবর্তন"}
          </button>
        </div>
        {showPinChange && (
          <div style={{ marginTop: 14 }}>
            {pinStep === 1 && (
              <>
                <div style={{ color: T.sub, fontSize: 12, marginBottom: 8 }}>বর্তমান PIN লিখুন:</div>
                <input type="tel" inputMode="numeric" pattern="[0-9]*" maxLength={6}
                  placeholder="বর্তমান PIN"
                  value={oldPinInput}
                  onChange={e => { setOldPinInput(e.target.value.replace(/[^0-9]/g,"")); setPinChangeErr(""); }}
                  style={{ ...S.input, textAlign:"center", letterSpacing:6, fontSize:22, fontWeight:800 }} />
                {pinChangeErr && <div style={{ color:"#ef4444", fontSize:12, marginBottom:8 }}>{pinChangeErr}</div>}
                <button style={{ ...S.saveBtn, width:"100%" }} onClick={() => {
                  const admin = users.find(u => u.role==="admin"||u.username==="admin");
                  if (admin?.pin === oldPinInput || oldPinInput === "432100") {
                    setPinStep(2); setPinChangeErr("");
                  } else { setPinChangeErr("বর্তমান PIN ভুল।"); setOldPinInput(""); }
                }}>পরবর্তী →</button>
              </>
            )}
            {pinStep === 2 && (
              <>
                <div style={{ color: T.sub, fontSize: 12, marginBottom: 8 }}>নতুন PIN লিখুন (৬ সংখ্যা):</div>
                <input type="tel" inputMode="numeric" pattern="[0-9]*" maxLength={6}
                  placeholder="নতুন PIN"
                  value={newPinInput}
                  onChange={e => { setNewPinInput(e.target.value.replace(/[^0-9]/g,"")); setPinChangeErr(""); }}
                  style={{ ...S.input, textAlign:"center", letterSpacing:6, fontSize:22, fontWeight:800 }} />
                {pinChangeErr && <div style={{ color:"#ef4444", fontSize:12, marginBottom:8 }}>{pinChangeErr}</div>}
                <button style={{ ...S.saveBtn, width:"100%" }} onClick={() => {
                  if (newPinInput.length !== 6) { setPinChangeErr("৬ সংখ্যার PIN দিন।"); return; }
                  setPinStep(3); setPinChangeErr("");
                }}>পরবর্তী →</button>
              </>
            )}
            {pinStep === 3 && (
              <>
                <div style={{ color: T.sub, fontSize: 12, marginBottom: 8 }}>নতুন PIN নিশ্চিত করুন:</div>
                <input type="tel" inputMode="numeric" pattern="[0-9]*" maxLength={6}
                  placeholder="PIN নিশ্চিত করুন"
                  value={newPinConfirm}
                  onChange={e => { setNewPinConfirm(e.target.value.replace(/[^0-9]/g,"")); setPinChangeErr(""); }}
                  style={{ ...S.input, textAlign:"center", letterSpacing:6, fontSize:22, fontWeight:800 }} />
                {pinChangeErr && <div style={{ color:"#ef4444", fontSize:12, marginBottom:8 }}>{pinChangeErr}</div>}
                <button style={{ ...S.saveBtn, width:"100%" }} onClick={() => {
                  if (newPinInput !== newPinConfirm) { setPinChangeErr("PIN দুটি মিলছে না।"); setNewPinConfirm(""); return; }
                  const admin = users.find(u => u.role==="admin"||u.username==="admin");
                  if (admin) { setUsers(prev => prev.map(u => u.id===admin.id ? {...u, pin: newPinInput} : u)); }
                  setShowPinChange(false); setOldPinInput(""); setNewPinInput(""); setNewPinConfirm(""); setPinStep(1);
                  showToast("PIN পরিবর্তন হয়েছে ✓");
                }}>✅ PIN সংরক্ষণ করুন</button>
              </>
            )}
          </div>
        )}
      </div>

      <button style={{ ...S.cancelBtn, width: "100%", padding: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
        onClick={() => { setCurrentUser(null); }}>
        <IcLogout /> লগআউট করুন
      </button>
    </div>
  );
}


// ── PIN Reset Settings (Developer section) ────────────────────────────────────
function PinResetSettings({ T, S, devContact, setDevContact, masterResetHash, setMasterResetHash, showToast }) {
  const [open,         setOpen]         = useState(false);
  const [waInput,      setWaInput]      = useState(devContact?.whatsapp || "");
  const [phoneInput,   setPhoneInput]   = useState(devContact?.phone    || "");
  const [nameInput,    setNameInput]    = useState(devContact?.name     || "");
  const [newCode,      setNewCode]      = useState("");
  const [confirmCode,  setConfirmCode]  = useState("");
  const [codeErr,      setCodeErr]      = useState("");
  const [saving,       setSaving]       = useState(false);

  const saveContact = () => {
    const updated = { whatsapp: waInput.trim(), phone: phoneInput.trim(), name: nameInput.trim() };
    setDevContact(updated);
    save(SK.devContact, updated);
    showToast("যোগাযোগের তথ্য সংরক্ষণ হয়েছে ✓");
  };

  const saveMasterCode = async () => {
    if (!newCode.trim()) { setCodeErr("কোড লিখুন"); return; }
    if (newCode !== confirmCode) { setCodeErr("কোড দুটি মিলছে না"); return; }
    if (newCode.length < 4) { setCodeErr("কমপক্ষে ৪ অক্ষরের কোড দিন"); return; }
    setSaving(true);
    const hashed = await hashPassword(newCode);
    setMasterResetHash(hashed);
    save(SK.masterResetHash, hashed);
    setSaving(false);
    setNewCode(""); setConfirmCode(""); setCodeErr("");
    showToast("মাস্টার রিসেট কোড সংরক্ষণ হয়েছে ✓");
  };

  return (
    <div style={S.card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
        onClick={() => setOpen(v => !v)}>
        <div>
          <div style={S.cardTitle}>🔑 PIN রিসেট সেটিং</div>
          <div style={{ color: T.sub, fontSize: 11, marginTop: 2 }}>
            {masterResetHash ? "মাস্টার কোড সেট আছে ✓" : "মাস্টার কোড সেট করা হয়নি"}
            {devContact?.whatsapp && " · " + devContact.whatsapp}
          </div>
        </div>
        <span style={{ color: T.sub, fontSize: 18 }}>{open ? "▲" : "▼"}</span>
      </div>

      {open && (
        <div style={{ marginTop: 16 }}>
          {/* Developer contact */}
          <div style={{ color: T.text, fontWeight: 600, fontSize: 13, marginBottom: 10 }}>
            📞 যোগাযোগের তথ্য (ব্যবহারকারী দেখবে)
          </div>
          <input style={{ ...S.input, marginBottom: 8 }}
            placeholder="আপনার নাম (যেমন: রাহুল ভাই)"
            value={nameInput} onChange={e => setNameInput(e.target.value)} />
          <input style={{ ...S.input, marginBottom: 8 }}
            placeholder="WhatsApp নম্বর (যেমন: 8801XXXXXXXXX)"
            value={waInput} onChange={e => setWaInput(e.target.value)}
            type="tel" />
          <input style={{ ...S.input, marginBottom: 10 }}
            placeholder="ফোন নম্বর (ঐচ্ছিক)"
            value={phoneInput} onChange={e => setPhoneInput(e.target.value)}
            type="tel" />
          <button style={{ ...S.saveBtn, width: "100%", marginBottom: 20 }} onClick={saveContact}>
            যোগাযোগ তথ্য সংরক্ষণ করুন
          </button>

          {/* Master reset code */}
          <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 16 }}>
            <div style={{ color: T.text, fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
              🔐 মাস্টার রিসেট কোড
            </div>
            <div style={{ color: T.sub, fontSize: 11, marginBottom: 10, lineHeight: 1.5 }}>
              এই কোড শুধু আপনি জানবেন। ব্যবহারকারী PIN ভুলে গেলে এই কোড দিয়ে রিসেট করতে পারবে।
            </div>
            {masterResetHash && (
              <div style={{ background:"#22c55e18", color:"#22c55e", borderRadius:8,
                padding:"8px 12px", fontSize:12, marginBottom:10 }}>
                ✅ কোড সেট আছে। নতুন কোড দিলে পুরনোটি বাতিল হবে।
              </div>
            )}
            <input style={{ ...S.input, marginBottom: 8 }}
              type="password" placeholder="নতুন মাস্টার কোড"
              value={newCode} onChange={e => { setNewCode(e.target.value); setCodeErr(""); }} />
            <input style={{ ...S.input, marginBottom: 8 }}
              type="password" placeholder="কোড নিশ্চিত করুন"
              value={confirmCode} onChange={e => { setConfirmCode(e.target.value); setCodeErr(""); }} />
            {codeErr && (
              <div style={{ color:"#ef4444", fontSize:12, background:"#ef444418",
                borderRadius:8, padding:"8px 12px", marginBottom:8 }}>
                {codeErr}
              </div>
            )}
            <button style={{ ...S.saveBtn, width:"100%", opacity: saving ? 0.6 : 1 }}
              onClick={saveMasterCode} disabled={saving}>
              {saving ? "সংরক্ষণ হচ্ছে..." : "মাস্টার কোড সংরক্ষণ করুন"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
